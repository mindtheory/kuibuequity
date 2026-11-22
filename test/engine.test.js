/**
 * kuibuequity — 回测引擎 + 象限账本 单元测试
 *
 * 运行：node --test test/engine.test.js
 * 纯函数 + 临时目录，无网络、无第三方依赖（原则 P2）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runBacktest } from '../src/backtest.js';
import { makeLedger, QUADRANTS } from '../src/ledger.js';
import { DEFAULT_FEE, tradeFee } from '../src/costs.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 造一根 K 线；默认无涨跌停、无停牌、无分红 */
function bar({ date, open, high, low, close, limitUp = false, limitDown = false, suspended = false, dividendPerShare = 0, symbol }) {
  return {
    date,
    open,
    high: high ?? Math.max(open, close),
    low: low ?? Math.min(open, close),
    close,
    volume: 1e6,
    amount: 1e7,
    adjClose: close,
    limitUp,
    limitDown,
    suspended,
    dividendPerShare,
    ...(symbol ? { symbol } : {}),
  };
}

/** 升序日期序列（跳过周末，便于 holdDays 直觉核对） */
function dates(n) {
  const out = [];
  const d = new Date('2026-01-05T00:00:00Z'); // 周一
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 平盘 K 线序列（开=收=price），便于精确手算 */
function flatBars(n, price = 10, overrides = {}) {
  const ds = dates(n);
  return ds.map((date, i) => bar({ date, open: price, close: price, ...(overrides[i] || {}) }));
}

/** 断言抛出指定 ERR-* 码 */
function throwsCode(code, fn, msg) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}：${err.message}`);
    assert.ok(String(err.message).startsWith(`${code}:`), `message 应以 ${code}: 开头，实际：${err.message}`);
    return true;
  }, msg);
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-${tag}-`));
}

const near = (a, b, eps = 1e-9, what = '') =>
  assert.ok(Number.isFinite(a) && Math.abs(a - b) < eps, `${what} 期望 ≈${b}，实际 ${a}`);

// ===========================================================================
// 一、backtest：无未来函数
// ===========================================================================

test('backtest: 最后一根 K 线上的信号不成交（P3 无未来函数）', () => {
  const bars = flatBars(4, 10);
  const signals = [null, null, null, { action: 'buy', qty: 100, reason: '尾盘信号' }];
  const r = runBacktest({ bars, signals });

  assert.equal(r.trades.length, 0, '最后一根的信号不得成交');
  assert.equal(r.metrics.trades, 0);
  const skip = r.skipped.find((s) => s.rule === 'NO_NEXT_BAR');
  assert.ok(skip, '必须留痕 NO_NEXT_BAR');
  assert.match(skip.reason, /无未来函数/);
  // 全程全现金
  for (const row of r.equityCurve) assert.equal(row.equity, 100000);
});

test('backtest: 信号在 bar i 收盘确认、bar i+1 开盘成交（不吃当日收盘）', () => {
  const ds = dates(4);
  const bars = [
    bar({ date: ds[0], open: 10, close: 10 }),
    bar({ date: ds[1], open: 10, close: 100 }), // 收盘暴涨后确认买入信号
    bar({ date: ds[2], open: 20, close: 20 }), // 次日开盘 20 → 必须按 20 成交
    bar({ date: ds[3], open: 30, close: 30 }), // 卖出信号在 bar2 收盘确认 → bar3 开盘 30 成交
  ];
  const signals = [null, { action: 'buy', qty: 100 }, { action: 'sell', qty: 100 }, null];
  const r = runBacktest({ bars, signals });

  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.buyPrice, 20, '成交价必须是次日开盘价，不能是信号当日收盘价 100');
  assert.equal(t.sellPrice, 30);
  assert.equal(t.buyDate, ds[2]);
  assert.equal(t.sellDate, ds[3]);
});

// ===========================================================================
// 二、backtest：T+1 / 整手 / 涨跌停 / 停牌
// ===========================================================================

