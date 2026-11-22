/**
 * kuibuequity — Web 面板 API（节点半区）
 *
 * 设计：docs/web-panel.md §4。路由挂在 /api/kuibuequity/*，
 * 只读为主，唯一写 = 录入成交（本地账本，不接券商，P1）。
 * loopback 守卫：allowLanState=false（默认）时仅本机可访问。
 */
import { quote, dailyBars, indexBars } from './market.js';
import { sentimentGate, hardExitCheck } from './risk.js';
import { tradeFee } from './costs.js';
import { winRate, payoffRatio } from './indicators.js';

function writeJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function isAllowedRequest(req, allowLan) {
  if (allowLan) return true;
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 262144) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

function errCode(e) {
  const msg = String((e && e.message) || e || 'unknown');
  const m = msg.match(/^(ERR-[A-Z]+-\d{3}):\s*/);
  return { code: m ? m[1] : 'ERR-INTERNAL', message: msg };
}

/**
 * 注册全部面板路由。deps: { ctx, config, dataDir, fee, timeoutMs, adjust }
 * @returns {() => void} dispose
 */
export function registerWebRoutes({ ctx, config, dataDir, fee, timeoutMs, adjust }) {
  const disposer = ctx.inject(['webServer'], (wctx) => {
    const allowLan = config.allowLanState === true; // 默认关：面板只允许本机
    const routes = [];
    const guard = (handler) => async (req, res) => {
      if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { ok: false, code: 'ERR-AUTHZ-001', message: 'forbidden: loopback-only（allowLanState=false）' });
      try { return await handler(req, res); } catch (e) {
        const { code, message } = errCode(e);
        return writeJson(res, 200, { ok: false, code, message });
      }
    };
    const getLedger = async () => {
      const mod = await import('./ledger.js');
      return mod.makeLedger(dataDir);
    };

    // ---- GET /api/kuibuequity/state：三象限账户 + 持仓 + 契约 ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/state',
      handler: guard(async (req, res) => {
        const ledger = await getLedger();
        writeJson(res, 200, {
          ok: true,
          accounts: ledger.accounts(),
          positions: ledger.positions(),
          contracts: ledger.contracts(),
          fee,
          asOf: new Date().toISOString(),
        });
      }),
    }));

    // ---- GET /api/kuibuequity/quote?symbol= ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/quote',
      handler: guard(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const symbol = url.searchParams.get('symbol');
        if (!symbol) return writeJson(res, 200, { ok: false, code: 'ERR-SYMBOL-001', message: '缺少 symbol' });
        writeJson(res, 200, { ok: true, ...(await quote(symbol, { timeoutMs })) });
      }),
    }));

    // ---- GET /api/kuibuequity/sentiment：情绪总闸（沪深300 vs MA5） ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/sentiment',
      handler: guard(async (req, res) => {
        const idx = await indexBars('000300', { days: 10, timeoutMs });
        const closes = idx.bars.map((b) => b.adjClose ?? b.close);
        const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length);
        const g = sentimentGate({ indexAboveMa5: closes.at(-1) >= ma5 });
        writeJson(res, 200, { ok: true, index: { close: closes.at(-1), ma5: Math.round(ma5 * 100) / 100 }, ...g, asOf: idx.asOf, stale: idx.stale });
      }),
    }));

    // ---- POST /api/kuibuequity/plan {mode,symbol,days?} → 指令单 + 条件单 ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/plan',
      handler: guard(async (req, res) => {
        const body = await readBody(req);
        const { mode, symbol } = body || {};
        if (!mode || !symbol) return writeJson(res, 200, { ok: false, code: 'ERR-INTERNAL', message: '需要 mode 与 symbol' });
        const strat = (await import('./strategies/index.js')).registry[mode];
        if (!strat) return writeJson(res, 200, { ok: false, code: 'ERR-SYMBOL-001', message: `未知象限 ${mode}` });
        const barsRes = await dailyBars(symbol, { days: body.days || 250, adjust, timeoutMs });
        const ledger = await getLedger();
        const position = ledger.positions(mode).find((p) => p.symbol === symbol) || null;
        const contract = ledger.contracts().find((c) => c.symbol === symbol) || null;
        const res2 = strat.evaluate({ bars: barsRes.bars, position, contract, account: { equity: 0 }, config: {}, symbol });
        const { toConditionOrders } = await import('./plan.js');
        writeJson(res, 200, { ok: true, mode, symbol, asOf: barsRes.asOf, stale: barsRes.stale, plan: res2.plan, conditionOrders: res2.plan ? toConditionOrders(res2.plan) : [] });
      }),
    }));

    // ---- POST /api/kuibuequity/init：象限建账（面板首次使用） ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/init',
      handler: guard(async (req, res) => {
        if ((req.method || 'GET') !== 'POST') return writeJson(res, 405, { ok: false, code: 'ERR-INTERNAL', message: 'POST only' });
        const b = await readBody(req);
        if (!b?.quadrant) return writeJson(res, 200, { ok: false, code: 'ERR-INTERNAL', message: '需要 quadrant' });
        const ledger = await getLedger();
        const account = ledger.initAccount({ quadrant: b.quadrant, cash: Number(b.cash) || 0, totalAsset: Number(b.totalAsset) || Number(b.cash) || 0 });
        writeJson(res, 200, { ok: true, account });
      }),
    }));

    // ---- POST /api/kuibuequity/trade：录入成交（唯一写；stable 买入自动锁契约） ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/trade',
      handler: guard(async (req, res) => {
        if ((req.method || 'GET') !== 'POST') return writeJson(res, 405, { ok: false, code: 'ERR-INTERNAL', message: 'POST only' });
        const b = await readBody(req);
        const { quadrant, symbol, side, price, qty } = b || {};
        if (!quadrant || !symbol || !side || !(price > 0) || !(qty > 0)) {
          return writeJson(res, 200, { ok: false, code: 'ERR-INTERNAL', message: '需要 quadrant/symbol/side/price/qty' });
        }
        const ledger = await getLedger();
        const autoFee = b.fee != null ? Number(b.fee) : tradeFee({ side, price, qty, fee });
        const trade = ledger.recordTrade({ quadrant, symbol, side, price, qty, fee: autoFee, date: b.date, note: b.note || 'web 面板录入' });
        writeJson(res, 200, { ok: true, trade, positions: ledger.positions(quadrant) });
      }),
    }));

    // ---- POST /api/kuibuequity/check {symbol} → stable 持仓体检 ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/check',
      handler: guard(async (req, res) => {
        const b = await readBody(req);
        if (!b?.symbol) return writeJson(res, 200, { ok: false, code: 'ERR-SYMBOL-001', message: '需要 symbol' });
        const stable = (await import('./strategies/index.js')).registry.stable;
        const barsRes = await dailyBars(b.symbol, { days: 120, adjust, timeoutMs });
        const ledger = await getLedger();
        const contract = ledger.contracts().find((c) => c.symbol === b.symbol) || null;
        const position = ledger.positions('stable').find((p) => p.symbol === b.symbol) || null;
        const chk = stable.checkPosition({ bars: barsRes.bars, contract, position });
        const hard = position ? hardExitCheck({ openDate: position.openDate, asOf: barsRes.asOf }) : null;
        writeJson(res, 200, { ok: true, symbol: b.symbol, asOf: barsRes.asOf, stale: barsRes.stale, ...chk, hardExit: hard });
      }),
    }));

    // ---- GET /api/kuibuequity/review?period=&quadrant= ----
    routes.push(wctx.webServer.register({
      kind: 'exact',
      path: '/api/kuibuequity/review',
      handler: guard(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const period = url.searchParams.get('period') || 'week';
        const quadrant = url.searchParams.get('quadrant') || undefined;
        const ledger = await getLedger();
        const cutoff = new Date();
        if (period === 'week') cutoff.setDate(cutoff.getDate() - 7);
        else if (period === 'month') cutoff.setMonth(cutoff.getMonth() - 1);
        const inPeriod = (d) => !d || period === 'all' || new Date(d) >= cutoff;
        const trades = (ledger.trades(quadrant) || []).filter((t) => inPeriod(t.date));
        const closed = trades.filter((t) => typeof t.pnl === 'number');
        const overrides = (ledger.contracts() || []).flatMap((c) => (c.overrides || []).filter((o) => inPeriod(o.at)).map((o) => ({ contractId: c.id, symbol: c.symbol, ...o })));
        writeJson(res, 200, {
          ok: true, period, quadrant: quadrant || 'all', trades: trades.length,
          winRate: winRate(closed), payoffRatio: payoffRatio(closed), overrides,
          disciplineNote: overrides.length ? `本期 ${overrides.length} 次 override，逐条核对理由` : '本期无 override，纪律遵守',
        });
      }),
    }));

    ctx.effect(() => { for (const r of routes) { try { r.dispose?.(); } catch { /* ignore */ } } }, 'kuibuequity: web routes');
  });
  return disposer;
}
