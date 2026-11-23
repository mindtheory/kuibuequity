/**
 * kuibuequity — 短线候选池全市场扫描单测（不联网：globalThis.fetch 全部打桩）
 *
 * 覆盖：
 *  - src/market.js 纯函数：parseClistRow / parseLimitUpRow（字段映射、'-'→null、非法代码）
 *  - src/market.js 联网函数：listStocks 分页/去重/结构异常降级、limitUpPool 无数据不伪造
 *  - src/strategies/shortTerm.js 纯函数：buildCandidatePool 纳入/剔除/涨停池富化
 *  - index.js 端到端：kb_short scan 全市场扫描 / 涨停池降级 / 列表不可达 ERR-DATA-001 / 手工候选池
 *
 * 运行：node --test test/short-pool.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { parseClistRow, parseLimitUpRow, listStocks, limitUpPool } from '../src/market.js';
import { buildCandidatePool } from '../src/strategies/shortTerm.js';

// ---------------------------------------------------------------------------
// fetch 打桩工具（每个用例 try/finally 还原，避免污染其他用例）
// ---------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}

async function withFetch(router, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => router(String(url));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 生成 n 根上升日K行（close 逐日抬升，收盘价站上 MA5，情绪闸门开） */
function klineLines(n = 60, { start = 10, step = 0.05 } = {}) {
  const lines = [];
  const base = Date.UTC(2026, 5, 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(base + i * 86400000).toISOString().slice(0, 10);
    const close = Number((start + i * step).toFixed(2));
    const open = Number((close - 0.02).toFixed(2));
    const high = Number((close + 0.05).toFixed(2));
    const low = Number((close - 0.06).toFixed(2));
    const amount = Math.round(close * 1e7);
    lines.push(`${d},${open},${close},${high},${low},100000,${amount},2.00,0.50,0.03,1.00`);
  }
  return lines;
}

const indexKlinePayload = () => ({ rc: 0, data: { code: '000300', name: '沪深300', klines: klineLines(60) } });

const quotePayload = ({ price = 10, prevClose = 9.9, name = '测试股', volumeLots = 100000 } = {}) => ({
  rc: 0,
  data: {
    f43: Math.round(price * 100),
    f44: Math.round(price * 1.02 * 100),
    f45: Math.round(price * 0.98 * 100),
    f46: Math.round(price * 1.01 * 100),
    f47: volumeLots,
    f48: 1e8,
    f50: 1,
    f57: '600001',
    f58: name,
    f60: Math.round(prevClose * 100),
    f107: 0,
    f168: 800,
    f169: 10,
    f170: 100,
    f171: 5,
  },
});

// clist 原始行（f 字段口径见 docs/data-sources.md §1.6）
const clistRow = (over = {}) => ({
  f12: '600001',
  f14: '强势股份',
  f2: 11,
  f3: 10,
  f5: 100000,
  f6: 200000000,
  f8: 8,
  f10: 1.5,
  f15: 11,
  f16: 10.4,
  f17: 10.5,
  f18: 10,
  f20: 8000000000,
  f21: 5000000000,
  f26: 20200101,
  f62: 10000000,
  ...over,
});

