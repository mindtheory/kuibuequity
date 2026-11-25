/**
 * kuibuequity — 指令单（OrderPlan）构造与校验
 *
 * 设计依据：docs/design.md §3.2、docs/interface.md §6
 * 立场：插件只产出"指令单"，由人（或券商条件单）执行；被风控挡下的必须留痕。
 */

/** 固定免责脚注（P7：每个输出带 as_of 与非投资建议） */
export const DISCLAIMER = '本指令单由规则自动生成，不构成投资建议；历史回测不代表未来表现，交易风险自负。';

/** 整手取整：买入向下取整到 lot 的整数倍 */
export function roundToLot(qty, lot = 100) {
  return Math.floor(qty / lot) * lot;
}

/** 卖出族动作：这些信号在指令单里都渲染为「卖出」 */
const SELL_ACTIONS = new Set(['sell', 'take_profit', 'stop_loss', 'time_exit', 'force_exit']);

/**
 * 构造指令单：整手取整、同标的同向去重、被拒信号留痕、追加固定脚注。
 * @returns {object} OrderPlan（见 interface.md §3.2）
 */
export function buildPlan({ mode, asOf, tradingDay, signals = [], rejected = [], footnotes = [] }) {
  const orders = [];
  const dropped = [];
  const seen = new Set();

  for (const s of signals) {
    if (!s) continue;
    const isBuy = s.action === 'buy';
    if (!isBuy && !SELL_ACTIONS.has(s.action)) continue;
    const key = `${s.symbol}:${isBuy ? 'buy' : 'sell'}`;
    if (seen.has(key)) continue; // 同标的同向去重（保留先出现的，即优先级最高的）
    seen.add(key);

    const qty = roundToLot(Number(s.qty) || 0, s.lot || 100);
    if (isBuy && qty <= 0) {
      dropped.push({ symbol: s.symbol, rule: 'PLAN.LOT_MIN', reason: '买入数量不足 1 手（100 股），无法生成指令' });
      continue;
    }
    if (!isBuy && (Number(s.qty) || 0) <= 0) continue;

    orders.push({
      symbol: s.symbol,
      name: s.name || '',
      side: isBuy ? 'buy' : 'sell',
      qty: isBuy ? qty : Number(s.qty),
      price: Number(s.price) || null,
      priceType: Number(s.price) > 0 ? 'limit' : 'market',
      condition: s.condition ?? null,
      note: s.reason || '',
      rule: s.rule || '',
    });
  }

  return {
    planId: `plan-${mode}-${String(tradingDay || asOf || '').replace(/-/g, '')}`,
    mode,
    asOf: asOf || new Date().toISOString(),
    tradingDay: tradingDay || null,
    orders,
    rejected: [...rejected, ...dropped],
    footnotes: [
      `数据时点 as_of=${asOf || '未知'}`,
      ...footnotes,
      DISCLAIMER,
    ],
  };
}

/**
 * 导出券商条件单参数（L1 自动化落点）：
 * 人一次性把止盈/止损条件单挂到券商，盘中不再需要决策。
 */
export function toConditionOrders(plan) {
  const out = [];
  for (const o of plan.orders || []) {
    if (!o.condition) continue;
    out.push({
      symbol: o.symbol,
      side: o.side,
      triggerPrice: o.condition.triggerPrice ?? null,
      orderPrice: o.price ?? null,
      qty: o.qty,
      validUntil: o.condition.validUntil || plan.tradingDay || null,
      priceType: o.priceType,
      note: o.note,
    });
  }
  return out;
}

/** 条件单 CSV 表头（券商导入格式：触发价/委托价/数量/有效期） */
export const CONDITION_ORDER_CSV_HEADER = ['symbol', 'side', 'triggerPrice', 'orderPrice', 'qty', 'validUntil'];

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * 纯函数：日期 + n 个交易日（只跳周末）。非法日期/非法 n → null，绝不编造日期。
 * 法定节假日未纳入（与 risk.tradingDaysBetween 同口径，待 P2 交易日历任务统一修正）。
 */
function addTradingDays(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) return null;
  const days = Number(n);
  if (!Number.isInteger(days) || days < 1) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, da));
  // 2026-02-30 之类溢出日期必须拒绝（Date 会自动进位，不能用它冒充真日期）
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * 已锁定契约 + 当前持仓 → 条件单参数（纯函数，无网络无时钟）。
 *
 * 口径与 stable.checkPosition 的 conditionOrders **完全一致**：
 *   triggerPrice(take_profit) = round2(entry.price × (1 + takeProfitPct))
 *   triggerPrice(stop_loss)   = round2(entry.price × (1 + stopLossPct))
 *   orderPrice = triggerPrice（到价即限价挂出），qty = 当前持仓股数
 *   validUntil = entry.date + maxHoldDays 个交易日（只跳周末）
 *
 * 诚实失败：持仓无锁定契约 / 契约缺 entry.price 或 t/s → 只进 warnings，不导出伪条件单。
 */
