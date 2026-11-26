/**
 * kuibuequity — A 股交易日历（纯函数：无网络、无时钟、无 DSH 依赖）
 *
 * 设计依据：docs/interface.md §11（契约唯一事实源）、docs/risk.md §3.4、design.md P2/P6
 *
 * 为什么需要它：
 *   短线 5 日硬期限、稳定象限时间止损、条件单有效期都按**交易日**计数。只跳周末会把
 *   春节/国庆整段法定假期算成交易日 —— 硬红线会提前一天砍仓、时间止损会提前触发、
 *   条件单有效期会提前到期（该挂到真期限的止损单提前失效）。所以计数必须走真实日历。
 *
 * 数据口径：
 *   交易日 = 周一~周五 且 不在 HOLIDAYS（法定节假日落在工作日的那几天）
 *            且 不在 EXCHANGE_EXTRA_CLOSED（交易所额外休市，如 2024 除夕）
 *   注意：春节/国庆的**周末调休上班日** A 股并不开市，因此不补成交易日。
 *
 * 诚实失败（P6）：
 *   超出 CALENDAR_COVERAGE 的日期**不**回退到"只跳周末"近似，一律抛 ERR-CALENDAR-001，
 *   逼维护者更新年度表，而不是交出一个看起来能用、实际偏一天的计数。
 */

export const CALENDAR_VERSION = '2026.11';

/** 内置年度表覆盖范围（含端点）。扩表时必须同步 CALENDAR_VERSION 与测试用例。 */
export const CALENDAR_COVERAGE = Object.freeze({
  from: '2024-01-01',
  to: '2027-12-31',
  years: Object.freeze([2024, 2025, 2026, 2027]),
});

/**
 * 各年**落在周一~周五**的法定节假日（升序）。
 * 周末天然非交易日，不重复入表；表内只放"工作日但休市"的日期。
 */
