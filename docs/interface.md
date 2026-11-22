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

/** 日 K（默认前复权） */
export async function dailyBars(symbol, { days = 250, adjust = 'qfq', timeoutMs = 10000 } = {})
   : Promise<{ symbol, bars: Bar[], adjust, asOf, stale, source, count }>
Bar = { date, open, high, low, close, volume, amount, adjClose,
        limitUp:boolean, limitDown:boolean, suspended:boolean, dividendPerShare:number }

/** 分红送配历史（用于股息率与摊薄模拟） */
export async function dividends(symbol, { timeoutMs = 10000 } = {})
   : Promise<{ symbol, items: [{ exDate, cashPerShare, bonusShares, capitalizeShares }], source }>

/** 指数收盘序列（大盘过滤用），默认 000300 沪深300 */
export async function indexBars(symbol = '000300', { days = 60 } = {}): Promise<{ bars: Bar[], asOf }>
```

实现要求：
- 只用 `node:https`/`fetch`，零第三方依赖
- 失败重试 ≤3 次指数退避；最终失败 `throw new Error('ERR-DATA-001: ...')`
- 网络不可用时返回明确错误码，**绝不返回伪造或缓存冒充实时的数据**
- 每次响应记录 `source` 与 `asOf`；`asOf` 早于最近交易日 → `stale: true`

---

## 4. `src/ledger.js` — 象限账本（JSON 原子写）

```js
export function makeLedger(dataDir): {
  load(): State, save(State): void,
  accounts(): Quadrant[],
  initAccount({ quadrant, cash, totalAsset }): Quadrant,
  recordTrade({ quadrant, symbol, side, price, qty, fee, date, note }): Trade,
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
Trade     = { id, quadrant, symbol, side, price, qty, fee, amount, date, createdAt, note }
Contract  = { id, quadrant, symbol, mode, entry:{ price, qty, date },
              takeProfitPct, stopLossPct, maxHoldDays, locked:true,
              createdAt, overrides:[{ at, patch, reason }] }
```

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
```

### 7.3 `shortTerm.js` 专有导出
```js
export function scoreCandidates({ quotes, barsMap, indexBars, config }): Array<{
  symbol, name, score, factors:object, reasons:string[], tradable:boolean, note:string }>
export function exitPlan({ position, bars, contract }): {
  action, mustExit:boolean, deadline:string, reason:string }
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