export function conditionOrdersFromContracts({ contracts, positions } = {}) {
  if (!Array.isArray(contracts) || !Array.isArray(positions)) {
    throw new Error('ERR-EXPORT-001: contracts 与 positions 必须是数组');
  }
  const byId = new Map();
  const latestBySymbol = new Map();
  for (const c of contracts) {
    if (!c || !c.symbol) continue;
    if (c.id != null) byId.set(c.id, c);
    const prev = latestBySymbol.get(c.symbol);
    if (!prev || String(c.createdAt ?? '').localeCompare(String(prev.createdAt ?? '')) >= 0) {
      latestBySymbol.set(c.symbol, c);
    }
  }

  const orders = [];
  const warnings = [];
  const seen = new Set();
  for (const p of positions) {
    if (!p || !p.symbol || seen.has(p.symbol)) continue; // 同一标的只导出一次
    const qty = Number(p.qty);
    if (!(qty > 0)) continue; // 已清仓不导出
    seen.add(p.symbol);

    const contract = (p.contractId != null ? byId.get(p.contractId) : null) || latestBySymbol.get(p.symbol) || null;
    if (!contract) {
      warnings.push({ symbol: p.symbol, code: 'STABLE.NO_CONTRACT', message: '该持仓无锁定契约：先用 kb_stable action=contract 补建，不导出伪条件单' });
      continue;
    }
    // null/undefined 必须视为缺失（Number(null)=0 会冒充合法比例，绝不允许）
    const entryPrice = contract.entry?.price == null ? NaN : Number(contract.entry.price);
    const t = contract.takeProfitPct == null ? NaN : Number(contract.takeProfitPct);
    const s = contract.stopLossPct == null ? NaN : Number(contract.stopLossPct);
    if (!(entryPrice > 0) || !Number.isFinite(t) || !Number.isFinite(s)) {
      warnings.push({ symbol: p.symbol, code: 'STABLE.CONTRACT_INCOMPLETE', message: '契约缺 entry.price 或止盈/止损比例，无法计算触发价' });
      continue;
    }
    const validUntil = addTradingDays(contract.entry?.date, contract.maxHoldDays);
    const base = { symbol: p.symbol, side: 'sell', qty, validUntil, priceType: 'limit' };
    const tp = round2(entryPrice * (1 + t));
    const sl = round2(entryPrice * (1 + s));
    orders.push({ ...base, type: 'take_profit', triggerPrice: tp, orderPrice: tp });
    orders.push({ ...base, type: 'stop_loss', triggerPrice: sl, orderPrice: sl });
  }
  return { orders, warnings };
}

/** RFC4180 单元格：null/undefined → 空；含逗号/引号/换行 → 双引号包裹并转义内部引号 */
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 券商条件单导入 CSV（纯函数）：固定表头 + CRLF 行尾 + 默认 UTF-8 BOM（Excel 直接可读）。
 * 行内字段缺失写空单元格，绝不写 "null"/"NaN" 字符串。
 */
export function renderConditionOrdersCsv(orders, { bom = true } = {}) {
  if (!Array.isArray(orders)) throw new Error('ERR-EXPORT-001: orders 必须是数组');
  const lines = [CONDITION_ORDER_CSV_HEADER.join(',')];
  for (const o of orders) {
    lines.push(CONDITION_ORDER_CSV_HEADER.map((k) => csvCell(o?.[k])).join(','));
  }
  return `${bom ? '\ufeff' : ''}${lines.join('\r\n')}\r\n`;
}

/** 人类可读渲染（模型可直接转述给用户） */
export function renderPlanText(plan) {
  const lines = [];
  lines.push(`【${plan.mode} 指令单】生效交易日：${plan.tradingDay || '次日'}　as_of=${plan.asOf}`);
  if (!plan.orders.length) {
    lines.push('今日无指令（空仓等待或条件未触发）。');
  } else {
    lines.push('序号 | 标的 | 方向 | 数量(股) | 委托价 | 类型 | 依据');
    plan.orders.forEach((o, i) => {
      lines.push(
        `${i + 1} | ${o.symbol}${o.name ? ' ' + o.name : ''} | ${o.side === 'buy' ? '买入' : '卖出'} | ${o.qty} | ${o.price ?? '市价'} | ${o.priceType} | ${o.note}`,
      );
    });
  }
  if (plan.rejected.length) {
    lines.push('— 以下被挡下（必须留痕）—');
    for (const r of plan.rejected) lines.push(`· ${r.symbol || '-'} [${r.rule}] ${r.reason}`);
  }
  for (const f of plan.footnotes) lines.push(`※ ${f}`);
  return lines.join('\n');
}
