/**
 * kuibuequity — 风控闸门（纯函数）
 *
 * 设计依据：docs/design.md §4.6/§5.4/§6.5、docs/risk.md
 * 立场：风控是"事前写死的红线"，事中不可临时更改；硬红线连 override 都不接受。
 */

export const QUADRANTS = ['long', 'stable', 'short'];

export const RED_LINES = {
  long: {
    maxSymbolPct: 0.4, // 单票不超过长期账户 40%
    maxQuadrantPct: 0.7, // 长期象限不超过总资金 70%
  },
  stable: {
    riskPerTrade: 0.01, // 每笔最大亏损 = 账户 1%
    maxSymbolPct: 0.25,
    maxQuadrantPct: 0.3,
    maxConsecutiveLoss: 4, // 连亏 4 笔熔断
    weeklyDrawdownPct: 0.03, // 周回撤 >3% 熔断
    cooldownDays: 3, // 平仓后同标的 3 交易日冷静期
    minWinRate: 0.45, // 期望值自检线（盈亏比 1.25 → 要求 44.4%）
  },
  short: {
    maxSymbolPct: 0.2,
    maxQuadrantPct: 0.2,
    maxNewPerDay: 2, // 同日新开仓 ≤2 只
    minWinRate: 0.45,
    hardMaxHoldDays: 5, // 硬红线：5 日强制离场，不可 override
  },
};

/** 统一闸门：返回 { allowed:true } 或 { allowed:false, code, reason } */
export function gate({ mode, action, signal, account, stats, config }) {
  const lines = { ...RED_LINES[mode], ...(config || {}) };

  // 强制离场恒放行（硬红线优先于一切）
  if (action === 'force_exit' || action === 'stop_loss') return { allowed: true };

  if (action !== 'buy') return { allowed: true };

  // 1) 冷静期：平仓后 cooldownDays 内同标的禁止再入
  const cooldown = stats?.cooldownUntil?.[signal.symbol];
  if (cooldown && stats?.asOf && String(stats.asOf) <= String(cooldown)) {
    return {
      allowed: false,
      code: 'ERR-RISK-001',
      reason: `${signal.symbol} 处于冷静期（至 ${cooldown}），平仓后 ${lines.cooldownDays} 个交易日内不得再入`,
    };
  }

  // 2) 连亏熔断 / 周回撤熔断
  if (Number(stats?.consecutiveLosses) >= Number(lines.maxConsecutiveLoss)) {
    return {
      allowed: false,
      code: 'ERR-RISK-002',
      reason: `连续亏损 ${stats.consecutiveLosses} 笔 ≥ 熔断线 ${lines.maxConsecutiveLoss}，本象限暂停`,
    };
  }
  if (Number(stats?.weeklyDrawdown) >= Number(lines.weeklyDrawdownPct)) {
    return {
      allowed: false,
      code: 'ERR-RISK-002',
      reason: `本周回撤 ${(stats.weeklyDrawdown * 100).toFixed(2)}% ≥ ${(lines.weeklyDrawdownPct * 100).toFixed(0)}%，本象限暂停`,
    };
  }

  // 3) 单票仓位上限
  const equity = Number(account?.equity);
  const symbolValue = Number(account?.symbolValue?.[signal.symbol] ?? 0);
  if (equity > 0) {
    const buyValue = Number(signal.price) * Number(signal.qty);
    if ((symbolValue + buyValue) / equity > lines.maxSymbolPct + 1e-9) {
      return {
        allowed: false,
        code: 'ERR-RISK-003',
        reason: `买入后 ${signal.symbol} 占比将超过单票上限 ${(lines.maxSymbolPct * 100).toFixed(0)}%`,
      };
    }
  }

  // 4) 当日新开仓数上限（短线）
  if (lines.maxNewPerDay != null && Number(stats?.newOpensToday) >= lines.maxNewPerDay) {
    return {
      allowed: false,
      code: 'ERR-RISK-005',
      reason: `当日新开仓已达 ${lines.maxNewPerDay} 只上限`,
    };
  }

  // 5) 期望值自检：样本足够但胜率不达标 → 拒绝帮用户做数学上亏钱的事
  if (stats?.expectancy && stats.expectancy.verdict === 'NOT_RECOMMENDED') {
    return {
      allowed: false,
      code: 'ERR-RISK-006',
      reason: `期望值自检未通过：${stats.expectancy.note}`,
    };
  }

  return { allowed: true };
}

