/**
 * kuibuequity — 长期象限：股息网格 · 成本转负引擎
 *
 * 设计依据：docs/design.md §4
 * 目标函数：不是"涨多少"，而是把有效持仓成本压到 0 以下。
 * 双仓结构：底仓 core（只买不卖）+ 活动仓 float（网格高抛低吸摊薄）。
 */
import { atrPct } from '../indicators.js';
import { holdingCost, costToNegativeEta, annualDilutionRate, tradeFee } from '../costs.js';
import { buildPlan } from '../plan.js';

export const meta = {
  mode: 'long',
  name: '股息网格 · 成本转负',
  horizon: '3~10 年',
  description: '高股息底仓 + 网格摊薄，把持仓成本做成负数（典型：工商银行）',
  configSchema: {
    coreWeight: { default: 0.7, range: [0.5, 0.9] },
    gridLevels: { default: 5, range: [3, 8] },
    stepMinPct: { default: 0.03, range: [0.02, 0.05] },
    stepMaxPct: { default: 0.08, range: [0.05, 0.12] },
    baseWindow: { default: 60, range: [20, 120] },
    reinvest: { default: false },
    gridAnnualGross: { default: 0.12, range: [0.05, 0.3] },
  },
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** 策略默认值（meta.configSchema 的 default 摊平，供纯函数独立调用） */
const defaultsOf = () => Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default]));

/**
 * 分红再投（纯函数，无网络无时钟）—— design.md §4.4、interface.md §7.1
 *
 * 把除息日的现金分红按**除息价**折成底仓股数（整手），默认关闭（reinvest:false）：
 * 长期象限的目标是把成本压负，现金回收比再投更快见效。
 *
 * 除息来源双通道：优先 `bars.at(-1).dividendPerShare`（回测/合成数据自带），
 * 否则查 `dividends[]` 中 `exDate === bars.at(-1).date`（行情层日K不含分红，实盘走这条）。
 *
 * 价格口径：`bar.close`（**未复权**收盘价）。每股分红是未复权口径，用 adjClose 折算会把
 * 股数算歪（除息后前复权价被压低 → 多算股数 = 伪造成交），因此绝不混用。
 *
 * 整手 + 不赊账：qty 从 `floor(cash/price/100)*100` 起逐手递减，直到
 * `price*qty + tradeFee(buy) ≤ cash`（佣金有 5 元最低，费用买不起时就少买一手）；
 * 最终 < 1 手 → 不生成指令，返回 rejected（P6 诚实失败，绝不伪造成交）。
 *
 * @param {{bars:Array, position:{qty:number}|null, dividends?:Array, config?:object,
 *          fee?:object}} p
 * @returns {{enabled:boolean, exDate:string|null, dividendPerShare:number, shares:number,
 *            cashDividend:number, price:number|null, qty:number, fee:number,
 *            rejected:{rule:string, reason:string}|null}}
 */
