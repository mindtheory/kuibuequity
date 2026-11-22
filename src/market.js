/**
 * kuibuequity — 行情层（唯一允许联网的模块）
 *
 * 数据源：东方财富免 Key 公开接口（push2 实时 / push2his 日K / datacenter 分红送配）
 * 契约：docs/interface.md §3；数据质量硬要求见 docs/design.md §9
 * 立场（P6 诚实的失败）：网络失败/结构异常一律抛 ERR-DATA-001，绝不返回伪造或缓存冒充实时的数据。
 *
 * 只用 global fetch + AbortController，零第三方依赖。
 */

// ---------------------------------------------------------------------------
// 常量与缓存
// ---------------------------------------------------------------------------

/** 实时快照缓存 TTL（毫秒），避免对同一标的高频请求被限频 */
export const QUOTE_TTL_MS = 60000;

/** symbol(归一化后 'MARKET.CODE') -> { at, value } */
export const quoteCache = new Map();

const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 10000;
/** 失败重试 ≤3 次，指数退避 */
const RETRY_DELAYS_MS = [200, 400, 800];

/** 常见指数 secid 映射（指数代码与个股代码空间重叠，如 000300/000001，必须显式映射） */
export const INDEX_SECIDS = {
  '000001': '1.000001', // 上证指数
  '000010': '1.000010', // 上证180
  '000016': '1.000016', // 上证50
  '000300': '1.000300', // 沪深300
  '000688': '1.000688', // 科创50
  '000852': '1.000852', // 中证1000
  '000905': '1.000905', // 中证500
  '399001': '0.399001', // 深证成指
  '399005': '0.399005', // 中小100
  '399006': '0.399006', // 创业板指
  '899050': '0.899050', // 北证50
};

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export class DataError extends Error {
  constructor(message) {
    super(`ERR-DATA-001: ${message}`);
    this.name = 'DataError';
    this.code = 'ERR-DATA-001';
  }
}

export class SymbolError extends Error {
  constructor(input) {
    super(`ERR-SYMBOL-001: 无法识别的证券代码: ${JSON.stringify(input)}`);
    this.name = 'SymbolError';
    this.code = 'ERR-SYMBOL-001';
  }
}

// ---------------------------------------------------------------------------
// 纯函数（可单测，不联网）
// ---------------------------------------------------------------------------

/** 分/100 类价格缩放并保留 2 位（round half up，A 股最小报价单位 0.01） */
export function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

/** 保留 4 位（每股分红等小数值） */
export function round4(x) {
  return Math.round((Number(x) + Number.EPSILON) * 10000) / 10000;
}

/**
 * 归一化证券代码。
 * 接受 '600036' | 'sh600036' | '600036.SH' | '000001.SZ' | 'bj920002'（大小写不敏感）。
 * 规则：6xxxxx→SH(1.)；0xxxxx/3xxxxx→SZ(0.)；4xxxxx/8xxxxx/92xxxx→BJ(0.)。
 * 前缀/后缀若给出，必须与数字规则一致，否则视为非法。
 * @returns {{code:string, market:'SH'|'SZ'|'BJ', secid:string}}
 */
export function normalizeSymbol(symbol) {
  if (symbol == null) throw new SymbolError(symbol);
  const raw = String(symbol).trim().toUpperCase();
  let code = '';
  let hint = '';
  const mDot = raw.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  const mPre = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (mDot) {
    code = mDot[1];
    hint = mDot[2];
  } else if (mPre) {
    code = mPre[2];
    hint = mPre[1];
  } else if (/^\d{6}$/.test(raw)) {
    code = raw;
  } else {
    throw new SymbolError(symbol);
  }
  let market;
  if (/^6/.test(code)) market = 'SH';
  else if (/^[03]/.test(code)) market = 'SZ';
  else if (/^92/.test(code) || /^[48]/.test(code)) market = 'BJ';
  else throw new SymbolError(symbol); // 5xxxxx 基金、9xxxxx(非92) B股等不在本插件范围
  if (hint && hint !== market) throw new SymbolError(symbol);
  return { code, market, secid: `${market === 'SH' ? 1 : 0}.${code}` };
}

/**
 * 涨跌停幅度：主板 ±10%；创业板(300/301)与科创板(688) ±20%；ST ±5%；北交所 ±30%。
 * 判定顺序：北交所 → 创/科（其 ST 仍为 20%，交易所规则如此）→ ST → 主板。
 */
export function limitPct({ code, market, name = '' }) {
  if (market === 'BJ') return 0.3;
  if (/^30/.test(code) || /^688/.test(code)) return 0.2;
  if (/ST/i.test(String(name))) return 0.05;
  return 0.1;
}

/**
 * 基于 prevClose 计算当日涨/跌停价（round half-up 到 0.01）。
 * 用「分」整数运算避免浮点误差（99.85×0.9 的浮点积是 89.86499999999999，会错舍成 89.86）。
 */
