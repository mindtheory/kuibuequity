/**
 * 长期象限「分红再投」单元测试（纯函数，无网络无时钟）
 *
 * 契约：docs/interface.md §7.1、docs/strategies.md §1.2(b)
 * 口径：除息现金按**除息价**折成整手底仓股数；除息价一律用未复权 close；
 *       含费用买不起就少买一手，不足 1 手进 rejected（P6 不伪造成交）。
 * 全部期望值均手算写死在断言注释里，方便逐条核对。
 *
 * node --test test/reinvest.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reinvestPlan, evaluate as longEval, dilutionReport, gridPlan } from '../src/strategies/longTerm.js';
import { tradeFee } from '../src/costs.js';

/** 80 根平盘 K 线：基准价 = 6.00（60 日中位），ATR% ≈ 2% → 步长夹逼到 3% */
function mkFlatBars(n = 80, px = 6) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      date: `2026-${String(Math.floor(i / 21) + 1).padStart(2, '0')}-${String((i % 21) + 1).padStart(2, '0')}`,
      open: px, close: px, high: px * 1.01, low: px * 0.99, volume: 1e6, amount: 1e6 * px,
      adjClose: px, limitUp: false, limitDown: false, suspended: false, dividendPerShare: 0,
    });
  }
  return bars;
}

/** 把最后一根改成「除息日」：可分别指定未复权 close 与前复权 adjClose */
function exDateBars({ close = 6, adjClose = null, dps = 0, date = '2026-11-26', n = 80 } = {}) {
  const bars = mkFlatBars(n);
  const last = bars[n - 1];
  last.date = date;
  last.close = close;
  last.adjClose = adjClose == null ? close : adjClose;
  last.high = Math.max(last.open, close) * 1.01;
  last.low = Math.min(last.open, close) * 0.99;
  last.dividendPerShare = dps;
  return bars;
}

// ---- 关闭态 ----------------------------------------------------------------

test('reinvest: 默认关闭 → enabled=false、不产生任何决策', () => {
  const bars = exDateBars({ close: 6, dps: 0.6 });
  const r = reinvestPlan({ bars, position: { qty: 5000 } }); // 不传 config = meta 默认 reinvest:false
  assert.equal(r.enabled, false);
  assert.equal(r.qty, 0);
  assert.equal(r.cashDividend, 0);
  assert.equal(r.rejected, null, '关闭态是"没开这个功能"，不是失败，不能有 rejected');
  // 字符串 'false' 也不得被当成 true（只有显式 true 才开）
  assert.equal(reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: 'true' } }).enabled, false);
});

test('reinvest: evaluate 默认关闭时不生成 LONG.REINVEST 信号', () => {
  const bars = exDateBars({ close: 6, dps: 0.6 });
  const { signals, plan } = longEval({ bars, position: { qty: 5000 }, account: { equity: 100000 }, symbol: '601398' });
  assert.equal(signals.some((s) => s.rule === 'LONG.REINVEST'), false);
  assert.equal(plan.orders.length, 0);
});

// ---- 手算对齐 --------------------------------------------------------------

test('reinvest: 手算 0.6 元 × 5000 股 = 3000 元，除息价 5.80 → 500 股（费 5.03）', () => {
  const bars = exDateBars({ close: 5.8, dps: 0.6 });
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true } });
  // 手算：cash = 0.6 × 5000 = 3000
  assert.equal(r.cashDividend, 3000);
  assert.equal(r.dividendPerShare, 0.6);
  assert.equal(r.shares, 5000);
  assert.equal(r.exDate, '2026-11-26');
  assert.equal(r.price, 5.8);
  // 手算：3000 / 5.8 / 100 = 5.17 手 → 向下取 500 股
  //       成交额 500×5.8 = 2900；佣金 max(2900×0.00025=0.725, 5) = 5；过户费 2900×0.00001 = 0.029
  //       费用 5.029 → round2 = 5.03；2900 + 5.03 = 2905.03 ≤ 3000 ✓ → 500 股
  assert.equal(r.qty, 500);
  assert.equal(r.fee, 5.03);
  assert.equal(r.fee, tradeFee({ side: 'buy', price: 5.8, qty: 500 }), '费用口径必须与 costs.tradeFee 一致');
  assert.equal(r.rejected, null);
});