export const HOLIDAYS = Object.freeze({
  // 2024：春节 2/10–2/17（除夕 2/9 见 EXCHANGE_EXTRA_CLOSED）、清明 4/4–4/6、
  //       劳动 5/1–5/5、端午 6/8–6/10、中秋 9/15–9/17、国庆 10/1–10/7
  2024: Object.freeze([
    '2024-01-01',
    '2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16',
    '2024-04-04', '2024-04-05',
    '2024-05-01', '2024-05-02', '2024-05-03',
    '2024-06-10',
    '2024-09-16', '2024-09-17',
    '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-07',
  ]),
  // 2025：元旦 1/1、春节 1/28–2/4、清明 4/4、劳动 5/1–5/5、端午 5/31–6/2、国庆+中秋 10/1–10/8
  2025: Object.freeze([
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
    '2025-04-04',
    '2025-05-01', '2025-05-02', '2025-05-05',
    '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  ]),
  // 2026：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动 5/1–5/5、
  //       端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7
  2026: Object.freeze([
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
  // 2027：元旦 1/1–1/3、春节 2/5–2/13、清明 4/3–4/5、劳动 5/1–5/5、
  //       端午 6/9、中秋 9/15、国庆 10/1–10/7
  2027: Object.freeze([
    '2027-01-01',
    '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
    '2027-04-05',
    '2027-05-03', '2027-05-04', '2027-05-05',
    '2027-06-09',
    '2027-09-15',
    '2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
  ]),
});

/**
 * 交易所额外休市：A 股当日休市，但国务院当年未把该日列入法定假日。
 * 2024 除夕（2/9 周五）→ 沪深北交易所休市，国务院 2024 通知未含此日（2025 起除夕才入法定假日）。
 */
export const EXCHANGE_EXTRA_CLOSED = Object.freeze({
  2024: Object.freeze(['2024-02-09']),
});

/** 各年度表的来源（可追溯；URL 为发布页） */
export const HOLIDAY_SOURCES = Object.freeze({
  2024: Object.freeze({ publishedAt: '2023-10-25', note: '国务院办公厅 2024 年部分节假日安排通知；除夕休市按沪深北交易所公告' }),
  2025: Object.freeze({ publishedAt: '2024-11-12', note: '国务院办公厅 2025 年部分节假日安排通知' }),
  2026: Object.freeze({
    publishedAt: '2025-11-04',
    notice: '国办发明电〔2025〕7号',
    url: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
  }),
  2027: Object.freeze({
    publishedAt: '2026-11-05',
    notice: '国办发明电〔2026〕10号',
    url: 'https://www.gov.cn/gongbao/2026/issue_13106/202611/content_7086651.html',
  }),
});

const DAY_MS = 86400000;

const holidaySets = new Map();
const extraSets = new Map();

function setOf(bucket, year) {
  const cache = bucket === 'holiday' ? holidaySets : extraSets;
  if (!cache.has(year)) {
    const list = (bucket === 'holiday' ? HOLIDAYS[year] : EXCHANGE_EXTRA_CLOSED[year]) || [];
    cache.set(year, new Set(list));
  }
  return cache.get(year);
}

function isCoveredYear(year) {
  return CALENDAR_COVERAGE.years.includes(year);
}

function uncoveredMessage(dateText) {
  return (
    `ERR-CALENDAR-001: 日期 ${dateText} 超出内置交易日历覆盖范围 ` +
    `${CALENDAR_COVERAGE.from}~${CALENDAR_COVERAGE.to}（年度表 ${CALENDAR_VERSION}）；` +
    '请更新 src/calendar.js 的 HOLIDAYS/EXCHANGE_EXTRA_CLOSED 与 CALENDAR_COVERAGE（并补测试）后再用'
  );
}

/** 严格解析 YYYY-MM-DD（允许 ISO 时间戳，只取前 10 位）；溢出日与非法格式 → null */
function parseDate(value) {
  if (value == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  // 2026-02-30 之类溢出日会被 Date 自动进位，必须回比三项才算真日期
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return { year, month, day, epochDay: dt.getTime() / DAY_MS, dow: dt.getUTCDay() };
}

function epochToKey(epochDay) {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

function isTradingEpoch(epochDay) {
  const dt = new Date(epochDay * DAY_MS);
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) return false; // 周末（含调休上班日，A 股也不开市）
  const year = dt.getUTCFullYear();
  if (!isCoveredYear(year)) throw new Error(uncoveredMessage(epochToKey(epochDay)));
  const key = epochToKey(epochDay);
  if (setOf('holiday', year).has(key)) return false;
  if (setOf('extra', year).has(key)) return false;
  return true;
}

/**
 * 单个自然日的日历信息（探针，不抛错）：非法/不可解析日期 → null。
 * covered=false 时 trading=null（未知），调用方必须显式处理，不得把未知当成可交易或不可交易。
 */
export function tradingDayInfo(date) {
  const p = parseDate(date);
  if (!p) return null;
  const covered = isCoveredYear(p.year);
  const weekend = p.dow === 0 || p.dow === 6;
  const key = epochToKey(p.epochDay);
  const holiday = covered ? setOf('holiday', p.year).has(key) || setOf('extra', p.year).has(key) : false;
  return {
    date: key,
    covered,
    weekend,
    holiday,
    trading: covered ? !weekend && !holiday : null,
  };
}

/** 是否交易日：非法日期或超出覆盖范围 → 抛 ERR-CALENDAR-001（不猜） */
export function isTradingDay(date) {
  const p = parseDate(date);
  if (!p) throw new Error(`ERR-CALENDAR-001: 无法解析日期 ${String(date)}（要求真实存在的 YYYY-MM-DD）`);
  if (!isCoveredYear(p.year)) throw new Error(uncoveredMessage(epochToKey(p.epochDay)));
  return isTradingEpoch(p.epochDay);
}

/**
 * (from, to] 内的交易日数：不含 from、含 to；from >= to → 0。
 * 任一端非法/越界 → 抛 ERR-CALENDAR-001（绝不回退到只跳周末）。
 */
export function tradingDaysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) {
    throw new Error(`ERR-CALENDAR-001: 无法解析交易日区间 ${String(from)} → ${String(to)}（要求真实存在的 YYYY-MM-DD）`);
  }
  if (!isCoveredYear(a.year)) throw new Error(uncoveredMessage(epochToKey(a.epochDay)));
  if (!isCoveredYear(b.year)) throw new Error(uncoveredMessage(epochToKey(b.epochDay)));
  if (a.epochDay >= b.epochDay) return 0;
  let n = 0;
  for (let e = a.epochDay + 1; e <= b.epochDay; e++) {
    if (isTradingEpoch(e)) n += 1;
  }
  return n;
}

/**
 * date 之后第 n 个交易日（不含 date 当日）；n 必须为正整数。
 * 入参不足（日期非法 / n 非正整数）→ null（调用方按"没有日期"处理，不编造）；
 * 走查过程越出覆盖范围 → 抛 ERR-CALENDAR-001（未知年份的日历不能冒充）。
 */
export function addTradingDays(date, n) {
  const p = parseDate(date);
  const days = Number(n);
  if (!p || !Number.isInteger(days) || days < 1) return null;
  if (!isCoveredYear(p.year)) throw new Error(uncoveredMessage(epochToKey(p.epochDay)));
  let left = days;
  let e = p.epochDay;
  while (left > 0) {
    e += 1;
    if (isTradingEpoch(e)) left -= 1;
  }
  return epochToKey(e);
}

/** 某年交易日总数（手算对齐见 test/calendar.test.js）；年份未覆盖 → ERR-CALENDAR-001 */
export function tradingDaysInYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || !isCoveredYear(y)) throw new Error(uncoveredMessage(String(year)));
  const start = Date.UTC(y, 0, 1) / DAY_MS;
  const end = Date.UTC(y + 1, 0, 1) / DAY_MS;
  let n = 0;
  for (let e = start; e < end; e++) {
    if (isTradingEpoch(e)) n += 1;
  }
  return n;
}

/**
 * ≤ date 的最近一个交易日（含 date 当日）；date 非法/越界 → ERR-CALENDAR-001。
 * 用途：`market.computeStale` 的"最近交易日"锚点（节假日不该被判成陈旧）。
 */
export function lastTradingDayOnOrBefore(date) {
  const p = parseDate(date);
  if (!p) throw new Error(`ERR-CALENDAR-001: 无法解析日期 ${String(date)}（要求真实存在的 YYYY-MM-DD）`);
  if (!isCoveredYear(p.year)) throw new Error(uncoveredMessage(epochToKey(p.epochDay)));
  let e = p.epochDay;
  while (!isTradingEpoch(e)) e -= 1;
  return epochToKey(e);
}
