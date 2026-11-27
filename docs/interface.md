# 接口契约（Interface Contract）— 唯一事实源

> 所有模块实现必须严格对齐本文件。字段名、单位、空值语义以本文为准；
> 有歧义先改本文再改代码（契约变更需在 CHANGELOG 记录）。

约定：
- 金额单位 **元**，价格单位 **元/股**（保留 3 位小数），数量单位 **股**（整数）
- 日期 `YYYY-MM-DD`，时间戳 ISO-8601（含时区偏移）
- 比率类字段一律 **小数**（0.03 表示 3%），除非字段名以 `Pct` 结尾（表示百分数）
- 未知值用 `null`，不得用 0 或字符串 `"NaN"` 代替
- 所有对外返回值必须含 `ok: boolean`；失败时含 `code`（`ERR-*`）与 `message`

---

## 1. `src/costs.js` — 成本与持仓成本（纯函数）

```js
export const DEFAULT_FEE = {
  commissionRate: 0.00025,   // 佣金 万2.5
  commissionMin: 5,          // 单笔最低佣金（元）
  stampTaxRate: 0.0005,      // 印花税，仅卖出（2026 口径，可配）
  transferRate: 0.00001,     // 过户费 万0.1（双向）
  slippageBps: 0,            // 滑点，基点
};

/** 单笔交易费用 */
export function tradeFee({ side, price, qty, fee = DEFAULT_FEE }): number
//  side: 'buy' | 'sell'
//  佣金 = max(price*qty*commissionRate, commissionMin)
//  印花税 = side==='sell' ? price*qty*stampTaxRate : 0
//  过户费 = price*qty*transferRate（双向）
//  返回四项合计，保留 2 位小数

/** 含滑点的成交价：买入上浮、卖出下调 */
export function applySlippage({ price, side, slippageBps }): number

/**
 * 有效持仓成本（本插件核心口径，全系统唯一实现）
 * @param {Array} lots  [{ date, side:'buy'|'sell', price, qty, fee, dividend?:number }]
 *                      dividend = 该笔持有期间**每股**现金分红累计（可选）
 * @param {object} opts { includeDividend: true }
 * @returns {{ shares:number, costPerShare:number|null, totalIn:number,
 *            totalRecovered:number, dividends:number, negative:boolean,
 *            progress:number }}
//  totalIn       = Σ buy 金额 + Σ buy 费用
//  totalRecovered= Σ sell 金额 − Σ sell 费用 + Σ(每股分红 × 当时持股数)
//  costPerShare  = (totalIn − totalRecovered) / shares   （shares=0 → null）
//  negative      = costPerShare <= 0
//  progress      = clamp(1 − costPerShare / 建仓加权均价, 0, 1)  成本转负进度
 */
export function holdingCost({ lots, opts = {} }): object

/** 成本转负 ETA（年）；参数非法或摊薄率<=0 返回 null */
export function costToNegativeEta({ costPerShare, price, annualDilutionRate }): number|null
```

---

## 2. `src/indicators.js` — 技术指标（纯函数）

统一签名：`f(values: number[], period: number) => (number|null)[]`
**输出长度必须等于输入长度**，前导不可计算位置填 `null`（索引对齐，P2/P3）。

```js
export function sma(values, period)
export function ema(values, period)              // alpha = 2/(period+1)，首值用首值播种
export function rsi(values, period = 14)        // Wilder 平滑，标准算法
export function macd(values, fast=12, slow=26, signal=9)
   // => { dif: (n|null)[], dea: (n|null)[], hist: (n|null)[] }
export function boll(values, period = 20, k = 2)
   // => { mid, upper, lower, width: (n|null)[] }  width = (upper-lower)/mid
export function atr(bars, period = 14)
   // bars: [{high, low, close}]；TR = max(h-l, |h-pc|, |l-pc|)，Wilder 平滑
export function atrPct(bars, period = 14)       // atr / close，前导 null
export function slope(values, period)           // 最近 period 点最小二乘斜率 / 均值，(n|null)[]
export function maxDrawdown(equity: number[])   // => 正数小数，如 0.23
export function sharpe(returns: number[], rf = 0, periodsPerYear = 244)
export function winRate(trades: {pnl:number}[]) // => 0..1，空数组返回 null
```

---

## 3. `src/market.js` — 行情层（唯一允许联网的模块）