export function reinvestPlan({ bars, position, dividends = [], config = {}, fee } = {}) {
  const cfg = { ...defaultsOf(), ...config };
  const enabled = cfg.reinvest === true; // 只有显式 true 才开，'false' 字符串不算
  const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
  const shares = Math.max(0, Math.round(Number(position?.qty) || 0));
  const idle = { enabled, exDate: null, dividendPerShare: 0, shares, cashDividend: 0, price: null, qty: 0, fee: 0, rejected: null };
  if (!enabled || !last) return idle;

  // 除息来源 1：最后一根 bar 自带每股分红
  let dps = Number(last.dividendPerShare) > 0 ? Number(last.dividendPerShare) : 0;
  let exDate = dps > 0 ? last.date ?? null : null;
  // 除息来源 2：分红历史上落在最后一根 bar 当天的实施方案
  if (!(dps > 0) && last.date && Array.isArray(dividends)) {
    const hit = dividends.find((d) => d && d.exDate === last.date && Number(d.cashPerShare) > 0);
    if (hit) {
      dps = Number(hit.cashPerShare);
      exDate = hit.exDate;
    }
  }
  if (!(dps > 0)) return idle; // 今天不是除息日：本来就没有再投，不是失败

  const cashDividend = round2(dps * shares);
  const base = { enabled, exDate, dividendPerShare: dps, shares, cashDividend, price: null, qty: 0, fee: 0, rejected: null };
  if (shares <= 0) {
    return {
      ...base,
      rejected: { rule: 'LONG.REINVEST_NO_POSITION', reason: `除息日 ${exDate} 无底仓持股（position.qty=${shares}）：无股份可分，不产生再投指令` },
    };
  }
  const px = Number(last.close); // 未复权收盘价 = 除息价，绝不取 adjClose
  if (!(px > 0)) {
    return {
      ...base,
      rejected: { rule: 'LONG.REINVEST_NO_PRICE', reason: '除息日缺少有效未复权收盘价（bar.close）：无法折算股数，不编造' },
    };
  }

  // 整手起始量 → 按"含费用买得起"逐手回退（佣金最低 5 元，费用会把最后一手吃掉）
  let qty = Math.floor(cashDividend / px / 100) * 100;
  let feeAmount = 0;
  while (qty >= 100) {
    feeAmount = tradeFee({ side: 'buy', price: px, qty, fee });
    if (round2(px * qty) + feeAmount <= cashDividend + 1e-9) break;
    qty -= 100;
  }
  if (qty < 100) {
    return {
      ...base,
      rejected: {
        rule: 'LONG.REINVEST_TOO_SMALL',
        reason: `现金分红 ${cashDividend} 元按除息价 ${px} 不足 1 手（含费用）：不生成再投指令，现金留在账上`,
      },
    };
  }
  return { ...base, price: round2(px), qty, fee: round2(feeAmount) };
}

/**
 * 网格参数生成（design.md §4.3）
 * 基准价 = median(近 baseWindow 收盘)；步长 = clamp(ATR20% × 1.2, stepMin, stepMax)
 */
export function gridPlan({ bars, budget, config = {} }) {
  const cfg = { ...Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default])), ...config };
  if (!Array.isArray(bars) || bars.length < cfg.baseWindow) {
    throw new Error(`ERR-DATA-002: 长期策略需要至少 ${cfg.baseWindow} 根 K 线`);
  }
  const closes = bars.map((b) => b.adjClose ?? b.close);
  const window = closes.slice(-cfg.baseWindow);
  const basePrice = Math.round(median(window) * 100) / 100;
  const ap = atrPct(bars, 20).filter((v) => v !== null);
  const lastAtrPct = ap.length ? ap[ap.length - 1] : 0.03;
  const stepPct = Math.min(cfg.stepMaxPct, Math.max(cfg.stepMinPct, lastAtrPct * 1.2));
  const floatBudget = budget * (1 - cfg.coreWeight);
  const qtyPerGrid = Math.floor(floatBudget / (cfg.gridLevels * 2) / basePrice / 100) * 100;

  const grids = [];
  for (let k = cfg.gridLevels; k >= 1; k--) {
    grids.push({ level: -k, side: 'buy', price: Math.round(basePrice * (1 - stepPct * k) * 100) / 100, qty: qtyPerGrid });
  }
  for (let k = 1; k <= cfg.gridLevels; k++) {
    grids.push({ level: k, side: 'sell', price: Math.round(basePrice * (1 + stepPct * k) * 100) / 100, qty: qtyPerGrid });
  }
  return {
    basePrice,
    stepPct: Math.round(stepPct * 10000) / 10000,
    gridLevels: cfg.gridLevels,
    qtyPerGrid,
    floatBudget: Math.round(floatBudget * 100) / 100,
    coreBudget: Math.round(budget * cfg.coreWeight * 100) / 100,
    grids,
    note: `基准价 ${basePrice}（${cfg.baseWindow} 日中位），步长 ${(stepPct * 100).toFixed(2)}%，每格 ${qtyPerGrid} 股；成交后基准价重置为成交价`,
  };
}