/** clist 原始行 → 归一化 StockRow（parseClistRow 的输出，供纯函数用例直接构造） */
function stockRow(over = {}) {
  const base = {
    code: '600001',
    name: '强势股份',
    market: 'SH',
    price: 11,
    changePct: 10,
    turnoverRate: 0.08,
    volumeRatio: 1.5,
    open: 10.5,
    high: 11,
    low: 10.4,
    prevClose: 10,
    volume: 10000000,
    amount: 200000000,
    floatCap: 5000000000,
    totalCap: 8000000000,
    listDate: '2020-01-01',
    mainNetInflow: 10000000,
    limitUpPrice: 11,
    limitUp: true,
    suspended: false,
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// 1) parseClistRow（纯函数）
// ---------------------------------------------------------------------------

test('parseClistRow: clist 字段映射（价格 2 位、涨跌幅百分数、换手率小数、量 手→股）', () => {
  const row = parseClistRow(clistRow());
  assert.equal(row.code, '600001');
  assert.equal(row.name, '强势股份');
  assert.equal(row.market, 'SH');
  assert.equal(row.price, 11);
  assert.equal(row.changePct, 10); // 百分数，与 quote() 口径一致
  assert.equal(row.turnoverRate, 0.08); // f8=8% → 小数
  assert.equal(row.volumeRatio, 1.5);
  assert.equal(row.volume, 10000000); // 手→股 ×100
  assert.equal(row.amount, 200000000);
  assert.equal(row.floatCap, 5000000000);
  assert.equal(row.listDate, '2020-01-01'); // f26 紧凑日期展开
  assert.equal(row.mainNetInflow, 10000000);
  assert.equal(row.limitUpPrice, 11); // 主板 +10%
  assert.equal(row.limitUp, true);
  assert.equal(row.suspended, false);
});

test('parseClistRow: ST 涨停幅 5%；非法/缺失字段处理（不补 0）', () => {
  const st = parseClistRow(clistRow({ f12: '600053', f14: '*ST九鼎', f2: 4.41, f18: 4.2, f3: 5, f8: 2 }));
  assert.equal(st.limitUpPrice, 4.41); // 4.20 × 1.05，整数分运算
  assert.equal(st.limitUp, true);

  const suspended = parseClistRow(clistRow({ f5: '-', f2: '-', f18: '-', f3: '-' }));
  assert.equal(suspended.price, null);
  assert.equal(suspended.prevClose, null);
  assert.equal(suspended.changePct, null);
  assert.equal(suspended.volume, null);
  assert.equal(suspended.suspended, true, '零成交/缺量视为停牌近似');

  assert.throws(() => parseClistRow({ f12: '510300' }), /ERR-SYMBOL-001/); // ETF 不在范围
  assert.throws(() => parseClistRow({}), /ERR-SYMBOL-001/);
});

// ---------------------------------------------------------------------------
// 2) parseLimitUpRow（纯函数）
// ---------------------------------------------------------------------------

test('parseLimitUpRow: p/1000、封单/连板/炸板/涨停时间/行业映射', () => {
  const row = parseLimitUpRow({
    c: '603324',
    n: '盛剑科技',
    p: 27710,
    zdp: 10.0039,
    amount: 673088896,
    ltsz: 4042291018.2,
    hs: 17.1433,
    lbc: 4,
    fbt: 92501,
    lbt: 140749,
    fund: 43397739,
    zbc: 4,
    hybk: '环保设备',
  });
  assert.equal(row.code, '603324');
  assert.equal(row.name, '盛剑科技');
  assert.equal(row.price, 27.71);
  assert.equal(row.changePct, 10.0039);
  assert.equal(row.turnoverRate, 0.171433);
  assert.equal(row.boards, 4);
  assert.equal(row.firstLimitTime, '09:25:01'); // 5 位补前导 0
  assert.equal(row.lastLimitTime, '14:07:49');
  assert.equal(row.blown, true); // zbc=4
  assert.equal(row.sealAmount, 43397739);
  assert.equal(row.sector, '环保设备');
  assert.equal(row.floatCap, 4042291018.2);

  const plain = parseLimitUpRow({ c: '600001', n: '首板', p: 11000, fbt: null, zbc: 0, lbc: 1 });
  assert.equal(plain.firstLimitTime, null);
  assert.equal(plain.blown, false);
  assert.throws(() => parseLimitUpRow({ c: 'abc' }), /ERR-SYMBOL-001/);
});

// ---------------------------------------------------------------------------
// 3) listStocks / limitUpPool（联网函数，fetch 打桩）
// ---------------------------------------------------------------------------

test('listStocks: 分页抓取 + 按 code 去重 + total/pages 透传（页间无额外 sleep）', async () => {
  const urls = [];
  const page1 = [clistRow({ f12: '600001' }), clistRow({ f12: '000001', f14: '平安深股' })];
  const page2 = [clistRow({ f12: '600001' }), clistRow({ f12: '300001' })]; // 600001 重复
  const router = (url) => {
    urls.push(url);
    const pn = Number(new URL(url).searchParams.get('pn'));
    return jsonResponse({ rc: 0, data: { total: 3, diff: pn === 1 ? page1 : page2 } });
  };
  const res = await withFetch(router, () => listStocks({ pageSize: 2, maxPages: 3, pageSleepMs: 0 }));
  assert.equal(res.rows.length, 3);
  assert.deepEqual(res.rows.map((r) => r.code), ['600001', '000001', '300001']);
  assert.equal(res.total, 3);
  assert.equal(res.pages, 2);
  assert.equal(res.source, 'eastmoney:clist');
  assert.ok(res.asOf);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /pn=1/);
  assert.match(urls[1], /pn=2/);
});

test('listStocks: 第一页结构异常 → ERR-DATA-001（绝不返回伪造候选池）', async () => {
  await withFetch(
    () => jsonResponse({ rc: 0, data: {} }),
    async () => {
      await assert.rejects(() => listStocks({ pageSleepMs: 0 }), (e) => e.code === 'ERR-DATA-001');
    },
  );
});

test('listStocks: 后续页异常 → 保留已抓到的行（诚实部分结果）', async () => {
  const router = (url) => {
    const pn = Number(new URL(url).searchParams.get('pn'));
    if (pn === 1) return jsonResponse({ rc: 0, data: { total: 5, diff: [clistRow({ f12: '600001' }), clistRow({ f12: '000001' })] } });
    return jsonResponse({ rc: 0, data: { total: 5 } }); // 无 diff
  };
  const res = await withFetch(router, () => listStocks({ pageSize: 2, maxPages: 3, pageSleepMs: 0 }));
  assert.equal(res.rows.length, 2);
  assert.equal(res.total, 5);
});

test('limitUpPool: 正常返回涨停池；无数据返回空池 + note（不伪造）', async () => {
  const ok = await withFetch(
    () => jsonResponse({ rc: 0, data: { tc: 2, qdate: 20261120, pool: [
      { c: '603324', n: '盛剑科技', p: 27710, zdp: 10.0039, amount: 1, ltsz: 1, hs: 10, lbc: 2, fbt: 93000, lbt: 145959, fund: 100, zbc: 0, hybk: '环保设备' },
      { c: '600001', n: '首板', p: 11000, zdp: 9.99, amount: 1, ltsz: 1, hs: 5, lbc: 1, fbt: 100000, lbt: 100000, fund: 50, zbc: 1, hybk: '半导体' },
    ] } }),
    () => limitUpPool({ date: '20261120' }),
  );
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.total, 2);
  assert.equal(ok.date, '20261120');
  assert.equal(ok.source, 'eastmoney:push2ex');
  assert.equal(ok.rows[0].boards, 2);

  const empty = await withFetch(
    () => jsonResponse({ rc: 0, data: null }),
    () => limitUpPool({ date: '20261122' }),
  );
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.total, 0);
  assert.match(empty.note, /不伪造/);
});