```js
/** 归一化证券代码：'600036' | 'sh600036' | '600036.SH' => { code:'600036', market:'SH'|'SZ'|'BJ' } */
export function normalizeSymbol(symbol): {code, market, secid}

/** 实时快照 */
export async function quote(symbol, { timeoutMs = 8000 } = {}): Promise<Quote>
Quote = { symbol, name, price, open, high, low, prevClose, changePct, volume, amount,
          turnoverRate, limitUp, limitDown, suspended, asOf, stale:boolean, source }

/** 日 K（默认前复权）——带数据源链，见 §3.1 */
export async function dailyBars(symbol, { days = 250, adjust = 'qfq', timeoutMs = 10000,
                                          sources = ['eastmoney','tushare'], tushareToken,
                                          retryDelaysMs } = {})
   : Promise<{ symbol, bars: Bar[], adjust, asOf, stale, source, sourceChain, attempts,
               warnings: string[], count }>
Bar = { date, open, high, low, close, volume, amount, adjClose,
        limitUp:boolean, limitDown:boolean, suspended:boolean, dividendPerShare:number }

/** 分红送配历史（用于股息率与摊薄模拟）——同样走数据源链 */
export async function dividends(symbol, { timeoutMs = 10000, sources, tushareToken, retryDelaysMs } = {})
   : Promise<{ symbol, items: [{ exDate, cashPerShare, bonusShares, capitalizeShares }],
               source, sourceChain, attempts, warnings: string[], count }>

/** 指数收盘序列（大盘过滤用），默认 000300 沪深300 */
export async function indexBars(symbol = '000300', { days = 60 } = {}): Promise<{ bars: Bar[], asOf }>

/**
 * 全市场列表（涨幅榜/换手榜，东财 clist 免 Key）——短线候选池的唯一列表来源。
 * 分页抓取：每页间隔 pageSleepMs（默认 250ms，限频友好），最多 maxPages 页，按 code 去重。
 * 结构异常 / 第一页无 data.diff → ERR-DATA-001（不伪造候选池）；后续页异常则保留已抓到的行。
 */
export async function listStocks({ fs, fid = 'f3', sortDesc = true, pageSize = 100,
                                  maxPages = 2, pageSleepMs = 250,
                                  timeoutMs } = {})
  : Promise<{ rows: StockRow[], total, pages, asOf, source }>
StockRow = {
  code, name, market:'SH'|'SZ'|'BJ',
  price, changePct,        // 价格元；changePct 百分数（与 quote() 口径一致）
  turnoverRate,            // 小数（f8=0.68% → 0.0068）
  volumeRatio, open, high, low, prevClose,
  volume,                  // 股
  amount, floatCap, totalCap,
  listDate,                // 'YYYY-MM-DD'（f26 上市日），未知 null
  mainNetInflow,           // 主力净流入（元，f62）
  limitUpPrice,            // 由 prevClose + 板块/ST 涨跌幅规则算出的涨停价
  limitUp,                 // price >= limitUpPrice
  suspended,               // 零成交近似
}

/**
 * 涨停池（东财 push2ex，免 Key）：短线打分卡的封单强度/连板高度/涨停时间/板块效应来源。
 * 非交易日或无数据 → rows: [] 且带 note（不伪造）；HTTP 失败 → ERR-DATA-001。
 * @param {{date?:string('YYYYMMDD'), timeoutMs?:number}} opts
 */
export async function limitUpPool({ date, timeoutMs } = {})
  : Promise<{ rows: LimitUpRow[], total, date, asOf, source, note? }>
LimitUpRow = {
  code, name, price, changePct,        // price 元；changePct 百分数
  amount, floatCap, turnoverRate,      // 换手率小数
  boards,                              // 连板数 lbc
  firstLimitTime, lastLimitTime,       // 'HH:MM:SS'
  blown,                               // zbc > 0
  sealAmount,                          // 封单额（元）fund
  sector,                              // 所属行业 hybk
}

/** 纯函数：clist 原始行 → StockRow（'-' → null；量 手→股；换手 % → 小数） */
export function parseClistRow(row): StockRow
/** 纯函数：涨停池原始行 → LimitUpRow（p/1000；fbt/lbt HHMMSS → 'HH:MM:SS'） */
export function parseLimitUpRow(row): LimitUpRow

// ---- 备选源适配器（Tushare Pro，纯函数，便于离线单测） ----
/** 纯函数：Tushare `data:{fields,items}` → 对象数组；结构异常（缺 fields/items、行长不符）→ ERR-DATA-001 */
export function tushareRows(data): object[]
/** 纯函数：Token 解析。opts 显式值优先；否则 env.KUIBU_TUSHARE_TOKEN，回退 env.TUSHARE_TOKEN；
 *  空白/null → null（调用方据此静默跳过备源，绝不编造）。不读文件、不写日志。 */
export function resolveTushareToken(optsToken, env = process.env): string|null
/** 纯函数：Tushare daily 行 → 未复权中间结构
 *  vol 手→股 ×100；amount 千元→元 ×1000；trade_date 'YYYYMMDD' → 'YYYY-MM-DD' */
export function parseTushareDailyRow(row): {
  date, open, high, low, close, preClose, volume, amount, changePct }
/** 纯函数：daily 行 + adj_factor 行 → Bar[]
 *  qfq：price × factor / 窗口内最新 factor；hfq：price × factor；none：原价
 *  任一交易日缺复权因子 → ERR-DATA-001（绝不把未复权价冒充复权价）；复权价 round4
 *  limitUp/limitDown 用前一交易日（复权后）收盘 + limitPrices 派生；suspended = volume===0 */
export function barsFromTushare(dailyRows, adjRows, { code, market, name = '', adjust = 'qfq' }): Bar[]
/** 纯函数：Tushare dividend 行 → 契约项；仅 `div_proc==='实施'` 且 ex_date 可解析；
 *  cashPerShare 取税前 `cash_div_tax`（元/股）；bonusShares←stk_bo_rate、capitalizeShares←stk_co_rate（每股） */
export function parseTushareDividendRow(row): { exDate, cashPerShare, bonusShares, capitalizeShares }|null
/** 纯函数：Tushare 请求日期窗（end=今天北京时区，start=回看 max(120, days*2+30) 自然日，上限 4000） */
export function tushareDateRange(days, now = new Date()): { startDate, endDate }
```

