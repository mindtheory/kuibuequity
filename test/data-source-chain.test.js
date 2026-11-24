/**
 * kuibuequity — 备选数据源适配器（Tushare 备源 + 数据源链）单测（不联网：globalThis.fetch 全部打桩）
 *
 * 覆盖：
 *  - 纯函数：tushareRows / parseTushareDailyRow / barsFromTushare / parseTushareDividendRow /
 *            resolveTushareToken / tushareDateRange
 *  - 联网函数：dailyBars / dividends 的东财→Tushare 源链（失败降级、无 Token 静默跳过、
 *            未知源拒绝、全源失败 ERR-DATA-001、拒绝未复权冒充复权）
 *  - indexBars 只走东财（Tushare 指数未纳入契约）
 *
 * 运行：node --test test/data-source-chain.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tushareRows,
  parseTushareDailyRow,
  barsFromTushare,
  parseTushareDividendRow,
  resolveTushareToken,
  tushareDateRange,
  dailyBars,
  dividends,
  indexBars,
  TUSHARE_TOKEN_ENV,
  TUSHARE_TOKEN_ENV_LEGACY,
} from '../src/market.js';

// ---------------------------------------------------------------------------
// fetch 打桩 / 环境变量隔离（每个用例 try/finally 还原，避免污染其他用例）
// ---------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}

/** 记录请求并按路由应答；router 收到 (url, init)，可读取 POST body */
async function withFetch(router, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return router(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** 暂时清空 Token 环境变量，保证「无 Token」用例与真实环境无关 */
async function withoutTokenEnv(fn) {
  const saved = [process.env[TUSHARE_TOKEN_ENV], process.env[TUSHARE_TOKEN_ENV_LEGACY]];
  delete process.env[TUSHARE_TOKEN_ENV];
  delete process.env[TUSHARE_TOKEN_ENV_LEGACY];
  try {
    return await fn();
  } finally {
    if (saved[0] === undefined) delete process.env[TUSHARE_TOKEN_ENV];
    else process.env[TUSHARE_TOKEN_ENV] = saved[0];
    if (saved[1] === undefined) delete process.env[TUSHARE_TOKEN_ENV_LEGACY];
    else process.env[TUSHARE_TOKEN_ENV_LEGACY] = saved[1];
  }
}

const TS_DAILY_FIELDS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'];
const TS_ADJ_FIELDS = ['ts_code', 'trade_date', 'adj_factor'];
const TS_DIV_FIELDS = ['ts_code', 'end_date', 'div_proc', 'cash_div_tax', 'stk_bo_rate', 'stk_co_rate', 'ex_date'];

const tsOk = (fields, items) => jsonResponse({ code: 0, msg: '', data: { fields, items } });

/**
 * 标准 Tushare 回应：
 *  日线 2 根（2026-11-19 / 2026-11-20），复权因子 2.0 / 2.2
 *  前复权手算：close1 = 10.00×2.0/2.2 = 9.0909，close2 = 11.00×2.2/2.2 = 11
 */
function tusharePayloads() {
  return {
    daily: {
      fields: TS_DAILY_FIELDS,
      items: [
        ['600036.SH', '20261120', 10.9, 11.2, 10.8, 11.0, 10.0, 200000, 200],
        ['600036.SH', '20261119', 9.9, 10.1, 9.8, 10.0, 9.9, 1000000, 100],
      ],
    },
    adj: {
      fields: TS_ADJ_FIELDS,
      items: [
        ['600036.SH', '20261120', 2.2],
        ['600036.SH', '20261119', 2.0],
      ],
    },
    dividend: {
      fields: TS_DIV_FIELDS,
      items: [
        ['600036.SH', '20251231', '实施', 0.5, 0.1, 0.2, '2026-06-20'],
        ['600036.SH', '20241231', '实施', 0.4, 0, 0, '2025-06-20'],
        ['600036.SH', '20261231', '预案', 0.6, 0, 0, ''],
      ],
    },
  };
}

/** 组合路由：东财日K/分红可配失败；Tushare 按 api_name 应答 */
function makeRouter({
  eastmoneyBars = 'fail',
  eastmoneyDiv = 'fail',
  tushare = tusharePayloads(),
  tushareCode = 0,
  tushareMsg = '',
  adjFail = false,
} = {}) {
  return (url, init) => {
    if (url.includes('push2his.eastmoney.com')) {
      if (eastmoneyBars === 'fail') throw new Error('offline (test stub)');
      return jsonResponse(eastmoneyBars);
    }
    if (url.includes('datacenter-web.eastmoney.com')) {
      if (eastmoneyDiv === 'fail') throw new Error('offline (test stub)');
      return jsonResponse(eastmoneyDiv);
    }
    if (url.includes('api.tushare.pro')) {
      if (!init || !init.body) throw new Error('Tushare 必须走 POST JSON（test stub）');
      const body = JSON.parse(init.body);
      if (tushareCode !== 0) return jsonResponse({ code: tushareCode, msg: tushareMsg, data: null });
      if (body.api_name === 'daily') return tsOk(tushare.daily.fields, tushare.daily.items);
      if (body.api_name === 'adj_factor') {
        if (adjFail) return jsonResponse({ code: 2002, msg: '积分不足', data: null });
        return tsOk(tushare.adj.fields, tushare.adj.items);
      }
      if (body.api_name === 'dividend') return tsOk(tushare.dividend.fields, tushare.dividend.items);
      return jsonResponse({ code: 5000, msg: `未知接口 ${body.api_name}`, data: null });
    }
    throw new Error(`未预期的请求: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// 纯函数：tushareRows
// ---------------------------------------------------------------------------

test('tushareRows: fields/items 按位置映射为对象数组', () => {
  const rows = tushareRows({
    fields: ['ts_code', 'adj_factor'],
    items: [
      ['600036.SH', 2.2],
      ['000001.SZ', 1.0],
    ],
  });
  assert.deepEqual(rows, [
    { ts_code: '600036.SH', adj_factor: 2.2 },
    { ts_code: '000001.SZ', adj_factor: 1.0 },
  ]);
});

test('tushareRows: 结构异常/行长不符 → ERR-DATA-001（不猜字段、不补位）', () => {
  for (const bad of [
    null,
    {},
    { fields: ['a'] },
    { items: [] },
    { fields: ['a', 'b'], items: [['x']] }, // 少一列
    { fields: ['a'], items: [['x', 'y']] }, // 多一列
    { fields: ['a'], items: ['not-array'] },
  ]) {
    assert.throws(() => tushareRows(bad), (e) => String(e.message).startsWith('ERR-DATA-001'), JSON.stringify(bad));
  }
  assert.deepEqual(tushareRows({ fields: ['a'], items: [] }), []); // 空结果合法
});

// ---------------------------------------------------------------------------
// 纯函数：resolveTushareToken
// ---------------------------------------------------------------------------

test('resolveTushareToken: 入参优先 > KUIBU_TUSHARE_TOKEN > TUSHARE_TOKEN；空白/null → null', () => {
  const env = { [TUSHARE_TOKEN_ENV]: 'env-primary', [TUSHARE_TOKEN_ENV_LEGACY]: 'env-legacy' };
  assert.equal(resolveTushareToken('explicit', env), 'explicit');
  assert.equal(resolveTushareToken(undefined, env), 'env-primary');
  assert.equal(resolveTushareToken(undefined, { [TUSHARE_TOKEN_ENV_LEGACY]: 'env-legacy' }), 'env-legacy');
  assert.equal(resolveTushareToken('  ', env), 'env-primary'); // 空白视为未提供
  assert.equal(resolveTushareToken(undefined, {}), null);
  assert.equal(resolveTushareToken(undefined, null), null);
  assert.equal(resolveTushareToken('  token-with-space  ', {}), 'token-with-space'); // 两端空白裁掉
});

// ---------------------------------------------------------------------------
// 纯函数：parseTushareDailyRow
// ---------------------------------------------------------------------------

test('parseTushareDailyRow: date 归一、vol 手→股 ×100、amount 千元→元 ×1000', () => {
  const row = parseTushareDailyRow({
    trade_date: '20261120',
    open: 10.9,
    high: 11.2,
    low: 10.8,
    close: 11.0,
    pre_close: 10.0,
    pct_chg: 10.0,
    vol: 200000, // 手
    amount: 200, // 千元
  });
  assert.deepEqual(row, {
    date: '2026-11-20',
    open: 10.9,
    high: 11.2,
    low: 10.8,
    close: 11.0,
    preClose: 10.0,
    volume: 20000000, // 200000 手 × 100 = 2000 万股
    amount: 200000, // 200 千元 × 1000 = 20 万元
    changePct: 10.0,
  });
});

test('parseTushareDailyRow: 也接受 YYYY-MM-DD；缺量/缺额/日期非法 → ERR-DATA-001', () => {
  assert.equal(
    parseTushareDailyRow({ trade_date: '2026-11-20', open: 1, high: 1, low: 1, close: 1, vol: 1, amount: 1 }).date,
    '2026-11-20',
  );
  const bad = [
    { trade_date: '2026-11-20', open: 1, high: 1, low: 1, close: 1, amount: 1 }, // 缺 vol
    { trade_date: '2026-11-20', open: 1, high: 1, low: 1, close: 1, vol: 1 }, // 缺 amount
    { trade_date: '2026-11-20', open: null, high: 1, low: 1, close: 1, vol: 1, amount: 1 },
    { trade_date: '20-11-2026', open: 1, high: 1, low: 1, close: 1, vol: 1, amount: 1 },
  ];
  for (const row of bad) {
    assert.throws(() => parseTushareDailyRow(row), (e) => String(e.message).startsWith('ERR-DATA-001'));
  }
});

// ---------------------------------------------------------------------------
// 纯函数：barsFromTushare（数值手算对齐）
// ---------------------------------------------------------------------------

test('barsFromTushare qfq: price×factor÷最新factor（手算 9.0909 / 11.0000）', () => {
  const daily = [
    { trade_date: '20261119', open: 9.9, high: 10.1, low: 9.8, close: 10.0, pre_close: 9.9, vol: 1000, amount: 100 },
    { trade_date: '20261120', open: 10.9, high: 11.2, low: 10.8, close: 11.0, pre_close: 10.0, vol: 2000, amount: 200 },
  ];
  const adj = [
    { trade_date: '20261119', adj_factor: 2.0 },
    { trade_date: '20261120', adj_factor: 2.2 },
  ];
  const bars = barsFromTushare(daily, adj, { code: '600036', market: 'SH', adjust: 'qfq' });
  assert.equal(bars.length, 2);
  // 2026-11-19：10.00×2.0/2.2 = 9.090909… → 9.0909；high 10.10×2/2.2 = 9.1818；low 9.80×2/2.2 = 8.9091
  assert.deepEqual(
    { open: bars[0].open, high: bars[0].high, low: bars[0].low, close: bars[0].close, adjClose: bars[0].adjClose },
    { open: 9.0, high: 9.1818, low: 8.9091, close: 9.0909, adjClose: 9.0909 },
  );
  // 2026-11-20：11.00×2.2/2.2 = 11
  assert.equal(bars[1].close, 11);
  // 量/额口径：手→股、千元→元
  assert.equal(bars[0].volume, 100000);
  assert.equal(bars[0].amount, 100000);
  // 涨跌停用前收（复权后）：9.0909×1.1 取整到分 = 10.00；close=11 ≥ 10 → 涨停口径成立
  assert.equal(bars[0].limitUp, false); // 首根无前收，不臆测
  assert.equal(bars[1].limitUp, true);
  assert.equal(bars[1].limitDown, false);
  assert.equal(bars[0].dividendPerShare, 0);
  assert.deepEqual(bars.map((b) => b.date), ['2026-11-19', '2026-11-20']); // 上游倒序也按日期升序
});

test('barsFromTushare hfq: price×factor（20.00 / 24.20）；none: 原价', () => {
  const daily = [
    { trade_date: '20261119', open: 9.9, high: 10.1, low: 9.8, close: 10.0, vol: 1000, amount: 100 },
    { trade_date: '20261120', open: 10.9, high: 11.2, low: 10.8, close: 11.0, vol: 2000, amount: 200 },
  ];
  const adj = [
    { trade_date: '20261119', adj_factor: 2.0 },
    { trade_date: '20261120', adj_factor: 2.2 },
  ];
  const hfq = barsFromTushare(daily, adj, { code: '600036', market: 'SH', adjust: 'hfq' });
  assert.deepEqual(hfq.map((b) => b.close), [20, 24.2]);
  const none = barsFromTushare(daily, [], { code: '600036', market: 'SH', adjust: 'none' });
  assert.deepEqual(none.map((b) => b.close), [10, 11]);
  assert.equal(none[0].adjClose, 10);
});

test('barsFromTushare: 复权因子缺失 → ERR-DATA-001（绝不把未复权价冒充复权价）', () => {
  const daily = [
    { trade_date: '20261119', open: 9.9, high: 10.1, low: 9.8, close: 10.0, vol: 1000, amount: 100 },
    { trade_date: '20261120', open: 10.9, high: 11.2, low: 10.8, close: 11.0, vol: 2000, amount: 200 },
  ];
  assert.throws(() => barsFromTushare(daily, [], { code: '600036', market: 'SH', adjust: 'qfq' }), /ERR-DATA-001/);
  // 只有第一天有因子：第二天必须报错，不能悄悄按原价
  assert.throws(
    () => barsFromTushare(daily, [{ trade_date: '20261119', adj_factor: 2.0 }], { code: '600036', market: 'SH', adjust: 'qfq' }),
    /ERR-DATA-001/,
  );
});

// ---------------------------------------------------------------------------
// 纯函数：parseTushareDividendRow
// ---------------------------------------------------------------------------

test('parseTushareDividendRow: 仅“实施”入契约；税前 cash_div_tax、送股/转增按每股', () => {
  assert.deepEqual(
    parseTushareDividendRow({
      div_proc: '实施',
      cash_div_tax: 0.5,
      stk_bo_rate: 0.1,
      stk_co_rate: 0.2,
      ex_date: '2026-06-20',
    }),
    { exDate: '2026-06-20', cashPerShare: 0.5, bonusShares: 0.1, capitalizeShares: 0.2 },
  );
  // 空值按 0（0 有明确语义：不送/不转/不派）
  assert.deepEqual(
    parseTushareDividendRow({ div_proc: '实施', cash_div_tax: null, stk_bo_rate: null, stk_co_rate: null, ex_date: '2026-06-20' }),
    { exDate: '2026-06-20', cashPerShare: 0, bonusShares: 0, capitalizeShares: 0 },
  );
  // 预案 / 无除权日 → 不入契约
  assert.equal(parseTushareDividendRow({ div_proc: '预案', cash_div_tax: 0.6, ex_date: '2026-06-20' }), null);
  assert.equal(parseTushareDividendRow({ div_proc: '实施', cash_div_tax: 0.6, ex_date: '' }), null);
});

// ---------------------------------------------------------------------------
// 纯函数：tushareDateRange
// ---------------------------------------------------------------------------

test('tushareDateRange: end=北京今天，start=回看 max(120, days×2+30) 自然日', () => {
  const now = new Date('2026-11-23T04:00:00Z'); // 北京 2026-11-23 12:00
  // days=250 → 回看 max(120, 530) = 530 天：2026-11-23 − 530d = 2025-06-11
  assert.deepEqual(tushareDateRange(250, now), { startDate: '20250611', endDate: '20261123' });
  // days=1 → 回看 120 天：2026-11-23 − 120d = 2026-07-26
  assert.deepEqual(tushareDateRange(1, now), { startDate: '20260726', endDate: '20261123' });
  // 上下限保护：days=99999 → 2000 根 → 回看 2000×2+30=4030，被 4000 截断
  assert.deepEqual(tushareDateRange(99999, now), { startDate: '20151211', endDate: '20261123' });
});

// ---------------------------------------------------------------------------
// 源链：dailyBars
// ---------------------------------------------------------------------------

test('dailyBars: 东财不可达 → Tushare 备源成功，source 标注实际源，attempts 留痕', async () => {
  await withFetch(makeRouter(), async (calls) => {
    const res = await dailyBars('600036', { days: 2, tushareToken: 'test-token', retryDelaysMs: [] });
    assert.equal(res.source, 'tushare:daily');
    assert.deepEqual(res.sourceChain, ['eastmoney', 'tushare']);
    assert.equal(res.attempts.length, 2);
    assert.equal(res.attempts[0].source, 'eastmoney');
    assert.equal(res.attempts[0].ok, false);
    assert.equal(res.attempts[0].code, 'ERR-DATA-001');
    assert.equal(res.attempts[1].source, 'tushare');
    assert.equal(res.attempts[1].ok, true);
    assert.equal(res.count, 2);
    assert.deepEqual(res.bars.map((b) => b.close), [9.0909, 11]);
    assert.equal(typeof res.stale, 'boolean');
    assert.equal(res.adjust, 'qfq');
    assert.equal(res.warnings.length, 1); // Tushare 无名称 → ST 判定提示（诚实标注）
    // 请求次数：1 次东财（不重试）+ 2 次 Tushare（daily + adj_factor）
    assert.equal(calls.filter((c) => c.url.includes('push2his.eastmoney.com')).length, 1);
    const tsCalls = calls.filter((c) => c.url.includes('api.tushare.pro'));
    assert.equal(tsCalls.length, 2);
    // Token 只在 POST 请求体，绝不进 URL
    for (const c of tsCalls) {
      assert.match(c.init.body, /"token":"test-token"/);
      assert.doesNotMatch(c.url, /test-token/);
    }
  });
});

test('dailyBars: 无 Token 时 Tushare 静默跳过（不请求、不报 Token 错误），全源失败抛 ERR-DATA-001', async () => {
  await withoutTokenEnv(async () => {
    await withFetch(makeRouter(), async (calls) => {
      await assert.rejects(
        () => dailyBars('600036', { days: 2, retryDelaysMs: [] }),
        (e) => {
          assert.match(e.message, /^ERR-DATA-001/);
          assert.match(e.message, /跳过（未配置 Token/);
          assert.match(e.message, /eastmoney/);
          assert.doesNotMatch(e.message, /test-token/);
          return true;
        },
      );
      assert.equal(calls.filter((c) => c.url.includes('api.tushare.pro')).length, 0); // 无 Token 不联网
    });
  });
});

test('dailyBars: 未知源名 → ERR-DATA-001（拼写错误不静默跳过）；sources=[] 亦拒绝', async () => {
  await withFetch(makeRouter(), async (calls) => {
    for (const sources of [['eastmoney', 'tusharex'], ['sina'], []]) {
      await assert.rejects(
        () => dailyBars('600036', { sources, tushareToken: 't', retryDelaysMs: [] }),
        (e) => String(e.message).startsWith('ERR-DATA-001'),
        JSON.stringify(sources),
      );
    }
    assert.equal(calls.length, 0); // 参数错误不触发任何网络请求
  });
});

test('dailyBars: 全部源失败（Tushare code≠0）→ ERR-DATA-001 汇总，不回显 Token', async () => {
  await withFetch(makeRouter({ tushareCode: 2002, tushareMsg: 'token 无效' }), async () => {
    await assert.rejects(
      () => dailyBars('600036', { tushareToken: 'secret-token', retryDelaysMs: [] }),
      (e) => {
        assert.match(e.message, /^ERR-DATA-001/);
        assert.match(e.message, /eastmoney: /);
        assert.match(e.message, /tushare: .*code=2002/);
        assert.doesNotMatch(e.message, /secret-token/);
        return true;
      },
    );
  });
});

test('dailyBars: sources=[\'tushare\'] 显式只用备源，东财一次都不请求', async () => {
  await withFetch(makeRouter(), async (calls) => {
    const res = await dailyBars('600036', { days: 2, sources: ['tushare'], tushareToken: 't', retryDelaysMs: [] });
    assert.equal(res.source, 'tushare:daily');
    assert.deepEqual(res.sourceChain, ['tushare']);
    assert.equal(res.attempts.length, 1);
    assert.equal(calls.filter((c) => c.url.includes('eastmoney')).length, 0);
  });
});

test('dailyBars: qfq 但复权因子接口失败 → Tushare 源诚实失败，不返回未复权假冒数据', async () => {
  await withFetch(makeRouter({ adjFail: true }), async () => {
    await assert.rejects(
      () => dailyBars('600036', { days: 2, sources: ['tushare'], tushareToken: 't', retryDelaysMs: [] }),
      (e) => {
        assert.match(e.message, /^ERR-DATA-001/);
        assert.match(e.message, /adj_factor.*code=2002/);
        return true;
      },
    );
  });
});

test('dailyBars: 东财成功时不触发备源（source=eastmoney:push2his）', async () => {
  const eastmoneyBars = {
    rc: 0,
    data: {
      code: '600036',
      name: '招商银行',
      klines: ['2026-11-20,42.90,44.00,44.16,42.70,4780213,20680356045.00,3.40,2.49,1.07,2.32'],
    },
  };
  await withFetch(makeRouter({ eastmoneyBars }), async (calls) => {
    const res = await dailyBars('600036', { days: 1, tushareToken: 't', retryDelaysMs: [] });
    assert.equal(res.source, 'eastmoney:push2his');
    assert.deepEqual(res.sourceChain, ['eastmoney', 'tushare']);
    assert.deepEqual(res.attempts, [{ source: 'eastmoney', ok: true }]);
    assert.equal(res.count, 1);
    assert.equal(calls.filter((c) => c.url.includes('api.tushare.pro')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 源链：dividends
// ---------------------------------------------------------------------------

test('dividends: 东财失败 → Tushare 备源，仅“实施”、按 exDate 降序、标注实际 source', async () => {
  await withFetch(makeRouter(), async () => {
    const res = await dividends('600036', { tushareToken: 't', retryDelaysMs: [] });
    assert.equal(res.source, 'tushare:dividend');
    assert.equal(res.count, 2);
    assert.deepEqual(res.items, [
      { exDate: '2026-06-20', cashPerShare: 0.5, bonusShares: 0.1, capitalizeShares: 0.2 },
      { exDate: '2025-06-20', cashPerShare: 0.4, bonusShares: 0, capitalizeShares: 0 },
    ]);
    assert.deepEqual(res.attempts.map((a) => a.ok), [false, true]);
    assert.equal(res.warnings.length, 0);
  });
});

test('dividends: 东财成功即返回主源，不请求 Tushare', async () => {
  const eastmoneyDiv = {
    result: {
      data: [
        { EX_DIVIDEND_DATE: '2026-06-20 00:00:00', PRETAX_BONUS_RMB: 5, BONUS_RATIO: 1, IT_RATIO: 2 },
      ],
    },
  };
  await withFetch(makeRouter({ eastmoneyDiv }), async (calls) => {
    const res = await dividends('600036', { tushareToken: 't', retryDelaysMs: [] });
    assert.equal(res.source, 'eastmoney:datacenter');
    assert.deepEqual(res.items, [
      { exDate: '2026-06-20', cashPerShare: 0.5, bonusShares: 0.1, capitalizeShares: 0.2 },
    ]);
    assert.equal(calls.filter((c) => c.url.includes('api.tushare.pro')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// indexBars：只走东财（Tushare 指数需 index_daily，未纳入契约）
// ---------------------------------------------------------------------------

test('indexBars: 即使配置了 Token 也只走东财，不因备源缺失而改道', async () => {
  await withFetch(makeRouter(), async (calls) => {
    await assert.rejects(
      () => indexBars('000300', { days: 60, retryDelaysMs: [] }),
      (e) => {
        assert.match(e.message, /^ERR-DATA-001/);
        assert.match(e.message, /eastmoney/);
        assert.doesNotMatch(e.message, /tushare/); // 指数不走 Tushare 备源
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.url.includes('api.tushare.pro')).length, 0);
  });
});