// ---------------------------------------------------------------------------
// 4) buildCandidatePool（纯函数：纳入规则）
// ---------------------------------------------------------------------------

test('buildCandidatePool: 四条纳入条件各自成立即入选（涨停/涨幅/换手/量比）', () => {
  const quotes = [
    stockRow({ code: '600001', name: '涨停票', changePct: 0.5, turnoverRate: 0.01, volumeRatio: 1 }),
    stockRow({ code: '600002', name: '涨幅票', changePct: 5.2, turnoverRate: 0.01, volumeRatio: 1, limitUp: false, limitUpPrice: 11.6 }),
    stockRow({ code: '600003', name: '换手票', changePct: 1, turnoverRate: 0.061, volumeRatio: 1, limitUp: false, limitUpPrice: 11.6 }),
    stockRow({ code: '600004', name: '量比票', changePct: 1, turnoverRate: 0.02, volumeRatio: 2.5, limitUp: false, limitUpPrice: 11.6 }),
    stockRow({ code: '600005', name: '弱票', changePct: 2, turnoverRate: 0.03, volumeRatio: 1.2, limitUp: false, limitUpPrice: 11.6 }),
  ];
  const res = buildCandidatePool({ quotes, asOf: '2026-11-20', config: {} });
  assert.deepEqual(res.candidates.map((c) => c.symbol), ['600001', '600002', '600003', '600004']);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].symbol, '600005');
  assert.equal(res.rejected[0].rule, 'NOT_STRONG');
  assert.deepEqual(res.stats, { quotes: 5, included: 4, rejected: 1 });
  assert.equal(res.asOf, '2026-11-20');
  assert.match(res.candidates[0].note, /当日成交额代理/);
});

test('buildCandidatePool: 剔除规则逐条命中（ST/次新/市值/成交额/停牌/一字板/缺失字段）', () => {
  const cases = [
    ['600001', { suspended: true }, 'SUSPENDED'],
    ['600002', { name: '*ST九鼎' }, 'ST'],
    ['600003', { listDate: '2026-10-15' }, 'NEW_LISTING'], // 距 2026-11-20 仅 36 自然日
    ['600004', { floatCap: 2e9 }, 'FLOAT_CAP'],
    ['600005', { amount: 5e7 }, 'AMOUNT'],
    ['600006', { open: 11, high: 11, low: 11, price: 11, limitUpPrice: 11, limitUp: true }, 'ONE_WORD'],
    ['600007', { listDate: null }, 'LIST_DATE_MISSING'],
    ['600008', { floatCap: null }, 'FLOAT_CAP_MISSING'],
    ['600009', { amount: null }, 'AMOUNT_MISSING'],
  ].map(([code, over]) => stockRow({ code, name: '样本', limitUp: false, limitUpPrice: 11.6, ...over }));
  const res = buildCandidatePool({ quotes: cases, asOf: '2026-11-20', config: {} });
  assert.equal(res.candidates.length, 0);
  assert.deepEqual(res.rejected.map((r) => r.rule), ['SUSPENDED', 'ST', 'NEW_LISTING', 'FLOAT_CAP', 'AMOUNT', 'ONE_WORD', 'LIST_DATE_MISSING', 'FLOAT_CAP_MISSING', 'AMOUNT_MISSING']);
  assert.ok(res.rejected.every((r) => typeof r.reason === 'string' && r.reason.length > 0));
});