export function limitPrices({ code, market, name = '', prevClose }) {
  const pc = Number(prevClose);
  if (!Number.isFinite(pc) || pc <= 0) return { limitUp: null, limitDown: null, pct: null };
  const pct = limitPct({ code, market, name });
  const cents = Math.round(pc * 100); // 前收以分计（行情价格均为 2 位小数）
  const p = Math.round(pct * 10000); // 1000/2000/500/3000
  const halfUp = (n) => Math.floor((n + 5000) / 10000);
  return {
    pct,
    limitUp: halfUp(cents * (10000 + p)) / 100,
    limitDown: halfUp(cents * (10000 - p)) / 100,
  };
}

/**
 * 解析 push2his klines 的一行。
 * 字段序：f51日期,f52开,f53收,f54高,f55低,f56量(手),f57额(元),f58振幅,f59涨跌幅,f60涨跌额,f61换手率
 * volume 手→股 ×100；fqt 已复权，adjClose=close。
 */
export function parseKlineLine(line) {
  const parts = String(line).split(',');
  if (parts.length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    throw new DataError(`K线行解析失败: ${String(line).slice(0, 80)}`);
  }
  const [date, open, close, high, low, volLots, amount, amplitude, changePct, change, turnover] = parts;
  const closeN = Number(close);
  const openN = Number(open);
  const highN = Number(high);
  const lowN = Number(low);
  const volN = Number(volLots);
  if (![openN, closeN, highN, lowN, volN].every(Number.isFinite)) {
    throw new DataError(`K线行数值非法: ${String(line).slice(0, 80)}`);
  }
  const num = (s) => (s != null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
  return {
    date,
    open: openN,
    high: highN,
    low: lowN,
    close: closeN,
    volume: Math.round(volN * 100), // 手 → 股
    amount: num(amount) ?? 0,
    adjClose: closeN, // fqt 已复权
    amplitude: num(amplitude),
    changePct: num(changePct),
    change: num(change),
    turnoverRate: num(turnover) != null ? num(turnover) / 100 : null, // 百分数→小数
    suspended: volN === 0, // 停牌近似：零成交
  };
}

/**
 * klines[] → Bar[]（interface.md §3）。
 * limitUp/limitDown 用前收盘近似：high>=limit && close>=limit（收盘仍封在板上）。
 */
export function barsFromKlines(klines, { code = '', market = '', name = '' } = {}) {
  const parsed = (klines || []).map(parseKlineLine);
  const bars = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const prevClose = i > 0 ? parsed[i - 1].close : null;
    let limitUp = false;
    let limitDown = false;
    if (prevClose > 0) {
      const lp = limitPrices({ code, market, name, prevClose });
      if (lp.limitUp != null) {
        limitUp = p.high >= lp.limitUp - 1e-9 && p.close >= lp.limitUp - 1e-9;
        limitDown = p.low <= lp.limitDown + 1e-9 && p.close <= lp.limitDown + 1e-9;
      }
    }
    bars.push({
      date: p.date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: p.volume,
      amount: p.amount,
      adjClose: p.adjClose,
      limitUp,
      limitDown,
      suspended: p.suspended,
      dividendPerShare: 0, // 日K不含分红；由 dividends() 单独入账，避免重复计算（design.md §4.4）
    });
  }
  return bars;
}

/**
 * 最近工作日（北京时区，跳过周末；法定节假日未纳入，保守口径见 risk.tradingDaysBetween）。
 * @param {Date} now
 * @param {number} offsetMinutes 相对 UTC 的分钟偏移，默认 +480（Asia/Shanghai）
 */
export function latestWeekdayString(now = new Date(), offsetMinutes = 480) {
  const shifted = new Date(now.getTime() + offsetMinutes * 60000);
  const dow = shifted.getUTCDay();
  const back = dow === 0 ? 2 : dow === 6 ? 1 : 0;
  shifted.setUTCDate(shifted.getUTCDate() - back);
  return shifted.toISOString().slice(0, 10);
}

/** 陈旧判定：asOf(YYYY-MM-DD) 早于最近工作日 → true */
export function computeStale(asOf, now = new Date(), offsetMinutes = 480) {
  if (!asOf) return true;
  return String(asOf).slice(0, 10) < latestWeekdayString(now, offsetMinutes);
}

// ---------------------------------------------------------------------------
// HTTP（fetch + AbortController + 指数退避重试）
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': UA, referer: 'https://quote.eastmoney.com/' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  const host = String(url).split('?')[0];
  throw new DataError(`行情源不可达 ${host}（重试 ${RETRY_DELAYS_MS.length} 次）: ${lastErr ? lastErr.message : 'unknown'}`);
}

// ---------------------------------------------------------------------------
// 对外 API（interface.md §3）
// ---------------------------------------------------------------------------

