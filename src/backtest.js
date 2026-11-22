/**
 * kuibuequity — 回测引擎（纯函数，无未来函数）
 *
 * 契约依据：docs/interface.md §8、docs/design.md §7（原则 P3 无未来函数、P4 成本口径唯一、P6 诚实的失败）
 *
 * 执行语义（硬要求）：
 *   1. signals[i] 对应 bars[i]（按 date 对齐），在 bar i **收盘**确认 → bar i+1 **开盘**成交；
 *      最后一根 K 线上的信号没有次日开盘，**不成交**，只记 skipped。
 *   2. T+1：当日买入的股数当日不可卖（可卖数量 = 持仓 − 当日买入）。
 *   3. 买入整手向下取整（lot，默认 100 股）；不足 1 手跳过并记入 skipped。
 *   4. 一字涨停（limitUp && high===low）买入不成交；跌停（limitDown && high===low）卖出不成交；
 *      停牌（suspended）双向跳过 —— 绝不伪造成交（P6）。
 *   5. 成本只引用 src/costs.js：tradeFee（佣金/印花税/过户费）+ applySlippage（slippageBps 取自 fee）。
 *   6. 分红：bar.dividendPerShare > 0 时按**除息日开盘前持股数**现金入账（equity 增加，不计入 trade pnl，避免重复计算）。
 *   7. 卖出数量超过持仓 → 截断到持仓并记 skipped；现金不足 → 缩量到可负担整手。
 *
 * 撮合顺序（本实现的取舍，见文件末"实现取舍"注释）：同一开盘内**先买入后卖出**，
 * 目的是让"当日买入当日卖出"必然被 T+1 挡下，使 T+1 可测、可验证。
 */

import { DEFAULT_FEE, resolveFee, tradeFee, applySlippage, holdingCost } from './costs.js';
import { maxDrawdown, sharpe, winRate, payoffRatio } from './indicators.js';

/** 年化基准：244 个交易日（docs/design.md §7） */
const TRADING_DAYS_PER_YEAR = 244;
/** 短线象限硬期限：5 日强制离场（docs/design.md §6.4，不可 override） */
const SHORT_HARD_MAX_HOLD_DAYS = 5;

const round2 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 100) / 100 : null);
const round3 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 1000) / 1000 : null);
const round6 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 1e6) / 1e6 : null);
const round8 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 1e8) / 1e8 : null);

/** 视为卖出的动作集合（stop_loss / take_profit / force_exit 都是卖出指令） */
const SELL_ACTIONS = new Set(['sell', 'stop_loss', 'take_profit', 'force_exit']);
/** 视为买入的动作集合 */
const BUY_ACTIONS = new Set(['buy']);
/** 明确忽略的动作（不产生成交，也不记 skipped） */
const IGNORE_ACTIONS = new Set(['hold', 'none', '']);

/** 统一错误构造：message 前缀 ERR-* 码（interface.md §10），并挂 err.code 便于上层分支 */
function btError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 空指标：bars 为空或全现金时的兜底（未知值用 null，不得用 0 冒充） */
function emptyMetrics(initialCash) {
  return {
    totalReturn: 0,
    annualReturn: 0,
    maxDrawdown: 0,
    sharpe: null,
    trades: 0,
    winRate: null,
    payoffRatio: null,
    avgHoldDays: null,
    feeRatio: 0,
    costToNegativeProgress: 0,
    initialCash: round2(initialCash),
    finalEquity: round2(initialCash),
    totalFees: 0,
    dividends: 0,
    costPerShare: null,
    negativeCost: false,
    bars: 0,
  };
}

/**
 * 无未来函数回测
 *
 * @param {object} p
 * @param {Array}  p.bars        Bar[]（升序，含 limitUp/limitDown/suspended/dividendPerShare）
 * @param {Array}  p.signals     Signal[]；signals[i] 锚定 bars[i]。允许元素为 Signal 或 Signal[]
 *                               （同一收盘确认多条信号），也允许 signal.date 显式指定锚定 K 线。
 * @param {number} p.initialCash 初始现金（元）
 * @param {object} p.fee         费率（含 slippageBps），见 costs.DEFAULT_FEE
 * @param {string} p.mode        'long' | 'stable' | 'short'；short 额外受 5 日硬期限强制离场
 * @param {boolean} p.tPlus1     是否启用 T+1（默认 true）
 * @param {number} p.lot         一手股数（默认 100）
 * @returns {{metrics:object, equityCurve:Array, trades:Array, skipped:Array}}
 */