test('reinvest: 整手向下取整（3000 元 / 7.30 → 400 股，不是 410）', () => {
  const bars = exDateBars({ close: 7.3, dps: 0.6 });
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true } });
  // 手算：3000 / 7.3 = 410.9 → floor 到 100 的倍数 = 400 股
  //       400×7.3 = 2920；佣金 max(0.73,5)=5；过户 0.0292 → 5.0292 → 5.03；2925.03 ≤ 3000 ✓
  assert.equal(r.qty, 400);
  assert.equal(r.fee, 5.03);
});

test('reinvest: 费用会把最后一手吃掉（1000 元 / 10.00 → 0 股，TOO_SMALL）', () => {
  // 手算：0.1 × 10000 = 1000 元现金；10.00 × 100 = 1000 元整，加 5.01 元费用 = 1005.01 > 1000
  //       不赊账 → 回退到 0 股 → rejected，绝不伪造 100 股成交
  const bars = exDateBars({ close: 10, dps: 0.1 });
  const r = reinvestPlan({ bars, position: { qty: 10000 }, config: { reinvest: true } });
  assert.equal(r.cashDividend, 1000);
  assert.equal(r.qty, 0);
  assert.equal(r.fee, 0);
  assert.equal(r.rejected.rule, 'LONG.REINVEST_TOO_SMALL');
  assert.ok(r.rejected.reason.includes('1000'));
});

test('reinvest: 除息价取未复权 close，绝不混用 adjClose', () => {
  // 同一根 bar：close=6.00（真实除息价）、adjClose=5.00（前复权，被除息压低）
  const bars = exDateBars({ close: 6, adjClose: 5, dps: 0.6 });
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true } });
  // 手算（正确口径，用 close）：3000/6/100 = 5 手 → 500 股 → 3000 + 5.03 > 3000 → 回退 400 股
  //   （400×6=2400；佣金 5；过户 0.024 → 5.02；2405.02 ≤ 3000 ✓）
  assert.equal(r.price, 6);
  assert.equal(r.qty, 400);
  // 若误用 adjClose=5.00：3000/5 = 600 股 —— 那就是一笔"多算 200 股"的伪造成交
  assert.notEqual(r.qty, 600);
});

test('reinvest: 无持仓 → NO_POSITION（有除息但没股份可分）', () => {
  const bars = exDateBars({ close: 6, dps: 0.6 });
  const r = reinvestPlan({ bars, position: null, config: { reinvest: true } });
  assert.equal(r.qty, 0);
  assert.equal(r.cashDividend, 0);
  assert.equal(r.rejected.rule, 'LONG.REINVEST_NO_POSITION');
  assert.equal(r.shares, 0);
});

test('reinvest: 除息日缺有效 close → NO_PRICE，不编造股数', () => {
  const bars = exDateBars({ close: 6, dps: 0.6 });
  bars[bars.length - 1].close = null; // 停牌/缺价
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true } });
  assert.equal(r.qty, 0);
  assert.equal(r.price, null);
  assert.equal(r.rejected.rule, 'LONG.REINVEST_NO_PRICE');
});

test('reinvest: 非除息日 → 什么都不做（不是失败，rejected 为 null）', () => {
  const bars = exDateBars({ close: 6, dps: 0 });
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true }, dividends: [] });
  assert.equal(r.enabled, true);
  assert.equal(r.qty, 0);
  assert.equal(r.exDate, null);
  assert.equal(r.rejected, null);
});

// ---- 分红历史通道（行情层日K恒无 dividendPerShare） -------------------------

test('reinvest: bar 无分红时从 dividends[] 命中同一除息日', () => {
  const bars = exDateBars({ close: 6, dps: 0 }); // 模拟 market.js 产出的日K：dividendPerShare 恒 0
  const dividends = [
    { exDate: '2026-06-12', cashPerShare: 0.31 }, // 历史除息日，不得触发
    { exDate: '2026-11-26', cashPerShare: 0.5 }, // 当日除息 → 现金 0.5×5000 = 2500
  ];
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true }, dividends });
  // 手算：2500 / 6 = 416.6 → 400 股；400×6 = 2400 + 5.02 = 2405.02 ≤ 2500 ✓
  assert.equal(r.dividendPerShare, 0.5);
  assert.equal(r.exDate, '2026-11-26');
  assert.equal(r.cashDividend, 2500);
  assert.equal(r.qty, 400);
  assert.equal(r.rejected, null);
});

