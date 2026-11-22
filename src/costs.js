/**
 * kuibuequity — 成本与持仓成本核算（纯函数，全系统唯一口径）
 *
 * 设计依据：docs/cost-model.md、docs/interface.md §1
 * 原则 P4：佣金/印花税/过户费/滑点只在本文件定义一次，其余模块一律引用。
 */

/** A 股默认费率（2026 口径，实际以券商为准） */
export const DEFAULT_FEE = {
  commissionRate: 0.00025, // 佣金 万2.5
  commissionMin: 5, // 单笔最低佣金（元）
  stampTaxRate: 0.0005, // 印花税，仅卖出
  transferRate: 0.00001, // 过户费 万0.1，双向
  slippageBps: 0, // 滑点（基点），仅回测/模拟使用
};

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;

/** 合并用户费率覆盖：只接受有限数值，undefined/null/NaN 一律回落默认值 */
export function resolveFee(overrides = {}) {
  const out = { ...DEFAULT_FEE };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in DEFAULT_FEE)) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * 单笔交易费用（佣金 + 印花税(卖出) + 过户费）
 * @param {{side:'buy'|'sell', price:number, qty:number, fee?:object}} p
 * @returns {number} 元，2 位小数
 */
export function tradeFee({ side, price, qty, fee }) {
  if (side !== 'buy' && side !== 'sell') throw new Error('ERR-COST-001: side 必须是 buy/sell');
  if (!(price > 0) || !(qty > 0)) throw new Error('ERR-COST-002: price/qty 必须为正数');
  const f = resolveFee(fee);
  const amount = price * qty;
  const commission = Math.max(amount * f.commissionRate, f.commissionMin);
  const stamp = side === 'sell' ? amount * f.stampTaxRate : 0;
  const transfer = amount * f.transferRate;
  return round2(commission + stamp + transfer);
}

/** 含滑点的成交价：买入上浮、卖出下调 */
export function applySlippage({ price, side, slippageBps = 0 }) {
  if (!(price > 0)) throw new Error('ERR-COST-002: price 必须为正数');
  const bps = Number(slippageBps) || 0;
  const factor = side === 'buy' ? 1 + bps / 10000 : 1 - bps / 10000;
  return round3(price * factor);
}

/**
 * 有效持仓成本 —— 本插件核心口径。
 *
 *   totalIn        = Σ 买入金额 + Σ 买入费用
 *   totalRecovered = Σ 卖出金额 − Σ 卖出费用 + Σ 现金分红
 *   costPerShare   = (totalIn − totalRecovered) / shares
 *   negative       = costPerShare <= 0   （成本已转负：任何价格卖出都是纯赚）
 *
 * @param {Array<{side:'buy'|'sell', price:number, qty:number, fee?:number,
 *                dividend?:number}>} lots  dividend = 每股现金分红（按当时持股数折算，见 cost-model.md）
 * @param {{includeDividend?:boolean}} [opts]
 * @returns {{shares:number, costPerShare:number|null, totalIn:number,
 *            totalRecovered:number, dividends:number, negative:boolean,
 *            progress:number, avgEntryPrice:number|null}}
 */
export function holdingCost({ lots, opts = {} }) {
  const includeDividend = opts.includeDividend !== false;
  if (!Array.isArray(lots)) throw new Error('ERR-COST-003: lots 必须是数组');

  let shares = 0;
  let totalIn = 0;
  let totalRecovered = 0;
  let dividends = 0;
  let entryAmount = 0; // 建仓加权均价用（毛买入金额）
  let entryShares = 0;

  for (const lot of lots) {
    if (!lot || (lot.side !== 'buy' && lot.side !== 'sell')) {
      throw new Error('ERR-COST-004: lots 中存在非法 side');
    }
    const price = Number(lot.price);
    const qty = Number(lot.qty);
    if (!(price > 0) || !(qty > 0)) throw new Error('ERR-COST-002: price/qty 必须为正数');
    const fee = Number(lot.fee) || 0;
    const amount = price * qty;

    if (lot.side === 'buy') {
      totalIn += amount + fee;
      entryAmount += amount;
      entryShares += qty;
      shares += qty;
    } else {
      totalRecovered += amount - fee;
      shares -= qty;
      if (shares < -1e-9) throw new Error('ERR-COST-005: 卖出数量超过持股（流水不闭合）');
    }

    // 分红按"除息日当时持股数"入账：lot.dividend 为每股金额
    if (includeDividend && Number(lot.dividend) > 0) {
      dividends += Number(lot.dividend) * shares;
    }
  }
  if (includeDividend) totalRecovered += dividends;

  shares = Math.max(0, Math.round(shares));
  const avgEntryPrice = entryShares > 0 ? round3(entryAmount / entryShares) : null;
  const costPerShare = shares > 0 ? round3((totalIn - totalRecovered) / shares) : null;
  const progress =
    costPerShare === null || avgEntryPrice === null || avgEntryPrice <= 0
      ? 0
      : Math.min(1, Math.max(0, 1 - costPerShare / avgEntryPrice));

  return {
    shares,
    costPerShare,
    totalIn: round2(totalIn),
    totalRecovered: round2(totalRecovered),
    dividends: round2(dividends),
    negative: costPerShare !== null && costPerShare <= 0,
    progress,
    avgEntryPrice,
  };
}

/**
 * 成本转负 ETA（年）：现价不变时，靠分红 + 网格摊薄把 costPerShare 压到 0 所需年数。
 * 模型：costPerShare × (1 − r)^n ≤ 0 的近似线性解 —— 采用几何摊薄口径：
 *   n = ln(1 − costPerShare/price·0) / ln(1 + r) 在 costPerShare>0 时退化为
 *   n = costPerShare / (price × r)（每年按现价的 r 比例回收现金）
 * @returns {number|null} 摊薄率 <=0 或参数非法返回 null（诚实失败，P6）
 */
export function costToNegativeEta({ costPerShare, price, annualDilutionRate }) {
  const c = Number(costPerShare);
  const p = Number(price);
  const r = Number(annualDilutionRate);
  if (!(p > 0) || !Number.isFinite(c)) return null;
  if (c <= 0) return 0; // 已转负
  if (!(r > 0)) return null; // 无摊薄来源：诚实拒绝给出 ETA
  const years = c / (p * r);
  return Math.round(years * 100) / 100;
}

/**
 * 年化摊薄率 ≈ 股息率 + 活动仓占比 × 网格年化毛收益 − 成本拖累
 * @returns {number} 小数；<=0 时原样返回（由 ETA 负责拒绝）
 */
export function annualDilutionRate({ dividendYield, floatWeight, gridAnnualGross, costDrag = 0 }) {
  const d = Number(dividendYield) || 0;
  const w = Number(floatWeight) || 0;
  const g = Number(gridAnnualGross) || 0;
  const drag = Number(costDrag) || 0;
  return Math.round((d + w * g - drag) * 10000) / 10000;
}