/**
 * 成本转负体检报告（招牌输出）
 * 年化摊薄率 ≈ 股息率 + 活动仓占比 × 网格年化毛收益 − 成本拖累
 */
export function dilutionReport({ bars, dividends = [], lots = [], price, config = {} }) {
  const cfg = { ...Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default])), ...config };
  const hc = holdingCost({ lots });
  const px = Number(price) || (bars.length ? bars[bars.length - 1].adjClose ?? bars[bars.length - 1].close : 0);
  // 近 5 年平均股息率（有分红史才给 ETA，否则诚实返回 null）
  const recent = dividends.filter((d) => Number(d.cashPerShare) > 0).slice(0, 5);
  const dividendYield = recent.length ? recent.reduce((a, d) => a + Number(d.cashPerShare), 0) / recent.length / px : 0;
  const floatWeight = 1 - cfg.coreWeight;
  const r = annualDilutionRate({
    dividendYield,
    floatWeight,
    gridAnnualGross: cfg.gridAnnualGross,
    costDrag: 0.005,
  });
  const eta = recent.length === 0
    ? null // 无分红史：诚实拒绝给出 ETA（design.md §4.4/§4.5）
    : costToNegativeEta({ costPerShare: hc.costPerShare ?? 0, price: px, annualDilutionRate: r });
  return {
    costPerShare: hc.costPerShare,
    price: px,
    negative: hc.negative,
    progress: hc.progress,
    dividendsReceived: hc.dividends,
    dividendYield: Math.round(dividendYield * 10000) / 10000,
    annualDilutionRate: r,
    etaYears: eta,
    // 分红再投会改变"已回收现金"的口径：如实回显，ETA 公式本身不为它打折
    reinvestEnabled: cfg.reinvest === true,
    note: [
      hc.costPerShare === null
        ? '当前无持仓，先建立底仓再谈摊薄'
        : hc.negative
          ? `成本已转负（${hc.costPerShare}）：任何价格卖出都是纯赚，保持网格纪律即可`
          : eta === null
            ? '缺少分红史或摊薄率不足，无法给出 ETA —— 诚实拒绝，不编造乐观数字'
            : `当前成本 ${hc.costPerShare}，现价 ${px}，年化摊薄 ${(r * 100).toFixed(1)}%，预计 ${eta} 年成本转负`,
      cfg.reinvest === true
        ? '已开启分红再投：分红变成股数、totalRecovered 不增，成本转负进度会慢于该 ETA（想更快拿回本金就关掉 reinvest）'
        : '',
    ].filter(Boolean).join('；'),
  };
}

/**
 * 统一 evaluate：根据当前价与网格位置生成次日指令
 * 触发规则（收盘确认、次日执行，P3）：
 *   前收 ≤ P0×(1−g×k) 且未持满 → 买 1 格；前收 ≥ P0×(1+g×k) 且活动仓>0 → 卖 1 格
 * 分红再投（config.reinvest 默认 false）：除息日把现金折成整手股数，同样次日执行；
 * 与网格买入同日触发时指令单同向去重（保留网格买入，再投留痕到 rejected）。
 */
