/**
 * kuibuequity — 复盘统计（纯函数：无网络、无时钟、无 DSH 依赖）
 *
 * 契约依据：docs/interface.md §12（唯一事实源）、docs/risk.md §6.2、docs/design.md P5/P6/P7
 *
 * 为什么必须是纯函数：
 *   复盘输出"我有没有守纪律"的判决，判决用的时间点必须由调用方显式传入（asOf），
 *   否则同一份账本在不同时刻跑出不同的遵守率，事后无法对账。所以本模块不读 Date.now()。
 *
 * 两个核心口径（写死，测试手算对齐）：
 *   1) 纪律遵守率 = 1 − 期内 override 次数 / 期内有效锁定契约数；
 *      同一契约被改 3 次 = 3 次违反 / 1 次机会 → 夹到 0、capped=true、overrideRate 如实给 3。
 *      期内没有契约 → rate 为 null（"0 次违规"与"没有机会违规"不是一回事）。
 *   2) 短线超期未离场：holdDays = tradingDaysBetween(openDate, asOf)（真实交易日，见 calendar.js），
 *      mustExitNow = holdDays >= 5（与 risk.hardExitCheck 同口径），
 *      overdue 只在 holdDays > 5 时成立（第 5 日没走成才是违规）。
 *
 * 诚实失败（P6）：
 *   asOf 非法 → ERR-CALENDAR-001；period/quadrant 非法 → ERR-REVIEW-001；
 *   短线持仓 openDate 无法核验（缺失/非法/超出日历覆盖）→ ERR-CALENDAR-001，
 *   绝不把"无法核验 5 日硬期限"粉饰成一份看起来正常的复盘。
 */
import { tradingDayInfo, tradingDaysBetween, addTradingDays, CALENDAR_COVERAGE } from './calendar.js';
import { winRate, payoffRatio, maxDrawdown } from './indicators.js';

export const REVIEW_PERIODS = Object.freeze(['week', 'month', 'all']);
export const REVIEW_QUADRANTS = Object.freeze(['long', 'stable', 'short']);
/** 短线 5 日硬期限（不可 override，design.md §6.5） */
export const SHORT_HARD_MAX_HOLD_DAYS = 5;

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const round3 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 1000) / 1000 : null);

/** 统一错误构造：message 前缀 ERR-* 码，并挂 err.code（与 ledger/calendar 同风格） */
function reviewError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * 严格归一化日期：只接受真实存在的 YYYY-MM-DD（允许带时间，只取自然日）。
 * 溢出日/非法格式 → null（调用方必须显式处理，绝不靠 Date 自动进位）。
 */
function normalizeDate(value) {
  if (value == null || value === '') return null;
  const info = tradingDayInfo(value);
  return info ? info.date : null;
}

/** 纯日期加减（自然日）：'YYYY-MM-DD' ± n 天，不依赖时钟/时区 */
function shiftDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 纯日期加减（自然月）：月末夹取，绝不进位到下一月。
 * 例：2026-03-31 − 1 月 = 2026-02-28（不是 2026-03-03）；2026-01-15 − 1 月 = 2025-12-15。
 */
function shiftMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad2(tm + 1)}-${pad2(Math.min(d, lastDay))}`;
}

/** 周期起点：week = 前 7 自然日；month = 前 1 自然月（夹取月末）；all = null */
function periodStartOf(period, asOf) {
  if (period === 'all') return null;
  if (period === 'week') return shiftDays(asOf, -7);
  return shiftMonths(asOf, -1);
}

/** 契约归属象限：契约表用 quadrant，mode 兜底（mode 缺省时等于 quadrant） */
function contractQuadrant(c) {
  return c?.quadrant ?? c?.mode ?? null;
}

/**
 * 期内有效契约统计（纪律遵守率的分母与分子）。
 * 有效 = createdAt 落在期内；或 createdAt 在期前但期内有 override（说明当期它仍在被改）。
 */
function disciplineFor({ contracts, quadrant, inPeriod, warnings }) {
  const stat = {
    quadrant,
    contractsChecked: 0,
    overrideCount: 0,
    overriddenContracts: 0,
    cleanContracts: 0,
    disciplineRate: null,
    overrideRate: null,
    capped: false,
  };
  const overrideRows = [];

  for (const c of contracts) {
    if (quadrant !== 'all' && contractQuadrant(c) !== quadrant) continue;
    const overrides = Array.isArray(c.overrides) ? c.overrides : [];
    const inPeriodOverrides = overrides.filter((o) => inPeriod(o?.at));
    const created = normalizeDate(c.createdAt);

    // 缺/非法 createdAt 一律告警（数据不完整必须留痕，不能静默当作"守纪律"）
    if (!created) warnings.add('REVIEW.MISSING_DATE');
    // 无法判定归属且期内也没有 override → 不进统计（无从判定它在不在期内）
    if (!created && inPeriodOverrides.length === 0) continue;
    const createdInPeriod = c.createdAt == null ? true : inPeriod(c.createdAt);
    if (!createdInPeriod && inPeriodOverrides.length === 0) continue; // 期外旧契约，本期无关

    stat.contractsChecked += 1;
    stat.overrideCount += inPeriodOverrides.length;
    if (inPeriodOverrides.length > 0) stat.overriddenContracts += 1;
    for (const o of inPeriodOverrides) {
      overrideRows.push({
        contractId: c.id ?? null,
        quadrant: contractQuadrant(c),
        symbol: c.symbol ?? null,
        at: o.at ?? null,
        patch: o.patch ?? null,
        reason: o.reason ?? null,
      });
    }
  }

  stat.cleanContracts = stat.contractsChecked - stat.overriddenContracts;
  if (stat.contractsChecked > 0) {
    stat.overrideRate = round3(stat.overrideCount / stat.contractsChecked);
    const raw = 1 - stat.overrideCount / stat.contractsChecked;
    stat.disciplineRate = round3(Math.max(0, raw));
    if (stat.overrideCount > stat.contractsChecked) {
      stat.capped = true;
      warnings.add('REVIEW.OVERRIDE_EXCEEDS_CONTRACTS');
    }
  }
  return { stat, overrideRows };
}

/**
 * 短线超期未离场检测（唯一硬红线：5 交易日不可 override）。
 * @returns {{checked:number, count:number, items:object[], dueToday:object[]}}
 */
function shortOverdueFor({ positions, asOf }) {
  const list = Array.isArray(positions) ? positions : [];
  const shorts = list.filter((p) => p && p.quadrant === 'short' && Number(p.qty) > 0);
  const items = [];
  const dueToday = [];

  for (const p of shorts) {
    const openDate = normalizeDate(p.openDate);
    if (!openDate) {
      throw reviewError(
        'ERR-CALENDAR-001',
        `短线持仓 ${p.symbol} 的建仓日 ${JSON.stringify(p.openDate)} 缺失或非法，无法核验 5 日硬期限`,
      );
    }
    let holdDays;
    let dueDate;
    try {
      holdDays = tradingDaysBetween(openDate, asOf);
      dueDate = addTradingDays(openDate, SHORT_HARD_MAX_HOLD_DAYS);
    } catch (e) {
      const msg = String((e && e.message) || e).replace(/^ERR-CALENDAR-001:\s*/, '');
      throw reviewError(
        'ERR-CALENDAR-001',
        `短线持仓 ${p.symbol}（建仓 ${openDate}）无法核验 5 日硬期限：${msg}（日历覆盖 ${CALENDAR_COVERAGE.from}~${CALENDAR_COVERAGE.to}）`,
      );
    }

    const mustExitNow = holdDays >= SHORT_HARD_MAX_HOLD_DAYS;
    if (!mustExitNow) continue; // 还没到期，不进清单
    const row = {
      quadrant: 'short',
      symbol: p.symbol ?? null,
      qty: Number(p.qty),
      openDate,
      holdDays,
      dueDate,
      overdueDays: Math.max(0, holdDays - SHORT_HARD_MAX_HOLD_DAYS),
      mustExitNow: true,
      note:
        holdDays > SHORT_HARD_MAX_HOLD_DAYS
          ? `已持有 ${holdDays} 个交易日，超期 ${holdDays - SHORT_HARD_MAX_HOLD_DAYS} 日（应于 ${dueDate} 收盘前离场，不可 override）`
          : `已持有 ${holdDays} 个交易日，达 5 日硬期限，今日收盘前无条件清仓（不可 override）`,
    };
    if (holdDays > SHORT_HARD_MAX_HOLD_DAYS) items.push(row);
    else dueToday.push(row);
  }

  items.sort((a, b) => b.overdueDays - a.overdueDays || String(a.symbol).localeCompare(String(b.symbol)));
  dueToday.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  return { checked: shorts.length, count: items.length, items, dueToday };
}

/**
 * 复盘报告（纯函数）
 * @param {{trades?:object[], contracts?:object[], positions?:object[],
 *          period?:'week'|'month'|'all', quadrant?:'long'|'stable'|'short', asOf:string}} p
 * @returns 契约见 docs/interface.md §12
 */
export function reviewReport({ trades, contracts, positions, period = 'week', quadrant, asOf } = {}) {
  const p = period == null || period === '' ? 'week' : String(period);
  if (!REVIEW_PERIODS.includes(p)) {
    throw reviewError('ERR-REVIEW-001', `未知复盘周期 ${JSON.stringify(period)}，只能是 ${REVIEW_PERIODS.join('/')}`);
  }
  const q = quadrant == null || quadrant === '' ? 'all' : String(quadrant);
  if (q !== 'all' && !REVIEW_QUADRANTS.includes(q)) {
    throw reviewError('ERR-REVIEW-001', `未知象限 ${JSON.stringify(quadrant)}，只能是 ${REVIEW_QUADRANTS.join('/')}`);
  }
  const asOfDate = normalizeDate(asOf);
  if (!asOfDate) {
    throw reviewError('ERR-CALENDAR-001', `复盘 asOf 非法：${JSON.stringify(asOf)}（要求真实存在的 YYYY-MM-DD）`);
  }

  const periodStart = periodStartOf(p, asOfDate);
  const warnings = new Set();

  // 期归属：缺日期 → 计入 + warning（不静默丢弃）；晚于 asOf → 排除 + warning（未来数据不进本期）
  const inPeriod = (rawDate) => {
    const d = normalizeDate(rawDate);
    if (!d) {
      warnings.add('REVIEW.MISSING_DATE');
      return true;
    }
    if (d > asOfDate) {
      warnings.add('REVIEW.RECORD_AFTER_ASOF');
      return false;
    }
    return periodStart === null || d >= periodStart;
  };

  const tradeList = (Array.isArray(trades) ? trades : []).filter(
    (t) => !q || q === 'all' || t?.quadrant === q,
  );
  const inPeriodTrades = tradeList.filter((t) => inPeriod(t?.date));
  const closed = inPeriodTrades.filter((t) => Number.isFinite(Number(t?.pnl)) && t.pnl !== null);
  const pnlSeries = closed.map((t) => Number(t.pnl));

  const contractList = Array.isArray(contracts) ? contracts : [];
  const scopeQuadrants = q === 'all' ? REVIEW_QUADRANTS : [q];
  const byQuadrant = {};
  const overrideRows = [];
  for (const qd of scopeQuadrants) {
    const { stat, overrideRows: rows } = disciplineFor({
      contracts: contractList,
      quadrant: qd,
      inPeriod,
      warnings,
    });
    byQuadrant[qd] = stat;
    overrideRows.push(...rows);
  }

  const totals = scopeQuadrants.reduce(
    (acc, qd) => {
      const s = byQuadrant[qd];
      acc.contractsChecked += s.contractsChecked;
      acc.overrideCount += s.overrideCount;
      acc.overriddenContracts += s.overriddenContracts;
      return acc;
    },
    { contractsChecked: 0, overrideCount: 0, overriddenContracts: 0 },
  );
  const overall = {
    quadrant: q,
    contractsChecked: totals.contractsChecked,
    overrideCount: totals.overrideCount,
    overriddenContracts: totals.overriddenContracts,
    cleanContracts: totals.contractsChecked - totals.overriddenContracts,
    disciplineRate: null,
    overrideRate: null,
    capped: false,
  };
  if (overall.contractsChecked > 0) {
    overall.overrideRate = round3(overall.overrideCount / overall.contractsChecked);
    overall.disciplineRate = round3(Math.max(0, 1 - overall.overrideCount / overall.contractsChecked));
    if (overall.overrideCount > overall.contractsChecked) {
      overall.capped = true;
      warnings.add('REVIEW.OVERRIDE_EXCEEDS_CONTRACTS');
    }
  }

  const shortOverdue = shortOverdueFor({ positions, asOf: asOfDate });

  overrideRows.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));

  const rateText = (s) => (s.disciplineRate == null ? '无契约（不评）' : `${(s.disciplineRate * 100).toFixed(1)}%`);
  const parts = [
    `期内契约 ${overall.contractsChecked} 份，override ${overall.overrideCount} 次，纪律遵守率 ${rateText(overall)}`,
  ];
  if (q === 'all') {
    parts.push(
      REVIEW_QUADRANTS.map((qd) => `${qd} ${rateText(byQuadrant[qd])}`).join(' / '),
    );
  }
  if (shortOverdue.count > 0) {
    parts.push(`短线超期未离场 ${shortOverdue.count} 只（>${SHORT_HARD_MAX_HOLD_DAYS} 交易日，硬红线）`);
  } else if (shortOverdue.dueToday.length > 0) {
    parts.push(`短线今日到期 ${shortOverdue.dueToday.length} 只（收盘前必须清仓）`);
  } else {
    parts.push('短线无超期持仓');
  }
  if (overall.capped) parts.push('override 次数超过契约数，遵守率按 0 计（逐条核对理由）');

  return {
    period: p,
    periodStart,
    periodEnd: asOfDate,
    asOf: asOfDate,
    asOfKind: 'reviewedAt',
    quadrant: q,
    trades: inPeriodTrades.length,
    winRate: winRate(closed),
    payoffRatio: payoffRatio(closed),
    maxDrawdown: pnlSeries.length ? maxDrawdown(pnlSeries) : null,
    overrides: overrideRows,
    discipline: { overall, byQuadrant },
    shortOverdue,
    warnings: [...warnings].sort(),
    disciplineNote: parts.join('；'),
  };
}
