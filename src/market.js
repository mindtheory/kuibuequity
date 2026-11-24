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
/** 涨停池接口的 ut（东财网页同源，免 Key） */
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';
/** clist 板块筛选：深主板/深创/沪主板/科创/北交所 */
export const CLIST_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
/** clist 默认字段（详见 docs/data-sources.md §1.6 与 parseClistRow） */
export const CLIST_FIELDS = 'f2,f3,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f26,f62,f100';
/** 分页页间退避（限频友好，docs/data-sources.md §3） */
export const CLIST_PAGE_SLEEP_MS = 250;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 10000;
/** 失败重试 ≤3 次，指数退避 */
const RETRY_DELAYS_MS = [200, 400, 800];

// ---- 备选数据源（Tushare Pro）：docs/interface.md §3.1 ----
/** 备源 Token 环境变量（只从环境读取，绝不写入代码/账本/错误消息） */
export const TUSHARE_TOKEN_ENV = 'KUIBU_TUSHARE_TOKEN';
/** 历史文档里出现过的变量名，作为兼容回退 */
export const TUSHARE_TOKEN_ENV_LEGACY = 'TUSHARE_TOKEN';
/** 默认数据源链：东财主源 → Tushare 备源 */
export const DEFAULT_SOURCE_CHAIN = ['eastmoney', 'tushare'];
/** 契约内允许的源名（未知源名 → ERR-DATA-001，不静默跳过） */
export const SOURCE_NAMES = ['eastmoney', 'tushare'];
const TUSHARE_URL = 'https://api.tushare.pro';
const TUSHARE_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount';
const TUSHARE_ADJ_FIELDS = 'ts_code,trade_date,adj_factor';
const TUSHARE_DIVIDEND_FIELDS =
  'ts_code,end_date,div_proc,cash_div,cash_div_tax,stk_bo_rate,stk_co_rate,ex_date,record_date,pay_date';

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

