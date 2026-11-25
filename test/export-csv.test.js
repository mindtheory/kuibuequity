/**
 * 条件单导出（纯函数）：契约+持仓 → 券商议价条件单参数 → CSV。
 *
 * 手算对齐（全部数字可复算）：
 *   entry = 10.00，t = +4%，s = −3.2%，qty = 1000
 *   止盈触发价 = 10.00 × 1.04 = 10.40
 *   止损触发价 = 10.00 × 0.968 = 9.68
 *   entry.date = 2026-11-20（周五），maxHoldDays = 15 个交易日
 *     → 11/23,24,25,26,27,30（6）+ 12/1,2,3,4（10）+ 12/7,8,9,10,11（15）
 *     → validUntil = 2026-12-11
 *   entry = 10.01 时：10.01 × 1.04 = 10.4104 → 10.41（四舍五入 2 位）；
 *                      10.01 × 0.968 = 9.68968 → 9.69
 *
 * node --test test/export-csv.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONDITION_ORDER_CSV_HEADER, conditionOrdersFromContracts, renderConditionOrdersCsv } from '../src/plan.js';

function mkContract(over = {}) {
  return {
    id: 'C1',
    quadrant: 'stable',
    symbol: '600036',
    mode: 'stable',
    entry: { price: 10, qty: 1000, date: '2026-11-20' },
    takeProfitPct: 0.04,
    stopLossPct: -0.032,
    maxHoldDays: 15,
    locked: true,
    createdAt: '2026-11-20T15:00:00+08:00',
    ...over,
  };
}

function mkPosition(over = {}) {
  return { quadrant: 'stable', symbol: '600036', qty: 1000, contractId: 'C1', ...over };
}

// ---------------------------------------------------------------------------
// 1. 契约 → 条件单：触发价/委托价/数量/有效期（手算）
// ---------------------------------------------------------------------------

test('export: 契约+持仓 → 止盈/止损两条条件单，触发价手算对齐', () => {
  const { orders, warnings } = conditionOrdersFromContracts({
    contracts: [mkContract()],
    positions: [mkPosition()],
  });
  assert.deepEqual(warnings, []);
  assert.equal(orders.length, 2);
  const [tp, sl] = orders;
  assert.equal(tp.type, 'take_profit');
  assert.equal(tp.side, 'sell');
  assert.equal(tp.triggerPrice, 10.4, '10.00 × 1.04 = 10.40');
  assert.equal(tp.orderPrice, 10.4, '委托价 = 触发价（到价即限价挂出）');
  assert.equal(tp.qty, 1000);
  assert.equal(tp.priceType, 'limit');
  assert.equal(tp.validUntil, '2026-12-11', '2026-11-20 + 15 个交易日（只跳周末）');
  assert.equal(sl.type, 'stop_loss');
  assert.equal(sl.triggerPrice, 9.68, '10.00 × 0.968 = 9.68');
  assert.equal(sl.orderPrice, 9.68);
  assert.equal(sl.validUntil, '2026-12-11');
});

test('export: 触发价四舍五入到 2 位（10.01 × 1.04 = 10.4104 → 10.41）', () => {
  const { orders } = conditionOrdersFromContracts({
    contracts: [mkContract({ entry: { price: 10.01, qty: 1000, date: '2026-11-20' } })],
    positions: [mkPosition()],
  });
  assert.equal(orders[0].triggerPrice, 10.41);
  assert.equal(orders[1].triggerPrice, 9.69, '10.01 × 0.968 = 9.68968 → 9.69');
});

test('export: validUntil 按 maxHoldDays 跳周末（5 日：11/20 周五 → 11/27 周五）', () => {
  const { orders } = conditionOrdersFromContracts({
    contracts: [mkContract({ maxHoldDays: 5 })],
    positions: [mkPosition()],
  });
  // 11/23,24,25,26,27 = 5 个交易日
  assert.equal(orders[0].validUntil, '2026-11-27');
});

// ---------------------------------------------------------------------------
// 2. 契约选取与去重
// ---------------------------------------------------------------------------

test('export: 优先使用 position.contractId 精确匹配的契约（不用更新的那条）', () => {
  const { orders } = conditionOrdersFromContracts({
    contracts: [
      mkContract({ id: 'C1', takeProfitPct: 0.04, stopLossPct: -0.032, createdAt: '2026-11-20T15:00:00+08:00' }),
      mkContract({ id: 'C2', takeProfitPct: 0.05, stopLossPct: -0.04, createdAt: '2026-11-21T15:00:00+08:00' }),
    ],
    positions: [mkPosition({ contractId: 'C1' })],
  });
  assert.equal(orders[0].triggerPrice, 10.4, 'C1 的 +4% → 10.40，而不是 C2 的 10.50');
  assert.equal(orders[1].triggerPrice, 9.68);
});

test('export: 无 contractId 时退化为该标的最新契约（createdAt 最大）', () => {
  const { orders } = conditionOrdersFromContracts({
    contracts: [
      mkContract({ id: 'C1', takeProfitPct: 0.04, createdAt: '2026-11-20T15:00:00+08:00' }),
      mkContract({ id: 'C2', takeProfitPct: 0.05, stopLossPct: -0.04, createdAt: '2026-11-21T15:00:00+08:00' }),
    ],
    positions: [mkPosition({ contractId: null })],
  });
  assert.equal(orders[0].triggerPrice, 10.5, '最新契约 +5% → 10.50');
});

test('export: 同一标的多条持仓行只导出一次（不重复挂单）', () => {
  const { orders } = conditionOrdersFromContracts({
    contracts: [mkContract()],
    positions: [mkPosition(), mkPosition({ contractId: 'C1' })],
  });
  assert.equal(orders.length, 2, '每标的仍是止盈/止损两条');
});

test('export: 已清仓（qty=0）不导出，也不产生 warning', () => {
  const { orders, warnings } = conditionOrdersFromContracts({
    contracts: [mkContract()],
    positions: [mkPosition({ qty: 0 })],
  });
  assert.deepEqual(orders, []);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// 3. 诚实失败：缺契约 / 契约不完整 / 日期非法
// ---------------------------------------------------------------------------

test('export: 持仓无锁定契约 → STABLE.NO_CONTRACT，不导出伪条件单', () => {
  const { orders, warnings } = conditionOrdersFromContracts({
    contracts: [],
    positions: [mkPosition({ contractId: null })],
  });
  assert.deepEqual(orders, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'STABLE.NO_CONTRACT');
  assert.equal(warnings[0].symbol, '600036');
  assert.ok(warnings[0].message.includes('kb_stable'));
});

test('export: 契约缺 entry.price / t / s → STABLE.CONTRACT_INCOMPLETE', () => {
  const a = conditionOrdersFromContracts({
    contracts: [mkContract({ takeProfitPct: null })],
    positions: [mkPosition()],
  });
  assert.deepEqual(a.orders, []);
  assert.equal(a.warnings[0].code, 'STABLE.CONTRACT_INCOMPLETE');

  const b = conditionOrdersFromContracts({
    contracts: [mkContract({ entry: { price: 0, qty: 1000, date: '2026-11-20' } })],
    positions: [mkPosition()],
  });
  assert.deepEqual(b.orders, []);
  assert.equal(b.warnings[0].code, 'STABLE.CONTRACT_INCOMPLETE');
});

test('export: entry.date 缺失/非法 → validUntil=null（空单元格，不伪造日期）', () => {
  for (const date of [null, '2026-02-30', '20261120', '2026/11/20']) {
    const { orders } = conditionOrdersFromContracts({
      contracts: [mkContract({ entry: { price: 10, qty: 1000, date } })],
      positions: [mkPosition()],
    });
    assert.equal(orders[0].validUntil, null, `date=${String(date)} 不得编造有效期`);
    const csv = renderConditionOrdersCsv(orders);
    assert.ok(csv.includes('600036,sell,10.4,10.4,1000,\r\n'), '空单元格必须是空串，不能写 null');
  }
});

test('export: 入参非数组 → ERR-EXPORT-001（不静默当空处理）', () => {
  assert.throws(() => conditionOrdersFromContracts({ contracts: null, positions: [] }), /ERR-EXPORT-001/);
  assert.throws(() => conditionOrdersFromContracts({ contracts: [], positions: 'x' }), /ERR-EXPORT-001/);
  assert.throws(() => renderConditionOrdersCsv(null), /ERR-EXPORT-001/);
});

// ---------------------------------------------------------------------------
// 4. CSV 渲染：表头/BOM/CRLF/RFC4180 转义
// ---------------------------------------------------------------------------

test('export: CSV 表头固定 + 默认 UTF-8 BOM + CRLF 行尾', () => {
  const csv = renderConditionOrdersCsv([
    { symbol: '600036', side: 'sell', triggerPrice: 10.4, orderPrice: 10.4, qty: 1000, validUntil: '2026-12-11' },
  ]);
  assert.ok(csv.startsWith('\ufeff'), '默认带 BOM（Excel 直开不乱码）');
  assert.equal(csv.slice(1).split('\r\n')[0], 'symbol,side,triggerPrice,orderPrice,qty,validUntil');
  assert.deepEqual(CONDITION_ORDER_CSV_HEADER, ['symbol', 'side', 'triggerPrice', 'orderPrice', 'qty', 'validUntil']);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2, '表头 + 1 行数据');
  assert.ok(csv.endsWith('\r\n'));
  // bom:false 用于非 Excel 消费者
  const plain = renderConditionOrdersCsv([], { bom: false });
  assert.equal(plain, 'symbol,side,triggerPrice,orderPrice,qty,validUntil\r\n');
});

test('export: CSV 单元格 RFC4180 转义（逗号/引号/换行）+ null 写空', () => {
  const csv = renderConditionOrdersCsv([
    { symbol: 'A"B', side: 'sell', triggerPrice: 10.4, orderPrice: 10.4, qty: 1000, validUntil: '2026-12-11,盘后' },
    { symbol: '600036', side: 'sell', triggerPrice: null, orderPrice: 10.4, qty: 1000, validUntil: null },
  ], { bom: false });
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '"A""B",sell,10.4,10.4,1000,"2026-12-11,盘后"');
  assert.equal(lines[2], '600036,sell,,10.4,1000,', 'null 必须是空单元格，不能写 "null"');
});

test('export: 完整链路 CSV 内容与 orders 顺序一致（止盈在前、止损在后）', () => {
  const { orders } = conditionOrdersFromContracts({ contracts: [mkContract()], positions: [mkPosition()] });
  const lines = renderConditionOrdersCsv(orders, { bom: false }).split('\r\n').filter(Boolean);
  assert.deepEqual(lines, [
    'symbol,side,triggerPrice,orderPrice,qty,validUntil',
    '600036,sell,10.4,10.4,1000,2026-12-11',
    '600036,sell,9.68,9.68,1000,2026-12-11',
  ]);
});