### 3.1 数据源链（source chain）

`dailyBars` / `dividends` 按 `sources` 顺序尝试，默认 `['eastmoney','tushare']`（东财主源 → Tushare 备源）：

- **未知源名 → ERR-DATA-001**（拼写错误不得静默跳过），`sources: []` 同样拒绝。
- **Tushare 需要 Token**：`opts.tushareToken` 优先，否则 env `KUIBU_TUSHARE_TOKEN`（兼容 `TUSHARE_TOKEN`）。
  Token 只从环境/入参读取，**不写入代码、不写账本、不进错误消息**。无 Token → 该源静默跳过
  （`attempts[i].skipped = 'NO_TOKEN'`），不报错也不伪造数据。
- 返回的 `source` 是**实际生效**的源（`'eastmoney:push2his'` | `'tushare:daily'` 等），
  `sourceChain` 是本次尝试的链（去重后的解析结果），`attempts` 按尝试顺序逐源留痕
  `{ source, ok, skipped?, code?, message? }`（命中即停止，其后源不再尝试；诚实可审计）。
- **全部源失败 → ERR-DATA-001**，message 汇总各源最后一次失败原因；绝不返回半截/未复权冒充复权。
- Tushare 日线不提供证券名称，ST 状态未知 → 涨跌停派生按非 ST 规则，返回 `warnings` 明确提示；
  调用方若知名称可通过 `name` 传入（工具层暂不传）。
- `retryDelaysMs` 可覆盖默认退避序列（`[]` = 不重试），供单测与运维收紧；默认 `[200,400,800]`。
- `indexBars` 只走东财（Tushare 指数在 `index_daily`，未纳入本契约），不因备源缺失而失败。

实现要求：
- 只用 `node:https`/`fetch`，零第三方依赖
- 失败重试 ≤3 次指数退避；最终失败 `throw new Error('ERR-DATA-001: ...')`
- 网络不可用时返回明确错误码，**绝不返回伪造或缓存冒充实时的数据**
- 每次响应记录 `source` 与 `asOf`；`asOf` 早于最近交易日 → `stale: true`
- 分红送配：东财失败 → Tushare `dividend` 备源；仅取实施中的方案，按 `exDate` 降序

---

## 4. `src/ledger.js` — 象限账本（JSON 原子写）

