/**
 * 插件入口冒烟测试：mock ctx 加载 apply()，8 个 kb_* 工具全部注册并可调用。
 * 离线工具（kb_account/kb_risk/kb_review）必须返回 ok:true；
 * 联网工具（kb_market 等）在断网环境必须优雅返回 ERR-DATA-001（不抛异常）。
 * node --test test/plugin.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const registered = new Map();
const promptSections = [];

function makeMockCtx() {
  return {
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
      },
    },
    systemPrompt: {
      section(s) { promptSections.push(s); },
    },
    effect() {},
  };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-'));
const mod = await import('../index.js');
mod.apply(makeMockCtx(), { dataDir, httpTimeoutMs: 4000 });

/** defineTool().execute 直接返回业务对象（render 才转文本） */
const call = (name, args) => registered.get(name).execute(args);

/**
 * fetch 打桩：让「断网降级」用例与真实网络环境解耦（CI/办公网/境外出口都可稳定复现）。
 * 不打桩的断网断言会在能联网的机器上失败 —— 那不是产品 bug，是测试依赖环境，属于禁止项。
 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 恒定波动的日K桩：TR = max(0.2, 0.1, 0.1) = 0.2 → ATR%=0.02 → t=4% / s=-3.2% */
function stableKlinePayload(n = 60) {
  const lines = [];
  const base = Date.UTC(2026, 5, 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(base + i * 86400000).toISOString().slice(0, 10);
    lines.push(`${d},10.00,10.00,10.10,9.90,100000,100000000,2.00,0.00,0.00,1.00`);
  }
  return { rc: 0, data: { code: '600036', name: '招商银行', klines: lines } };
}

async function withOffline(fn) {
  return withFetch(() => Promise.reject(new Error('offline (test stub)')), fn);
}

const TOOL_NAMES = ['kb_market', 'kb_account', 'kb_longterm', 'kb_stable', 'kb_short', 'kb_backtest', 'kb_risk', 'kb_review'];

test('apply: 注册全部 8 个 kb_* 工具 + systemPrompt 纪律段', () => {
  for (const n of TOOL_NAMES) assert.ok(registered.has(n), `缺少工具 ${n}`);
  assert.equal(registered.size, 8);
  assert.equal(promptSections.length, 1);
  assert.ok(promptSections[0].text().includes('不构成投资建议'));
});

test('kb_risk redlines：返回三象限红线与硬红线说明', async () => {
  const r = await call('kb_risk', { action: 'redlines' });
  assert.equal(r.ok, true);
  assert.ok(r.redLines.short.hardMaxHoldDays === 5);
  assert.ok(/(不接受|不可) override/.test(r.hardRedLine));
});

test('kb_risk check：超单票上限被闸门挡下', async () => {
  const r = await call('kb_risk', { action: 'check', mode: 'stable', signalValue: 50000, accountValue: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.gate.allowed, false);
  assert.equal(r.gate.code, 'ERR-RISK-003');
});

test('kb_account：init → trade → status 全链路（临时账本，日K打桩）', async () => {
  const init = await call('kb_account', { action: 'init', quadrant: 'stable', cash: 100000, totalAsset: 100000 });
  assert.equal(init.ok, true);
  const trade = await withFetch(
    () => ({ ok: true, status: 200, json: async () => stableKlinePayload() }),
    () => call('kb_account', { action: 'trade', quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 1000, date: '2026-11-20' }),
  );
  assert.equal(trade.ok, true);
  assert.ok(trade.trade.fee > 0, '费用应自动按费率计算');
  const status = await call('kb_account', { action: 'status' });
  assert.equal(status.ok, true);
  const pos = status.positions.find((p) => p.symbol === '600036');
  assert.ok(pos && pos.qty === 1000);
  // 行情打桩（TR=0.2 → ATR%=0.02）：t = 2×0.02 = 4%，s = −0.8t = −3.2%（手算对齐）
  assert.ok(trade.contract, 'stable 买入必须自动锁定契约');
  assert.equal(trade.contract.locked, true);
  assert.equal(trade.contract.takeProfitPct, 0.04);
  assert.equal(trade.contract.stopLossPct, -0.032);
  assert.ok(Math.abs(trade.contract.takeProfitPct * 0.8 + trade.contract.stopLossPct) < 1e-9, 's = −0.8t');
  assert.equal(trade.contract.id, trade.trade.contractId);
  assert.equal(pos.contractId, trade.contract.id, '持仓必须关联该契约');
});

test('kb_account transfer：无 reason 拒绝（跨象限必须留痕）', async () => {
  const r = await call('kb_account', { action: 'transfer', quadrant: 'stable', to: 'short', amount: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('reason'));
});

test('kb_review：空账本复盘不崩', async () => {
  const r = await call('kb_review', { period: 'week' });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.overrides));
});

test('kb_market：断网时优雅返回 ERR-DATA-001（不抛异常、不伪造数据）', async () => {
  const r = await withOffline(() => call('kb_market', { action: 'bars', symbol: '601398', days: 5 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERR-DATA-001');
});

test('kb_longterm：断网时优雅返回 ERR-DATA-001', async () => {
  const r = await withOffline(() => call('kb_longterm', { action: 'grid', symbol: '601398' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERR-DATA-001');
});

test('kb_stable expectancy：样本不足返回 INSUFFICIENT_SAMPLE', async () => {
  const r = await call('kb_stable', { action: 'expectancy' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'INSUFFICIENT_SAMPLE');
});

test('kb_short sentiment：断网时优雅返回 ERR-DATA-001', async () => {
  const r = await withOffline(() => call('kb_short', { action: 'sentiment' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERR-DATA-001');
});

test('kb_backtest：断网时优雅返回 ERR-DATA-001', async () => {
  const r = await withOffline(() => call('kb_backtest', { mode: 'stable', symbol: '601398', days: 60 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERR-DATA-001');
});

test('非法参数被 defineTool schema 挡下（INVALID_ARGS，不进业务代码）', async () => {
  await assert.rejects(
    () => call('kb_risk', { action: 'nope' }),
    (e) => e.code === 'INVALID_ARGS' || /must be one of/.test(e.message),
  );
});