/** 北京时区今天 YYYYMMDD（涨停池 date 参数；market.js 允许读时钟） */
export function todayCompactString(now = new Date(), offsetMinutes = 480) {
  const shifted = new Date(now.getTime() + offsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 百分数 → 小数（保留 6 位，避免 17.1433% → 0.1714 的二次舍入误差） */
export function pctToDecimal(pct) {
  if (pct == null || pct === '' || pct === '-') return null;
  const n = Number(pct);
  return Number.isFinite(n) ? Number((n / 100).toFixed(6)) : null;
}

/** 东财紧凑日期 'YYYYMMDD' → 'YYYY-MM-DD'；非法返回 null */
export function compactDateToIso(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 东财 'NNNNNN'（HHMMSS，可 5 位缺前导 0）→ 'HH:MM:SS'；空值/非法返回 null */
export function compactTimeToHms(v) {
  if (v == null || v === '' || v === '-') return null;
  const s = String(v).trim().padStart(6, '0');
  if (!/^\d{6}$/.test(s)) return null;
  const hh = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const ss = Number(s.slice(4, 6));
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/** 行情数值字段：'-' / '' / null → null（诚实空值，不补 0） */
function numField(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 代码 → 交易所（clist 只给 6 位代码，规则与 normalizeSymbol 一致） */
function marketOfCode(code) {
  if (/^6/.test(code)) return 'SH';
  if (/^92/.test(code) || /^[48]/.test(code)) return 'BJ';
  if (/^[03]/.test(code)) return 'SZ';
  return null;
}

/**
 * 纯函数：东财 clist 一行 → StockRow（interface.md §3）。
 * clist 字段：f12代码 f14名称 f2最新价 f3涨跌幅% f5成交量(手) f6成交额 f8换手率%
 *            f10量比 f15最高 f16最低 f17开盘 f18昨收 f20总市值 f21流通市值
 *            f26上市日(YYYYMMDD) f62主力净流入
 * 价格为 2 位小数；changePct 保持百分数（与 quote() 口径一致）；turnoverRate 转小数。
 */
export function parseClistRow(row = {}) {
  const code = String(row.f12 ?? '').trim();
  const market = marketOfCode(code);
  if (!code || !market) throw new SymbolError(row.f12);
  const name = row.f14 ? String(row.f14) : '';
  const price = numField(row.f2);
  const prevClose = numField(row.f18);
  const volumeLots = numField(row.f5);
  const lp = limitPrices({ code, market, name, prevClose });
  return {
    code,
    name,
    market,
    price,
    changePct: numField(row.f3), // 百分数
    turnoverRate: pctToDecimal(numField(row.f8)), // 小数
    volumeRatio: numField(row.f10),
    open: numField(row.f17),
    high: numField(row.f15),
    low: numField(row.f16),
    prevClose,
    volume: volumeLots != null ? Math.round(volumeLots * 100) : null, // 手→股
    amount: numField(row.f6),
    floatCap: numField(row.f21),
    totalCap: numField(row.f20),
    listDate: compactDateToIso(row.f26),
    mainNetInflow: numField(row.f62),
    limitUpPrice: lp.limitUp,
    limitUp: price != null && lp.limitUp != null ? price >= lp.limitUp - 1e-9 : false,
    suspended: volumeLots == null || volumeLots === 0,
  };
}

/**
 * 纯函数：东财涨停池一行 → LimitUpRow（interface.md §3）。
 * 字段：c代码 n名称 p价格×1000 zdp涨跌幅% amount成交额 ltsz流通市值 hs换手率%
 *      lbc连板数 fbt/lbt首/末封板时间(HHMMSS) zbc炸板次数 fund封单额 hybk行业
 */
export function parseLimitUpRow(row = {}) {
  const code = String(row.c ?? '').trim();
  const market = marketOfCode(code);
  if (!code || !market) throw new SymbolError(row.c);
  const priceRaw = numField(row.p);
  return {
    code,
    name: row.n ? String(row.n) : '',
    market,
    price: priceRaw != null ? round2(priceRaw / 1000) : null,
    changePct: numField(row.zdp), // 百分数
    amount: numField(row.amount),
    floatCap: numField(row.ltsz),
    turnoverRate: pctToDecimal(numField(row.hs)),
    boards: numField(row.lbc),
    firstLimitTime: compactTimeToHms(row.fbt),
    lastLimitTime: compactTimeToHms(row.lbt),
    blown: (numField(row.zbc) ?? 0) > 0,
    sealAmount: numField(row.fund),
    sector: row.hybk ? String(row.hybk) : null,
  };
}


// ---------------------------------------------------------------------------
// Tushare 备源纯函数（不联网、不读时钟：日期窗由 tushareDateRange 显式传入 now）
// ---------------------------------------------------------------------------

/** Tushare 日期（'YYYYMMDD' 或 'YYYY-MM-DD'）→ 'YYYY-MM-DD'；非法返回 null */
function tsIsoDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{8}$/.test(s)) return compactDateToIso(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** 数值字段：null/''/非数 → null（诚实空值，不补 0） */
function tsNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 纯函数：Token 解析。opts 显式值优先，其次 env.KUIBU_TUSHARE_TOKEN，
 * 再回退 env.TUSHARE_TOKEN；空白/null → null（调用方据此静默跳过备源）。
 * 只读入参，不读文件、不写日志、不回显。
 */
export function resolveTushareToken(optsToken, env = process.env) {
  const pick = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  return (
    pick(optsToken) ??
    pick(env ? env[TUSHARE_TOKEN_ENV] : null) ??
    pick(env ? env[TUSHARE_TOKEN_ENV_LEGACY] : null) ??
    null
  );
}

/**
 * 纯函数：Tushare 返回的 `data:{fields, items}` → 对象数组。
 * 结构异常（缺 fields/items、行长与 fields 不符）→ ERR-DATA-001：不猜字段、不补位。
 */
export function tushareRows(data) {
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.items)) {
    throw new DataError('Tushare 返回结构异常（缺 data.fields / data.items），不伪造数据');
  }
  const rows = [];
  for (const item of data.items) {
    if (!Array.isArray(item) || item.length !== data.fields.length) {
      throw new DataError('Tushare 行长度与 fields 不一致，不猜测字段');
    }
    const row = {};
    data.fields.forEach((f, i) => {
      row[f] = item[i];
    });
    rows.push(row);
  }
  return rows;
}

/**
 * 纯函数：Tushare `daily` 行 → 未复权中间结构。
 * vol 单位「手」→ 股 ×100；amount 单位「千元」→ 元 ×1000；trade_date 归一为 'YYYY-MM-DD'。
 * 关键字段缺失/非法 → ERR-DATA-001（不把空值当 0）。
 */
export function parseTushareDailyRow(row = {}) {
  const date = tsIsoDate(row.trade_date);
  if (!date) throw new DataError(`Tushare 日线行日期非法: ${JSON.stringify(row.trade_date)}`);
  const open = tsNum(row.open);
  const high = tsNum(row.high);
  const low = tsNum(row.low);
  const close = tsNum(row.close);
  const volLots = tsNum(row.vol);
  const amountK = tsNum(row.amount);
  if (![open, high, low, close, volLots, amountK].every((n) => n != null)) {
    throw new DataError(`Tushare 日线行数值缺失: ${date}`);
  }
  return {
    date,
    open,
    high,
    low,
    close,
    preClose: tsNum(row.pre_close),
    volume: Math.round(volLots * 100), // 手 → 股
    amount: amountK * 1000, // 千元 → 元
    changePct: tsNum(row.pct_chg),
  };
}

/**
 * 纯函数：Tushare `daily` 行 + `adj_factor` 行 → Bar[]（interface.md §3）。
 * 复权公式（与 tushare pro_bar 口径一致）：
 *   qfq: price × factor ÷ 窗口内最新 factor；hfq: price × factor；none: 原价。
 * 任一交易日缺复权因子 → ERR-DATA-001（绝不把未复权价冒充复权价）。
 * 复权价 round4（A 股报价 0.01，4 位足够且便于手算回归）。
 * limitUp/limitDown 用前一交易日（复权后）收盘 + limitPrices 派生；suspended = 零成交。
 */
export function barsFromTushare(dailyRows = [], adjRows = [], { code = '', market = '', name = '', adjust = 'qfq' } = {}) {
  const adj = adjust === 'hfq' ? 'hfq' : adjust === 'none' ? 'none' : 'qfq';
  const parsed = (dailyRows || [])
    .map(parseTushareDailyRow)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (parsed.length === 0) return [];
  const factorByDate = new Map();
  for (const r of adjRows || []) {
    const d = tsIsoDate(r.trade_date);
    const f = tsNum(r.adj_factor);
    if (d && f != null && f > 0) factorByDate.set(d, f);
  }
  let lastFactor = null;
  if (adj !== 'none') {
    const dates = [...factorByDate.keys()].sort();
    if (dates.length === 0) throw new DataError(`Tushare 复权因子为空，拒绝把未复权价冒充${adj === 'hfq' ? '后' : '前'}复权价`);
    lastFactor = factorByDate.get(dates[dates.length - 1]);
  }
  const bars = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    let scale = 1;
    if (adj !== 'none') {
      const f = factorByDate.get(p.date);
      if (f == null || f <= 0) {
        throw new DataError(`Tushare 缺 ${p.date} 复权因子，拒绝冒充复权价`);
      }
      scale = adj === 'hfq' ? f : f / lastFactor;
    }
    const adjPrice = (v) => round4(v * scale);
    const close = adjPrice(p.close);
    const bar = {
      date: p.date,
      open: adjPrice(p.open),
      high: adjPrice(p.high),
      low: adjPrice(p.low),
      close,
      volume: p.volume,
      amount: p.amount,
      adjClose: close,
      limitUp: false,
      limitDown: false,
      suspended: p.volume === 0,
      dividendPerShare: 0,
    };
    const prevClose = i > 0 ? bars[i - 1].close : null;
    if (prevClose > 0) {
      const lp = limitPrices({ code, market, name, prevClose });
      if (lp.limitUp != null) {
        bar.limitUp = bar.high >= lp.limitUp - 1e-9 && bar.close >= lp.limitUp - 1e-9;
        bar.limitDown = bar.low <= lp.limitDown + 1e-9 && bar.close <= lp.limitDown + 1e-9;
      }
    }
    bars.push(bar);
  }
  return bars;
}

/**
 * 纯函数：Tushare `dividend` 行 → 契约项（interface.md §3）。
 * 只取 div_proc==='实施' 且 ex_date 可解析；cashPerShare 用税前 `cash_div_tax`（元/股）；
 * bonusShares←stk_bo_rate、capitalizeShares←stk_co_rate（均为每股）。非实施/无日期 → null。
 */
export function parseTushareDividendRow(row = {}) {
  if (String(row.div_proc ?? '').trim() !== '实施') return null;
  const exDate = tsIsoDate(row.ex_date);
  if (!exDate) return null;
  return {
    exDate,
    cashPerShare: round4(tsNum(row.cash_div_tax) ?? 0),
    bonusShares: round4(tsNum(row.stk_bo_rate) ?? 0),
    capitalizeShares: round4(tsNum(row.stk_co_rate) ?? 0),
  };
}

/**
 * 纯函数：Tushare 请求日期窗。
 * end = 北京时区今天；start = 回看 max(120, days×2+30) 自然日（上限 4000），覆盖停牌与长假。
 */
export function tushareDateRange(days, now = new Date()) {
  const n = Math.max(1, Math.min(2000, Math.trunc(Number(days) || 250)));
  const lookback = Math.min(4000, Math.max(120, n * 2 + 30));
  const endDate = todayCompactString(now);
  const base = Date.UTC(Number(endDate.slice(0, 4)), Number(endDate.slice(4, 6)) - 1, Number(endDate.slice(6, 8)));
  const startDate = new Date(base - lookback * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return { startDate, endDate };
}

/** 解析数据源链：默认 ['eastmoney','tushare']，去重保序；未知源/空数组 → ERR-DATA-001 */
function normalizeSourceChain(sources) {
  if (sources == null) return [...DEFAULT_SOURCE_CHAIN];
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new DataError('sources 必须是非空数组（如 [\'eastmoney\',\'tushare\']）');
  }
  const chain = [];
  for (const raw of sources) {
    const name = String(raw ?? '').trim().toLowerCase();
    if (!SOURCE_NAMES.includes(name)) {
      throw new DataError(`未知数据源: ${JSON.stringify(raw)}（支持 ${SOURCE_NAMES.join(' / ')}）`);
    }
    if (!chain.includes(name)) chain.push(name);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// HTTP（fetch + AbortController + 指数退避重试）
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(
  url,
  { timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body = null, headers = null,
    retryDelaysMs = RETRY_DELAYS_MS } = {},
) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : RETRY_DELAYS_MS;
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const hdrs = { 'user-agent': UA };
      if (body == null) hdrs.referer = 'https://quote.eastmoney.com/'; // 东财同源，Tushare POST 不需要
      Object.assign(hdrs, headers || {});
      const init = { signal: ctrl.signal, headers: hdrs, method };
      if (body != null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  const host = String(url).split('?')[0];
  throw new DataError(`行情源不可达 ${host}（重试 ${delays.length} 次）: ${lastErr ? lastErr.message : 'unknown'}`);
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
 * 数据源链执行器（interface.md §3.1）：按顺序尝试，命中即返回并留痕；
 * 未配置 Token 的 Tushare 静默跳过（skipped='NO_TOKEN'）；全部失败 → ERR-DATA-001 汇总原因。
 */
async function runSourceChain({ chain, token, label, tasks, opts = {} }) {
  const attempts = [];
  for (const name of chain) {
    if (name === 'tushare' && !token) {
      attempts.push({ source: 'tushare', ok: false, skipped: 'NO_TOKEN' });
      continue;
    }
    try {
      const res = await tasks[name]({ ...opts, token });
      attempts.push({ source: name, ok: true });
      return { ...res, sourceChain: chain, attempts };
    } catch (e) {
      attempts.push({
        source: name,
        ok: false,
        code: (e && e.code) || 'ERR-DATA-001',
        message: e && e.message ? String(e.message) : String(e),
      });
    }
  }
  const detail = attempts
    .map((a) =>
      a.skipped === 'NO_TOKEN'
        ? `${a.source}: 跳过（未配置 Token，env ${TUSHARE_TOKEN_ENV}）`
        : `${a.source}: ${a.message}`,
    )
    .join(' | ');
  throw new DataError(`${label} 全部数据源失败 —— ${detail}`);
}

/** Tushare Pro POST 调用：Token 只进请求体，绝不进 URL/错误消息 */
async function tushareCall(apiName, params, { token, fields, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelaysMs } = {}) {
  if (!token) throw new DataError(`Tushare 未配置 Token（env ${TUSHARE_TOKEN_ENV}），跳过备源`);
  const json = await fetchJson(TUSHARE_URL, {
    method: 'POST',
    body: { api_name: apiName, token, params, fields },
    headers: { 'content-type': 'application/json' },
    timeoutMs,
    retryDelaysMs,
  });
  if (!json || typeof json !== 'object') {
    throw new DataError(`Tushare ${apiName} 返回非对象（不猜数据）`);
  }
  if (Number(json.code) !== 0) {
    throw new DataError(`Tushare ${apiName} 失败 code=${json.code}: ${String(json.msg ?? '').slice(0, 200)}`);
  }
  return json.data;
}

/** 东财日K（主源）。push2his 的 klt=101 才是日线（102 为周线）。 */
async function dailyBarsFromEastmoney(
  symbol,
  { days = 250, adjust = 'qfq', timeoutMs = DEFAULT_TIMEOUT_MS, secid: secidOverride = null, name = '', retryDelaysMs } = {},
) {
  const { code, market, secid } = normalizeSymbol(symbol);
  const fqt = adjust === 'hfq' ? 2 : adjust === 'none' ? 0 : 1; // qfq=1 hfq=2 none=0
  const lmt = Math.max(1, Math.min(2000, Math.trunc(Number(days) || 250)));
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidOverride || secid}&ut=${UT}` +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&klt=101&fqt=${fqt}&end=20500101&lmt=${lmt}`;
  const json = await fetchJson(url, { timeoutMs, retryDelaysMs });
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
    warnings: [],
    count: bars.length,
  };
}

/** Tushare 备源日K：daily + adj_factor（qfq/hfq 必须取到因子，否则诚实失败） */
async function dailyBarsFromTushare(
  symbol,
  { days = 250, adjust = 'qfq', name = '', token, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelaysMs } = {},
) {
  const { code, market } = normalizeSymbol(symbol);
  const tsCode = `${code}.${market}`;
  const lmt = Math.max(1, Math.min(2000, Math.trunc(Number(days) || 250)));
  const range = tushareDateRange(lmt);
  const dailyData = await tushareCall(
    'daily',
    { ts_code: tsCode, start_date: range.startDate, end_date: range.endDate },
    { token, fields: TUSHARE_DAILY_FIELDS, timeoutMs, retryDelaysMs },
  );
  const dailyRows = tushareRows(dailyData);
  if (dailyRows.length === 0) throw new DataError(`Tushare 无日线数据: ${tsCode}`);
  let adjRows = [];
  if (adjust !== 'none') {
    const adjData = await tushareCall(
      'adj_factor',
      { ts_code: tsCode, start_date: range.startDate, end_date: range.endDate },
      { token, fields: TUSHARE_ADJ_FIELDS, timeoutMs, retryDelaysMs },
    );
    adjRows = tushareRows(adjData);
    if (adjRows.length === 0) {
      throw new DataError(`Tushare 复权因子为空: ${tsCode}（拒绝把未复权价冒充复权价）`);
    }
  }
  dailyRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
  const sliced = dailyRows.slice(-lmt);
  const bars = barsFromTushare(sliced, adjRows, { code, market, name, adjust });
  if (bars.length === 0) throw new DataError(`Tushare 日线窗口无有效数据: ${tsCode}`);
  const warnings = [];
  if (!name) {
    warnings.push('Tushare 源不提供证券名称，涨跌停判定按非 ST 规则（若为 ST 标的可能偏差）');
  }
  const asOf = bars[bars.length - 1].date;
  return {
    symbol: code,
    bars,
    adjust,
    asOf,
    stale: computeStale(asOf),
    source: 'tushare:daily',
    warnings,
    count: bars.length,
  };
}

/**
 * 日K线（默认前复权）——数据源链：东财主源 → Tushare 备源（需 env KUIBU_TUSHARE_TOKEN）。
 * 返回的 source 是实际生效源，attempts 逐源留痕；全部失败 → ERR-DATA-001（不返回半截/未复权冒充）。
 * @param {{days?:number, adjust?:'qfq'|'hfq'|'none', timeoutMs?:number,
 *          sources?:string[], tushareToken?:string, retryDelaysMs?:number[],
 *          secid?:string, name?:string}} [options]
 */
export async function dailyBars(symbol, options = {}) {
  const {
    days = 250,
    adjust = 'qfq',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sources,
    tushareToken,
    retryDelaysMs = RETRY_DELAYS_MS,
    secid = null,
    name = '',
  } = options;
  const chain = normalizeSourceChain(sources);
  const token = resolveTushareToken(tushareToken);
  const adj = adjust === 'hfq' ? 'hfq' : adjust === 'none' ? 'none' : 'qfq';
  return runSourceChain({
    chain,
    token,
    label: `日K ${String(symbol)}`,
    opts: { days, adjust: adj, timeoutMs, retryDelaysMs, secid, name },
    tasks: {
      eastmoney: (o) => dailyBarsFromEastmoney(symbol, o),
      tushare: (o) => dailyBarsFromTushare(symbol, o),
    },
  });
}

/** 东财分红送配（主源） */
async function dividendsFromEastmoney(symbol, { timeoutMs = DEFAULT_TIMEOUT_MS, retryDelaysMs } = {}) {
  const { code } = normalizeSymbol(symbol);
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    `?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)` +
    '&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&pageSize=50&pageNumber=1&source=WEB&client=WEB';
  const json = await fetchJson(url, { timeoutMs, retryDelaysMs });
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
  return { symbol: code, items, source: 'eastmoney:datacenter', warnings: [], count: items.length };
}

/** Tushare 备源分红：仅实施中的方案，按 exDate 降序 */
async function dividendsFromTushare(symbol, { token, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelaysMs } = {}) {
  const { code, market } = normalizeSymbol(symbol);
  const data = await tushareCall('dividend', { ts_code: `${code}.${market}` }, {
    token,
    fields: TUSHARE_DIVIDEND_FIELDS,
    timeoutMs,
    retryDelaysMs,
  });
  const rows = tushareRows(data);
  const items = rows
    .map(parseTushareDividendRow)
    .filter(Boolean)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  return { symbol: code, items, source: 'tushare:dividend', warnings: [], count: items.length };
}

/**
 * 分红送配历史（数据源链同 dailyBars）。
 * @param {{timeoutMs?:number, sources?:string[], tushareToken?:string, retryDelaysMs?:number[]}} [options]
 */
export async function dividends(symbol, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, sources, tushareToken, retryDelaysMs = RETRY_DELAYS_MS } = options;
  const chain = normalizeSourceChain(sources);
  const token = resolveTushareToken(tushareToken);
  return runSourceChain({
    chain,
    token,
    label: `分红送配 ${String(symbol)}`,
    opts: { timeoutMs, retryDelaysMs },
    tasks: {
      eastmoney: (o) => dividendsFromEastmoney(symbol, o),
      tushare: (o) => dividendsFromTushare(symbol, o),
    },
  });
}

/**
 * 指数收盘序列（大盘过滤用），默认 000300 沪深300（secid=1.000300）。
 * 指数数据只走东财：Tushare 指数需 `index_daily`，未纳入 §3.1 契约（不因备源缺失而失败）。
 */
export async function indexBars(symbol = '000300', { days = 60, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelaysMs } = {}) {
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
    retryDelaysMs,
    sources: ['eastmoney'],
    secid: secid || undefined,
  });
  return res;
}