```js
export function makeLedger(dataDir): {
  load(): State, save(State): void,
  accounts(): Quadrant[],
  initAccount({ quadrant, cash, totalAsset }): Quadrant,
  recordTrade({ quadrant, symbol, side, price, qty, fee, date, note, dividend,
                contract? }): Trade,
  positions(quadrant?): Position[],
  contracts(): Contract[],
  addContract(Contract): Contract,
  overrideContract({ contractId, patch, reason }): Contract,   // 必须带 reason，写审计
  transfers(): Transfer[],
  transfer({ from, to, amount, reason }): Transfer,            // 余额不足抛 ERR-LEDGER-002
  trades(quadrant?): Trade[],
  audit(): AuditRow[],
  auditAppend({ action, target, before, after, reason }): void,
}
```

数据文件：`$dataDir/ledger.json`（原子写：写 tmp → rename），`$dataDir/audit.jsonl`（追加）。
象限枚举固定 `['long','stable','short']`。

```js
Quadrant  = { quadrant, cash, initialCash, updatedAt }
Position  = { quadrant, symbol, name, qty, avgPrice, costPerShare, negative,
              dividends, openDate, contractId|null }
Trade     = { id, quadrant, symbol, side, price, qty, fee, amount, date, createdAt, note,
              contractId? }   // 仅当本笔成交带了契约草案且成功落库时出现
Contract  = { id, quadrant, symbol, mode, entry:{ price, qty, date },
              takeProfitPct, stopLossPct, maxHoldDays, locked:true,
              createdAt, overrides:[{ at, patch, reason }] }
```

**成交流水联动契约（P5 事前承诺）**：`recordTrade` 可选 `contract` 参数（契约草案），
与成交在**同一次 `save()`** 内落库（要么都成功、要么都不写）：
- 该象限 + 标的**尚无契约** → 新建 `locked:true` 契约，`trade.contractId` 指向新契约；
- 该象限 + 标的有**已存在契约** → 复用其 `id`（加仓不新建契约，`t/s/D` 保持锁定、不改历史），
  写一条 `contract.reuse` 审计说明；
- 草案的 `quadrant`/`symbol` 与成交不一致 → `ERR-CONTRACT-001`，整笔成交不落库。
`positions()` 的 `contractId` 由同一份契约表推导（同象限同标的取最新一条），
因此"成交 → 契约 → 持仓"三者的 id 严格自洽。
契约的 `t/s/D` 只能来自 `stable.buildLockedContract`（内部调 `adaptiveTarget`）或显式 `addContract`；
事后修改一律走 `overrideContract`（必须 reason，写审计）。

---

## 5. `src/risk.js` — 风控闸门（纯函数 + 少量账本读取）

```js
export const RED_LINES = {
  long:   { maxSymbolPct: 0.40, maxQuadrantPct: 0.70 },
  stable: { riskPerTrade: 0.01, maxSymbolPct: 0.25, maxQuadrantPct: 0.30,
            maxConsecutiveLoss: 4, weeklyDrawdownPct: 0.03, cooldownDays: 3 },
  short:  { maxSymbolPct: 0.20, maxQuadrantPct: 0.20, maxNewPerDay: 2,
            minWinRate: 0.45, hardMaxHoldDays: 5 },
};

/** 统一闸门：返回 { allowed:true } 或 { allowed:false, code, reason } */
export function gate({ mode, action, quadrant, signal, account, stats, config }): GateResult
// 检查顺序：象限启用 → 冷静期 → 连亏熔断 → 单票上限 → 象限上限 → 当日新开仓数 → 期望值自检
// 任一不过：allowed=false，code 形如 'ERR-RISK-003'，reason 中文可读

/** 期望值自检：盈亏比与最低胜率 */
export function expectancyCheck({ trades, payoffRatio }): {
  winRate:number|null, payoffRatio:number, requiredWinRate:number,
  expectancy:number, verdict:'OK'|'NOT_RECOMMENDED'|'INSUFFICIENT_SAMPLE', note:string }
// requiredWinRate = 1 / (1 + payoffRatio)
// 样本 < 20 笔 → INSUFFICIENT_SAMPLE（不得据此宣称有效）

/** 短线情绪总闸 */
export function sentimentGate({ indexAboveMa5, yesterdayLimitUpPremium, blowUpRate }):
  { open:boolean, reason:string }
// 指数跌破 5 日线 或 昨日涨停平均溢价 < 0 或 炸板率 > 0.4 → open:false

/** 短线 5 日硬期限（唯一不可 override 的红线） */
export function hardExitCheck({ openDate, asOf, maxHoldDays = 5 }): {
  mustExit:boolean, holdDays:number, remaining:number, rule:'SHORT.HARD_EXIT_5D', note:string }
// holdDays = tradingDaysBetween(openDate, asOf)：**真实交易日**（周末 + 法定节假日 + 交易所额外休市）
// 计数区间为半开区间 (openDate, asOf]：不含建仓当日、含 asOf 当日（沿用既有口径，不改硬红线触发点）

// 交易日计数唯一实现是 src/calendar.js（§11），risk.js 只做 re-export 兼容既有调用方：
export { tradingDaysBetween } from './calendar.js';
```

