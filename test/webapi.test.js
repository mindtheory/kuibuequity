/**
 * Web 面板 API 路由测试：mock webServer 注册表，直接调 handler。
 * 离线路由（state/trade/review）必须 ok:true；联网路由断网优雅 ERR-DATA-001。
 * node --test test/webapi.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { registerWebRoutes } from '../src/webapi.js';
import { resolveFee } from '../src/costs.js';

const routes = new Map();
const ctx = {
  inject(_deps, fn) {
    fn({ webServer: { register: (r) => { routes.set(r.path, r); return { dispose() {} }; } } });
    return () => {};
  },
  effect() { return () => {}; },
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-web-'));
registerWebRoutes({ ctx, config: {}, dataDir, fee: resolveFee({}), timeoutMs: 4000, adjust: 'qfq' });

function mockRes() {
  const res = { code: 0, body: null, headers: null };
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers; return res; };
  res.end = (body) => { res.body = body; };
  return res;
}

async function call(pathname, { method = 'GET', body } = {}) {
  const route = routes.get(pathname.split('?')[0]) || [...routes.entries()].find(([k]) => pathname.startsWith(k))?.[1];
  assert.ok(route, `路由未注册: ${pathname}`);
  const req = {
    method,
    url: pathname,
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data' && body != null) cb(Buffer.from(JSON.stringify(body)));
      if (ev === 'end') setImmediate(cb);
    },
  };
  const res = mockRes();
  await route.handler(req, res);
  return { code: res.code, json: JSON.parse(res.body) };
}

// register 的 mock 已直接收集路由

test('webapi: 8 条路由全部注册', () => {
  for (const p of ['/api/kuibuequity/state', '/api/kuibuequity/quote', '/api/kuibuequity/sentiment', '/api/kuibuequity/plan', '/api/kuibuequity/init', '/api/kuibuequity/trade', '/api/kuibuequity/check', '/api/kuibuequity/review']) {
    assert.ok(routes.has(p), `缺少路由 ${p}`);
  }
});

test('webapi: loopback 守卫 —— 非本机 403', async () => {
  const route = routes.get('/api/kuibuequity/state');
  const res = mockRes();
  await route.handler({ method: 'GET', url: '/api/kuibuequity/state', socket: { remoteAddress: '10.0.0.5' }, on() {} }, res);
  assert.equal(res.code, 403);
  assert.equal(JSON.parse(res.body).code, 'ERR-AUTHZ-001');
});

test('webapi: state 初始为空账本', async () => {
  const r = await call('/api/kuibuequity/state');
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.positions));
});

test('webapi: init 建账 → trade 录入 → state 可见（离线可用）', async () => {
  const init = await call('/api/kuibuequity/init', { method: 'POST', body: { quadrant: 'long', cash: 100000 } });
  assert.equal(init.json.ok, true);
  const r = await call('/api/kuibuequity/trade', { method: 'POST', body: { quadrant: 'long', symbol: '601398', side: 'buy', price: 6, qty: 1000 } });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.trade.fee > 0);
  const s = await call('/api/kuibuequity/state');
  assert.ok(s.json.positions.some((p) => p.symbol === '601398'));
});

test('webapi: trade 缺参拒绝', async () => {
  const r = await call('/api/kuibuequity/trade', { method: 'POST', body: { quadrant: 'long' } });
  assert.equal(r.json.ok, false);
});

test('webapi: review 离线可用', async () => {
  const r = await call('/api/kuibuequity/review?period=all');
  assert.equal(r.json.ok, true);
  assert.ok(r.json.trades >= 1);
});

test('webapi: quote 缺 symbol → ERR-SYMBOL-001', async () => {
  const r = await call('/api/kuibuequity/quote');
  assert.equal(r.json.code, 'ERR-SYMBOL-001');
});

test('webapi: 联网路由断网优雅降级（ERR-DATA-001，不 500）', async () => {
  const r = await call('/api/kuibuequity/sentiment');
  assert.equal(r.code, 200); // 错误走 200 + ok:false，UI 统一处理
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'ERR-DATA-001');
});
