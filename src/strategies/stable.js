/**
 * kuibuequity — 稳定象限：1%~5% 反人性止盈纪律
 *
 * 设计依据：docs/design.md §5
 * 灵魂：全部设计都在制造摩擦 —— 让冲动变贵，让纪律变自动。
 * 骨架公式：单票仓位 = 象限资金 × riskPerTrade / |stopLoss|（目标收益与仓位反向联动）
 */
import { atrPct, sma, slope } from '../indicators.js';
import { buildPlan } from '../plan.js';
import { expectancyCheck } from '../risk.js';

export const meta = {
  mode: 'stable',
  name: '1~5% 反人性止盈',
  horizon: '≤20 交易日',
  description: '不追求最高收益，赚 1~5% 就走；用事前契约与条件单对抗贪婪与不甘',
  configSchema: {
    targetPct: { default: null, range: [0.01, 0.05] }, // 显式止盈目标；null=按 ATR 自适应
    targetMinPct: { default: 0.01 },
    targetMaxPct: { default: 0.05 },
    targetVolMult: { default: 2.0 },
    stopRatio: { default: 0.8 }, // 止损 = -0.8 × 目标（盈亏比 1.25:1）
    maxHoldDays: { default: 15 },
    riskPerTrade: { default: 0.01 },
    minAmount: { default: 50000000 }, // 日均成交额 > 5000 万
  },
};

const defaults = Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default]));

/**
 * 止盈目标自适应（design.md §5.2）
 * t = clamp(2×ATR14%, 1%, 5%)；s = −0.8t；仓位 = riskPerTrade / |s|
 * config.targetPct 显式给定时直接采用（仍 clamp 到 [targetMin, targetMax]）
 */
export function adaptiveTarget({ bars, config = {} }) {
  const cfg = { ...defaults, ...config };
  const ap = atrPct(bars, 14).filter((v) => v !== null);
  if (!ap.length) throw new Error('ERR-DATA-002: ATR 数据不足，无法自适应目标');
  const vol = ap[ap.length - 1];
  const targetPct = cfg.targetPct != null
    ? Math.min(cfg.targetMaxPct, Math.max(cfg.targetMinPct, Number(cfg.targetPct)))
    : Math.min(cfg.targetMaxPct, Math.max(cfg.targetMinPct, vol * cfg.targetVolMult));
  const stopLossPct = -cfg.stopRatio * targetPct;
  const rawPositionPct = cfg.riskPerTrade / Math.abs(stopLossPct);
  return {
    atrPct: Math.round(vol * 10000) / 10000,
    targetPct: Math.round(targetPct * 10000) / 10000,
    stopLossPct: Math.round(stopLossPct * 10000) / 10000,
    positionPct: Math.min(0.25, rawPositionPct), // 受 maxSymbolPct 截断（risk.js）
    maxHoldDays: cfg.maxHoldDays,
    payoffRatio: 1 / cfg.stopRatio,
  };
}