/** 实时快照（60s TTL 缓存，key=归一化 symbol） */
export async function quote(symbol, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { code, market, secid } = normalizeSymbol(symbol);
  const key = `${market}.${code}`;
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.value;

  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&ut=${UT}&invt=2` +
    '&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f107,f168,f169,f170,f171';
  const json = await fetchJson(url, { timeoutMs });
  const d = json && json.data;
  if (!d || typeof d.f43 !== 'number' || typeof d.f60 !== 'number') {
    throw new DataError(`实时快照返回异常（无数据或字段缺失）: ${code}`);
  }
  const prevClose = d.f60 / 100;
  const name = d.f58 || '';
  const lp = limitPrices({ code, market, name, prevClose });
  const now = new Date();
  const value = {
    symbol: code,
    name,
    price: d.f43 / 100,
    open: typeof d.f46 === 'number' ? d.f46 / 100 : null,
    high: typeof d.f44 === 'number' ? d.f44 / 100 : null,
    low: typeof d.f45 === 'number' ? d.f45 / 100 : null,
    prevClose,
    changePct: typeof d.f170 === 'number' ? d.f170 / 100 : null, // 百分数（字段以 Pct 结尾）
    volume: typeof d.f47 === 'number' ? Math.round(d.f47 * 100) : null, // 手→股
    amount: typeof d.f48 === 'number' ? d.f48 : null,
    turnoverRate: typeof d.f168 === 'number' ? d.f168 / 10000 : null, // 百分数→小数
    limitUp: lp.limitUp,
    limitDown: lp.limitDown,
    suspended: d.f47 === 0,
    asOf: now.toISOString(),
    stale: computeStale(now.toISOString().slice(0, 10), now),
    source: 'eastmoney:push2',
  };
  quoteCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 日K线（默认前复权）。
 * 注意：push2his 的 klt=101 才是日线（102 为周线），任务书里的 klt=102 是笔误，
 * 这里按契约「日K」实现为 klt=101。
 */
export async function dailyBars(
  symbol,
  { days = 250, adjust = 'qfq', timeoutMs = DEFAULT_TIMEOUT_MS, secid: secidOverride = null, name = '' } = {},
) {
  const { code, market, secid } = normalizeSymbol(symbol);
  const fqt = adjust === 'hfq' ? 2 : adjust === 'none' ? 0 : 1; // qfq=1 hfq=2 none=0
  const lmt = Math.max(1, Math.min(2000, Math.trunc(Number(days) || 250)));
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidOverride || secid}&ut=${UT}` +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&klt=101&fqt=${fqt}&end=20500101&lmt=${lmt}`;
  const json = await fetchJson(url, { timeoutMs });
  const data = json && json.data;
  if (!data || !Array.isArray(data.klines) || data.klines.length === 0) {
    throw new DataError(`无K线数据: ${code}（可能代码错误或停牌过久）`);
  }
  const bars = barsFromKlines(data.klines, { code, market, name: name || data.name || '' });
  const asOf = bars[bars.length - 1].date;
  return {
    symbol: code,
    bars,
    adjust,
    asOf,
    stale: computeStale(asOf),
    source: 'eastmoney:push2his',
    count: bars.length,
  };
}

/** 分红送配历史（用于股息率与摊薄模拟） */
export async function dividends(symbol, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { code } = normalizeSymbol(symbol);
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    `?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)` +
    '&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&pageSize=50&pageNumber=1&source=WEB&client=WEB';
  const json = await fetchJson(url, { timeoutMs });
  const rows = json && json.result && json.result.data;
  if (!Array.isArray(rows)) {
    throw new DataError(`分红接口返回结构与预期不符: ${code}（不硬编造，请人工核对接口）`);
  }
  const items = rows
    .map((r) => ({
      exDate: r.EX_DIVIDEND_DATE ? String(r.EX_DIVIDEND_DATE).slice(0, 10) : null,
      // PRETAX_BONUS_RMB = 每10股税前派X元 → 每股
      cashPerShare: r.PRETAX_BONUS_RMB != null ? round4(Number(r.PRETAX_BONUS_RMB) / 10) : 0,
      // BONUS_RATIO/IT_RATIO = 每10股送/转X股 → 每股
      bonusShares: r.BONUS_RATIO != null ? round4(Number(r.BONUS_RATIO) / 10) : 0,
      capitalizeShares: r.IT_RATIO != null ? round4(Number(r.IT_RATIO) / 10) : 0,
    }))
    .filter((it) => it.exDate);
  return { symbol: code, items, source: 'eastmoney:datacenter' };
}

/** 指数收盘序列（大盘过滤用），默认 000300 沪深300（secid=1.000300） */
export async function indexBars(symbol = '000300', { days = 60, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bare = String(symbol)
    .trim()
    .toUpperCase()
    .replace(/^(SH|SZ|BJ)/, '')
    .replace(/\.(SH|SZ|BJ)$/, '');
  const secid = INDEX_SECIDS[bare] || null;
  const res = await dailyBars(secid ? bare : symbol, {
    days,
    adjust: 'none', // 指数不复权
    timeoutMs,
    secid: secid || undefined,
  });
  return res;
}
