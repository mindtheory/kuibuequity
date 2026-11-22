/**
 * kb_stable 契约落库联动：stable 买入自动锁定契约（t/s/D ← adaptiveTarget），
 * 成交 ↔ 契约 ↔ 持仓 contractId 三者自洽，override 走既有审计。
 *
 * 手算对齐（本文件所有数字均可复算）：
 *   给定 20 根 bar：high=close+1、low=close−1、close=100（TR 恒为 2）
 *   → ATR14 = 2（Wilder 播种后恒定）
 *   → atrPct = 2 / 100 = 0.02
 *   → t = clamp(2 × 0.02, 0.01, 0.05) = 0.04
 *   → s = −0.8 × t = −0.032
 *   → positionPct = min(0.25, 0.01 / 0.032) = min(0.25, 0.3125) = 0.25
 *
 * node --test test/contract-link.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { makeLedger } from '../src/ledger.js';
import { adaptiveTarget, buildLockedContract } from '../src/strategies/stable.js';

const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `kb-link-${tag}-`));

/** 波动率可手算的平盘序列：TR 恒为 2，close 恒为 100 */
function flatBars(n = 20, close = 100) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    adjClose: close,
    volume: 1_000_000,
    amount: 100_000_000,
  }));
}

function throwsCode(code, fn, msg) {
  assert.throws(fn, (e) => String(e.message).includes(code), msg);
}

// ---------------------------------------------------------------------------
// 1. 手算对齐：adaptiveTarget 的 t/s 数值
// ---------------------------------------------------------------------------

test('stable: adaptiveTarget 手算对齐（t=0.04 / s=-0.032 / 仓位 0.25）', () => {
  const t = adaptiveTarget({ bars: flatBars() });
  assert.equal(t.atrPct, 0.02, 'ATR14=2 / close=100 → 0.02');
  assert.equal(t.targetPct, 0.04, 't = clamp(2×0.02, 1%, 5%) = 4%');
  assert.equal(t.stopLossPct, -0.032, 's = −0.8 × 0.04 = −3.2%');
  assert.equal(t.maxHoldDays, 15);
  assert.equal(t.positionPct, 0.25, 'riskPerTrade 1% / |s| 3.2% = 31.25%，被单票上限截到 25%');
  assert.equal(t.payoffRatio, 1.25);
});

test('stable: adaptiveTarget 上下限 clamp（显式 targetPct 仍受 [1%,5%] 约束）', () => {
  const hi = adaptiveTarget({ bars: flatBars(), config: { targetPct: 0.2 } });
  assert.equal(hi.targetPct, 0.05, '超过 5% 上限截断');
  assert.equal(hi.stopLossPct, -0.04);
  const lo = adaptiveTarget({ bars: flatBars(), config: { targetPct: 0.001 } });
  assert.equal(lo.targetPct, 0.01, '低于 1% 下限抬升');
  assert.equal(lo.stopLossPct, -0.008);
  // 显式目标覆盖 ATR 自适应：3% → −2.4%
  const mid = adaptiveTarget({ bars: flatBars(), config: { targetPct: 0.03 } });
  assert.equal(mid.targetPct, 0.03);
  assert.equal(mid.stopLossPct, -0.024);
});

// ---------------------------------------------------------------------------
// 2. 契约草案（纯函数）：t/s/D 全部来自 adaptiveTarget，entry 必须来自真实成交
// ---------------------------------------------------------------------------

test('stable: buildLockedContract 草案字段 = adaptiveTarget + 真实成交 entry', () => {
  const draft = buildLockedContract({
    bars: flatBars(),
    symbol: '600036',
    entry: { price: 10, qty: 1000, date: '2026-11-20' },
  });
  assert.equal(draft.quadrant, 'stable');
  assert.equal(draft.mode, 'stable');
  assert.equal(draft.symbol, '600036');
  assert.deepEqual(draft.entry, { price: 10, qty: 1000, date: '2026-11-20' });
  assert.equal(draft.takeProfitPct, 0.04, 't 必须来自 adaptiveTarget 手算值');
  assert.equal(draft.stopLossPct, -0.032);
  assert.equal(draft.maxHoldDays, 15);
  assert.equal(draft.source, 'adaptiveTarget');
  assert.match(draft.note, /adaptiveTarget/);
});

test('stable: buildLockedContract 诚实失败（缺 symbol / 非法 entry / bars 不足）', () => {
  throwsCode('ERR-SYMBOL-001', () => buildLockedContract({ bars: flatBars(), entry: { price: 10, qty: 100 } }), '缺 symbol');
  throwsCode('ERR-CONTRACT-001', () => buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 0, qty: 100 } }), 'price=0 不可成交');
  throwsCode('ERR-CONTRACT-001', () => buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 10, qty: 150.5 } }), 'qty 必须整数股');
  throwsCode('ERR-DATA-002', () => buildLockedContract({ bars: [], symbol: '600036', entry: { price: 10, qty: 100 } }), '无 K 线不得编造 t/s');
});

// ---------------------------------------------------------------------------
// 3. 账本联动：stable 买入 + 契约同一次落库（原子），contractId 关联持仓
// ---------------------------------------------------------------------------

