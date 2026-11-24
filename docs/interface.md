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
```

**硬红线**：`short.hardMaxHoldDays` 的强制离场指令**不接受 override**；
`gate()` 对 `action==='force_exit'` 恒放行，对 `action==='buy'` 在超期持仓存在时拒绝。

---

## 6. `src/plan.js` — 指令单构造

```js
export function buildPlan({ mode, asOf, tradingDay, signals, rejected, footnotes }): OrderPlan
export function renderPlanText(plan): string     // 人类可读，含表头/脚注/免责
export function toConditionOrders(plan): Array   // 券商条件单参数（L1 自动化的落点）
// 每条：{ symbol, side, triggerPrice, orderPrice, qty, validUntil, priceType }
```
`buildPlan` 必须：整手取整（买 100 倍数，向下）、去重同标的同向、
被拒信号全部进 `rejected` 不得丢弃、追加固定脚注（as_of + 非投资建议）。

---

## 7. `src/strategies/*` — 三策略

统一导出（见 design.md §3.1）：

```js
export const meta = { mode, name, horizon, description, configSchema }
export function evaluate({ bars, position, account, config, indexBars, stats }): {
  signals: Signal[], plan: OrderPlan|null, diagnostics: object }
export function simulate?({ bars, config }): { metrics: object, trades: Trade[] }  // 可选
```

### 7.1 `longTerm.js` 专有导出
```js
export function gridPlan({ bars, budget, config }): {
  basePrice, stepPct, gridUp:number[], gridDown:number[], qtyPerGrid,
  grids: [{ level, price, side, qty }] }
export function dilutionReport({ bars, dividends, lots, config }): {
  costPerShare, price, dividendYield, annualDilutionRate,
  etaYears:number|null, progress, note }
```

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