test('backtest: T+1 —— 当日买入当日不可卖', () => {
  const bars = flatBars(3, 10);
  // 同一收盘确认"买 + 卖"，两者都在 bar1 开盘撮合
  const signals = [[{ action: 'buy', qty: 100, reason: '建仓' }, { action: 'sell', qty: 100, reason: '想当日走' }], null, null];
  const r = runBacktest({ bars, signals });

  assert.equal(r.trades.length, 0, 'T+1 下当日买当日卖不得成对成交');
  const skip = r.skipped.find((s) => s.rule === 'T_PLUS_1');
  assert.ok(skip, '必须留痕 T_PLUS_1');
  assert.equal(r.equityCurve.at(-1).position, 100, '买入的 100 股必须仍在仓');
});

test('backtest: T+1 关闭后当日可卖（tPlus1=false）', () => {
  const bars = flatBars(3, 10);
  const signals = [[{ action: 'buy', qty: 100 }, { action: 'sell', qty: 100 }], null, null];
  const r = runBacktest({ bars, signals, tPlus1: false });
  assert.equal(r.trades.length, 1);
  assert.equal(r.equityCurve.at(-1).position, 0);
});

test('backtest: 买入整手向下取整（250 股 → 200 股）', () => {
  const bars = flatBars(3, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 250 }, null, null] });
  // 未平仓的买入不进 trades（trades 记录已配对平仓的回合，含 sellDate/pnl）
  assert.equal(r.trades.length, 0);
  assert.equal(r.equityCurve.at(-1).position, 200, '必须向下取整到 100 的整数倍');
  assert.equal(r.metrics.totalFees, tradeFee({ side: 'buy', price: 10, qty: 200 }));
});

test('backtest: 不足 1 手跳过并记入 skipped（ERR-PLAN-001）', () => {
  const bars = flatBars(3, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 50 }, null, null] });
  assert.equal(r.trades.length, 0);
  const skip = r.skipped.find((s) => s.rule === 'LOT_ROUND_DOWN');
  assert.ok(skip);
  assert.equal(skip.code, 'ERR-PLAN-001');
});

test('backtest: 一字涨停（limitUp && high===low）买入不成交', () => {
  const bars = flatBars(3, 10, { 1: { limitUp: true, high: 10, low: 10 } });
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null] });
  assert.equal(r.trades.length, 0, '一字涨停买不到，绝不伪造成交（P6）');
  const skip = r.skipped.find((s) => s.rule === 'LIMIT_UP_ONE_WORD');
  assert.ok(skip);
  assert.equal(skip.code, 'ERR-PLAN-002');
});

test('backtest: 跌停（limitDown && high===low）卖出不成交', () => {
  const bars = flatBars(4, 10, { 3: { limitDown: true, high: 10, low: 10 } });
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, { action: 'sell', qty: 100 }, null] });
  assert.equal(r.trades.length, 0);
  const skip = r.skipped.find((s) => s.rule === 'LIMIT_DOWN_ONE_WORD');
  assert.ok(skip);
  assert.equal(skip.code, 'ERR-PLAN-002');
  assert.equal(r.equityCurve.at(-1).position, 100, '卖不掉，持仓仍在');
});

test('backtest: 停牌跳过（双向不成交）', () => {
  const bars = flatBars(3, 10, { 1: { suspended: true } });
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null] });
  assert.equal(r.trades.length, 0);
  const skip = r.skipped.find((s) => s.rule === 'SUSPENDED');
  assert.ok(skip);
  assert.equal(skip.code, 'ERR-PLAN-002');
});

// ===========================================================================
// 三、backtest：费用 / 滑点 / 分红
// ===========================================================================

test('backtest: 费用计入（买入 100 股 @10 元，佣金最低 5 元 + 过户费 0.01）', () => {
  const bars = flatBars(2, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null] });
  const expectFee = tradeFee({ side: 'buy', price: 10, qty: 100 });
  assert.equal(expectFee, 5.01, '万2.5 佣金按 0.25 元但最低 5 元，过户费 0.01');
  assert.equal(r.metrics.totalFees, 5.01);
  // 权益 = 初始 - 买入金额 - 费用 + 市值（开=收=10，市值恰等于买入金额）
  assert.equal(r.equityCurve[1].equity, 100000 - 1000 - 5.01 + 1000);
  near(r.metrics.feeRatio, 5.01 / 100000, 1e-9, 'feeRatio');
});