/**
 * 期望值自检（design.md §5.5）
 * requiredWinRate = 1 / (1 + payoffRatio)；样本 < 20 笔不得宣称有效。
 */
export function expectancyCheck({ trades, payoffRatio: pr }) {
  const list = Array.isArray(trades) ? trades : [];
  const n = list.length;
  if (n < 20) {
    return {
      winRate: null,
      payoffRatio: pr ?? null,
      requiredWinRate: pr ? 1 / (1 + pr) : null,
      expectancy: null,
      verdict: 'INSUFFICIENT_SAMPLE',
      note: `样本仅 ${n} 笔（<20），不足以判定该纪律是否正期望`,
    };
  }
  const wins = list.filter((t) => Number(t.pnl) > 0);
  const losses = list.filter((t) => Number(t.pnl) < 0);
  const wr = wins.length / n;
  const avgWin = wins.length ? wins.reduce((a, t) => a + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((a, t) => a + Number(t.pnl), 0) / losses.length)
    : 0;
  const payoff = pr ?? (avgLoss > 0 ? avgWin / avgLoss : null);
  const required = payoff ? 1 / (1 + payoff) : null;
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;
  const verdict =
    required !== null && (wr < required || expectancy <= 0) ? 'NOT_RECOMMENDED' : 'OK';
  return {
    winRate: Math.round(wr * 1000) / 1000,
    payoffRatio: payoff ? Math.round(payoff * 100) / 100 : null,
    requiredWinRate: required ? Math.round(required * 1000) / 1000 : null,
    expectancy: Math.round(expectancy * 100) / 100,
    verdict,
    note:
      verdict === 'NOT_RECOMMENDED'
        ? `近 ${n} 笔胜率 ${(wr * 100).toFixed(1)}% 低于盈亏比要求的 ${required ? (required * 100).toFixed(1) : '?'}%，当前该纪律为负期望，建议停用本象限`
        : `近 ${n} 笔胜率 ${(wr * 100).toFixed(1)}%，期望收益为正`,
  };
}

/**
 * 短线情绪总闸（design.md §6.3）：比任何个股打分优先。
 * 指数跌破 5 日线 / 昨日涨停平均溢价 < 0 / 炸板率 > 40% → 关闭
 */
export function sentimentGate({ indexAboveMa5, yesterdayLimitUpPremium, blowUpRate }) {
  const reasons = [];
  if (indexAboveMa5 === false) reasons.push('指数收盘跌破 5 日线');
  if (Number(yesterdayLimitUpPremium) < 0)
    reasons.push(`昨日涨停今日平均溢价 ${yesterdayLimitUpPremium}% < 0（亏钱效应）`);
  if (Number(blowUpRate) > 0.4)
    reasons.push(`炸板率 ${(blowUpRate * 100).toFixed(0)}% > 40%（情绪退潮）`);
  return {
    open: reasons.length === 0,
    reason: reasons.length ? reasons.join('；') : '情绪正常',
  };
}

/** 短线 5 日硬期限：唯一不可 override 的硬红线 */
export function hardExitCheck({ openDate, asOf, maxHoldDays = RED_LINES.short.hardMaxHoldDays }) {
  if (!openDate || !asOf) return { mustExit: false };
  const days = tradingDaysBetween(openDate, asOf);
  return {
    mustExit: days >= maxHoldDays,
    holdDays: days,
    remaining: Math.max(0, maxHoldDays - days),
    rule: 'SHORT.HARD_EXIT_5D',
    note: `短线持仓 ${days} 交易日${days >= maxHoldDays ? '，已达 5 日硬期限，收盘前无条件清仓（不可 override）' : `，剩余 ${maxHoldDays - days} 日`}`,
  };
}

/** 简易交易日计数（跳过周末；不含法定节假日，节假日按保守多算处理） */
export function tradingDaysBetween(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  if (!(a < b)) return 0;
  let n = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}