**硬红线**：`short.hardMaxHoldDays` 的强制离场指令**不接受 override**；
`gate()` 对 `action==='force_exit'` 恒放行，对 `action==='buy'` 在超期持仓存在时拒绝。
**日历越界即失败**：`openDate`/`asOf` 超出内置交易日历覆盖范围 → 抛 `ERR-CALENDAR-001`，
不回退到"只跳周末"（那会把法定节假日算成交易日，等于伪造计数）。

---

## 6. `src/plan.js` — 指令单构造

```js
export function buildPlan({ mode, asOf, tradingDay, signals, rejected, footnotes }): OrderPlan
export function renderPlanText(plan): string     // 人类可读，含表头/脚注/免责
export function toConditionOrders(plan): Array   // 券商条件单参数（L1 自动化的落点）
// 每条：{ symbol, side, triggerPrice, orderPrice, qty, validUntil, priceType }
/**
 * 已锁定契约 + 当前持仓 → 条件单参数（纯函数，无网络无时钟）。
 * 同一标的每个持仓产出 2 条：止盈（t）与止损（s），字段与 toConditionOrders 同口径。
 */
export function conditionOrdersFromContracts({ contracts, positions }): {
  orders: Array,     // { symbol, type:'take_profit'|'stop_loss', side:'sell',
                     //   triggerPrice, orderPrice, qty, validUntil, priceType:'limit' }
  warnings: Array,   // { symbol, code, message }；无契约/契约缺 t/s 时留痕，绝不编造行
}
/**
 * 券商条件单导入 CSV（纯函数）：表头固定
 * symbol,side,triggerPrice,orderPrice,qty,validUntil；CRLF 行尾、RFC4180 转义、
 * null/undefined → 空单元格；默认带 UTF-8 BOM（Excel 直接双击可读），bom:false 去掉。
 */
export function renderConditionOrdersCsv(orders, { bom = true } = {}): string
```
`buildPlan` 必须：整手取整（买 100 倍数，向下）、去重同标的同向、
被拒信号全部进 `rejected` 不得丢弃、追加固定脚注（as_of + 非投资建议）。

条件单导出口径（L1 自动化的落点，`kb_stable action=export`）：
- `triggerPrice = round2(entry.price × (1 + takeProfitPct | stopLossPct))`，与 `stable.checkPosition`
  的条件单参数**同一舍入口径**（2 位小数，四舍五入）；`orderPrice = triggerPrice`（到价即限价挂出）；
  `qty` 取该标的当前持仓股数（`positions()` 口径，已清仓不导出）。
- `validUntil = entry.date + maxHoldDays 个交易日`（`src/calendar.js#addTradingDays`，**真实交易日**：
  周末 + 法定节假日 + 交易所额外休市日全部跳过，覆盖 2024-01-01~2027-12-31）。
  entry.date 缺失/非法 → `null`（CSV 为空单元格），**不伪造日期**；entry.date 合法但日期落出日历
  覆盖范围 → `validUntil=null` + warning `STABLE.CALENDAR_UNCOVERED`（该标的其余字段照常导出，
  只留空有效期，绝不编造日期）。
- 契约选取：优先 `position.contractId` 精确匹配，否则退化为该标的最新契约（createdAt 最大）；
  同一标的只导出一次。
- 诚实失败：持仓存在但无锁定契约 → warning `STABLE.NO_CONTRACT`；契约缺 `entry.price`/`t`/`s`
  → warning `STABLE.CONTRACT_INCOMPLETE`；被跳过的不导出伪条件单。`orders` 为空时上层返回
  `ERR-EXPORT-001`（并原样带出 `warnings`）。

---

## 7. `src/strategies/*` — 三策略

统一导出（见 design.md §3.1）：

```js
export const meta = { mode, name, horizon, description, configSchema }
export function evaluate({ bars, position, account, config, indexBars, stats, dividends }): {
  signals: Signal[], plan: OrderPlan|null, diagnostics: object }
export function simulate?({ bars, config }): { metrics: object, trades: Trade[] }  // 可选
```

