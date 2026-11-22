/**
 * 风控闸门单元测试（纯函数）
 * node --test test/risk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, expectancyCheck, sentimentGate, hardExitCheck, tradingDaysBetween, RED_LINES } from '../src/risk.js';

const buy = { symbol: '600036', action: 'buy', price: 6, qty: 1000 };
const acct = { equity: 100000, symbolValue: {} };

test('risk: 正常买入放行', () => {
  assert.equal(gate({ mode: 'stable', action: 'buy', signal: buy, account: acct, stats: {} }).allowed, true);
});

test('risk: 冷静期拒绝 ERR-RISK-001', () => {
  const r = gate({ mode: 'stable', action: 'buy', signal: buy, account: acct, stats: { asOf: '2026-11-20', cooldownUntil: { '600036': '2026-11-24' } } });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'ERR-RISK-001');
});

test('risk: 连亏熔断 ERR-RISK-002', () => {
  const r = gate({ mode: 'stable', action: 'buy', signal: buy, account: acct, stats: { consecutiveLosses: 4 } });
  assert.equal(r.code, 'ERR-RISK-002');
});

test('risk: 单票上限 ERR-RISK-003（stable 25%）', () => {
  const big = { symbol: '600036', action: 'buy', price: 6, qty: 5000 }; // 3 万 > 25%
  const r = gate({ mode: 'stable', action: 'buy', signal: big, account: acct, stats: {} });
  assert.equal(r.code, 'ERR-RISK-003');
});

test('risk: 当日新开仓上限 ERR-RISK-005（short ≤2）', () => {
  const r = gate({ mode: 'short', action: 'buy', signal: buy, account: acct, stats: { newOpensToday: 2 } });
  assert.equal(r.code, 'ERR-RISK-005');
});

test('risk: 期望值不达标 ERR-RISK-006', () => {
  const exp = expectancyCheck({ trades: Array.from({ length: 30 }, (_, i) => ({ pnl: i < 12 ? 125 : -100 })), payoffRatio: 1.25 });
  assert.equal(exp.verdict, 'NOT_RECOMMENDED');
  const r = gate({ mode: 'stable', action: 'buy', signal: buy, account: acct, stats: { expectancy: exp } });
  assert.equal(r.code, 'ERR-RISK-006');
});

test('risk: 强制离场/止损恒放行（硬红线优先）', () => {
  assert.equal(gate({ mode: 'short', action: 'force_exit', signal: buy, account: acct, stats: { consecutiveLosses: 9 } }).allowed, true);
  assert.equal(gate({ mode: 'stable', action: 'stop_loss', signal: buy, account: acct, stats: {} }).allowed, true);
});

test('risk: 期望值自检 1.25:1 → 要求胜率 44.4%', () => {
  const e = expectancyCheck({ trades: [], payoffRatio: 1.25 });
  assert.equal(e.verdict, 'INSUFFICIENT_SAMPLE');
  assert.ok(Math.abs(e.requiredWinRate - 0.444) < 0.001);
  // 胜率 50%、盈亏比 1.25 → 正期望 OK
  const trades = Array.from({ length: 20 }, (_, i) => ({ pnl: i % 2 === 0 ? 125 : -100 }));
  const ok = expectancyCheck({ trades });
  assert.equal(ok.verdict, 'OK');
  assert.equal(ok.winRate, 0.5);
});

test('risk: 情绪总闸（溢价<0 或 炸板率>40% 关闭）', () => {
  assert.equal(sentimentGate({ indexAboveMa5: true, yesterdayLimitUpPremium: 2, blowUpRate: 0.2 }).open, true);
  assert.equal(sentimentGate({ indexAboveMa5: true, yesterdayLimitUpPremium: -1, blowUpRate: 0.2 }).open, false);
  assert.equal(sentimentGate({ indexAboveMa5: true, yesterdayLimitUpPremium: 1, blowUpRate: 0.45 }).open, false);
  assert.equal(sentimentGate({ indexAboveMa5: false, yesterdayLimitUpPremium: 1, blowUpRate: 0.1 }).open, false);
});

test('risk: 5 日硬期限（自然日 7 天含 5 个交易日）', () => {
  assert.equal(tradingDaysBetween('2026-11-16', '2026-11-20'), 4); // 周一→周五
  const hard = hardExitCheck({ openDate: '2026-11-16', asOf: '2026-11-20' });
  assert.equal(hard.mustExit, false);
  assert.equal(hard.remaining, 1);
  const done = hardExitCheck({ openDate: '2026-11-13', asOf: '2026-11-20' });
  assert.equal(done.mustExit, true);
  assert.equal(RED_LINES.short.hardMaxHoldDays, 5);
});