export function runBacktest({
  bars,
  signals,
  initialCash = 100000,
  fee = DEFAULT_FEE,
  mode = 'stable',
  tPlus1 = true,
  lot = 100,
} = {}) {
  if (!Array.isArray(bars)) throw btError('ERR-DATA-002', 'bars 必须是数组');
  const sigs = Array.isArray(signals) ? signals : [];
  const feeConf = resolveFee(fee);
  const slippageBps = Number(feeConf.slippageBps) || 0;
  const lotSize = Number(lot) > 0 ? Math.floor(Number(lot)) : 100;
  const n = bars.length;

  const startCash = Number(initialCash) > 0 ? Number(initialCash) : 0;
  const skipped = [];
  const trades = [];
  const equityCurve = [];

  /** 记录被拒/未成交原因（必须留痕，不得丢弃） */
  const skip = (date, rule, reason, code = null, symbol = null) =>
    skipped.push({ date: date ?? null, rule, reason, code, symbol });

  if (n === 0) return { metrics: emptyMetrics(startCash), equityCurve, trades, skipped };

  // ---- 标的：回测以单一 K 线序列为标的，信号标的必须与之一致（否则拒绝，不伪造价格） ----
  const primarySymbol =
    bars.find((b) => b && b.symbol)?.symbol ??
    sigs.flat().find((s) => s && s.symbol)?.symbol ??
    'UNKNOWN';

  // ---- date → bar 下标（信号按 date 对齐；无 date 时按数组下标对齐） ----
  const dateIndex = new Map();
  bars.forEach((b, i) => {
    if (b && b.date && !dateIndex.has(b.date)) dateIndex.set(b.date, i);
  });

  // ---- 信号编排：bar i 收盘确认 → 登记到 bar i+1 开盘执行队列 ----
  /** @type {Map<number, object[]>} execBarIndex -> 待执行信号 */
  const execMap = new Map();
  const pushExec = (idx, sig) => {
    if (!execMap.has(idx)) execMap.set(idx, []);
    execMap.get(idx).push(sig);
  };

  sigs.forEach((entry, i) => {
    const list = Array.isArray(entry) ? entry : [entry];
    for (const sig of list) {
      if (!sig || typeof sig !== 'object') continue;
      const action = String(sig.action ?? '');
      if (IGNORE_ACTIONS.has(action)) continue;
      const anchor = sig.date && dateIndex.has(sig.date) ? dateIndex.get(sig.date) : i;
      if (anchor >= n) {
        skip(null, 'ANCHOR_OUT_OF_RANGE', `信号锚定的 K 线下标 ${anchor} 超出 bars 长度 ${n}`, 'ERR-DATA-002', sig.symbol ?? primarySymbol);
        continue;
      }
      if (anchor + 1 >= n) {
        // P3：最后一根收盘确认的信号没有次日开盘，绝不"借用"当日价格成交
        skip(bars[anchor]?.date ?? null, 'NO_NEXT_BAR', '信号在最后一根 K 线收盘确认，无次日开盘可成交（P3 无未来函数）', null, sig.symbol ?? primarySymbol);
        continue;
      }
      pushExec(anchor + 1, sig);
    }
  });

  // ---- 持仓状态 ----
  /** @type {Map<string, {qty:number, fifo:Array, lots:Array, qtyBoughtToday:number, lastBuyDate:string|null}>} */
  const positions = new Map();
  const getPosition = (sym) => {
    if (!positions.has(sym)) {
      positions.set(sym, { qty: 0, fifo: [], lots: [], qtyBoughtToday: 0, lastBuyDate: null });
    }
    return positions.get(sym);
  };
  /** 全局时序流水（供 costs.holdingCost 计算成本转负进度）；与 p.lots 共享同一批对象 */
  const allLots = [];

  let cash = startCash;
  let totalFees = 0;
  let totalDividends = 0;

  /** 买入撮合：bar 开盘价 + 滑点；整手向下取整；现金不足缩量到可负担整手 */
  function doBuy(sig, bar, j) {
    const sym = sig.symbol ?? primarySymbol;
    if (sym !== primarySymbol) {
      skip(bar.date, 'SYMBOL_MISMATCH', `回测只支持单一 K 线序列，信号标的 ${sym} 与 K 线标的 ${primarySymbol} 不一致`, 'ERR-SYMBOL-001', sym);
      return;
    }
    if (bar.suspended) {
      skip(bar.date, 'SUSPENDED', '停牌，买入不成交（P6 不伪造成交）', 'ERR-PLAN-002', sym);
      return;
    }
    if (bar.limitUp && bar.high === bar.low) {
      skip(bar.date, 'LIMIT_UP_ONE_WORD', '一字涨停（high===low）封单买不到，买入不成交', 'ERR-PLAN-002', sym);
      return;
    }
    const rawOpen = Number(bar.open);
    if (!(rawOpen > 0)) {
      skip(bar.date, 'BAD_PRICE', `bar.open=${bar.open} 非法，无法撮合`, 'ERR-DATA-002', sym);
      return;
    }
    const price = applySlippage({ price: rawOpen, side: 'buy', slippageBps });
    // 未给数量 → 按开盘价全仓买入（再受整手与现金约束）
    const want = Number(sig.qty) > 0 ? Math.floor(Number(sig.qty)) : Math.floor(cash / (price * lotSize)) * lotSize;
    let qty = Math.floor(want / lotSize) * lotSize;
    if (qty < lotSize) {
      skip(bar.date, 'LOT_ROUND_DOWN', `买入 ${want} 股不足 1 手（${lotSize} 股），向下取整为 0，跳过`, 'ERR-PLAN-001', sym);
      return;
    }
    let f = tradeFee({ side: 'buy', price, qty, fee: feeConf });
    let shrunk = false;
    // 现金不足 → 逐手缩量到可负担整手（含费用）
    while (qty >= lotSize && price * qty + f > cash + 1e-9) {
      qty -= lotSize;
      shrunk = true;
      if (qty >= lotSize) f = tradeFee({ side: 'buy', price, qty, fee: feeConf });
    }
    if (qty < lotSize) {
      skip(bar.date, 'INSUFFICIENT_CASH', `现金 ${cash} 元买不起 1 手（${lotSize} 股 @ ${price}），跳过`, 'ERR-LEDGER-002', sym);
      return;
    }
    if (shrunk) {
      skip(bar.date, 'CASH_SHRINK', `现金不足，买入量由 ${Math.floor(want / lotSize) * lotSize} 股缩量到 ${qty} 股`, 'ERR-LEDGER-002', sym);
    }
    const cost = round2(price * qty + f);
    cash = round2(cash - cost);
    totalFees = round2(totalFees + f);

    const p = getPosition(sym);
    p.qty += qty;
    p.qtyBoughtToday += qty;
    p.lastBuyDate = bar.date ?? null;
    const rec = { side: 'buy', price, qty, fee: f };
    p.lots.push(rec);
    allLots.push(rec);
    p.fifo.push({ qty, price, fee: f, date: bar.date ?? null, index: j });
  }

  /** 卖出撮合：T+1 可卖数量校验 → 超持仓截断 → FIFO 配对成 trade 记录 */
  function doSell(sig, bar, j) {
    const sym = sig.symbol ?? primarySymbol;
    if (sym !== primarySymbol) {
      skip(bar.date, 'SYMBOL_MISMATCH', `回测只支持单一 K 线序列，信号标的 ${sym} 与 K 线标的 ${primarySymbol} 不一致`, 'ERR-SYMBOL-001', sym);
      return;
    }
    const p = positions.get(sym);
    if (!p || p.qty <= 0) {
      skip(bar.date, 'NO_POSITION', '无持仓可卖', 'ERR-LEDGER-003', sym);
      return;
    }
    if (bar.suspended) {
      skip(bar.date, 'SUSPENDED', '停牌，卖出不成交（P6 不伪造成交）', 'ERR-PLAN-002', sym);
      return;
    }
    if (bar.limitDown && bar.high === bar.low) {
      skip(bar.date, 'LIMIT_DOWN_ONE_WORD', '跌停（high===low）封单卖不掉，卖出不成交', 'ERR-PLAN-002', sym);
      return;
    }
    // T+1：当日买入部分不可卖
    const sellable = tPlus1 ? p.qty - p.qtyBoughtToday : p.qty;
    if (sellable <= 0) {
      skip(bar.date, 'T_PLUS_1', `当日买入 ${p.qtyBoughtToday} 股，T+1 规则下当日不可卖`, 'ERR-LEDGER-003', sym);
      return;
    }
    let want = Number(sig.qty) > 0 ? Math.floor(Number(sig.qty)) : p.qty;
    if (want > sellable) {
      skip(bar.date, 'SELL_TRUNCATED', `卖出 ${want} 股超过可卖持仓 ${sellable} 股，已截断到 ${sellable} 股`, 'ERR-LEDGER-003', sym);
      want = sellable;
    }
    const rawOpen = Number(bar.open);
    if (!(rawOpen > 0)) {
      skip(bar.date, 'BAD_PRICE', `bar.open=${bar.open} 非法，无法撮合`, 'ERR-DATA-002', sym);
      return;
    }
    const price = applySlippage({ price: rawOpen, side: 'sell', slippageBps });
    const f = tradeFee({ side: 'sell', price, qty: want, fee: feeConf });
    cash = round2(cash + round2(price * want - f));
    totalFees = round2(totalFees + f);

    // FIFO 配对：费用按成交额比例分摊到每笔配对
    const reason = String(sig.reason ?? sig.rule ?? 'signal');
    let remain = want;
    while (remain > 0 && p.fifo.length > 0) {
      const head = p.fifo[0];
      const take = Math.min(head.qty, remain);
      const buyCost = head.price * take + head.fee * (take / head.qty);
      const sellNet = price * take - f * (take / want);
      const pnl = round2(sellNet - buyCost);
      trades.push({
        symbol: sym,
        buyDate: head.date,
        sellDate: bar.date ?? null,
        buyPrice: round3(head.price),
        sellPrice: round3(price),
        qty: take,
        pnl,
        pnlPct: buyCost > 0 ? round6(pnl / buyCost) : null,
        holdDays: j - head.index,
        reason,
      });
      head.qty -= take;
      remain -= take;
      if (head.qty <= 0) p.fifo.shift();
    }
    p.qty -= want;
    const rec = { side: 'sell', price, qty: want, fee: f };
    p.lots.push(rec);
    allLots.push(rec);
    if (p.qty <= 0) {
      p.qty = 0;
      p.qtyBoughtToday = 0;
      p.lastBuyDate = null;
    }
  }

  // ---- 主循环：逐根 K 线（分红 → 撮合昨日信号 → 硬期限 → 盯市） ----
  for (let j = 0; j < n; j++) {
    const bar = bars[j] || {};
    const date = bar.date ?? null;

    // 每根开盘前重置"当日买入"计数
    for (const p of positions.values()) p.qtyBoughtToday = 0;

    // 1) 分红：按除息日开盘前持股数现金入账（equity 增加；不计入 trade pnl）
    const div = Number(bar.dividendPerShare) || 0;
    if (div > 0) {
      for (const p of positions.values()) {
        if (p.qty <= 0) continue;
        cash = round2(cash + div * p.qty);
        totalDividends = round2(totalDividends + div * p.qty);
        // 挂到该标的最近一笔流水上：该笔之后的持股数 === 除息日持股数，与 costs.holdingCost 口径一致
        if (p.lots.length > 0) {
          const last = p.lots[p.lots.length - 1];
          last.dividend = round6((Number(last.dividend) || 0) + div);
        }
      }
    }

    // 2) 撮合 bar j-1 收盘确认的信号（先买后卖，保证 T+1 必然生效）
    const pending = execMap.get(j);
    if (pending && pending.length > 0) {
      const buys = [];
      const sells = [];
      const others = [];
      for (const sig of pending) {
        const action = String(sig.action ?? '');
        if (BUY_ACTIONS.has(action)) buys.push(sig);
        else if (SELL_ACTIONS.has(action)) sells.push(sig);
        else others.push(sig);
      }
      for (const sig of others) {
        skip(bar.date, 'UNKNOWN_ACTION', `无法识别的动作 ${JSON.stringify(sig.action)}`, 'ERR-DATA-002', sig.symbol ?? primarySymbol);
      }
      for (const sig of buys) doBuy(sig, bar, j);
      for (const sig of sells) doSell(sig, bar, j);
    }

    // 3) 短线硬期限：持仓满 5 个交易日 → 次日开盘无条件清仓（不可 override）
    if (mode === 'short') {
      for (const [sym, p] of positions) {
        if (p.qty <= 0 || p.fifo.length === 0) continue;
        const held = j - p.fifo[0].index;
        if (held >= SHORT_HARD_MAX_HOLD_DAYS && j + 1 < n) {
          pushExec(j + 1, {
            action: 'force_exit',
            symbol: sym,
            qty: p.qty,
            rule: 'SHORT.HARD_EXIT_5D',
            reason: `短线持仓满 ${SHORT_HARD_MAX_HOLD_DAYS} 个交易日，强制清仓（硬红线，不可 override）`,
          });
        }
      }
    }

    // 4) 收盘盯市
    let position = 0;
    let marketValue = 0;
    for (const p of positions.values()) {
      if (p.qty <= 0) continue;
      position += p.qty;
      const px = Number(bar.close ?? bar.adjClose);
      marketValue += p.qty * (Number.isFinite(px) ? px : 0);
    }
    equityCurve.push({ date, equity: round2(cash + marketValue), position });
  }

  // ---- 指标 ----
  const equityArr = equityCurve.map((e) => e.equity).filter((v) => Number.isFinite(v));
  const finalEquity = equityArr.length > 0 ? equityArr[equityArr.length - 1] : startCash;
  const dailyReturns = [];
  for (let i = 1; i < equityArr.length; i++) {
    if (equityArr[i - 1] > 0) dailyReturns.push(equityArr[i] / equityArr[i - 1] - 1);
  }
  const totalReturn = startCash > 0 ? round6(finalEquity / startCash - 1) : null;
  let annualReturn = null;
  if (startCash > 0 && n > 0) {
    const growth = finalEquity / startCash;
    annualReturn = growth <= 0 ? -1 : round6(Math.pow(growth, TRADING_DAYS_PER_YEAR / n) - 1);
  }
  const holdDaysArr = trades.map((t) => t.holdDays).filter((v) => Number.isFinite(v));
  const hc = holdingCost({ lots: allLots, opts: { includeDividend: true } });
  const sh = sharpe(dailyReturns);
  const pr = payoffRatio(trades);

  const metrics = {
    totalReturn,
    annualReturn,
    maxDrawdown: round6(maxDrawdown(equityArr)),
    sharpe: sh === null ? null : round6(sh),
    trades: trades.length,
    winRate: winRate(trades),
    payoffRatio: pr === null ? null : round6(pr),
    avgHoldDays: holdDaysArr.length > 0 ? round2(holdDaysArr.reduce((a, b) => a + b, 0) / holdDaysArr.length) : null,
    // feeRatio 用 8 位小数：小额费用/大额本金在 6 位下会丢精度
    feeRatio: startCash > 0 ? round8(totalFees / startCash) : null,
    costToNegativeProgress: round6(hc.progress),
    // 以下为便于复盘的附加字段（不影响契约要求的 10 项）
    initialCash: round2(startCash),
    finalEquity: round2(finalEquity),
    totalFees: round2(totalFees),
    dividends: round2(totalDividends),
    costPerShare: hc.costPerShare,
    negativeCost: hc.negative,
    bars: n,
  };

  return { metrics, equityCurve, trades, skipped };
}

/*
 * 实现取舍（与契约的偏离/补充，需在 CHANGELOG 记录）：
 * 1. 撮合顺序为"同一开盘先买入后卖出"。代价：同日"先卖老仓腾出现金再买"的资金腾挪不计入
 *    （买入只能动用开盘前现金，可能偏保守地缩量）；收益：当日买当日卖必然被 T+1 挡下，
 *    T+1 语义可测可验证。
 * 2. 回测以单一 K 线序列为标的；信号带不同 symbol 时拒绝成交并记 skipped（ERR-SYMBOL-001），
 *    不用同一价格序列给别的标的伪造成交（P6）。
 * 3. mode='short' 时实现 design.md §6.4/§7 的 5 日强制离场：满 5 个交易日次日开盘无条件清仓。
 *    mode='long'|'stable' 不引入额外离场，离场完全由传入信号决定。
 * 4. feeRatio 口径 = 全部交易费用 / 初始资金（费用对本金的占比）。
 * 5. holdDays 以 K 线根数差计（buyBar→sellBar），即交易日持仓天数；分红不计入 pnl，
 *    只进现金与 holdingCost 的"已回收"，避免与 equity 重复计算。
 */