test('backtest: 滑点来自 fee.slippageBps（买上浮、卖下调）', () => {
  const ds = dates(4);
  const bars = [
    bar({ date: ds[0], open: 10, close: 10 }),
    bar({ date: ds[1], open: 10, close: 10 }),
    bar({ date: ds[2], open: 10, close: 10 }),
    bar({ date: ds[3], open: 12, close: 12 }),
  ];
  const signals = [null, { action: 'buy', qty: 100 }, { action: 'sell', qty: 100 }, null];
  const r = runBacktest({ bars, signals, fee: { ...DEFAULT_FEE, slippageBps: 100 } });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].buyPrice, 10.1, '1% 滑点：买入上浮');
  assert.equal(r.trades[0].sellPrice, 11.88, '1% 滑点：卖出下调');
});

test('backtest: 分红按持股数现金入账，且不计入 trade pnl（不重复计算）', () => {
  const bars = flatBars(4, 10, { 3: { dividendPerShare: 0.5 } });
  const withDiv = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null, null] });
  const noDiv = runBacktest({ bars: flatBars(4, 10), signals: [{ action: 'buy', qty: 100 }, null, null, null] });

  assert.equal(withDiv.metrics.dividends, 50, '100 股 × 0.5 元 = 50 元现金入账');
  near(withDiv.equityCurve[3].equity - noDiv.equityCurve[3].equity, 50, 1e-9, '分红使 equity 增加 50');
  assert.equal(withDiv.trades.length, 0, '未卖出则无 trade，分红不进 pnl');
  assert.equal(withDiv.metrics.totalFees, noDiv.metrics.totalFees, '分红不产生费用');
});

// ===========================================================================
// 四、backtest：数量约束（截断 / 缩量）
// ===========================================================================

test('backtest: 卖出超过持仓 → 截断到持仓并记 skipped', () => {
  const bars = flatBars(4, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 200 }, null, { action: 'sell', qty: 500 }, null] });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].qty, 200, '必须截断到持仓 200 股');
  const skip = r.skipped.find((s) => s.rule === 'SELL_TRUNCATED');
  assert.ok(skip);
  assert.equal(skip.code, 'ERR-LEDGER-003');
});

test('backtest: 现金不足 → 缩量到可负担整手', () => {
  const bars = flatBars(3, 10);
  // 现金 1500 元：想买 1000 股（需 10005.1）→ 逐手缩量到 100 股（1005.01）
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 1000 }, null, null], initialCash: 1500 });
  assert.equal(r.trades.length, 0, '未平仓，不进 trades');
  assert.equal(r.equityCurve.at(-1).position, 100, '必须缩量到可负担的整手');
  assert.ok(r.equityCurve.at(-1).equity <= 1500, '不得透支现金');
  const skip = r.skipped.find((s) => s.rule === 'CASH_SHRINK');
  assert.ok(skip, '缩量必须留痕');
  assert.equal(skip.code, 'ERR-LEDGER-002');
});

test('backtest: 现金连 1 手都买不起 → 跳过并记 skipped', () => {
  const bars = flatBars(3, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null], initialCash: 500 });
  assert.equal(r.trades.length, 0);
  assert.ok(r.skipped.some((s) => s.rule === 'INSUFFICIENT_CASH' && s.code === 'ERR-LEDGER-002'));
});

// ===========================================================================
// 五、backtest：输出结构与指标
// ===========================================================================

test('backtest: 空信号返回全现金（equityCurve 全程 = initialCash）', () => {
  const bars = flatBars(6, 10);
  const r = runBacktest({ bars, signals: [] });
  assert.equal(r.equityCurve.length, 6);
  for (const row of r.equityCurve) {
    assert.equal(row.equity, 100000);
    assert.equal(row.position, 0);
  }
  assert.equal(r.trades.length, 0);
  assert.equal(r.metrics.totalReturn, 0);
  assert.equal(r.metrics.maxDrawdown, 0);
  assert.equal(r.metrics.sharpe, null, '无波动样本不得伪造夏普');
  assert.equal(r.metrics.winRate, null, '空交易胜率必须 null，不得用 0 冒充');
});

test('backtest: equityCurve 长度 === bars 长度且字段齐全', () => {
  const bars = flatBars(7, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null, null, null, null, null] });
  assert.equal(r.equityCurve.length, bars.length);
  r.equityCurve.forEach((row, i) => {
    assert.equal(typeof row.date, 'string');
    assert.equal(row.date, bars[i].date, 'equityCurve 必须与 bars 逐根对齐');
    assert.equal(typeof row.equity, 'number');
    assert.equal(typeof row.position, 'number');
  });
});

