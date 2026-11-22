/**
 * 三策略单元测试（纯函数，无网络）
 * node --test test/strategies.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridPlan, dilutionReport, evaluate as longEval } from '../src/strategies/longTerm.js';
import { adaptiveTarget, checkPosition, entryChecks } from '../src/strategies/stable.js';
import { scoreOne, scoreCandidates, exitPlan } from '../src/strategies/shortTerm.js';
import { buildPlan, renderPlanText, roundToLot, toConditionOrders } from '../src/plan.js';

// ---- 测试夹具：构造合成 K 线 ------------------------------------------------
function mkBars(n, { start = 10, drift = 0, vol = 0.02 } = {}) {
  const bars = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const open = c;
    c = c * (1 + drift + (i % 3 === 0 ? vol : -vol / 2));
    bars.push({
      date: `2026-${String(Math.floor(i / 21) + 1).padStart(2, '0')}-${String((i % 21) + 1).padStart(2, '0')}`,
      open, close: c, high: Math.max(open, c) * 1.01, low: Math.min(open, c) * 0.99,
      volume: 1000000, amount: 1000000 * c, adjClose: c,
      limitUp: false, limitDown: false, suspended: false, dividendPerShare: 0,
    });
  }
  return bars;
}

// ---- plan.js ---------------------------------------------------------------
test('plan: 买入整手向下取整', () => {
  assert.equal(roundToLot(1250), 1200);
  assert.equal(roundToLot(99), 0);
  const p = buildPlan({ mode: 'stable', asOf: '2026-11-20', signals: [{ symbol: '600036', action: 'buy', qty: 1250, price: 6 }] });
  assert.equal(p.orders[0].qty, 1200);
});

test('plan: 不足 1 手进 rejected 不丢弃', () => {
  const p = buildPlan({ mode: 'stable', asOf: '2026-11-20', signals: [{ symbol: '600036', action: 'buy', qty: 50, price: 6 }] });
  assert.equal(p.orders.length, 0);
  assert.equal(p.rejected[0].rule, 'PLAN.LOT_MIN');
});

test('plan: 止盈/止损/强制离场都渲染为 sell', () => {
  const p = buildPlan({ mode: 'short', asOf: '2026-11-20', signals: [
    { symbol: '000001', action: 'take_profit', qty: 500, price: 11 },
    { symbol: '000002', action: 'force_exit', qty: 300, price: 12 },
  ] });
  assert.equal(p.orders[0].side, 'sell');
  assert.equal(p.orders[1].side, 'sell');
});

test('plan: 同标的同向去重保留先者', () => {
  const p = buildPlan({ mode: 'stable', asOf: 'x', signals: [
    { symbol: '600036', action: 'buy', qty: 200, price: 6, rule: 'FIRST' },
    { symbol: '600036', action: 'buy', qty: 300, price: 6, rule: 'SECOND' },
  ] });
  assert.equal(p.orders.length, 1);
  assert.equal(p.orders[0].rule, 'FIRST');
});

test('plan: 脚注含 as_of 与免责声明；renderPlanText 可读', () => {
  const p = buildPlan({ mode: 'long', asOf: '2026-11-20', signals: [] });
  assert.ok(p.footnotes.some((f) => f.includes('as_of=2026-11-20')));
  assert.ok(p.footnotes.some((f) => f.includes('不构成投资建议')));
  const text = renderPlanText(p);
  assert.ok(text.includes('今日无指令'));
});

test('plan: toConditionOrders 只导出带条件的单', () => {
  const p = buildPlan({ mode: 'stable', asOf: 'x', tradingDay: '2026-11-23', signals: [
    { symbol: '600036', action: 'buy', qty: 100, price: 6, condition: { triggerPrice: 6.2, validUntil: '15D' } },
    { symbol: '600037', action: 'buy', qty: 100, price: 6 },
  ] });
  const co = toConditionOrders(p);
  assert.equal(co.length, 1);
  assert.equal(co[0].triggerPrice, 6.2);
});

// ---- longTerm --------------------------------------------------------------
test('long: gridPlan 基准价=60日中位、步长在 [3%,8%]', () => {
  const bars = mkBars(80, { start: 6, drift: 0.0002 });
  const gp = gridPlan({ bars, budget: 100000 });
  assert.ok(gp.basePrice > 0);
  assert.ok(gp.stepPct >= 0.03 && gp.stepPct <= 0.08, `stepPct=${gp.stepPct}`);
  assert.equal(gp.grids.length, 10);
  assert.ok(gp.grids.every((g) => g.qty % 100 === 0));
});

test('long: K 线不足抛 ERR-DATA-002', () => {
  assert.throws(() => gridPlan({ bars: mkBars(10), budget: 1e5 }), /ERR-DATA-002/);
});

test('long: dilutionReport 手算对齐（工行例）', () => {
  const bars = mkBars(80, { start: 6.1 });
  const lots = [
    { side: 'buy', price: 6.0, qty: 10000, fee: 15 },
    { side: 'buy', price: 5.8, qty: 5000, fee: 10 },
  ];
  const divs = [{ cashPerShare: 0.30 }, { cashPerShare: 0.31 }, { cashPerShare: 0.30 }];
  const r = dilutionReport({ bars, dividends: divs, lots, price: 6.1 });
  // 手工：totalIn=60000+15+29000+10=89025；shares=15000；cost=5.935
  assert.equal(r.costPerShare, 5.935);
  // 股息率 = 0.3033/6.1 ≈ 0.04973；摊薄率 = 0.0497 + 0.3×0.12 − 0.005 ≈ 0.0807
  assert.ok(Math.abs(r.annualDilutionRate - 0.0807) < 0.002, `r=${r.annualDilutionRate}`);
  // ETA = 5.935 / (6.1 × 0.0807) ≈ 12.04
  assert.ok(r.etaYears > 11 && r.etaYears < 13, `eta=${r.etaYears}`);
});

test('long: 无分红史时诚实返回 null ETA', () => {
  const bars = mkBars(80, { start: 6 });
  const r = dilutionReport({ bars, dividends: [], lots: [{ side: 'buy', price: 6, qty: 1000, fee: 5 }], price: 6 });
  assert.equal(r.etaYears, null);
  assert.ok(r.note.includes('诚实拒绝'));
});

test('long: evaluate 跌破网格买格生成买入', () => {
  const bars = mkBars(80, { start: 6, drift: 0 });
  // 人为把最后一根砸到基准价 -10%
  const gp0 = gridPlan({ bars, budget: 100000 });
  bars[bars.length - 1].close = bars[bars.length - 1].adjClose = gp0.basePrice * 0.9;
  const { signals, plan } = longEval({ bars, position: null, account: { equity: 100000 }, symbol: '601398' });
  assert.ok(signals.some((s) => s.action === 'buy' && s.rule === 'LONG.GRID_BUY'));
  assert.ok(plan.orders.some((o) => o.side === 'buy'));
});

// ---- stable ----------------------------------------------------------------
test('stable: adaptiveTarget 手算（vol=1.2% → t=2.4%, s=-1.92%）', () => {
  // 构造恒定 ATR% ≈ 1.2% 的 bars：high-low = 1.2% × close
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({ date: `d${i}`, open: 10, close: 10, high: 10.06, low: 9.94, volume: 1e6, amount: 1e7, adjClose: 10 });
  }
  const t = adaptiveTarget({ bars });
  assert.ok(Math.abs(t.atrPct - 0.012) < 0.001, `atrPct=${t.atrPct}`);
  assert.ok(Math.abs(t.targetPct - 0.024) < 0.002, `t=${t.targetPct}`);
  assert.ok(Math.abs(t.stopLossPct + 0.0192) < 0.002);
  // 盈亏比 1.25 → 要求胜率 44.4%
  assert.equal(t.payoffRatio, 1.25);
});

test('stable: 目标被 clamp 到 [1%,5%]', () => {
  const lowVol = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, open: 10, close: 10, high: 10.01, low: 9.99, adjClose: 10 }));
  assert.equal(adaptiveTarget({ bars: lowVol }).targetPct, 0.01);
  const highVol = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, open: 10, close: 10, high: 11, low: 9, adjClose: 10 }));
  assert.equal(adaptiveTarget({ bars: highVol }).targetPct, 0.05);
});

test('stable: checkPosition 止盈/止损/时间到期', () => {
  const mk = (px) => [{ date: 'd', open: 1, close: px, adjClose: px, high: px, low: px }];
  const contract = { entry: { price: 10 }, takeProfitPct: 0.03, stopLossPct: -0.024, maxHoldDays: 15, holdDays: 3 };
  assert.equal(checkPosition({ bars: mk(10.35), contract, position: { qty: 100 } }).action, 'take_profit');
  assert.equal(checkPosition({ bars: mk(9.7), contract, position: { qty: 100 } }).action, 'stop_loss');
  assert.equal(checkPosition({ bars: mk(10.1), contract: { ...contract, holdDays: 15 }, position: { qty: 100 } }).action, 'time_exit');
  const hold = checkPosition({ bars: mk(10.1), contract, position: { qty: 100 } });
  assert.equal(hold.action, 'hold');
  assert.equal(hold.conditionOrders.length, 2); // 条件单前置：止盈+止损
});

test('stable: entryChecks 弱市拒绝（指数跌破 MA20）', () => {
  const bars = mkBars(80, { start: 10, drift: 0.001 });
  const downIndex = mkBars(30, { start: 4000, drift: -0.005 });
  const { checks, passed } = entryChecks({ bars, indexBars: downIndex });
  assert.equal(checks.indexAboveMa20, false);
  assert.equal(passed, false);
});

// ---- short -----------------------------------------------------------------
const baseCand = {
  symbol: '000001', name: '测试', gainPct: 0.1, turnover: 0.08, volumeRatio: 2.5,
  limitUp: true, blown: false, firstLimitTime: '09:45', boards: 1, floatCap: 5e9,
  amount20Avg: 2e8, listDays: 500, st: false, oneWordBoard: false,
  sealAmount: 2e8, mainNetInflow: 2e7, amount: 3e8, sectorLimitUps: 4,
};
const goodMarket = { indexAboveMa5: true, yesterdayLimitUpPremium: 2.1, blowUpRate: 0.2 };

test('short: 强势首板打分 ≥70', () => {
  const s = scoreOne(baseCand, goodMarket);
  assert.ok(s.score >= 70, `score=${s.score}`);
  assert.equal(s.tradable, true);
});

test('short: 一字板/ST/次新被剔除（不伪造成交）', () => {
  assert.equal(scoreOne({ ...baseCand, oneWordBoard: true }, goodMarket).tradable, false);
  assert.equal(scoreOne({ ...baseCand, st: true }, goodMarket).note, '剔除:ST');
  assert.equal(scoreOne({ ...baseCand, listDays: 30 }, goodMarket).note.includes('次新'), true);
});

test('short: 情绪总闸关闭时候选池为空', () => {
  const r = scoreCandidates({ candidates: [baseCand], market: { indexAboveMa5: true, yesterdayLimitUpPremium: -1.5, blowUpRate: 0.5 } });
  assert.equal(r.open, false);
  assert.equal(r.candidates.length, 0);
});

test('short: 5 日硬期限强制离场', () => {
  const bars = mkBars(10); // 最后一根日期 2026-01-10
  const ep = exitPlan({
    position: { qty: 100, avgPrice: 10 },
    bars,
    contract: { entry: { price: 10, date: '2026-01-01' } },
  });
  assert.equal(ep.mustExit, true);
  assert.equal(ep.action, 'force_exit');
});

test('short: -3% 止损触发', () => {
  const bars = mkBars(6);
  const last = bars.at(-1);
  const ep = exitPlan({
    position: { qty: 100, avgPrice: last.adjClose / 0.95 },
    bars,
    contract: { entry: { price: last.adjClose / 0.95, date: last.date } },
  });
  assert.equal(ep.action, 'stop_loss');
});
