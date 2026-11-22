/**
 * kuibuequity — src/market.js 纯逻辑单测（不联网）
 * 覆盖：normalizeSymbol / 涨跌停价 / kline 行解析 / stale 判定
 * 运行：node --test test/market.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSymbol,
  limitPct,
  limitPrices,
  parseKlineLine,
  barsFromKlines,
  computeStale,
  latestWeekdayString,
  round2,
  round4,
} from '../src/market.js';

// ---------------------------------------------------------------------------
// normalizeSymbol
// ---------------------------------------------------------------------------

test('normalizeSymbol: 六位纯数字', () => {
  assert.deepEqual(normalizeSymbol('600036'), { code: '600036', market: 'SH', secid: '1.600036' });
  assert.deepEqual(normalizeSymbol('000001'), { code: '000001', market: 'SZ', secid: '0.000001' });
  assert.deepEqual(normalizeSymbol('300750'), { code: '300750', market: 'SZ', secid: '0.300750' });
  assert.deepEqual(normalizeSymbol('688111'), { code: '688111', market: 'SH', secid: '1.688111' });
  assert.deepEqual(normalizeSymbol('430047'), { code: '430047', market: 'BJ', secid: '0.430047' });
  assert.deepEqual(normalizeSymbol('830000'), { code: '830000', market: 'BJ', secid: '0.830000' });
  assert.deepEqual(normalizeSymbol('920002'), { code: '920002', market: 'BJ', secid: '0.920002' });
});

test('normalizeSymbol: sh/sz/bj 前缀（大小写不敏感）', () => {
  assert.deepEqual(normalizeSymbol('sh600036'), { code: '600036', market: 'SH', secid: '1.600036' });
  assert.deepEqual(normalizeSymbol('SZ000001'), { code: '000001', market: 'SZ', secid: '0.000001' });
  assert.deepEqual(normalizeSymbol('bj920002'), { code: '920002', market: 'BJ', secid: '0.920002' });
});

test('normalizeSymbol: .SH/.SZ/.BJ 后缀', () => {
  assert.deepEqual(normalizeSymbol('600036.SH'), { code: '600036', market: 'SH', secid: '1.600036' });
  assert.deepEqual(normalizeSymbol('000001.SZ'), { code: '000001', market: 'SZ', secid: '0.000001' });
  assert.deepEqual(normalizeSymbol('830000.BJ'), { code: '830000', market: 'BJ', secid: '0.830000' });
});

test('normalizeSymbol: 前后空白容错', () => {
  assert.deepEqual(normalizeSymbol('  600036  '), { code: '600036', market: 'SH', secid: '1.600036' });
});

test('normalizeSymbol: 非法代码抛 ERR-SYMBOL-001', () => {
  const bad = ['', '   ', 'ABC', '60003', '6000366', '123456', '510300', '900901', 'sh60003', '600036.SZ', 'SZ600036', '600036.HK', null, undefined, 12345];
  for (const s of bad) {
    assert.throws(() => normalizeSymbol(s), (e) => e.code === 'ERR-SYMBOL-001' || String(e.message).startsWith('ERR-SYMBOL-001'), `应拒绝: ${JSON.stringify(s)}`);
  }
});

test('normalizeSymbol: 前缀/后缀与数字规则冲突时拒绝', () => {
  assert.throws(() => normalizeSymbol('sh000001'), /ERR-SYMBOL-001/); // 000001 是深市
  assert.throws(() => normalizeSymbol('600036.BJ'), /ERR-SYMBOL-001/);
});

// ---------------------------------------------------------------------------
// 涨跌停幅度与价格
// ---------------------------------------------------------------------------

test('limitPct: 主板 10% / 创业板 20% / 科创板 20% / ST 5% / 北交所 30%', () => {
  assert.equal(limitPct({ code: '600036', market: 'SH', name: '招商银行' }), 0.1);
  assert.equal(limitPct({ code: '000001', market: 'SZ', name: '平安银行' }), 0.1);
  assert.equal(limitPct({ code: '300750', market: 'SZ', name: '宁德时代' }), 0.2);
  assert.equal(limitPct({ code: '688111', market: 'SH', name: '金山办公' }), 0.2);
  assert.equal(limitPct({ code: '600053', market: 'SH', name: '*ST九鼎' }), 0.05);
  assert.equal(limitPct({ code: '000029', market: 'SZ', name: 'ST深深房' }), 0.05);
  assert.equal(limitPct({ code: '830000', market: 'BJ', name: '某北交所票' }), 0.3);
});

test('limitPrices: 主板 prevClose=10.00 → 11.00 / 9.00', () => {
  const lp = limitPrices({ code: '600036', market: 'SH', name: '招商银行', prevClose: 10.0 });
  assert.equal(lp.limitUp, 11.0);
  assert.equal(lp.limitDown, 9.0);
});

test('limitPrices: 创业板 prevClose=10.00 → 12.00 / 8.00', () => {
  const lp = limitPrices({ code: '300750', market: 'SZ', name: '宁德时代', prevClose: 10.0 });
  assert.equal(lp.limitUp, 12.0);
  assert.equal(lp.limitDown, 8.0);
});

test('limitPrices: ST prevClose=10.00 → 10.50 / 9.50', () => {
  const lp = limitPrices({ code: '600053', market: 'SH', name: '*ST九鼎', prevClose: 10.0 });
  assert.equal(lp.limitUp, 10.5);
  assert.equal(lp.limitDown, 9.5);
});

test('limitPrices: 北交所 prevClose=10.00 → 13.00 / 7.00', () => {
  const lp = limitPrices({ code: '830000', market: 'BJ', name: '北票', prevClose: 10.0 });
  assert.equal(lp.limitUp, 13.0);
  assert.equal(lp.limitDown, 7.0);
});

test('limitPrices: 四舍五入到 0.01（99.85 × 1.1 = 109.835 → 109.84）', () => {
  const lp = limitPrices({ code: '600000', market: 'SH', name: '浦发银行', prevClose: 99.85 });
  assert.equal(lp.limitUp, 109.84);
  assert.equal(lp.limitDown, 89.87); // 99.85*0.9=89.865 → 89.87
});

test('limitPrices: prevClose 非法返回 null', () => {
  for (const pc of [0, -1, NaN, null, undefined, 'x']) {
    const lp = limitPrices({ code: '600000', market: 'SH', prevClose: pc });
    assert.equal(lp.limitUp, null);
    assert.equal(lp.limitDown, null);
  }
});

// ---------------------------------------------------------------------------
// kline 行解析
// ---------------------------------------------------------------------------

test('parseKlineLine: 标准行字段映射（量 手→股 ×100，adjClose=close）', () => {
  const line = '2026-11-20,42.90,44.00,44.16,42.70,4780213,20680356045.00,3.40,2.49,1.07,2.32';
  const b = parseKlineLine(line);
  assert.equal(b.date, '2026-11-20');
  assert.equal(b.open, 42.9);
  assert.equal(b.close, 44.0);
  assert.equal(b.high, 44.16);
  assert.equal(b.low, 42.7);
  assert.equal(b.volume, 478021300); // 手→股
  assert.equal(b.amount, 20680356045);
  assert.equal(b.adjClose, 44.0);
  assert.equal(b.amplitude, 3.4);
  assert.equal(b.changePct, 2.49);
  assert.equal(b.change, 1.07);
  assert.equal(b.turnoverRate, 0.0232); // 2.32% → 小数
  assert.equal(b.suspended, false);
});

test('parseKlineLine: 零成交视为停牌近似', () => {
  const b = parseKlineLine('2026-11-20,10.00,10.00,10.00,10.00,0,0.00,0.00,0.00,0.00,0.00');
  assert.equal(b.suspended, true);
  assert.equal(b.volume, 0);
  assert.equal(b.amount, 0);
  assert.equal(b.changePct, 0); // 合法的 0 不得变 null
});

test('parseKlineLine: 非法行抛 ERR-DATA-001', () => {
  for (const bad of ['', 'garbage', '2026-11-20,abc,44,44,42,100,1000', '20-11-2026,1,2,3,4,5,6,7']) {
    assert.throws(() => parseKlineLine(bad), (e) => String(e.message).startsWith('ERR-DATA-001'), `应拒绝: ${bad}`);
  }
});

test('barsFromKlines: limitUp/limitDown 用前收盘近似（high>=limit && close>=limit）', () => {
  const lines = [
    '2026-11-19,10.00,10.00,10.20,9.90,100000,1000000.00,3.00,0.00,0.00,1.00',
    '2026-11-20,10.50,11.00,11.00,10.50,100000,1100000.00,5.00,10.00,1.00,1.00', // 主板涨停封死
    '2026-11-21,11.00,11.50,12.10,10.90,100000,1200000.00,10.91,4.55,0.50,1.00', // 触板未封住
  ];
  const bars = barsFromKlines(lines, { code: '600036', market: 'SH', name: '招商银行' });
  assert.equal(bars.length, 3);
  assert.equal(bars[0].limitUp, false); // 无前收
  assert.equal(bars[1].limitUp, true);
  assert.equal(bars[1].limitDown, false);
  assert.equal(bars[2].limitUp, false); // high=12.10>=12.10 但 close=11.50<12.10
  assert.equal(bars[0].dividendPerShare, 0);
});

// ---------------------------------------------------------------------------
// stale 判定
// ---------------------------------------------------------------------------

test('latestWeekdayString: 周末回退到周五（北京时区）', () => {
  const sat = new Date('2026-11-21T04:00:00Z'); // 北京 2026-11-21 12:00 周六
  assert.equal(latestWeekdayString(sat), '2026-11-20');
  const sun = new Date('2026-11-22T04:00:00Z'); // 北京 周日
  assert.equal(latestWeekdayString(sun), '2026-11-20');
  const wed = new Date('2026-11-25T04:00:00Z'); // 北京 周三
  assert.equal(latestWeekdayString(wed), '2026-11-25');
});

test('computeStale: asOf 早于最近工作日 → true；当天 → false；缺失 → true', () => {
  const fri = new Date('2026-11-20T07:00:00Z'); // 北京周五 15:00
  assert.equal(computeStale('2026-11-20', fri), false);
  assert.equal(computeStale('2026-11-19', fri), true);
  assert.equal(computeStale('2026-11-21', fri), false); // 未来日期不算陈旧
  assert.equal(computeStale(null, fri), true);
  assert.equal(computeStale('', fri), true);
  // 周六看周五的数据：不陈旧
  const sat = new Date('2026-11-21T07:00:00Z');
  assert.equal(computeStale('2026-11-20', sat), false);
});

// ---------------------------------------------------------------------------
// 舍入
// ---------------------------------------------------------------------------

test('round2/round4: 半进位与浮点容差', () => {
  assert.equal(round2(11.006), 11.01);
  assert.equal(round2(11.004), 11.0);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round4(0.00005), 0.0001);
  assert.equal(round4(1.00004999), 1);
});