test('backtest: metrics 必含契约要求的 10 项', () => {
  const bars = flatBars(6, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null, null, { action: 'sell', qty: 100 }, null] });
  const required = ['totalReturn', 'annualReturn', 'maxDrawdown', 'sharpe', 'trades', 'winRate', 'payoffRatio', 'avgHoldDays', 'feeRatio', 'costToNegativeProgress'];
  for (const k of required) {
    assert.ok(k in r.metrics, `metrics 缺少 ${k}`);
    assert.notEqual(r.metrics[k], undefined);
  }
  assert.equal(typeof r.metrics.trades, 'number');
  assert.equal(r.metrics.trades, 1);
  assert.equal(r.metrics.winRate, 0, '平盘买卖因费用小亏 → 胜率 0（费用必须真的进了 pnl）');
  assert.equal(r.metrics.payoffRatio, null, '无盈利样本时盈亏比必须 null');
  assert.ok(r.metrics.costToNegativeProgress >= 0 && r.metrics.costToNegativeProgress <= 1, '成本转负进度必须在 [0,1]');
});

test('backtest: 6 根 K 线盈亏手算精确对齐（含费用）', () => {
  const ds = dates(6);
  const bars = [
    bar({ date: ds[0], open: 10, close: 10 }),
    bar({ date: ds[1], open: 10, close: 10 }), // 收盘确认买入 → bar2 开盘 10 成交
    bar({ date: ds[2], open: 10, close: 12 }),
    bar({ date: ds[3], open: 12, close: 12 }),
    bar({ date: ds[4], open: 12, close: 13 }), // 收盘确认卖出 → bar5 开盘 12 成交
    bar({ date: ds[5], open: 12, close: 12 }),
  ];
  const signals = [null, { action: 'buy', qty: 100, reason: 'STABLE.ENTRY' }, null, null, { action: 'take_profit', qty: 100, reason: 'STABLE.TP_HIT' }, null];
  const r = runBacktest({ bars, signals });

  // 手算：买入 100 股 @10 → 佣金 max(0.25,5)=5 + 过户 0.01 = 5.01，成本 1005.01
  //       卖出 100 股 @12 → 佣金 max(0.3,5)=5 + 印花税 0.6 + 过户 0.012 = 5.61，净得 1194.39
  //       pnl = 1194.39 − 1005.01 = 189.38
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.buyPrice, 10);
  assert.equal(t.sellPrice, 12);
  assert.equal(t.qty, 100);
  assert.equal(t.pnl, 189.38, 'pnl 必须与手算逐分对齐');
  near(t.pnlPct, 189.38 / 1005.01, 1e-6, 'pnlPct');
  assert.equal(t.holdDays, 3, 'bar2 → bar5 共 3 个交易日');
  assert.equal(t.reason, 'STABLE.TP_HIT');

  assert.equal(r.metrics.totalFees, 10.62, '5.01 + 5.61');
  assert.equal(r.metrics.finalEquity, 100189.38, '期末权益 = 100000 + 189.38');
  near(r.metrics.totalReturn, 0.0018938, 1e-6, 'totalReturn');
  assert.equal(r.metrics.avgHoldDays, 3);
  assert.equal(r.metrics.payoffRatio, null, '无亏损样本时盈亏比必须 null');
  assert.equal(r.equityCurve[2].equity, 100194.99, 'bar2 收盘盯市：98994.99 + 100×12');
});

test('backtest: short 模式 5 日强制离场（硬红线，无需卖出信号）', () => {
  const bars = flatBars(9, 10);
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100 }, null, null, null, null, null, null, null, null], mode: 'short' });
  assert.equal(r.trades.length, 1, '满 5 个交易日必须强制清仓');
  assert.equal(r.trades[0].holdDays, 6, 'bar1 建仓 → bar7 开盘离场');
  assert.match(r.trades[0].reason, /强制清仓/);
  assert.equal(r.equityCurve.at(-1).position, 0, '硬期限后不得留仓');
});

test('backtest: 信号标的与 K 线标的不一致 → 拒绝成交（不伪造价格）', () => {
  const bars = flatBars(3, 10, { 0: { symbol: '600036' } });
  const r = runBacktest({ bars, signals: [{ action: 'buy', qty: 100, symbol: '000001' }, null, null] });
  assert.equal(r.trades.length, 0);
  assert.ok(r.skipped.some((s) => s.rule === 'SYMBOL_MISMATCH' && s.code === 'ERR-SYMBOL-001'));
});