`evaluate` 的 `dividends`（可选）为 `market.dividends()` 的 `items`（`[{exDate, cashPerShare, ...}]`）：
仅长期象限消费（分红再投，见 §7.1），其余策略忽略；不传不影响既有行为。

### 7.1 `longTerm.js` 专有导出
```js
export function gridPlan({ bars, budget, config }): {
  basePrice, stepPct, gridUp:number[], gridDown:number[], qtyPerGrid,
  grids: [{ level, price, side, qty }] }
export function dilutionReport({ bars, dividends, lots, config }): {
  costPerShare, price, dividendYield, annualDilutionRate,
  etaYears:number|null, progress, note, reinvestEnabled:boolean }
/**
 * 分红再投（纯函数，无网络无时钟）：把除息日现金按除息价折成底仓股数（整手）。
 *
 * 除息来源双通道（按序）：
 *   1) bars.at(-1).dividendPerShare > 0 —— 回测/合成数据自带每股分红；
 *   2) dividends[] 中 exDate === bars.at(-1).date 且 cashPerShare > 0 —— 行情层日K
 *      不含分红（market.js 恒置 0），实盘必须走这条。
 *
 * 口径（写死在实现里，测试逐项手算对齐）：
 *   shares        = position.qty（除息日当时持股数，即上一交易日收盘持股）
 *   cashDividend  = round2(dividendPerShare × shares)
 *   price         = bars.at(-1).close（**未复权**收盘价：每股分红是未复权口径，
 *                   用 adjClose 折算会把股数算歪，绝不混用）
 *   qty           = 从 floor(cashDividend / price / 100) × 100 起逐手递减，直到
 *                   price × qty + tradeFee(buy) ≤ cashDividend（费用买不起就少买，不赊账）
 *   最终 qty < 100 → 不生成指令、进 rejected（整手是硬约束，不伪造成交）
 *
 * @returns {{ enabled:boolean, exDate:string|null, dividendPerShare:number, shares:number,
 *   cashDividend:number, price:number|null, qty:number, fee:number,
 *   rejected:{rule:string, reason:string}|null }}
 * rule 码：LONG.REINVEST_NO_POSITION / LONG.REINVEST_NO_PRICE / LONG.REINVEST_TOO_SMALL
 * enabled=false（默认）时不产生任何决策，rejected 恒为 null（无除息日也恒为 null）。
 */
export function reinvestPlan({ bars, position, dividends, config, fee }): object
```

**evaluate 内的分红再投（`config.reinvest: true`）**：`reinvestPlan` 产出 `qty ≥ 100` 时追加一条
`action:'buy'`、`rule:'LONG.REINVEST'` 的信号（信号收盘确认、次日成交，守住 P3）。指令单对同标的同向
去重（`plan.js`）：若当日网格买入与再投同时触发，**保留网格买入**，再投进 `plan.rejected` 且
`rule:'LONG.REINVEST_DEDUPED'`（不静默丢单，也不伪造第二笔成交）。`evaluate().diagnostics.reinvest`
始终带出 `reinvestPlan()` 结果，便于模型解释"为什么没有再投"。

**`dilutionReport` 与再投的关系**：`reinvestEnabled` 回显 `config.reinvest`；开启时 `note` 追加提示
"分红再投不增加 totalRecovered，成本转负进度会慢于该 ETA"——不改 ETA 公式，只如实提醒。

### 7.2 `stable.js` 专有导出
```js
export function adaptiveTarget({ bars, config }): {
  targetPct, stopLossPct, maxHoldDays, atrPct, positionPct }
export function checkPosition({ bars, contract, position }): {
  action:'hold'|'take_profit'|'stop_loss'|'time_exit',
  hitRule:string, detail:string, conditionOrders:object[] }
/**
 * 建仓契约草案（纯函数）：t/s/D 全部来自 adaptiveTarget，供 recordTrade({ contract }) 原子落库。
 * entry 必须来自真实成交（price>0、qty 为正整数），否则抛 ERR-CONTRACT-001；
 * 缺 symbol 抛 ERR-SYMBOL-001；bars 不足由 adaptiveTarget 抛 ERR-DATA-002（绝不编造 t/s）。
 */
export function buildLockedContract({ bars, symbol, entry, config, note }): {
  quadrant:'stable', symbol, mode:'stable',
  entry:{ price, qty, date }, takeProfitPct, stopLossPct, maxHoldDays,
  source:'adaptiveTarget', note }
```