/**
 * 全市场列表（东财 clist 免 Key）：短线候选池的唯一列表来源。
 *
 * 分页 + 页间退避 + 按 code 去重；total 取接口 data.total。
 * 第一页结构异常 → ERR-DATA-001（绝不返回伪造候选池）；后续页失败保留已抓到的行（诚实部分结果）。
 *
 * @param {{fs?:string, fid?:string, sortDesc?:boolean, pageSize?:number, maxPages?:number,
 *          pageSleepMs?:number, fields?:string, timeoutMs?:number}} opts
 * @returns {Promise<{rows:object[], total:number, pages:number, asOf:string, source:string}>}
 */
export async function listStocks({
  fs = CLIST_FS,
  fid = 'f3',
  sortDesc = true,
  pageSize = 100,
  maxPages = 2,
  pageSleepMs = CLIST_PAGE_SLEEP_MS,
  fields = CLIST_FIELDS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const pz = Math.max(1, Math.min(200, Math.trunc(Number(pageSize) || 100)));
  const pagesMax = Math.max(1, Math.min(10, Math.trunc(Number(maxPages) || 1)));
  const gap = Math.max(0, Math.trunc(Number(pageSleepMs) || 0));
  const rows = [];
  const seen = new Set();
  let total = null;
  let pages = 0;
  for (let pn = 1; pn <= pagesMax; pn++) {
    if (pn > 1 && gap > 0) await sleep(gap);
    const url =
      'https://push2.eastmoney.com/api/qt/clist/get' +
      `?pn=${pn}&pz=${pz}&po=${sortDesc ? 1 : 0}&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&ut=${UT}&fields=${fields}`;
    let json;
    try {
      json = await fetchJson(url, { timeoutMs });
    } catch (e) {
      if (pn === 1) throw e; // 第一页就失败：整体诚实失败
      break; // 后续页失败：保留已抓到的行（调用方看 pages/total 判断是否完整）
    }
    const data = json && json.data;
    const diff = data && data.diff;
    if (!diff) {
      if (pn === 1) throw new DataError('列表接口返回异常（无 data.diff），不伪造候选池');
      break;
    }
    const raw = Array.isArray(diff) ? diff : Object.values(diff);
    if (total == null) total = Number.isFinite(Number(data.total)) ? Number(data.total) : raw.length;
    pages = pn;
    let added = 0;
    for (const r of raw) {
      let row;
      try {
        row = parseClistRow(r);
      } catch {
        continue; // 单行代码异常：跳过该行（不污染整池）
      }
      if (seen.has(row.code)) continue;
      seen.add(row.code);
      rows.push(row);
      added++;
    }
    if (raw.length < pz || rows.length >= total || added === 0) break;
  }
  return { rows, total: total ?? rows.length, pages, asOf: new Date().toISOString(), source: 'eastmoney:clist' };
}

/**
 * 涨停池（东财 push2ex 免 Key）：封单强度 / 连板高度 / 涨停时间 / 板块效应来源。
 * 非交易日或无数据 → rows: [] + note（不伪造）；HTTP 失败 → ERR-DATA-001。
 *
 * @param {{date?:string('YYYYMMDD'|'YYYY-MM-DD'), timeoutMs?:number}} opts
 * @returns {Promise<{rows:object[], total:number, date:string, asOf:string, source:string, note?:string}>}
 */
export async function limitUpPool({ date, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const compact = String(date ?? '').trim().replace(/-/g, '') || todayCompactString();
  if (!/^\d{8}$/.test(compact)) throw new DataError(`涨停池 date 非法（需 YYYYMMDD）: ${date}`);
  const url =
    'https://push2ex.eastmoney.com/getTopicZTPool' +
    `?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${compact}`;
  const json = await fetchJson(url, { timeoutMs });
  const asOf = new Date().toISOString();
  const data = json && json.data;
  if (!data) {
    return {
      rows: [],
      total: 0,
      date: compact,
      asOf,
      source: 'eastmoney:push2ex',
      note: '涨停池无数据（非交易日或当日接口未更新），不伪造涨停/封单数据',
    };
  }
  const pool = Array.isArray(data.pool) ? data.pool : [];
  const rows = [];
  for (const r of pool) {
    try {
      rows.push(parseLimitUpRow(r));
    } catch {
      /* 单行异常跳过 */
    }
  }
  return {
    rows,
    total: Number.isFinite(Number(data.tc)) ? Number(data.tc) : rows.length,
    date: String(data.qdate || compact),
    asOf,
    source: 'eastmoney:push2ex',
  };
}