test('backtest: bars 非数组直接抛 ERR-DATA-002', () => {
  throwsCode('ERR-DATA-002', () => runBacktest({ bars: null, signals: [] }));
});

// ===========================================================================
// 六、ledger
// ===========================================================================

test('ledger: 空目录 load 返回空结构；象限枚举固定三档', () => {
  const dir = tmpDir('init');
  const led = makeLedger(dir);
  const s = led.load();
  assert.deepEqual(Object.keys(s).sort(), ['contracts', 'quadrants', 'trades', 'transfers']);
  for (const k of ['quadrants', 'trades', 'contracts', 'transfers']) assert.ok(Array.isArray(s[k]), `${k} 必须是数组`);
  assert.deepEqual(QUADRANTS, ['long', 'stable', 'short']);
  assert.deepEqual(led.audit(), [], '未发生写操作时审计为空');
  assert.equal(fs.existsSync(path.join(dir, 'ledger.json')), false, 'load 不得凭空造文件');
});

test('ledger: initAccount 建账 + 未知象限 ERR-LEDGER-001', () => {
  const led = makeLedger(tmpDir('acct'));
  const acc = led.initAccount({ quadrant: 'long', cash: 60000 });
  assert.deepEqual({ quadrant: acc.quadrant, cash: acc.cash, initialCash: acc.initialCash }, { quadrant: 'long', cash: 60000, initialCash: 60000 });
  assert.equal(typeof acc.updatedAt, 'string');
  assert.equal(led.accounts().length, 1);
  throwsCode('ERR-LEDGER-001', () => led.initAccount({ quadrant: 'margin', cash: 1 }), '三象限之外必须拒绝');
  throwsCode('ERR-LEDGER-001', () => led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 100 }), '未建账象限必须拒绝');
});

test('ledger: 买入后现金与持仓正确（费用回落 costs.tradeFee）', () => {
  const led = makeLedger(tmpDir('buy'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  const t = led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 100, date: '2026-01-05' });
  assert.equal(t.fee, 5.01, '未传 fee 时回落 costs.tradeFee（P4 口径唯一）');
  assert.equal(t.amount, 1000);
  assert.equal(t.id, 'T000001');
  assert.equal(led.accounts()[0].cash, 98994.99, '100000 − (1000 + 5.01)');

  const pos = led.positions('stable');
  assert.equal(pos.length, 1);
  assert.equal(pos[0].qty, 100);
  assert.equal(pos[0].avgPrice, 10);
  assert.equal(pos[0].costPerShare, 10.05, 'costPerShare = 1005.01/100 = 10.05');
  assert.equal(pos[0].negative, false);
  assert.equal(pos[0].openDate, '2026-01-05');
  assert.equal(pos[0].contractId, null);
  assert.equal(led.trades('stable').length, 1);
});

test('ledger: 现金不足抛 ERR-LEDGER-002 且不落库', () => {
  const led = makeLedger(tmpDir('nocash'));
  led.initAccount({ quadrant: 'short', cash: 100 });
  throwsCode('ERR-LEDGER-002', () => led.recordTrade({ quadrant: 'short', symbol: '600036', side: 'buy', price: 10, qty: 100 }));
  assert.equal(led.accounts()[0].cash, 100, '失败写入不得改动现金');
  assert.equal(led.trades().length, 0, '失败写入不得留流水');
});

test('ledger: 卖出超持仓抛 ERR-LEDGER-003', () => {
  const led = makeLedger(tmpDir('nosell'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 100 });
  throwsCode('ERR-LEDGER-003', () => led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'sell', price: 12, qty: 200 }));
  throwsCode('ERR-LEDGER-003', () => led.recordTrade({ quadrant: 'stable', symbol: '000001', side: 'sell', price: 12, qty: 100 }), '无持仓标的卖出同样拒绝');
  assert.equal(led.positions('stable')[0].qty, 100);
  // 正常卖出：现金 = 98994.99 + (1200 − 5.61)
  const s = led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'sell', price: 12, qty: 100 });
  assert.equal(s.fee, 5.61, '卖出含印花税 0.6');
  near(led.accounts()[0].cash, 98994.99 + 1194.39, 1e-9, '卖出后现金');
  assert.deepEqual(led.positions('stable'), [], '清仓后不再出现在持仓中');
});

