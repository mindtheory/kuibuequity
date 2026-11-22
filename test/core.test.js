/**
 * 内核单元测试：costs.js + indicators.js（纯函数，含经典数值对齐）
 * node --test test/core.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeFee, applySlippage, holdingCost, costToNegativeEta, annualDilutionRate } from '../src/costs.js';
import { sma, ema, rsi, macd, boll, atr, atrPct, slope, maxDrawdown, sharpe, winRate, payoffRatio } from '../src/indicators.js';

// ---- costs ------------------------------------------------------------------
test('costs: 买入费用 = max(佣金万2.5, 5元) + 过户费', () => {
  // 1000 股 × 10 元 = 1 万元：佣金 max(2.5, 5)=5，过户 0.1 → 5.10
  assert.equal(tradeFee({ side: 'buy', price: 10, qty: 1000 }), 5.1);
  // 10 万元成交：佣金 25 + 过户 1 = 26
  assert.equal(tradeFee({ side: 'buy', price: 10, qty: 10000 }), 26);
});

test('costs: 卖出加收印花税万5', () => {
  // 1 万元卖出：佣金 5 + 印花 5 + 过户 0.1 = 10.10
  assert.equal(tradeFee({ side: 'sell', price: 10, qty: 1000 }), 10.1);
});

test('costs: 滑点买高卖低', () => {
  assert.equal(applySlippage({ price: 10, side: 'buy', slippageBps: 10 }), 10.01);
  assert.equal(applySlippage({ price: 10, side: 'sell', slippageBps: 10 }), 9.99);
});

test('costs: holdingCost 手算（买→分红→部分卖）', () => {
  const lots = [
    { side: 'buy', price: 6, qty: 10000, fee: 15 },
    { side: 'buy', price: 5.5, qty: 5000, fee: 10, dividend: 0.3 }, // 除息时持股 15000
    { side: 'sell', price: 6.2, qty: 5000, fee: 21 },
  ];
  const r = holdingCost({ lots });
  // totalIn = 60000+15 + 27500+10 = 87525
  // dividends = 0.3 × 15000 = 4500（分红按除息时持股）
  // totalRecovered = 31000−21 + 4500 = 35479
  // shares = 10000 → cost = (87525−35479)/10000 = 5.2046 → 5.205
  assert.equal(r.totalIn, 87525);
  assert.equal(r.dividends, 4500);
  assert.equal(r.totalRecovered, 35479);
  assert.equal(r.shares, 10000);
  assert.equal(r.costPerShare, 5.205);
  assert.equal(r.negative, false);
});

test('costs: 分红+网格把成本做成负数', () => {
  const lots = [
    { side: 'buy', price: 6, qty: 10000, fee: 15 },
    { side: 'buy', price: 6, qty: 10000, fee: 15, dividend: 0.35 }, // 20000 股 × 0.35 = 7000
    { side: 'sell', price: 6.5, qty: 10000, fee: 41 }, // 回收 64959
  ];
  const r = holdingCost({ lots });
  // totalIn=120030; recovered=64959+7000=71959; shares=10000 → cost=4.807
  assert.equal(r.costPerShare, 4.807);
  // 再来一轮大卖出把成本压负
  lots.push({ side: 'sell', price: 7, qty: 8000, fee: 33 });
  const r2 = holdingCost({ lots });
  // recovered += 56000−33 = 127926; shares=2000 → (120030−127926)/2000 = −3.948
  assert.equal(r2.negative, true);
  assert.ok(r2.costPerShare < 0);
  assert.equal(r2.progress, 1);
});

test('costs: 卖出超过持股抛错', () => {
  assert.throws(() => holdingCost({ lots: [{ side: 'buy', price: 1, qty: 100, fee: 5 }, { side: 'sell', price: 1, qty: 200, fee: 5 }] }), /ERR-COST-005/);
});

test('costs: ETA 边界（已负→0；无摊薄→null）', () => {
  assert.equal(costToNegativeEta({ costPerShare: -1, price: 6, annualDilutionRate: 0.08 }), 0);
  assert.equal(costToNegativeEta({ costPerShare: 5, price: 6, annualDilutionRate: 0 }), null);
  // 5.935 / (6.1 × 0.094) ≈ 10.35
  assert.equal(costToNegativeEta({ costPerShare: 5.935, price: 6.1, annualDilutionRate: 0.094 }), 10.35);
});

test('costs: annualDilutionRate = 股息 + w×网格 − 拖累', () => {
  assert.equal(annualDilutionRate({ dividendYield: 0.055, floatWeight: 0.3, gridAnnualGross: 0.12, costDrag: 0.005 }), 0.086);
});

// ---- indicators --------------------------------------------------------------
test('ind: sma 索引对齐（前导 null）', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r, [null, null, 2, 3, 4]);
});

test('ind: ema 首值播种', () => {
  const r = ema([1, 2, 3], 2); // alpha=2/3: 1, 1.6667, 2.5556
  assert.equal(r[0], 1);
  assert.ok(Math.abs(r[1] - 1.6666667) < 1e-6);
  assert.ok(Math.abs(r[2] - 2.5555556) < 1e-6);
});

test('ind: rsi Wilder 经典值对齐（周期 14 标准数据集）', () => {
  // Wilder 原书经典 9 日 RSI 序列（前 15 个收盘价）
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const r = rsi(closes, 14);
  assert.equal(r[13], null); // 第 14 个变动才出首个值（index 14）
  // 经典值：首个 RSI(14) ≈ 70.46
  assert.ok(Math.abs(r[14] - 70.46) < 0.1, `rsi=${r[14]}`);
});

test('ind: macd/boll 长度对齐', () => {
  const xs = Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i / 3));
  const m = macd(xs);
  assert.equal(m.dif.length, 40);
  assert.equal(m.dea.length, 40);
  assert.equal(m.hist.length, 40);
  const b = boll(xs, 20);
  assert.equal(b.mid.length, 40);
  assert.equal(b.mid[18], null);
  assert.ok(b.mid[19] !== null);
  assert.ok(b.upper[39] > b.mid[39] && b.lower[39] < b.mid[39]);
});

test('ind: atr 手算（恒定 TR）', () => {
  const bars = Array.from({ length: 20 }, () => ({ high: 11, low: 9, close: 10 }));
  const a = atr(bars, 14);
  assert.equal(a[12], null);
  assert.ok(Math.abs(a[13] - 2) < 1e-9);
  assert.ok(Math.abs(a[19] - 2) < 1e-9);
  const ap = atrPct(bars, 14);
  assert.ok(Math.abs(ap[19] - 0.2) < 1e-9);
});

test('ind: slope 上升序列为正、下降为负', () => {
  const up = Array.from({ length: 10 }, (_, i) => 10 + i);
  const s = slope(up, 5);
  assert.ok(s[9] > 0);
  const down = Array.from({ length: 10 }, (_, i) => 20 - i);
  assert.ok(slope(down, 5)[9] < 0);
});

test('ind: maxDrawdown 手算', () => {
  assert.equal(maxDrawdown([100, 120, 90, 95, 130]), 0.25);
  assert.equal(maxDrawdown([100, 110]), 0);
});

test('ind: sharpe/winRate/payoffRatio', () => {
  const rets = [0.01, 0.02, -0.01, 0.015, 0.005, -0.005];
  const s = sharpe(rets);
  assert.ok(s !== null && s > 0);
  const trades = [{ pnl: 10 }, { pnl: 5 }, { pnl: -4 }, { pnl: -6 }];
  assert.equal(winRate(trades), 0.5);
  assert.equal(payoffRatio(trades), 1.5);
  assert.equal(winRate([]), null);
});