test('ledger: 买入 + 契约原子落库，trade.contractId ↔ positions.contractId ↔ contracts.id 自洽', () => {
  const dir = tmpDir('atomic');
  const led = makeLedger(dir);
  led.initAccount({ quadrant: 'stable', cash: 100000 });

  const draft = buildLockedContract({
    bars: flatBars(),
    symbol: '600036',
    entry: { price: 10, qty: 1000, date: '2026-11-20' },
  });
  const trade = led.recordTrade({
    quadrant: 'stable',
    symbol: '600036',
    side: 'buy',
    price: 10,
    qty: 1000,
    date: '2026-11-20',
    contract: draft,
  });

  // 费用回落 costs.tradeFee：佣金 max(2.5,5)=5 + 过户费 0.1 → 5.1
  assert.equal(trade.fee, 5.1);
  assert.equal(trade.contractId, 'C000001', '成交必须带契约 id');
  assert.equal(led.accounts()[0].cash, 100000 - (10000 + 5.1));

  const contracts = led.contracts();
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].id, 'C000001');
  assert.equal(contracts[0].locked, true, '建仓即锁定（P5）');
  assert.equal(contracts[0].takeProfitPct, 0.04);
  assert.equal(contracts[0].stopLossPct, -0.032);
  assert.equal(contracts[0].maxHoldDays, 15);
  assert.deepEqual(contracts[0].entry, { price: 10, qty: 1000, date: '2026-11-20' });
  assert.equal(contracts[0].source, 'adaptiveTarget');

  const pos = led.positions('stable')[0];
  assert.equal(pos.qty, 1000);
  assert.equal(pos.contractId, 'C000001', '持仓必须关联契约');

  // 审计顺序：建账 → 成交 → 契约
  assert.deepEqual(led.audit().map((r) => r.action), ['account.init', 'trade.buy', 'contract.add']);
  assert.equal(led.audit()[2].after.id, 'C000001');

  // 新实例重读：成交与契约一起可见（单次 save 的原子性）
  const led2 = makeLedger(dir);
  assert.equal(led2.trades('stable')[0].contractId, 'C000001');
  assert.equal(led2.positions('stable')[0].contractId, 'C000001');
});

test('ledger: 加仓不新建契约 —— 复用 id，t/s/D 保持锁定并写 contract.reuse 审计', () => {
  const led = makeLedger(tmpDir('reuse'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  const first = buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 10, qty: 1000, date: '2026-11-20' } });
  const t1 = led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 1000, date: '2026-11-20', contract: first });

  // 第二次买入（若按新波动率会是 t=0.05，但既有契约不允许被自动改）
  const second = buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 11, qty: 500, date: '2026-11-21' }, config: { targetPct: 0.05 } });
  const t2 = led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 11, qty: 500, date: '2026-11-21', contract: second });

  assert.equal(t2.contractId, t1.contractId, '加仓沿用既有契约 id');
  assert.equal(led.contracts().length, 1, '不得为加仓生成第二张契约');
  const c = led.contracts()[0];
  assert.equal(c.takeProfitPct, 0.04, 't 保持建仓时的锁定值');
  assert.equal(c.stopLossPct, -0.032);
  assert.deepEqual(c.entry, { price: 10, qty: 1000, date: '2026-11-20' }, '历史 entry 不被加仓改写');
  assert.deepEqual(c.overrides, [], '自动回退不走 override');
  assert.equal(led.positions('stable')[0].qty, 1500, '持仓合并为 1500 股');
  assert.equal(led.positions('stable')[0].contractId, t1.contractId);
  assert.equal(led.audit().filter((r) => r.action === 'contract.reuse').length, 1);
  assert.equal(led.contracts()[0].entry.price, 10);
});

test('ledger: 契约与成交不一致 → ERR-CONTRACT-001，整笔不落库（原子回滚）', () => {
  const led = makeLedger(tmpDir('mismatch'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  const draft = buildLockedContract({ bars: flatBars(), symbol: '000001', entry: { price: 10, qty: 100 } });
  throwsCode(
    'ERR-CONTRACT-001',
    () => led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 100, contract: draft }),
    '草案标的与成交标的不一致必须拒绝',
  );
  assert.equal(led.trades().length, 0, '失败不得留流水');
  assert.equal(led.contracts().length, 0, '失败不得留契约');
  assert.equal(led.accounts()[0].cash, 100000, '失败不得动现金');

  // 现金不足同样整笔回滚（不得只落契约）
  throwsCode(
    'ERR-LEDGER-002',
    () => led.recordTrade({ quadrant: 'stable', symbol: '600036', side: 'buy', price: 10, qty: 1000000, contract: buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 10, qty: 1000000 } }) }),
    '现金不足必须在写契约前失败',
  );
  assert.equal(led.contracts().length, 0);
});

// ---------------------------------------------------------------------------
// 4. override 走既有审计（自动锁定的契约与手工契约同一套规则）
// ---------------------------------------------------------------------------

test('ledger: 自动锁定契约的 override 必须带 reason，且逐条写审计', () => {
  const led = makeLedger(tmpDir('override'));
  led.initAccount({ quadrant: 'stable', cash: 100000 });
  const trade = led.recordTrade({
    quadrant: 'stable',
    symbol: '600036',
    side: 'buy',
    price: 10,
    qty: 1000,
    date: '2026-11-20',
    contract: buildLockedContract({ bars: flatBars(), symbol: '600036', entry: { price: 10, qty: 1000, date: '2026-11-20' } }),
  });

  throwsCode('ERR-CONTRACT-001', () => led.overrideContract({ contractId: trade.contractId, patch: { takeProfitPct: 0.05 } }), '缺 reason 必须拒绝');

  const c2 = led.overrideContract({ contractId: trade.contractId, patch: { takeProfitPct: 0.05 }, reason: '财报超预期，止盈上移' });
  assert.equal(c2.takeProfitPct, 0.05);
  assert.equal(c2.locked, true, 'override 不解锁');
  assert.equal(c2.overrides.length, 1);
  assert.equal(c2.overrides[0].reason, '财报超预期，止盈上移');

  const rows = led.audit();
  assert.ok(rows.some((r) => r.action === 'contract.override' && r.reason === '财报超预期，止盈上移'));
  assert.equal(led.positions('stable')[0].contractId, trade.contractId, 'override 后持仓仍关联同一契约');
});
