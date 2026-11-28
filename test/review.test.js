/**
 * src/review.js 单元测试（纯函数，无网络无时钟）
 * 契约：docs/interface.md §12
 *
 * 所有期望值手算写死，不复用被测函数自身算期望（尤其交易日序列，逐日列出）。
 * 2026-11 日历核对：11/20 周五、11/21 周六、11/22 周日、11/23 周一、11/24 周二、
 * 11/25 周三、11/26 周四、11/27 周五、11/28 周六、11/29 周日、11/30 周一（无 11 月假期）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewReport, REVIEW_PERIODS, SHORT_HARD_MAX_HOLD_DAYS } from '../src/review.js';

// ---------- 构造器（只造数据，不算期望值） ----------

function contract({ id = 'C000001', quadrant = 'stable', symbol = '600036', createdAt, overrides = [] }) {
  return {
    id,
    quadrant,
    mode: quadrant,
    symbol,
    createdAt,
    overrides,
  };
}

function overrideAt(at, reason = '觉得还能涨', patch = { takeProfitPct: 0.05 }) {
  return { at, reason, patch };
}

function shortPosition({ symbol = '600001', qty = 1000, openDate }) {
  return { quadrant: 'short', symbol, qty, openDate };
}

function trade({ quadrant = 'stable', date, pnl }) {
  return { quadrant, date, pnl };
}

const base = (extra) => ({ trades: [], contracts: [], positions: [], period: 'all', asOf: '2026-11-28', ...extra });

// ---------- 1. 周期起点：手算自然日 / 自然月夹取 ----------

test('periodStart 手算：week=前 7 自然日、month=前 1 自然月且月末夹取、all=null', () => {
  assert.deepEqual(REVIEW_PERIODS, ['week', 'month', 'all']);

  const week = reviewReport(base({ period: 'week', asOf: '2026-11-28' }));
  assert.equal(week.periodStart, '2026-11-21', '11/28 − 7 天 = 11/21');
  assert.equal(week.periodEnd, '2026-11-28');
  assert.equal(week.asOf, '2026-11-28');
  assert.equal(week.asOfKind, 'reviewedAt');

  const month = reviewReport(base({ period: 'month', asOf: '2026-03-31' }));
  assert.equal(month.periodStart, '2026-02-28', '3/31 往前 1 月 = 2 月末（夹取，绝不进位成 3/03）');

  const month2 = reviewReport(base({ period: 'month', asOf: '2026-01-15' }));
  assert.equal(month2.periodStart, '2025-12-15');

  const all = reviewReport(base({ period: 'all' }));
  assert.equal(all.periodStart, null);
});

// ---------- 2. 空账本：遵守率必须 null，不是 100% ----------

test('空账本：三象限遵守率全 null（"没机会违规" ≠ "0 次违规"），无短线持仓，无 warning', () => {
  const r = reviewReport(base({}));
  assert.equal(r.trades, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.payoffRatio, null);
  assert.equal(r.maxDrawdown, null);
  assert.deepEqual(r.overrides, []);
  assert.deepEqual(r.warnings, []);
  for (const q of ['long', 'stable', 'short']) {
    const s = r.discipline.byQuadrant[q];
    assert.equal(s.contractsChecked, 0);
    assert.equal(s.overrideCount, 0);
    assert.equal(s.disciplineRate, null, `${q} 无契约不得输出 100%`);
    assert.equal(s.overrideRate, null);
    assert.equal(s.capped, false);
  }
  assert.equal(r.discipline.overall.disciplineRate, null);
  assert.equal(r.shortOverdue.count, 0);
  assert.equal(r.shortOverdue.checked, 0);
  assert.deepEqual(r.shortOverdue.items, []);
  assert.deepEqual(r.shortOverdue.dueToday, []);
});

// ---------- 3. 干净契约：遵守率 100% ----------

test('1 份锁定契约、0 次 override → 遵守率 1（stable），其他象限仍 null', () => {
  const r = reviewReport(base({ contracts: [contract({ createdAt: '2026-06-01T02:00:00.000Z' })] }));
  const st = r.discipline.byQuadrant.stable;
  assert.equal(st.contractsChecked, 1);
  assert.equal(st.overrideCount, 0);
  assert.equal(st.overriddenContracts, 0);
  assert.equal(st.cleanContracts, 1);
  assert.equal(st.disciplineRate, 1);
  assert.equal(st.overrideRate, 0);
  assert.equal(st.capped, false);
  assert.equal(r.discipline.byQuadrant.long.disciplineRate, null);
  assert.equal(r.discipline.overall.disciplineRate, 1);
  assert.equal(r.disciplineNote.includes('100.0%'), true);
});

// ---------- 4. 1 次 override：遵守率 0，明细带 patch/reason ----------

test('1 份契约 1 次 override → 遵守率 0、overrideRate 1，override 清单带 patch 与 reason', () => {
  const r = reviewReport(
    base({
      contracts: [
        contract({
          createdAt: '2026-06-01T02:00:00.000Z',
          overrides: [overrideAt('2026-11-26T06:30:00.000Z', '止盈太薄，改成 5%')],
        }),
      ],
    }),
  );
  const st = r.discipline.byQuadrant.stable;
  assert.equal(st.contractsChecked, 1);
  assert.equal(st.overrideCount, 1);
  assert.equal(st.overriddenContracts, 1);
  assert.equal(st.cleanContracts, 0);
  assert.equal(st.disciplineRate, 0, '1 − 1/1 = 0');
  assert.equal(st.overrideRate, 1);
  assert.equal(st.capped, false);
  assert.equal(r.overrides.length, 1);
  assert.equal(r.overrides[0].contractId, 'C000001');
  assert.equal(r.overrides[0].quadrant, 'stable');
  assert.equal(r.overrides[0].symbol, '600036');
  assert.equal(r.overrides[0].reason, '止盈太薄，改成 5%');
  assert.deepEqual(r.overrides[0].patch, { takeProfitPct: 0.05 });
});

// ---------- 5. 同一契约改 3 次：不稀释，夹 0 并告警 ----------

test('1 份契约被 override 3 次 → 遵守率夹 0、capped、overrideRate 如实 3、warning 留痕', () => {
  const r = reviewReport(
    base({
      contracts: [
        contract({
          createdAt: '2026-06-01T02:00:00.000Z',
          overrides: [
            overrideAt('2026-11-23T06:00:00.000Z', '第一次改'),
            overrideAt('2026-11-25T06:00:00.000Z', '第二次改'),
            overrideAt('2026-11-27T06:00:00.000Z', '第三次改'),
          ],
        }),
      ],
    }),
  );
  const st = r.discipline.byQuadrant.stable;
  assert.equal(st.contractsChecked, 1);
  assert.equal(st.overrideCount, 3);
  assert.equal(st.disciplineRate, 0);
  assert.equal(st.overrideRate, 3, '不夹：必须暴露"改了 3 次"');
  assert.equal(st.capped, true);
  assert.ok(r.warnings.includes('REVIEW.OVERRIDE_EXCEEDS_CONTRACTS'));
  assert.equal(r.overrides.length, 3);
  assert.ok(r.disciplineNote.includes('override 次数超过契约数'));
});

// ---------- 6. 期内归属：期外旧契约不计、期前契约因期内 override 计入 ----------

test('week 窗口：期外旧契约（无 override）不计；期前契约但期内被 override 计入 → 2 份 1 次 → 0.5', () => {
  const r = reviewReport(
    base({
      period: 'week',
      asOf: '2026-11-28', // periodStart = 2026-11-21
      contracts: [
        contract({ id: 'C1', createdAt: '2026-11-10T02:00:00.000Z' }), // 期外，无 override → 不计
        contract({ id: 'C2', symbol: '601398', createdAt: '2026-11-25T02:00:00.000Z' }), // 期内 → 计
        contract({
          id: 'C3',
          symbol: '600000',
          createdAt: '2026-11-01T02:00:00.000Z', // 期前
          overrides: [overrideAt('2026-11-26T02:00:00.000Z', '期内还在改')], // 因 override 计入
        }),
        contract({
          id: 'C4',
          symbol: '600519',
          createdAt: '2026-11-01T02:00:00.000Z', // 期前
          overrides: [overrideAt('2026-11-10T02:00:00.000Z', '期外改的')], // 期外 override 不算
        }),
      ],
    }),
  );
  const st = r.discipline.byQuadrant.stable;
  assert.equal(st.contractsChecked, 2, 'C2（期内新建）+ C3（期内被改）');
  assert.equal(st.overrideCount, 1, '只有 C3 的期内 override');
  assert.equal(st.disciplineRate, 0.5, '1 − 1/2');
  assert.equal(st.overrideRate, 0.5);
  assert.equal(r.overrides.length, 1);
  assert.equal(r.overrides[0].contractId, 'C3');
});

test('3 份契约 1 次 override → 遵守率 0.667（round3，手算 1 − 1/3）', () => {
  const r = reviewReport(
    base({
      contracts: [
        contract({ id: 'C1', createdAt: '2026-11-24T02:00:00.000Z' }),
        contract({ id: 'C2', symbol: '601398', createdAt: '2026-11-25T02:00:00.000Z' }),
        contract({
          id: 'C3',
          symbol: '600000',
          createdAt: '2026-11-26T02:00:00.000Z',
          overrides: [overrideAt('2026-11-27T02:00:00.000Z')],
        }),
      ],
    }),
  );
  assert.equal(r.discipline.byQuadrant.stable.disciplineRate, 0.667);
  assert.equal(r.discipline.overall.disciplineRate, 0.667);
});

// ---------- 7. 象限隔离 + overall 汇总 ----------

test('象限隔离：stable 的 override 不污染 short；overall = 1 − 1/2 = 0.5', () => {
  const r = reviewReport(
    base({
      contracts: [
        contract({
          quadrant: 'stable',
          createdAt: '2026-11-24T02:00:00.000Z',
          overrides: [overrideAt('2026-11-26T02:00:00.000Z')],
        }),
        contract({ id: 'C2', quadrant: 'short', symbol: '600001', createdAt: '2026-11-24T02:00:00.000Z' }),
      ],
    }),
  );
  assert.equal(r.discipline.byQuadrant.stable.overrideCount, 1);
  assert.equal(r.discipline.byQuadrant.short.overrideCount, 0);
  assert.equal(r.discipline.byQuadrant.short.disciplineRate, 1);
  assert.equal(r.discipline.byQuadrant.short.contractsChecked, 1);
  assert.equal(r.discipline.overall.contractsChecked, 2);
  assert.equal(r.discipline.overall.overrideCount, 1);
  assert.equal(r.discipline.overall.disciplineRate, 0.5);

  // 只看 short：overall 收敛成 short 自己，stable 不出现在 byQuadrant
  const only = reviewReport(
    base({
      quadrant: 'short',
      contracts: [
        contract({
          quadrant: 'stable',
          createdAt: '2026-11-24T02:00:00.000Z',
          overrides: [overrideAt('2026-11-26T02:00:00.000Z')],
        }),
        contract({ id: 'C2', quadrant: 'short', symbol: '600001', createdAt: '2026-11-24T02:00:00.000Z' }),
      ],
    }),
  );
  assert.equal(only.discipline.overall.quadrant, 'short');
  assert.equal(only.discipline.overall.overrideCount, 0);
  assert.deepEqual(Object.keys(only.discipline.byQuadrant), ['short']);
});

// ---------- 8. 短线超期：手算交易日序列 ----------

test('短线超期：2026-11-20 建仓，asOf 2026-11-30 → 6 个交易日（11/23、24、25、26、27、30）超期 1 日', () => {
  const r = reviewReport(
    base({ asOf: '2026-11-30', positions: [shortPosition({ openDate: '2026-11-20' })] }),
  );
  assert.equal(SHORT_HARD_MAX_HOLD_DAYS, 5);
  const o = r.shortOverdue;
  assert.equal(o.checked, 1);
  assert.equal(o.count, 1);
  assert.deepEqual(o.dueToday, []);
  const item = o.items[0];
  assert.equal(item.symbol, '600001');
  assert.equal(item.holdDays, 6);
  assert.equal(item.dueDate, '2026-11-27', '11/23、24、25、26、27 为第 5 个交易日');
  assert.equal(item.overdueDays, 1);
  assert.equal(item.mustExitNow, true);
  assert.ok(item.note.includes('不可 override'));
});

// ---------- 9. 第 5 个交易日：到期而非超期 ----------

test('短线第 5 个交易日（asOf 2026-11-27）→ 进 dueToday 不进 items，overdueDays 0', () => {
  const r = reviewReport(base({ asOf: '2026-11-27', positions: [shortPosition({ openDate: '2026-11-20' })] }));
  assert.equal(r.shortOverdue.count, 0, '第 5 日还没走成不算超期');
  assert.equal(r.shortOverdue.dueToday.length, 1);
  assert.equal(r.shortOverdue.dueToday[0].holdDays, 5);
  assert.equal(r.shortOverdue.dueToday[0].overdueDays, 0);
  assert.equal(r.shortOverdue.dueToday[0].mustExitNow, true);
  assert.ok(r.disciplineNote.includes('今日到期'));
});

// ---------- 10. 未到期 / 非短线 / 已清仓 不计入；无短线持仓不触碰日历 ----------

test('未到期（2 日）与长期持仓不计入；已清仓 qty=0 不计；无短线持仓时 asOf 越界也能复盘', () => {
  const notDue = reviewReport(
    base({
      asOf: '2026-11-27',
      positions: [
        shortPosition({ symbol: '600001', openDate: '2026-11-25' }), // 11/26、11/27 两日
        { quadrant: 'long', symbol: '601398', qty: 5000, openDate: '2020-01-02' }, // 长期不按 5 日算
        shortPosition({ symbol: '600002', openDate: '2026-11-01', qty: 0 }), // 已清仓
      ],
    }),
  );
  assert.equal(notDue.shortOverdue.checked, 1, '只核验 qty>0 的短线持仓');
  assert.equal(notDue.shortOverdue.count, 0);
  assert.deepEqual(notDue.shortOverdue.dueToday, []);

  // 无短线持仓 → 不调用日历（复盘周期统计不需要日历）：2028 年（日历未覆盖）也能出报告
  const outOfRange = reviewReport(
    base({ asOf: '2028-06-01', positions: [{ quadrant: 'long', symbol: '601398', qty: 100, openDate: '2024-01-02' }] }),
  );
  assert.equal(outOfRange.periodEnd, '2028-06-01');
  assert.equal(outOfRange.shortOverdue.checked, 0);
});

// ---------- 11. 诚实失败：asOf 非法/溢出日 ----------

test('asOf 非法或溢出日 → ERR-CALENDAR-001（不让 Date 自动进位）', () => {
  assert.throws(() => reviewReport(base({ asOf: '' })), (e) => e.code === 'ERR-CALENDAR-001');
  assert.throws(() => reviewReport(base({ asOf: undefined })), (e) => e.code === 'ERR-CALENDAR-001');
  assert.throws(() => reviewReport(base({ asOf: '2026-02-30' })), (e) => e.code === 'ERR-CALENDAR-001');
  assert.throws(() => reviewReport(base({ asOf: '2026/11/28' })), (e) => e.code === 'ERR-CALENDAR-001');
});

// ---------- 12. 入参非法：period / quadrant ----------

test('period / quadrant 非法 → ERR-REVIEW-001', () => {
  assert.throws(() => reviewReport(base({ period: 'day' })), (e) => e.code === 'ERR-REVIEW-001');
  assert.throws(() => reviewReport(base({ quadrant: 'futures' })), (e) => e.code === 'ERR-REVIEW-001');
});

// ---------- 13. 短线硬期限无法核验 → 硬失败，不产出半成品 ----------

test('短线持仓 openDate 缺失 / 超出日历覆盖 → ERR-CALENDAR-001（硬期限无法核验就不给复盘）', () => {
  assert.throws(
    () => reviewReport(base({ positions: [shortPosition({ symbol: '600009', openDate: null })] })),
    (e) => e.code === 'ERR-CALENDAR-001' && e.message.includes('600009'),
  );
  assert.throws(
    () =>
      reviewReport(
        base({ asOf: '2028-01-10', positions: [shortPosition({ symbol: '600010', openDate: '2027-12-30' })] }),
      ),
    (e) => e.code === 'ERR-CALENDAR-001' && e.message.includes('600010'),
  );
});

// ---------- 14. 交易统计：期内过滤 + 未来数据 + 缺日期 ----------

test('交易统计：期内 2 笔 → 胜率 0.5、盈亏比 2；未来交易排除并告警；缺日期计入并告警', () => {
  const r = reviewReport(
    base({
      period: 'week',
      asOf: '2026-11-28', // periodStart = 2026-11-21
      trades: [
        trade({ date: '2026-11-24', pnl: 100 }),
        trade({ date: '2026-11-25', pnl: -50 }),
        trade({ date: '2026-12-05', pnl: 30 }), // 晚于 asOf → 排除
        trade({ date: '2026-10-01', pnl: 200 }), // 期外 → 排除
        trade({ date: null, pnl: 10 }), // 缺日期 → 计入 + 告警
      ],
    }),
  );
  assert.equal(r.trades, 3, '2 笔期内 + 1 笔缺日期');
  assert.equal(r.winRate, 2 / 3, '100、10 为盈利，−50 为亏损');
  assert.equal(r.payoffRatio, 55 / 50, '平均盈利 (100+10)/2 = 55，平均亏损 50 → 55/50 = 1.1');
  assert.ok(r.warnings.includes('REVIEW.RECORD_AFTER_ASOF'));
  assert.ok(r.warnings.includes('REVIEW.MISSING_DATE'));
});

test('盈亏比/回撤：2 笔（+100、−50）→ 盈亏比 2、回撤 1.5（沿用 indicators 的 pnl 序列口径）', () => {
  const r = reviewReport(
    base({ period: 'all', trades: [trade({ date: '2026-11-24', pnl: 100 }), trade({ date: '2026-11-25', pnl: -50 })] }),
  );
  assert.equal(r.trades, 2);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.payoffRatio, 2, '平均盈利 100 / 平均亏损 50');
  assert.equal(r.maxDrawdown, 1.5, '(100 − (−50)) / 100');
});

// ---------- 15. 契约缺 createdAt 但期内有 override → 计入 ----------

test('契约缺 createdAt 但期内有 override → 计入（warning 记 MISSING_DATE）', () => {
  const r = reviewReport(
    base({
      contracts: [contract({ createdAt: null, overrides: [overrideAt('2026-11-26T02:00:00.000Z')] })],
    }),
  );
  const st = r.discipline.byQuadrant.stable;
  assert.equal(st.contractsChecked, 1);
  assert.equal(st.overrideCount, 1);
  assert.equal(st.disciplineRate, 0);
  assert.ok(r.warnings.includes('REVIEW.MISSING_DATE'));
});