test('buildCandidatePool: 涨停池富化（连板/封单/炸板/板块涨停家数）', () => {
  const quotes = [
    stockRow({ code: '600001', name: '甲', limitUp: true }),
    stockRow({ code: '600002', name: '乙', changePct: 6, limitUp: false, limitUpPrice: 11.6 }),
  ];
  const limitUpRows = [
    { code: '600001', name: '甲', price: 11, changePct: 10, amount: 2e8, floatCap: 5e9, turnoverRate: 0.08, boards: 3, firstLimitTime: '09:25:01', lastLimitTime: '09:25:01', blown: false, sealAmount: 1.2e8, sector: '半导体' },
    { code: '600900', name: '丙', price: 20, changePct: 10, amount: 3e8, floatCap: 9e9, turnoverRate: 0.1, boards: 1, firstLimitTime: '14:00:00', lastLimitTime: '14:30:00', blown: false, sealAmount: 5e7, sector: '半导体' },
    { code: '600901', name: '丁', price: 30, changePct: 10, amount: 4e8, floatCap: 9e9, turnoverRate: 0.12, boards: 1, firstLimitTime: '10:00:00', lastLimitTime: '10:30:00', blown: true, sealAmount: 1e7, sector: '半导体' },
  ];
  const res = buildCandidatePool({ quotes, limitUpRows, asOf: '2026-11-20', config: {} });
  const a = res.candidates.find((c) => c.symbol === '600001');
  assert.equal(a.boards, 3);
  assert.equal(a.firstLimitTime, '09:25:01');
  assert.equal(a.sealAmount, 1.2e8);
  assert.equal(a.blown, false);
  assert.equal(a.sectorLimitUps, 3, '同行业涨停 3 家');
  // 600002 不在涨停池：boards 记 0（不冒充连板），sectorLimitUps 也应为 0
  const b = res.candidates.find((c) => c.symbol === '600002');
  assert.equal(b.boards, 0);
  assert.equal(b.sectorLimitUps, 0);
  assert.equal(b.sealAmount, undefined, '无涨停池数据不得编造封单额');
});

test('buildCandidatePool: 空输入与重复代码（去重、不抛异常）', () => {
  const empty = buildCandidatePool({ quotes: [], asOf: '2026-11-20' });
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.rejected, []);
  assert.deepEqual(empty.stats, { quotes: 0, included: 0, rejected: 0 });

  const dup = buildCandidatePool({ quotes: [stockRow({ code: '600001' }), stockRow({ code: '600001' })], asOf: '2026-11-20' });
  assert.equal(dup.candidates.length, 1);
  assert.equal(dup.stats.quotes, 1);
});

// ---------------------------------------------------------------------------
// 5) index.js 端到端：kb_short scan 全市场扫描（mock ctx + fetch 打桩）
// ---------------------------------------------------------------------------

const registered = new Map();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-short-pool-'));
const plugin = await import('../index.js');
plugin.apply(
  {
    tools: { register: (tool) => registered.set(tool.name, tool) },
    systemPrompt: { section: () => {} },
    inject: () => () => {},
    effect: () => {},
  },
  { dataDir, httpTimeoutMs: 2000 },
);
const call = (name, args) => registered.get(name).execute(args);