/** 入场五条件（design.md §5.3），全真才允许建仓 */
export function entryChecks({ bars, indexBars, config = {} }) {
  const cfg = { ...defaults, ...config };
  const closes = bars.map((b) => b.adjClose ?? b.close);
  const last = bars[bars.length - 1];
  const px = last.adjClose ?? last.close;
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const sl = slope(closes.map((c, i) => (ma20[i] === null ? null : ma20[i])), 10);
  const checks = {
    indexAboveMa20: null,
    aboveMa60: ma60.at(-1) !== null ? px > ma60.at(-1) : null,
    ma20Rising: sl.at(-1) !== null ? sl.at(-1) > 0 : null,
    pullbackReclaim: null,
    volumeOk: null,
    liquid: bars.slice(-20).every((b) => (b.amount ?? 0) > cfg.minAmount / 20) ||
            (bars.slice(-20).reduce((a, b) => a + (b.amount ?? 0), 0) / 20 > cfg.minAmount),
  };
  if (Array.isArray(indexBars) && indexBars.length >= 20) {
    const ic = indexBars.map((b) => b.adjClose ?? b.close);
    const im = sma(ic, 20).at(-1);
    checks.indexAboveMa20 = im !== null ? ic.at(-1) > im : null;
  }
  // 近 5 日曾跌破 MA20 后重新站回，且当日收阳
  let dipped = false;
  for (let i = Math.max(0, bars.length - 5); i < bars.length - 1; i++) {
    if (ma20[i] !== null && closes[i] < ma20[i]) dipped = true;
  }
  checks.pullbackReclaim = dipped && ma20.at(-1) !== null && px > ma20.at(-1) && last.close >= last.open;
  const vols = bars.map((b) => b.volume);
  const volMa5 = sma(vols, 5).at(-1);
  checks.volumeOk = volMa5 ? last.volume / volMa5 >= 0.8 && last.volume / volMa5 <= 3.0 : null;

  const passed = Object.values(checks).every((v) => v === true);
  return { checks, passed };
}

/**
 * 建仓契约草案（P5：事前承诺，纯函数）
 *
 * t/s/D 全部来自 adaptiveTarget（不猜、不硬凑）；entry 必须来自真实成交。
 * 落库由 ledger.recordTrade({ contract }) 在同一次 save() 内完成（成交 ↔ 契约原子一致），
 * 事后修改只能走 ledger.overrideContract（必须 reason，写审计）。
 *
 * @param {{bars:object[], symbol:string, entry:{price:number, qty:number, date?:string},
 *          config?:object, note?:string}} p
 * @returns {object} 契约草案（见 docs/interface.md §7.2）
 */
export function buildLockedContract({ bars, symbol, entry, config = {}, note } = {}) {
  if (!symbol || typeof symbol !== 'string') throw new Error('ERR-SYMBOL-001: 建仓契约需要 symbol');
  const price = Number(entry?.price);
  const qty = Number(entry?.qty);
  if (!(price > 0) || !Number.isInteger(qty) || qty <= 0) {
    throw new Error(`ERR-CONTRACT-001: 建仓契约需要合法 entry.price/qty，收到 price=${entry?.price} qty=${entry?.qty}`);
  }
  const target = adaptiveTarget({ bars, config });
  return {
    quadrant: 'stable',
    symbol,
    mode: 'stable',
    entry: { price: Math.round(price * 1000) / 1000, qty, date: entry?.date ?? null },
    takeProfitPct: target.targetPct,
    stopLossPct: target.stopLossPct,
    maxHoldDays: target.maxHoldDays,
    source: 'adaptiveTarget',
    note:
      note ??
      `建仓自动锁定：t=+${(target.targetPct * 100).toFixed(2)}% / s=${(target.stopLossPct * 100).toFixed(2)}% / D=${target.maxHoldDays}日（adaptiveTarget）`,
  };
}

/**
 * 持仓体检（契约驱动）：止盈/止损/时间到期 → 动作 + 条件单参数
 * 契约锁定：contract 的 t/s/D 建仓时写死，改需 override（risk.js/ledger.js 负责审计）
 */
