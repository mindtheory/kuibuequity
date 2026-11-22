/**
 * kuibuequity — 长期象限：股息网格 · 成本转负引擎
 *
 * 设计依据：docs/design.md §4
 * 目标函数：不是"涨多少"，而是把有效持仓成本压到 0 以下。
 * 双仓结构：底仓 core（只买不卖）+ 活动仓 float（网格高抛低吸摊薄）。
 */
import { atrPct } from '../indicators.js';
import { holdingCost, costToNegativeEta, annualDilutionRate } from '../costs.js';
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
    note:
      hc.costPerShare === null
        ? '当前无持仓，先建立底仓再谈摊薄'
        : hc.negative
          ? `成本已转负（${hc.costPerShare}）：任何价格卖出都是纯赚，保持网格纪律即可`
          : eta === null
            ? '缺少分红史或摊薄率不足，无法给出 ETA —— 诚实拒绝，不编造乐观数字'
            : `当前成本 ${hc.costPerShare}，现价 ${px}，年化摊薄 ${(r * 100).toFixed(1)}%，预计 ${eta} 年成本转负`,
  };
}

/**
 * 统一 evaluate：根据当前价与网格位置生成次日指令
 * 触发规则（收盘确认、次日执行，P3）：
 *   前收 ≤ P0×(1−g×k) 且未持满 → 买 1 格；前收 ≥ P0×(1+g×k) 且活动仓>0 → 卖 1 格
 */
export function evaluate({ bars, position, account, config = {}, symbol }) {
  const cfg = { ...Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default])), ...config };
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

  const plan = buildPlan({
    mode: 'long', asOf: last.date, tradingDay: null, signals, rejected,
    footnotes: [gp.note],
  });
  return { signals, plan, diagnostics: { grid: gp, gridFull, price: px } };
}