/** 全市场扫描路由：clist 涨幅榜 + 涨停池 + 沪深300 日K */
function fullMarketRouter({ ztDisabled = false } = {}) {
  return (url) => {
    if (url.includes('clist/get')) {
      return jsonResponse({ rc: 0, data: { total: 4, diff: [
        clistRow({ f12: '600001', f14: '强势股份' }),
        clistRow({ f12: '600002', f14: '*ST风险', f2: 4.41, f18: 4.2, f3: 5, f8: 2 }),
        clistRow({ f12: '600003', f14: '次新股', f26: 20261015 }),
        clistRow({ f12: '600004', f14: '一字板', f2: 11, f15: 11, f16: 11, f17: 11, f10: 1.5 }),
      ] } });
    }
    if (url.includes('getTopicZTPool')) {
      if (ztDisabled) return jsonResponse({ rc: 0, data: null });
      return jsonResponse({ rc: 0, data: { tc: 3, qdate: 20261120, pool: [
        { c: '600001', n: '强势股份', p: 11000, zdp: 10, amount: 2e8, ltsz: 5e9, hs: 8, lbc: 2, fbt: 92501, lbt: 92501, fund: 1.2e8, zbc: 0, hybk: '半导体' },
        { c: '600900', n: '同板甲', p: 20000, zdp: 10, amount: 3e8, ltsz: 9e9, hs: 10, lbc: 1, fbt: 93000, lbt: 93000, fund: 5e7, zbc: 0, hybk: '半导体' },
        { c: '600901', n: '同板乙', p: 30000, zdp: 10, amount: 4e8, ltsz: 9e9, hs: 12, lbc: 1, fbt: 100000, lbt: 100000, fund: 1e7, zbc: 1, hybk: '半导体' },
      ] } });
    }
    if (url.includes('kline/get')) return jsonResponse(indexKlinePayload());
    return jsonResponse({ rc: 0, data: null });
  };
}

test('kb_short scan: symbols 留空 → 自动全市场扫描，剔除 ST/次新/一字板并打分排序', async () => {
  const r = await withFetch(fullMarketRouter(), () => call('kb_short', { action: 'scan', topN: 10 }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'full-market');
  assert.equal(r.sentimentOpen, true);
  assert.equal(r.pool.included, 1, '4 只里只有 600001 通过剔除规则');
  assert.equal(r.pool.rejectedTotal, 3);
  assert.deepEqual(r.pool.rejected.map((x) => x.rule).sort(), ['NEW_LISTING', 'ONE_WORD', 'ST']);
  assert.equal(r.pool.limitUpPoolRows, 3);
  assert.ok(r.candidates.length >= 1);
  assert.equal(r.candidates[0].symbol, '600001');
  // 封单强度 = fund/ltsz = 1.2e8/5e9 = 2.4% → 16 分；连板 2 → 15 分；同板块 3 家 → 15 分
  assert.equal(r.candidates[0].factors.seal, 16);
  assert.equal(r.candidates[0].factors.boards, 15);
  assert.equal(r.candidates[0].factors.sector, 15);
  assert.ok(r.footnotes.some((f) => f.includes('不构成任何投资建议')));
});

test('kb_short scan: 涨停池不可用 → 降级为仅涨幅榜并给出 warning（不伪造封单/连板）', async () => {
  const r = await withFetch(fullMarketRouter({ ztDisabled: true }), () => call('kb_short', { action: 'scan' }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'full-market');
  assert.equal(r.pool.limitUpPoolRows, 0);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 1);
  assert.equal(r.warnings[0].code, 'ERR-DATA-001');
  // 无涨停池：600001 仍因 clist 涨停价判定入选，但连板/封单因子无数据（boards=1、无 sealAmount）
  const c = r.candidates.find((x) => x.symbol === '600001');
  assert.ok(c, '涨停价由 clist 前收算出，仍可入选');
  assert.equal(c.factors.seal, 0, '无封单数据 → 封单强度记 0，不编造封单额');
  assert.equal(c.sealAmount, undefined);
});

test('kb_short scan: 列表不可达 → ERR-DATA-001 优雅降级（不抛异常、不伪造候选池）', async () => {
  const r = await withFetch(
    () => { throw new Error('offline (test)'); },
    () => call('kb_short', { action: 'scan' }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERR-DATA-001');
});

test('kb_short scan: 手工 symbols 仍可用（向后兼容，mode=manual）', async () => {
  const router = (url) => {
    if (url.includes('stock/get')) return jsonResponse(quotePayload({ price: 10, prevClose: 9.9 }));
    if (url.includes('kline/get')) {
      if (url.includes('secid=1.000300')) return jsonResponse(indexKlinePayload());
      return jsonResponse({ rc: 0, data: { code: '300999', name: '测试股', klines: klineLines(60) } });
    }
    return jsonResponse({ rc: 0, data: null });
  };
  const r = await withFetch(router, () => call('kb_short', { action: 'scan', symbols: '300999', topN: 5 }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'manual');
  assert.equal(r.sentimentOpen, true);
  assert.ok(Array.isArray(r.candidates));
});