export function evaluate({ bars, position, account, config = {}, symbol, dividends = [] }) {
  const cfg = { ...defaultsOf(), ...config };
  if (!Array.isArray(bars) || bars.length < cfg.baseWindow) {
    return { signals: [], plan: null, diagnostics: { error: `ERR-DATA-002: 需要至少 ${cfg.baseWindow} 根 K 线` } };
  }
  const last = bars[bars.length - 1];
  const px = last.adjClose ?? last.close;
  const budget = Number(account?.equity) || Number(account?.cash) || 0;
  const gp = gridPlan({ bars, budget: budget || 100000, config: cfg });
  const signals = [];
  const rejected = [];

  // 单边下跌熔断：现价低于最深买格 → 停止加仓（design.md §4.6）
  // 注意：grids 中买格按 level -N..-1 排列，最深层（最低价）在前
  const buyGrids = gp.grids.filter((g) => g.side === 'buy');
  const deepestBuy = buyGrids.at(0).price;
  const gridFull = px <= deepestBuy;
  if (gridFull) {
    rejected.push({ symbol, rule: 'LONG.GRID_FLOOR', reason: `现价 ${px.toFixed(3)} 已跌破最深买格 ${deepestBuy}，网格打满：只卖不买，转人工复核` });
  }

  if (px <= gp.basePrice * (1 - gp.stepPct) && !gridFull) {
    // 找到最深已触发的未成交买格（价格最低者优先摊薄）
    const hit = gp.grids.filter((g) => g.side === 'buy' && px <= g.price).at(0);
    if (hit) {
      signals.push({
        mode: 'long', symbol, action: 'buy', qty: hit.qty, price: hit.price,
        reason: `LONG.GRID_BUY L${hit.level}：现价 ${px} ≤ 网格买价 ${hit.price}`,
        rule: 'LONG.GRID_BUY', confidence: 0.9,
      });
    }
  } else if (px >= gp.basePrice * (1 + gp.stepPct) && Number(position?.qty) > 0) {
    const hit = gp.grids.filter((g) => g.side === 'sell' && px >= g.price).at(0);
    const sellable = Math.min(hit ? hit.qty : 0, Number(position.qty));
    if (hit && sellable >= 100) {
      signals.push({
        mode: 'long', symbol, action: 'sell', qty: sellable, price: hit.price,
        reason: `LONG.GRID_SELL L+${hit.level}：现价 ${px} ≥ 网格卖价 ${hit.price}`,
        rule: 'LONG.GRID_SELL', confidence: 0.9,
      });
    }
  }

  // 分红再投（默认关闭）：除息日现金 → 整手股数，信号次日执行（P3），不伪造成交
  const reinvest = reinvestPlan({ bars, position, dividends, config: cfg });
  if (reinvest.qty >= 100) {
    const deduped = signals.some((s) => s.action === 'buy');
    if (deduped) {
      // 指令单同标的同向去重（plan.js）：保留网格买入，再投必须留痕，绝不静默丢单
      rejected.push({
        symbol,
        rule: 'LONG.REINVEST_DEDUPED',
        reason: `除息再投 ${reinvest.qty} 股与网格买入同日同向：指令单去重保留网格买入，除息现金 ${reinvest.cashDividend} 元留账上（未下单，未伪造成交）`,
      });
    } else {
      signals.push({
        mode: 'long', symbol, action: 'buy', qty: reinvest.qty, price: reinvest.price,
        reason: `LONG.REINVEST：除息 ${reinvest.dividendPerShare}×${reinvest.shares} 股 = 现金 ${reinvest.cashDividend} 元，按除息价 ${reinvest.price} 折 ${reinvest.qty} 股整手（含费 ${reinvest.fee}）`,
        rule: 'LONG.REINVEST', confidence: 0.95,
      });
    }
  } else if (reinvest.rejected) {
    rejected.push({ symbol, rule: reinvest.rejected.rule, reason: reinvest.rejected.reason });
  }

  const footnotes = [gp.note];
  if (reinvest.enabled) {
    footnotes.push('分红再投已开启：除息现金折成整手股数（次日执行），totalRecovered 不增，成本转负慢于纯现金回收');
  }

  const plan = buildPlan({
    mode: 'long', asOf: last.date, tradingDay: null, signals, rejected,
    footnotes,
  });
  return { signals, plan, diagnostics: { grid: gp, gridFull, price: px, reinvest } };
}
