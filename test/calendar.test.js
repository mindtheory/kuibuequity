/**
 * 交易日历（纯函数）：真实交易日计数 —— 周末 + 法定节假日 + 交易所额外休市全部跳过。
 *
 * 手算对齐（全部数字可复算，不调用被测函数自身算期望值）：
 *   2026 春节：2/15(日)~2/23(一) 放假 → 工作日休市 2/16,17,18,19,20,23 共 6 天
 *   2026 国庆：10/1(四)~10/7(三) → 工作日休市 10/1,2,5,6,7 共 5 天
 *   2024 除夕：2/9(五) A 股休市，但当年国务院通知未把该日列为法定假日 → 走交易所额外休市表
 *   年度工作日总数：2024 闰年 366 天 = 52 周 + 周一/周二 → 262 个工作日；
 *                   2025/2026/2027 各 365 天 = 52 周 + 1 天（分别落在周三/周四/周五）→ 261 个工作日
 *
 * node --test test/calendar.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALENDAR_COVERAGE,
  CALENDAR_VERSION,
  EXCHANGE_EXTRA_CLOSED,
  HOLIDAY_SOURCES,
  HOLIDAYS,
  addTradingDays,
  isTradingDay,
  lastTradingDayOnOrBefore,
  tradingDayInfo,
  tradingDaysBetween,
  tradingDaysInYear,
} from '../src/calendar.js';

const isDOW = (date, allowed) => allowed.includes(new Date(`${date}T00:00:00Z`).getUTCDay());

// ---------------------------------------------------------------------------
// 1. 数据自洽：表里只能放"真实存在的周一~周五"，否则周末会被重复计算
// ---------------------------------------------------------------------------

test('calendar: 年度表只含真实工作日，升序不重复，年份键与覆盖范围一致', () => {
  assert.deepEqual(CALENDAR_COVERAGE.years, [2024, 2025, 2026, 2027]);
  assert.equal(CALENDAR_COVERAGE.from, '2024-01-01');
  assert.equal(CALENDAR_COVERAGE.to, '2027-12-31');
  assert.deepEqual(Object.keys(HOLIDAYS).map(Number), CALENDAR_COVERAGE.years);
  assert.deepEqual(Object.keys(HOLIDAY_SOURCES).map(Number), CALENDAR_COVERAGE.years);
  assert.match(CALENDAR_VERSION, /^\d{4}\.\d{2}$/);

  for (const year of CALENDAR_COVERAGE.years) {
    const rows = [...HOLIDAYS[year], ...(EXCHANGE_EXTRA_CLOSED[year] || [])];
    assert.equal(new Set(rows).size, rows.length, `${year} 年日历表不得有重复日期`);
    for (const day of rows) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/, `${day} 必须是 YYYY-MM-DD`);
      assert.equal(day.slice(0, 4), String(year), `${day} 必须落在 ${year} 年的表里`);
      assert.ok(isDOW(day, [1, 2, 3, 4, 5]), `${day} 是周末，周末天然非交易日，不应入表`);
      // 真实存在（2026-02-30 之类溢出日会被 Date 进位，这里回比年月日）
      const [y, m, d] = day.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      assert.deepEqual(
        [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()],
        [y, m, d],
        `${day} 不是真实日期`,
      );
    }
    // 升序（便于人工核对年度表）
    const sorted = [...HOLIDAYS[year]].sort();
    assert.deepEqual(HOLIDAYS[year], sorted, `${year} 年法定节假日表必须升序`);
  }

  // 2024 除夕特例：A 股休市但当年非法定假日，必须单独登记
  assert.deepEqual(EXCHANGE_EXTRA_CLOSED[2024], ['2024-02-09']);
});

// ---------------------------------------------------------------------------
// 2. 年度交易日总数（工作日 − 工作日休市）
// ---------------------------------------------------------------------------

test('calendar: 年度交易日总数与手算一致（262/261 工作日 − 休市）', () => {
  // 2024：366 天，1/1 周一 → 52×5 + 周一/周二 = 262 工作日；休市 19 法定 + 2/9 除夕 = 20
  assert.equal(HOLIDAYS[2024].length, 19);
  assert.equal(tradingDaysInYear(2024), 262 - 20); // = 242
  // 2025：365 天，1/1 周三 → 261 工作日；休市 18 天（春节 1/28~2/4 含除夕）
  assert.equal(HOLIDAYS[2025].length, 18);
  assert.equal(tradingDaysInYear(2025), 261 - 18); // = 243
  // 2026：365 天，1/1 周四 → 261 工作日；休市 19 天
  assert.equal(HOLIDAYS[2026].length, 19);
  assert.equal(tradingDaysInYear(2026), 261 - 19); // = 242
  // 2027：365 天，1/1 周五 → 261 工作日；休市 18 天（春节 2/5~2/13 含除夕）
  assert.equal(HOLIDAYS[2027].length, 18);
  assert.equal(tradingDaysInYear(2027), 261 - 18); // = 243
  assert.throws(() => tradingDaysInYear(2028), /ERR-CALENDAR-001/);
});

// ---------------------------------------------------------------------------
// 3. isTradingDay / tradingDayInfo
// ---------------------------------------------------------------------------

test('calendar: 交易日判定——工作日、周末、法定假日、交易所额外休市', () => {
  assert.equal(isTradingDay('2026-11-20'), true); // 周五
  assert.equal(isTradingDay('2026-11-21'), false); // 周六
  assert.equal(isTradingDay('2026-10-01'), false); // 国庆
  assert.equal(isTradingDay('2026-10-08'), true); // 国庆后首个交易日
  assert.equal(isTradingDay('2026-02-23'), false); // 春节最后一天（周一）
  assert.equal(isTradingDay('2026-02-24'), true); // 春节后首个交易日
  assert.equal(isTradingDay('2024-02-08'), true); // 除夕前一日
  assert.equal(isTradingDay('2024-02-09'), false); // 除夕：交易所休市（额外休市表）
  assert.equal(isTradingDay('2027-02-08'), false); // 2027 春节（周一）
  assert.equal(isTradingDay('2027-02-15'), true); // 2027 春节后首个交易日
  // 调休上班的周末 A 股并不开市：2026-01-04 周日"上班"，但不是交易日
  assert.equal(isTradingDay('2026-01-04'), false);
});

test('calendar: tradingDayInfo 区分周末/假日/未覆盖，未知绝不冒充可交易', () => {
  assert.deepEqual(tradingDayInfo('2026-10-01'), {
    date: '2026-10-01', covered: true, weekend: false, holiday: true, trading: false,
  });
  assert.deepEqual(tradingDayInfo('2026-11-21'), {
    date: '2026-11-21', covered: true, weekend: true, holiday: false, trading: false,
  });
  assert.deepEqual(tradingDayInfo('2026-11-20T15:00:00+08:00'), {
    date: '2026-11-20', covered: true, weekend: false, holiday: false, trading: true,
  });
  const unknown = tradingDayInfo('2028-01-04');
  assert.equal(unknown.covered, false);
  assert.equal(unknown.trading, null, '未覆盖年份的 trading 必须是 null（未知），不能是 true/false');
  assert.equal(tradingDayInfo('2026-02-30'), null, '溢出日不是真日期');
  assert.equal(tradingDayInfo('2026/11/20'), null);
  assert.equal(tradingDayInfo(null), null);
});

test('calendar: 非法日期/越界一律 ERR-CALENDAR-001（不回退只跳周末）', () => {
  assert.throws(() => isTradingDay('2026-02-30'), /ERR-CALENDAR-001/);
  assert.throws(() => isTradingDay('2026/11/20'), /ERR-CALENDAR-001/);
  assert.throws(() => isTradingDay('2019-01-02'), /ERR-CALENDAR-001/);
  assert.throws(() => isTradingDay('2028-01-04'), /ERR-CALENDAR-001/);
  assert.throws(() => tradingDaysBetween('2028-01-04', '2028-01-05'), /ERR-CALENDAR-001/);
  assert.throws(() => tradingDaysBetween('2026-11-20', '2028-01-05'), /ERR-CALENDAR-001/);
  assert.throws(() => tradingDaysBetween('2026-02-30', '2026-03-02'), /ERR-CALENDAR-001/);
});

// ---------------------------------------------------------------------------
// 4. tradingDaysBetween 跨假期手算：(from, to] 半开区间
// ---------------------------------------------------------------------------

test('calendar: 交易日计数跨春节/国庆/清明手算对齐（半开区间 (from, to]）', () => {
  assert.equal(tradingDaysBetween('2026-11-16', '2026-11-20'), 4); // 11/17,18,19,20
  // 2026 春节 2/16~2/20 + 2/23 休市：(2/13, 2/24] 只有 2/24 一个交易日
  assert.equal(tradingDaysBetween('2026-02-13', '2026-02-24'), 1);
  // 2026 国庆 10/1,2,5,6,7 休市：(9/30, 10/9] = 10/8, 10/9 → 2
  assert.equal(tradingDaysBetween('2026-09-30', '2026-10-09'), 2);
  // 2027 清明 4/5(一) 休市：(4/2, 4/6] = 4/6 → 1
  assert.equal(tradingDaysBetween('2027-04-02', '2027-04-06'), 1);
  // 2027 春节 2/5,2/8~2/12 休市：(2/4, 2/15] = 2/15 → 1
  assert.equal(tradingDaysBetween('2027-02-04', '2027-02-15'), 1);
  // 2024 除夕 2/9 休市：(2/8, 2/19] = 2/19 → 1
  assert.equal(tradingDaysBetween('2024-02-08', '2024-02-19'), 1);
  // 空区间/逆序 → 0
  assert.equal(tradingDaysBetween('2026-11-20', '2026-11-20'), 0);
  assert.equal(tradingDaysBetween('2026-11-20', '2026-11-16'), 0);
});

// ---------------------------------------------------------------------------
// 5. addTradingDays 跨假期手算
// ---------------------------------------------------------------------------

test('calendar: 日期 + N 交易日跨春节/国庆/元旦手算对齐', () => {
  assert.equal(addTradingDays('2026-11-20', 15), '2026-12-11'); // 回归：无假日区间
  // 2/13(五) 之后：2/16~2/20、2/23 休市 → 下一交易日是 2/24(二)
  assert.equal(addTradingDays('2026-02-13', 1), '2026-02-24');
  // 9/30(三) +3：10/8(四)1、10/9(五)2、10/12(一)3（10/1~10/7 国庆休市）
  assert.equal(addTradingDays('2026-09-30', 3), '2026-10-12');
  // 跨年：12/31(四) +1 → 2027-01-01 元旦 + 周末 → 2027-01-04(一)
  assert.equal(addTradingDays('2026-12-31', 1), '2027-01-04');
  // 2027 国庆 10/1~10/7 休市：9/30(四) +1 → 10/8(五)
  assert.equal(addTradingDays('2027-09-30', 1), '2027-10-08');
});

test('calendar: addTradingDays 入参不足 → null；走出覆盖范围 → ERR-CALENDAR-001', () => {
  for (const [date, n] of [
    [null, 5], ['2026-02-30', 5], ['20261120', 5], ['2026/11/20', 5],
    ['2026-11-20', 0], ['2026-11-20', -1], ['2026-11-20', 1.5], ['2026-11-20', 'x'], ['2026-11-20', null],
  ]) {
    assert.equal(addTradingDays(date, n), null, `date=${String(date)} n=${String(n)} 不得编造日期`);
  }
  // 2027-12-31 之后已无日历数据：明确失败，而不是猜 2028 年的节假日
  assert.throws(() => addTradingDays('2027-12-31', 5), /ERR-CALENDAR-001/);
  assert.throws(() => addTradingDays('2029-01-02', 1), /ERR-CALENDAR-001/);
});

// ---------------------------------------------------------------------------
// 6. 消费方对齐：短线硬红线 / 稳定时间止损 / 条件单有效期都走同一本日历
// ---------------------------------------------------------------------------

test('calendar: 短线 5 日硬期限用真实交易日（跨春节不提前砍仓）', async () => {
  const { hardExitCheck } = await import('../src/risk.js');
  // 2026 春节：2/16~2/20、2/23 休市。(2/10, 2/24] = 2/11,12,13,24 → 4 个交易日
  const four = hardExitCheck({ openDate: '2026-02-10', asOf: '2026-02-24' });
  assert.equal(four.holdDays, 4);
  assert.equal(four.mustExit, false);
  assert.equal(four.remaining, 1);
  // (2/9, 2/24] = 2/10,11,12,13,24 → 5 个交易日 → 触发硬红线
  const five = hardExitCheck({ openDate: '2026-02-09', asOf: '2026-02-24' });
  assert.equal(five.holdDays, 5);
  assert.equal(five.mustExit, true);
  assert.equal(five.rule, 'SHORT.HARD_EXIT_5D');
  // 越界：宁可明确失败，也不拿"只跳周末"的近似值去砍仓
  assert.throws(() => hardExitCheck({ openDate: '2028-01-04', asOf: '2028-01-05' }), /ERR-CALENDAR-001/);
  // 缺日期：沿用既有语义，不触发（也不报错）
  assert.equal(hardExitCheck({ openDate: null, asOf: '2026-02-24' }).mustExit, false);
});

test('calendar: stable 时间止损按真实交易日（跨春节不误触发）', async () => {
  const { checkPosition } = await import('../src/strategies/stable.js');
  const mkBar = (date, px) => [{ date, open: px, close: px, adjClose: px, high: px, low: px }];
  const contract = {
    entry: { price: 10, date: '2026-02-10' },
    takeProfitPct: 0.03,
    stopLossPct: -0.024,
    maxHoldDays: 5,
  };
  // 2026-02-24：春节后首个交易日，(2/10, 2/24] = 4 → 未到 5 日
  const before = checkPosition({ bars: mkBar('2026-02-24', 10.1), contract, position: { qty: 100 } });
  assert.equal(before.action, 'hold');
  assert.equal(before.holdDays, 4);
  assert.equal(before.conditionOrders.length, 2);
  // 2026-02-25：(2/10, 2/25] = 5 → 时间止损
  const after = checkPosition({ bars: mkBar('2026-02-25', 10.1), contract, position: { qty: 100 } });
  assert.equal(after.action, 'time_exit');
  assert.equal(after.holdDays, 5);
  assert.equal(after.hitRule, 'STABLE.TIME_EXIT');
  // 显式 holdDays 优先（历史数据/测试注入），不被日历覆盖
  const explicit = checkPosition({ bars: mkBar('2026-02-24', 10.1), contract: { ...contract, holdDays: 15 }, position: { qty: 100 } });
  assert.equal(explicit.action, 'time_exit');
  // 拿不到建仓日期 → holdDays=null，不按 0 天冒充、也不误触发时间止损
  const noDate = checkPosition({ bars: mkBar('2026-02-25', 10.1), contract: { ...contract, entry: { price: 10 } }, position: { qty: 100 } });
  assert.equal(noDate.holdDays, null);
  assert.equal(noDate.action, 'hold');
});

test('calendar: 条件单 validUntil 用真实交易日（跨国庆），越界留空 + warning', async () => {
  const { conditionOrdersFromContracts, renderConditionOrdersCsv } = await import('../src/plan.js');
  const mkContract = (over = {}) => ({
    id: 'C1', symbol: '600036', mode: 'stable',
    entry: { price: 10, qty: 1000, date: '2026-09-30' },
    takeProfitPct: 0.04, stopLossPct: -0.032, maxHoldDays: 3,
    createdAt: '2026-09-30T15:00:00+08:00', ...over,
  });
  const position = { symbol: '600036', qty: 1000, contractId: 'C1' };

  // 2026 国庆 10/1~10/7 休市：9/30(三) +3 = 10/8(四)1、10/9(五)2、10/12(一)3
  const normal = conditionOrdersFromContracts({ contracts: [mkContract()], positions: [position] });
  assert.deepEqual(normal.warnings, []);
  assert.deepEqual(normal.orders.map((o) => o.validUntil), ['2026-10-12', '2026-10-12']);
  assert.ok(renderConditionOrdersCsv(normal.orders).includes('600036,sell,10.4,10.4,1000,2026-10-12'));

  // 走出日历覆盖范围：有效期留空，但止盈/止损价照常导出（不编造日期、也不整单丢弃）
  const far = conditionOrdersFromContracts({
    contracts: [mkContract({ entry: { price: 10, qty: 1000, date: '2027-12-01' }, maxHoldDays: 30 })],
    positions: [position],
  });
  assert.equal(far.orders.length, 2);
  assert.deepEqual(far.orders.map((o) => o.validUntil), [null, null]);
  assert.equal(far.warnings[0].code, 'STABLE.CALENDAR_UNCOVERED');
  assert.match(far.warnings[0].message, /ERR-CALENDAR-001/);
  assert.ok(renderConditionOrdersCsv(far.orders).includes('600036,sell,10.4,10.4,1000,\r\n'), 'CSV 有效期列必须是空单元格');
});

test('calendar: 最近交易日锚点（stale 判定）跨节假日回退，不误报陈旧', async () => {
  assert.equal(lastTradingDayOnOrBefore('2026-10-05'), '2026-09-30'); // 国庆期间（周一）→ 节前最后一个交易日
  assert.equal(lastTradingDayOnOrBefore('2026-11-22'), '2026-11-20'); // 周日 → 上周五
  assert.equal(lastTradingDayOnOrBefore('2026-02-20'), '2026-02-13'); // 春节中（周五）→ 节前
  assert.equal(lastTradingDayOnOrBefore('2026-11-20'), '2026-11-20'); // 交易日当天 → 就是它
  assert.throws(() => lastTradingDayOnOrBefore('2019-01-02'), /ERR-CALENDAR-001/);

  const { computeStale } = await import('../src/market.js');
  // 国庆期间拿到的 9/30 数据是最新的：旧逻辑会误判 stale:true，这里必须 false
  assert.equal(computeStale('2026-09-30', new Date('2026-10-05T10:00:00+08:00')), false);
  assert.equal(computeStale('2026-09-29', new Date('2026-10-05T10:00:00+08:00')), true);
  assert.equal(computeStale('2026-11-23', new Date('2026-11-23T10:00:00+08:00')), false);
  // 日历未覆盖年份 → 回退最近工作日：只会高估陈旧（宁可多报，不把旧数据说新鲜）
  assert.equal(computeStale('2028-01-04', new Date('2028-01-05T10:00:00+08:00')), true);
});