export function checkPosition({ bars, contract, position }) {
  if (!contract || !position) {
    return { action: 'hold', hitRule: 'STABLE.NO_CONTRACT', detail: '该标的无持仓或无事前契约：先用 kb_stable contract 建仓契约，再体检', conditionOrders: [] };
  }
  const last = bars[bars.length - 1];
  const px = last.adjClose ?? last.close;
  const entry = Number(contract.entry.price);
  const ret = px / entry - 1;
  const t = Number(contract.takeProfitPct);
  const s = Number(contract.stopLossPct);
  const holdDays = Number(contract.holdDays ?? 0);
  const conditionOrders = [
    { type: 'take_profit', triggerPrice: Math.round(entry * (1 + t) * 100) / 100, side: 'sell', qty: position?.qty },
    { type: 'stop_loss', triggerPrice: Math.round(entry * (1 + s) * 100) / 100, side: 'sell', qty: position?.qty },
  ];
  if (ret >= t) return { action: 'take_profit', hitRule: 'STABLE.TP_HIT', detail: `浮盈 ${(ret * 100).toFixed(2)}% ≥ 目标 ${(t * 100).toFixed(2)}%，落袋`, conditionOrders };
  if (ret <= s) return { action: 'stop_loss', hitRule: 'STABLE.SL_HIT', detail: `浮亏 ${(ret * 100).toFixed(2)}% ≤ 止损 ${(s * 100).toFixed(2)}%，无条件离场`, conditionOrders };
  if (holdDays >= Number(contract.maxHoldDays)) {
    return { action: 'time_exit', hitRule: 'STABLE.TIME_EXIT', detail: `持仓 ${holdDays} 日 ≥ ${contract.maxHoldDays} 日时间止损，释放资金效率`, conditionOrders };
  }
  return { action: 'hold', hitRule: 'STABLE.HOLD', detail: `浮盈 ${(ret * 100).toFixed(2)}%，区间内持有；条件单已挂`, conditionOrders };
}

export function evaluate({ bars, indexBars, position, contract, account, config = {}, symbol, stats }) {
  const cfg = { ...defaults, ...config };
  if (!Array.isArray(bars) || bars.length < 60) {
    return { signals: [], plan: null, diagnostics: { error: 'ERR-DATA-002: 稳定策略需要至少 60 根 K 线' } };
  }
  const last = bars[bars.length - 1];
  const px = last.adjClose ?? last.close;
  const signals = [];
  const rejected = [];

  // 期望值自检（P6：数学上亏钱的事直接拒绝）
  const exp = stats?.trades ? expectancyCheck({ trades: stats.trades, payoffRatio: 1 / cfg.stopRatio }) : null;
  if (exp?.verdict === 'NOT_RECOMMENDED') {
    rejected.push({ symbol, rule: 'STABLE.EXPECTANCY', reason: exp.note });
  }

  if (position && contract) {
    const chk = checkPosition({ bars, contract, position });
    if (chk.action !== 'hold') {
      signals.push({
        mode: 'stable', symbol, action: chk.action === 'take_profit' ? 'take_profit' : 'sell',
        qty: position.qty, price: px, reason: chk.detail, rule: chk.hitRule, confidence: 1,
      });
    }
  } else if (exp?.verdict !== 'NOT_RECOMMENDED') {
    const entry = entryChecks({ bars, indexBars, config: cfg });
    const target = adaptiveTarget({ bars, config: cfg });
    if (entry.passed) {
      const equity = Number(account?.equity) || Number(account?.cash) || 0;
      const budget = equity * target.positionPct;
      const qty = Math.floor(budget / px / 100) * 100;
      if (qty >= 100) {
        signals.push({
          mode: 'stable', symbol, action: 'buy', qty, price: px,
          reason: `STABLE.ENTRY 五条件齐备；目标 +${(target.targetPct * 100).toFixed(1)}% / 止损 ${(target.stopLossPct * 100).toFixed(1)}% / ≤${target.maxHoldDays}日`,
          rule: 'STABLE.ENTRY', confidence: 0.7,
          condition: {
            triggerPrice: Math.round(px * (1 + target.targetPct) * 100) / 100,
            validUntil: `${target.maxHoldDays} 交易日`,
          },
        });
      }
    } else {
      rejected.push({ symbol, rule: 'STABLE.ENTRY_FILTER', reason: `入场条件未齐备：${Object.entries(entry.checks).filter(([, v]) => v !== true).map(([k]) => k).join(', ')}` });
    }
  }

  const plan = buildPlan({ mode: 'stable', asOf: last.date, signals, rejected });
  return { signals, plan, diagnostics: { price: px, expectancy: exp } };
}