### 7.3 `shortTerm.js` 专有导出
```js
export function scoreCandidates({ quotes, barsMap, indexBars, config }): Array<{
  symbol, name, score, factors:object, reasons:string[], tradable:boolean, note:string }>
export function exitPlan({ position, bars, contract }): {
  action, mustExit:boolean, deadline:string, reason:string }
/**
 * 短线候选池构建（纯函数，无网络/时钟）：涨幅榜/换手/量比纳入，ST/次新/流通市值/成交额/停牌/一字板剔除。
 * quotes 来自 market.parseClistRow；limitUpRows 来自 market.parseLimitUpRow（可为空——此时封单/连板因子
 * 缺失，打分偏保守，不得凭空补 0 以外的值）。
 * @param {{quotes:object[], limitUpRows?:object[], asOf:string, config?:object}} p
 * @returns {{ asOf, candidates: Candidate[], rejected: [{symbol,name,rule,reason}], stats }}
 * Candidate = scoreOne 的输入字段（symbol,name,gainPct,turnover,volumeRatio,limitUp,blown,
 *             firstLimitTime,boards,floatCap,amount20Avg,listDays,st,oneWordBoard,sealAmount,
 *             mainNetInflow,amount,sectorLimitUps）
 * 纳入：limitUp 或 gainPct >= minGainPct(0.05) 或 turnover >= minTurnover(0.05) 或 volumeRatio >= minVolRatio(2)
 * 剔除：ST/*ST、上市自然日 < minListDays(60)、floatCap < minFloatCap(3e9)、
 *       amount < minAmount(1e8)、suspended、一字板（open=high=low=price=涨停价，买不到）
 *      上市日/流通市值/成交额缺失 → 保守剔除（LIST_DATE_MISSING/FLOAT_CAP_MISSING/AMOUNT_MISSING），
 *      不得用默认值冒充真实数据。
 * 口径说明：clist 无「20 日均成交额」，以当日成交额作代理（amount20Avg=amount），
 *           已在候选 note 标注，不冒充均额。
 */
export function buildCandidatePool({ quotes, limitUpRows, asOf, config }): object
```

---

## 8. `src/backtest.js`

```js
export function runBacktest({ bars, signals, initialCash = 100000, fee = DEFAULT_FEE,
                              mode = 'stable', tPlus1 = true, lot = 100 }): {
  metrics: { totalReturn, annualReturn, maxDrawdown, sharpe, trades, winRate,
             payoffRatio, avgHoldDays, feeRatio, costToNegativeProgress },
  equityCurve: [{ date, equity, position }],
  trades: [{ symbol, buyDate, sellDate, buyPrice, sellPrice, qty, pnl, pnlPct, holdDays, reason }]
}
```
执行语义（P3）：`signals[i]` 在 bar i 收盘确认 → bar i+1 开盘成交；
一字涨停不成交买入；跌停不成交卖出；停牌跳过；买入整手向下取整。

---

## 9. `index.js` — 工具注册

```js
export const name = 'kuibuequity';
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({ dataDir, defaultQuadrantSplit, fee, httpTimeoutMs, allowLanState });
export function apply(ctx, config) { ctx.tools.register(defineTool({...})) ... }
```
工具参数用扁平 `type/required/description` 描述（与 dsh-super-agents 同风格），
返回 `JSON.stringify` 文本；错误统一 `{ ok:false, code, message }`。

---

## 10. 错误码表

| Code | 含义 |
| :-- | :-- |
| `ERR-DATA-001` | 行情源不可达 / 超时 |
| `ERR-DATA-002` | 数据不足（K 线长度 < 策略最小要求） |
| `ERR-DATA-003` | 数据陈旧（超过 1 个交易日） |
| `ERR-SYMBOL-001` | 无法识别的证券代码 |
| `ERR-LEDGER-001` | 账本不存在或未初始化 |
| `ERR-LEDGER-002` | 象限现金不足 |
| `ERR-LEDGER-003` | 持仓不足，无法卖出 |
| `ERR-RISK-001` | 象限处于冷静期 |
| `ERR-RISK-002` | 连亏熔断中 |
| `ERR-RISK-003` | 超出单票仓位上限 |
| `ERR-RISK-004` | 超出象限仓位上限 |
| `ERR-RISK-005` | 当日新开仓数达上限 |
| `ERR-RISK-006` | 期望值不达标，象限停用（NOT_RECOMMENDED） |
| `ERR-RISK-007` | 情绪总闸关闭，短线禁止开仓 |
| `ERR-PLAN-001` | 数量不足 1 手，无法生成指令 |
| `ERR-PLAN-002` | 涨跌停/停牌导致无法成交 |
| `ERR-CONTRACT-001` | 契约锁定，修改需 override + reason |
| `ERR-OVERRIDE-001` | 硬红线不可 override（短线 5 日强制离场） |
| `ERR-CALENDAR-001` | 交易日历不支持该日期（非法日期 / 超出内置覆盖范围），禁止回退到"只跳周末" |