test('reinvest: dividends 里非当日 exDate 不触发', () => {
  const bars = exDateBars({ close: 6, dps: 0 });
  const r = reinvestPlan({ bars, position: { qty: 5000 }, config: { reinvest: true }, dividends: [{ exDate: '2026-11-25', cashPerShare: 0.5 }] });
  assert.equal(r.qty, 0);
  assert.equal(r.rejected, null);
});

// ---- evaluate 集成 ---------------------------------------------------------

test('evaluate: reinvest=true + 除息 → 生成 LONG.REINVEST 买单（整手、次日执行）', () => {
  const bars = exDateBars({ close: 6, dps: 0.6 }); // 6.00 在基准价 ±3% 内，不触发网格
  const { signals, plan, diagnostics } = longEval({
    bars, position: { qty: 5000 }, account: { equity: 100000 }, symbol: '601398', config: { reinvest: true },
  });
  const sig = signals.find((s) => s.rule === 'LONG.REINVEST');
  assert.ok(sig, '必须生成分红再投信号');
  assert.equal(sig.action, 'buy');
  assert.equal(sig.qty, 400); // 手算同前：3000 元按 6.00 折算，含费回退到 400 股
  assert.equal(sig.price, 6);
  assert.ok(plan.orders.some((o) => o.side === 'buy' && o.rule === 'LONG.REINVEST'));
  assert.equal(diagnostics.reinvest.qty, 400, 'diagnostics 必须带出再投明细（便于解释"为什么没下单"）');
});

test('evaluate: 同日网格买入与再投同向 → 保留网格买入，再投留痕 DEDUPED', () => {
  const base = gridPlan({ bars: exDateBars({ close: 6, dps: 0 }), budget: 100000 });
  // 把最后价砸到基准价下 5%：必然触发网格买入，同时当天除息 0.6 元
  const bars = exDateBars({ close: base.basePrice * 0.95, dps: 0.6 });
  const { signals, plan } = longEval({
    bars, position: { qty: 5000 }, account: { equity: 100000 }, symbol: '601398', config: { reinvest: true },
  });
  const buys = plan.orders.filter((o) => o.side === 'buy');
  assert.equal(buys.length, 1, '同标的同向去重后只能有 1 张买单');
  assert.equal(buys[0].rule, 'LONG.GRID_BUY', '网格买入优先保留');
  assert.ok(plan.rejected.some((r) => r.rule === 'LONG.REINVEST_DEDUPED'), '再投被去重必须留痕，不静默丢单');
  assert.equal(signals.some((s) => s.rule === 'LONG.REINVEST'), false);
});

test('evaluate: 再投不足 1 手 → 进 rejected（不伪造成交）', () => {
  const bars = exDateBars({ close: 6, dps: 0.001 }); // 0.001 × 1000 = 1 元，连 1 手都买不起
  const { plan } = longEval({
    bars, position: { qty: 1000 }, account: { equity: 100000 }, symbol: '601398', config: { reinvest: true },
  });
  assert.equal(plan.orders.length, 0, '不足 1 手不得生成买单（也不得同向冒充网格单）');
  assert.ok(plan.rejected.some((r) => r.rule === 'LONG.REINVEST_TOO_SMALL'));
});

// ---- dilutionReport 口径提示 ------------------------------------------------

test('dilutionReport: reinvestEnabled 回显，并在 note 里提醒再投会让转负更慢', () => {
  const bars = mkFlatBars(80, 6);
  const lots = [{ side: 'buy', price: 6, qty: 1000, fee: 5 }];
  const off = dilutionReport({ bars, dividends: [{ cashPerShare: 0.3 }], lots, price: 6, config: {} });
  assert.equal(off.reinvestEnabled, false);
  assert.equal(off.note.includes('分红再投'), false);
  const on = dilutionReport({ bars, dividends: [{ cashPerShare: 0.3 }], lots, price: 6, config: { reinvest: true } });
  assert.equal(on.reinvestEnabled, true);
  assert.ok(on.note.includes('分红再投'), '开启再投必须如实提醒"totalRecovered 不增、转负更慢"');
  // ETA 公式不因再投而打折（不是"再投会更快"的假承诺）
  assert.equal(on.etaYears, off.etaYears);
});