test('ledger: 契约创建即锁定；override 必须带 reason', () => {
  const led = makeLedger(tmpDir('contract'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  const c = led.addContract({
    quadrant: 'stable',
    symbol: '600036',
    mode: 'stable',
    entry: { price: 10, qty: 100, date: '2026-01-05' },
    takeProfitPct: 0.03,
    stopLossPct: -0.024,
    maxHoldDays: 15,
  });
  assert.equal(c.locked, true, '事前承诺：创建即锁定（P5）');
  assert.equal(c.id, 'C000001');
  assert.deepEqual(c.overrides, []);
  assert.equal(led.contracts().length, 1);

  throwsCode('ERR-CONTRACT-001', () => led.overrideContract({ contractId: c.id, patch: { takeProfitPct: 0.08 } }), '缺 reason 必须拒绝');
  throwsCode('ERR-CONTRACT-001', () => led.overrideContract({ contractId: c.id, patch: { takeProfitPct: 0.08 }, reason: '   ' }), '空白 reason 同样拒绝');
  throwsCode('ERR-CONTRACT-001', () => led.overrideContract({ contractId: 'C999999', patch: { takeProfitPct: 0.08 }, reason: '改一下' }), '不存在的契约必须拒绝');

  const c2 = led.overrideContract({ contractId: c.id, patch: { takeProfitPct: 0.08, locked: false }, reason: '财报提前，止盈上移' });
  assert.equal(c2.takeProfitPct, 0.08);
  assert.equal(c2.locked, true, 'override 不得解除锁定');
  assert.equal(c2.overrides.length, 1);
  assert.equal(c2.overrides[0].reason, '财报提前，止盈上移');
  assert.deepEqual(Object.keys(c2.overrides[0].patch), ['takeProfitPct'], '非白名单字段必须忽略');
});

test('ledger: 短线 5 日强制离场不可放宽（ERR-OVERRIDE-001）', () => {
  const led = makeLedger(tmpDir('hardline'));
  led.initAccount({ quadrant: 'short', cash: 10000 });
  const c = led.addContract({ quadrant: 'short', symbol: '300750', mode: 'short', maxHoldDays: 5 });
  throwsCode('ERR-OVERRIDE-001', () => led.overrideContract({ contractId: c.id, patch: { maxHoldDays: 20 }, reason: '再拿一周' }), '硬红线不接受 override');
  const ok = led.overrideContract({ contractId: c.id, patch: { maxHoldDays: 3 }, reason: '提前离场' });
  assert.equal(ok.maxHoldDays, 3, '收紧期限允许');
});

test('ledger: transfer 跨象限调拨；余额不足 ERR-LEDGER-002', () => {
  const led = makeLedger(tmpDir('transfer'));
  led.initAccount({ quadrant: 'long', cash: 1000 });
  led.initAccount({ quadrant: 'stable', cash: 500 });

  throwsCode('ERR-LEDGER-002', () => led.transfer({ from: 'long', to: 'stable', amount: 5000, reason: '救火' }), '余额不足必须拒绝');
  throwsCode('ERR-LEDGER-001', () => led.transfer({ from: 'long', to: 'long', amount: 100, reason: '自己转自己' }), 'from/to 必须不同象限');
  throwsCode('ERR-LEDGER-001', () => led.transfer({ from: 'long', to: 'stable', amount: 100 }), '调拨必须写 reason');

  const x = led.transfer({ from: 'long', to: 'stable', amount: 400, reason: '按 60/30 再平衡' });
  assert.equal(x.amount, 400);
  assert.equal(x.id, 'X000001');
  const accs = Object.fromEntries(led.accounts().map((a) => [a.quadrant, a.cash]));
  assert.equal(accs.long, 600);
  assert.equal(accs.stable, 900);
  assert.equal(led.transfers().length, 1);
});

test('ledger: 每个写操作都写审计（audit.jsonl 行数对账）', () => {
  const led = makeLedger(tmpDir('audit'));
  led.initAccount({ quadrant: 'long', cash: 1000 }); // 1
  led.initAccount({ quadrant: 'stable', cash: 500 }); // 2
  led.recordTrade({ quadrant: 'long', symbol: '601398', side: 'buy', price: 6, qty: 100 }); // 3
  const c = led.addContract({ quadrant: 'long', symbol: '601398', mode: 'long', takeProfitPct: 0.05 }); // 4
  led.overrideContract({ contractId: c.id, patch: { takeProfitPct: 0.06 }, reason: '股息率上调' }); // 5
  led.transfer({ from: 'long', to: 'stable', amount: 100, reason: '再平衡' }); // 6
  led.auditAppend({ action: 'manual.note', target: 'test', reason: '人工备注' }); // 7

  const rows = led.audit();
  assert.equal(rows.length, 7, '审计行数必须与写操作一一对应');
  assert.deepEqual(rows.map((r) => r.action), ['account.init', 'account.init', 'trade.buy', 'contract.add', 'contract.override', 'transfer', 'manual.note']);
  for (const r of rows) {
    assert.equal(typeof r.at, 'string', '每条审计必须带时间戳');
    assert.ok('reason' in r);
  }
  const ov = rows.find((r) => r.action === 'contract.override');
  assert.equal(ov.reason, '股息率上调', 'override 理由必须进审计');
  assert.equal(ov.after.takeProfitPct, 0.06);
  // 失败的写入不得进审计
  assert.equal(rows.filter((r) => r.action === 'trade.sell').length, 0);
});

test('ledger: 原子写后重读一致（新实例读盘 == 内存态，且无残留 tmp）', () => {
  const dir = tmpDir('atomic');
  const led = makeLedger(dir);
  led.initAccount({ quadrant: 'long', cash: 50000 });
  led.recordTrade({ quadrant: 'long', symbol: '601398', side: 'buy', price: 6, qty: 1000, date: '2026-01-05' });
  led.addContract({ quadrant: 'long', symbol: '601398', mode: 'long', takeProfitPct: 0.05, maxHoldDays: null });

  const left = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(left, [], '原子写不得留下 tmp 残留');
  assert.ok(fs.existsSync(path.join(dir, 'ledger.json')));
  assert.ok(fs.existsSync(path.join(dir, 'audit.jsonl')));

  const led2 = makeLedger(dir);
  assert.deepEqual(led2.load(), led.load(), '重读必须与内存态逐字段一致');
  assert.equal(led2.accounts()[0].cash, led.accounts()[0].cash);
  assert.equal(led2.trades('long').length, 1);
  assert.equal(led2.contracts()[0].locked, true);
  // 损坏的 JSON 必须报错而不是静默清空用户账本
  fs.writeFileSync(path.join(dir, 'ledger.json'), '{ broken');
  throwsCode('ERR-LEDGER-001', () => makeLedger(dir).load(), 'JSON 损坏必须诚实报错');
});

test('ledger: positions 用 costs.holdingCost 算 costPerShare / negative（分红摊薄）', () => {
  const led = makeLedger(tmpDir('negative'));
  led.initAccount({ quadrant: 'long', cash: 100000 });
  // 买 100 股 @10（成本 1005.01），持有期间每股分红 20 元 → 已回收 2000 > 投入 → 成本转负
  led.recordTrade({ quadrant: 'long', symbol: '601398', side: 'buy', price: 10, qty: 100, dividend: 20 });
  const p = led.positions('long')[0];
  assert.equal(p.qty, 100);
  assert.equal(p.dividends, 2000, '分红 = 每股 20 × 100 股');
  assert.equal(p.costPerShare, -9.95, 'costPerShare = (1005.01 − 2000)/100');
  assert.equal(p.negative, true, '成本转负：任何价格卖出都是纯赚');
});

test('ledger: 象限物理隔离 —— 跨象限不得互卖互买', () => {
  const led = makeLedger(tmpDir('isolate'));
  led.initAccount({ quadrant: 'long', cash: 10000 });
  led.initAccount({ quadrant: 'short', cash: 10000 });
  led.recordTrade({ quadrant: 'long', symbol: '601398', side: 'buy', price: 10, qty: 100 });
  throwsCode('ERR-LEDGER-003', () => led.recordTrade({ quadrant: 'short', symbol: '601398', side: 'sell', price: 12, qty: 100 }), '别的象限持仓不能拿来卖');
  assert.equal(led.positions().length, 1);
  assert.equal(led.positions('short').length, 0);
});