---

## 11. `src/calendar.js` — 交易日历（纯函数）

> 唯一事实源：本节的覆盖范围、计数口径与错误语义。实现不得另立一套"只跳周末"的近似。

```js
export const CALENDAR_VERSION = '2026.11';          // 年度表版本，每年国务院通知发布后更新
export const CALENDAR_COVERAGE = { from: '2024-01-01', to: '2027-12-31',
                                   years: [2024, 2025, 2026, 2027] };
export const HOLIDAYS = { 2024: [...], 2025: [...], 2026: [...], 2027: [...] };
// 每个年份数组 = 该年**落在周一~周五**的法定节假日（YYYY-MM-DD 升序）；周末天然非交易日，不入表
export const EXCHANGE_EXTRA_CLOSED = { 2024: ['2024-02-09'] };
// 交易所额外休市日：A 股休市但当年国务院未列为法定假日（2024 除夕），必须计入否则计数偏多
export const HOLIDAY_SOURCES = { 2024: { publishedAt, notice? }, ... };

/** 单个自然日的日历信息；非法/不可解析日期 → null（不抛，供探针使用） */
export function tradingDayInfo(date): {
  date:string, covered:boolean, weekend:boolean, holiday:boolean,
  trading:boolean|null        // covered=false → null（未知，绝不冒充可交易/不可交易）
}|null

/** 是否交易日：非法日期或超出覆盖范围 → 抛 ERR-CALENDAR-001 */
export function isTradingDay(date): boolean

/** (from, to] 区间内的交易日数：不含 from、含 to；from >= to → 0 */
export function tradingDaysBetween(from, to): number
// 非法日期 / 任一端超出覆盖范围 → 抛 ERR-CALENDAR-001（不回退到跳周末近似）

/** date 之后第 n 个交易日（n 为正整数）；date 非法或 n 非正整数 → null */
export function addTradingDays(date, n): string|null
// 走查过程一旦越出 CALENDAR_COVERAGE → 抛 ERR-CALENDAR-001（返回 null 只表示"入参不足"，
// 绝不拿未知年份的日历冒充结果）

/** 某年交易日总数；年份未被覆盖 → 抛 ERR-CALENDAR-001 */
export function tradingDaysInYear(year): number

/** ≤ date 的最近一个交易日（含当日）；非法/越界 → 抛 ERR-CALENDAR-001 */
export function lastTradingDayOnOrBefore(date): string
```

口径：
- 交易日 = 周一~周五 且 不在 `HOLIDAYS[year]` / `EXCHANGE_EXTRA_CLOSED[year]` 中；
  **周末调休上班日（如 2/14 周六上班）A 股并不开市**，因此不补为交易日。
- 日期一律 `YYYY-MM-DD`（允许 `YYYY-MM-DDTHH:mm...`，只取前 10 位；不做时区换算，
  调用方负责传北京时区自然日）；溢出日（`2026-02-30`）必须拒绝，不得让 `Date` 自动进位。
- 年度维护：新一年国务院通知发布后，把该年"落在工作日的节假日 + 交易所额外休市日"追加进
  `HOLIDAYS` / `EXCHANGE_EXTRA_CLOSED`，扩 `CALENDAR_COVERAGE.to` 与 `CALENDAR_VERSION`，
  并在 `test/calendar.test.js` 补该年度计数用例（含春节/国庆跨假期手算对齐）。
- 消费方：`risk.hardExitCheck`（短线 5 日硬期限）、`strategies/stable.checkPosition`
  （时间止损 `holdDays`）、`plan.conditionOrdersFromContracts`（条件单 `validUntil`）、
  `market.computeStale`（陈旧判定锚定最近交易日：节假日期间不误报 stale；日历未覆盖年份
  回退"最近工作日"，只高估陈旧、不把旧数据说成新鲜）。
