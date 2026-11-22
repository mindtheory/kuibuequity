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
