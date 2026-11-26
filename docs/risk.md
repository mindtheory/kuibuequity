# 风控与合规（Risk & Compliance）

> 上游事实源：`docs/design.md` §4.6 / §5.4 / §6.5 / §11 / §12、`docs/interface.md` §5 与 §10 错误码表。
> 立场：风控是**事前写死的红线**，事中不可临时更改；硬红线连 override 都不接受。
> 实现状态：`src/risk.js` 已有骨架，本文中标注「计划」的检查项尚未落地。

---

## 1. RED_LINES 全表

来源：`src/risk.js` 的 `RED_LINES`（与 `interface.md` §5 一致）。

### 1.1 长期 `long`

| 字段 | 默认值 | 含义 | 可 override | 违反码 |
| :-- | :-- | :-- | :-- | :-- |
| `maxSymbolPct` | 0.40 | 单票市值 ≤ 长期账户 40% | 可（需理由，只可下调为默认建议） | `ERR-RISK-003` |
| `maxQuadrantPct` | 0.70 | 长期象限 ≤ 总资金 70% | 可（同上） | `ERR-RISK-004` |
| 网格打满（派生） | `close < P0×(1−g×N)` | 停止加仓，只出不进 | **不可**（熔断即事实） | `diagnostics.halt = LONG.GRID_EXHAUSTED` |
| 基本面恶化（派生） | 连续 2 年扣非亏损 / 股息率同比降 >40% / 被 ST | 冻结网格，降级"只出不进" | **不可** | `LONG.FUNDAMENTAL_DETERIORATED` |
| 停牌 | `suspended === true` | 当日全部指令转 rejected | 不可（无法成交是事实） | `ERR-PLAN-002` |

### 1.2 稳定 `stable`

| 字段 | 默认值 | 含义 | 可 override | 违反码 |
| :-- | :-- | :-- | :-- | :-- |
| `riskPerTrade` | 0.01 | 每笔最大亏损 = 象限账户 1% | 可，**只可下调** | 仓位反推时体现 |
| `maxSymbolPct` | 0.25 | 单票 ≤ 象限 25% | 可，只可下调 | `ERR-RISK-003` |
| `maxQuadrantPct` | 0.30 | 象限 ≤ 总资金 30% | 可，只可下调 | `ERR-RISK-004` |
| `maxConsecutiveLoss` | 4 | 连亏 4 笔熔断 5 交易日 | **不可** | `ERR-RISK-002` |
| `weeklyDrawdownPct` | 0.03 | 周回撤 ≥3% 熔断 5 交易日 | **不可** | `ERR-RISK-002` |
| `cooldownDays` | 3 | 平仓后同标的 3 交易日冷静期 | 可延长，**不可设为 0** | `ERR-RISK-001` |
| `minWinRate` | 0.45（派生） | 期望值自检线 | **不可** | `ERR-RISK-006` |
| 契约锁定 | `contract.locked = true` | 止盈/止损/期限中途不可改 | 可（`override + reason`，写审计） | `ERR-CONTRACT-001` |

### 1.3 短线 `short`

| 字段 | 默认值 | 含义 | 可 override | 违反码 |
| :-- | :-- | :-- | :-- | :-- |
| `maxSymbolPct` | 0.20 | 单票 ≤ 短线账户 20% | 可，只可下调 | `ERR-RISK-003` |
| `maxQuadrantPct` | 0.20 | 短线象限 ≤ 总资金 20% | 可，只可下调 | `ERR-RISK-004` |
| `maxNewPerDay` | 2 | 同日新开仓 ≤ 2 只 | 可，只可下调 | `ERR-RISK-005` |
| `minWinRate` | 0.45 | 滚动 30 笔胜率线 | **不可** | `ERR-RISK-006` |
| `hardMaxHoldDays` | **5** | **5 交易日强制离场** | **绝对不可** | `ERR-OVERRIDE-001` |
| 情绪总闸 | 见 §5 | 关闭时禁止一切买入 | **不可** | `ERR-RISK-007` |
| 止损 −3% | 0.03 | 无条件止损 | **不可** | 条件单前置，`gate()` 恒放行 |

### 1.4 象限默认资金分配（design.md §6.6）

| 象限 | 默认占总资金 | 红线 | 说明 |
| :-- | :-- | :-- | :-- |
| `long` | 60% | 70% | 高股息底仓，几乎不动 |
| `stable` | 30% | 30% | 纪律止盈，中频 |
| `short` | 10% | 20% | 强制离场，可全损也不心疼 |

跨象限调拨必须显式 `transfer({from,to,amount,reason})` 并写审计；
**"短线套了拿长期的钱补"在账本层面直接拒绝**（现金可调拨但需理由并计入复盘"救火"清单；持仓永不跨象限迁移）。

---

## 2. 闸门检查顺序（`gate()`）

契约顺序（`interface.md` §5）：

```
象限启用 → 冷静期 → 连亏熔断 → 单票上限 → 象限上限 → 当日新开仓数 → 期望值自检
```

完整判定表（含前置放行规则）：

| 序 | 检查 | 适用动作 | 拒绝码 | reason 示例 | 实现状态 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 0a | **强制离场/止损恒放行**：`action ∈ {force_exit, stop_loss}` | 全部 | — | 直接 `{allowed:true}` | ✅ 已实现 |
| 0b | 非买入动作（`hold`/`sell`/`take_profit`）放行 | 全部 | — | `{allowed:true}` | ✅ 已实现 |
| 0c | **超期持仓存在时拒绝新开仓**（短线 5 日硬期限未清） | buy | `ERR-OVERRIDE-001` | "存在超期未清的短线持仓，先执行强制离场" | **计划** |
| 1 | **象限启用**：人工暂停 / 熔断暂停 / 自检停用 | buy | `ERR-RISK-002` / `ERR-RISK-006` | "本象限处于暂停期（至 2026-11-27）" | **计划**（当前由 stats 间接体现） |
| 2 | **情绪总闸**（仅 short，优先于个股打分） | buy | `ERR-RISK-007` | "炸板率 46% > 40%（情绪退潮）" | ✅ `sentimentGate()` |
| 3 | **冷静期**：`asOf ≤ cooldownUntil[symbol]` | buy | `ERR-RISK-001` | "600xxx 处于冷静期（至 2026-11-25）" | ✅ 已实现 |
| 4a | **连亏熔断**：`consecutiveLosses ≥ maxConsecutiveLoss` | buy | `ERR-RISK-002` | "连续亏损 4 笔 ≥ 熔断线 4，本象限暂停" | ✅ 已实现 |
| 4b | **周回撤熔断**：`weeklyDrawdown ≥ weeklyDrawdownPct` | buy | `ERR-RISK-002` | "本周回撤 3.10% ≥ 3%，本象限暂停" | ✅ 已实现 |
| 5 | **单票上限**：`(symbolValue + buyValue)/equity > maxSymbolPct` | buy | `ERR-RISK-003` | "买入后占比将超过单票上限 25%" | ✅ 已实现 |
| 6 | **象限上限**：`(quadrantValue + buyValue)/totalAsset > maxQuadrantPct` | buy | `ERR-RISK-004` | "买入后长期象限超过总资金 70%" | **计划** |
| 7 | **当日新开仓数**：`newOpensToday ≥ maxNewPerDay` | buy | `ERR-RISK-005` | "当日新开仓已达 2 只上限" | ✅ 已实现 |
| 8 | **期望值自检**：`verdict === 'NOT_RECOMMENDED'` | buy | `ERR-RISK-006` | "近 50 笔胜率 41.2% 低于要求的 44.4%" | ✅ 已实现 |
| 9 | 现金/持仓充足性（账本层，非 gate） | buy/sell | `ERR-LEDGER-002` / `ERR-LEDGER-003` | "象限现金不足" | 账本层 |
| 10 | 整手与可成交性（`plan.js` 层） | buy/sell | `ERR-PLAN-001` / `ERR-PLAN-002` | "数量不足 1 手" / "停牌无法成交" | ✅ 部分（`plan.js` 骨架） |

要点：

- **任一不过即返回**，不继续往下（首个拒绝码即诊断结论），被拒信号必须进 `plan.rejected` 留痕，不得静默丢弃。
- 长期象限的 `RED_LINES.long` 没有 `cooldownDays`/`maxConsecutiveLoss` 字段，
  第 3/4 步比较时因 `undefined` 参与比较为假而**自然跳过** —— 这是有意设计（长期靠网格熔断而非连亏熔断）。
- 第 2 步情绪总闸只对 `short` 生效，且**优先于任何个股打分**：闸门关闭时 90 分的票也不发买入指令。

---

## 3. 冷静期 / 连亏熔断 / 周回撤 判定算法

### 3.1 冷静期（cooldown）

```text
on 平仓(symbol, date):
    cooldownUntil[symbol] = addTradingDays(date, RED_LINES[mode].cooldownDays)   # 默认 3

gate 检查:
    if stats.cooldownUntil[signal.symbol] and stats.asOf <= cooldownUntil[symbol]:
        return { allowed:false, code:'ERR-RISK-001',
                 reason:`${symbol} 处于冷静期（至 ${cooldownUntil[symbol]}），平仓后 3 个交易日内不得再入` }
```

| 项 | 规则 |
| :-- | :-- |
| 起算 | **平仓当日不计**，从次一交易日起数 `cooldownDays` 个 |
| 解除 | 到达当日**收盘后**解除（即该日仍不可买，次交易日可买）—— 实现用 `asOf <= cooldown` 判定 |
| 作用域 | 按 `symbol` 记，不同标的互不影响；跨象限同标的也共享（防止换象限绕过） |
| 对抗人性 | "不服气，当天追回同一只票" |

**算例**：600xxx 于 2026-11-20（周五）平仓，`cooldownDays=3`
→ 冷静期至 2026-11-25（下周三）；11-23、11-24、11-25 买入均返回 `ERR-RISK-001`，11-26 放行。

### 3.2 连亏熔断（circuit breaker）

```text
on 平仓(trade):
    if trade.pnl < 0: consecutiveLosses += 1
    else:             consecutiveLosses = 0          # 任一盈利笔即归零

gate 检查:
    if consecutiveLosses >= RED_LINES[mode].maxConsecutiveLoss:
        if breakerUntil is null:
            breakerUntil = addTradingDays(asOf, 5)   # 熔断时长 5 交易日（design.md §5.4）
            auditAppend({ action:'RISK.BREAKER_ON', target:mode,
                          before:{consecutiveLosses}, after:{breakerUntil}, reason:'连亏达上限' })
        return { allowed:false, code:'ERR-RISK-002', reason:`连续亏损 ${n} 笔 ≥ 熔断线 4，本象限暂停至 ${breakerUntil}` }

on 每个新交易日:
    if breakerUntil and asOf > breakerUntil:
        breakerUntil = null; consecutiveLosses = 0
        auditAppend({ action:'RISK.BREAKER_OFF', ... })
```

| 项 | 规则 |
| :-- | :-- |
| 计数口径 | **已平仓实现盈亏**，浮亏不计；盈利/打平（pnl ≥ 0）即归零 |
| 熔断时长 | 5 个交易日（design.md §5.4）；`RED_LINES` 中暂无该字段，见 §8 澄清项 R2 |
| 解除后 | 连亏计数归零重新起算（不给"再来一把就回本"的暗示） |
| 边界 | 实现用 `>=`（design.md 表述为"连续 4 笔"），即第 4 笔亏损当笔即触发 |

**算例**（账户 100,000，`riskPerTrade=1%`）：

| 笔 | 实现盈亏 | 连亏 | 判定 |
| :-- | :-- | :-- | :-- |
| 1 | −475 | 1 | 放行 |
| 2 | −500 | 2 | 放行 |
| 3 | +574 | 0 | 放行（归零） |
| 4 | −500 | 1 | 放行 |
| 5 | −500 | 2 | 放行 |
| 6 | −500 | 3 | 放行 |
| 7 | −500 | **4** | **`ERR-RISK-002`，暂停至 5 交易日后** |

### 3.3 周回撤（weekly drawdown）

```text
weekAnchor = 本周一（或本周首个交易日）开盘前记录的象限净值
             # 即上一周最后一个交易日收盘时的 equity（现金 + 持仓市值）

weeklyDrawdown = max(0, (weekAnchor − equityNow) / weekAnchor)

gate 检查:
    if weeklyDrawdown >= RED_LINES[mode].weeklyDrawdownPct:     # 默认 0.03
        breakerUntil = addTradingDays(asOf, 5)
        return { allowed:false, code:'ERR-RISK-002',
                 reason:`本周回撤 ${(weeklyDrawdown*100).toFixed(2)}% ≥ 3%，本象限暂停` }
```

| 项 | 规则 |
| :-- | :-- |
| 净值口径 | 象限**现金 + 持仓市值**（按当日收盘），不是仅实现盈亏 |
| 锚点重置 | 每周一重置为上周收盘净值；跨周不累计（跨周累计由 `maxDrawdown` 在复盘里看） |
| 与连亏熔断关系 | **两条独立，任一命中即停**，不叠加时长 |
| 边界 | 实现用 `>=`（design.md 表述 ">3%"），保守侧取 `>=`，见澄清项 R3 |

**算例**：上周收盘净值 100,000 → 本周净值 96,900
→ `weeklyDrawdown = (100,000 − 96,900)/100,000 = 3.10% ≥ 3%` → 熔断。
若本周净值 97,000 → 3.00% ≥ 3% → **同样熔断**（`>=` 边界）。

### 3.4 交易日计数

```text
tradingDaysBetween(from, to)   # 真实交易日：周末 + 法定节假日 + 交易所额外休市全部跳过
                               # 半开区间 (from, to]：不含 from、含 to；from >= to → 0
```

唯一实现在 `src/calendar.js`（契约见 `docs/interface.md` §11），`src/risk.js` 只 re-export 兼容既有调用。
年度表内置 2024-01-01~2027-12-31：

| 年 | 工作日休市 | 交易日 |
| :-- | :-- | :-- |
| 2024 | 19 天法定 + 除夕 2/9 交易所休市 = 20 | 262 − 20 = 242 |
| 2025 | 18 天法定（春节含除夕） | 261 − 18 = 243 |
| 2026 | 19 天法定 | 261 − 19 = 242 |
| 2027 | 18 天法定（春节含除夕） | 261 − 18 = 243 |

口径与诚实失败（P6）：
- 交易日 = 周一~周五 且 不在年度表；**调休上班的周末 A 股并不开市**，不补为交易日。
- 超出覆盖范围（如 2028 年）→ 抛 `ERR-CALENDAR-001`，**不回退到"只跳周末"**：
  回退会把春节/国庆算成交易日，硬红线提前砍仓、冷静期/熔断提前解除，属于伪造计数。
- 溢出日（`2026-02-30`）一律拒绝，`Date` 自动进位不得冒充真日期。
- 年度维护：国务院新一年通知发布后更新 `HOLIDAYS`/`EXCHANGE_EXTRA_CLOSED`/`CALENDAR_COVERAGE`，
  同步扩 `test/calendar.test.js` 年度计数用例。见澄清项 R4（已关闭）。

---

## 4. 期望值自检（`expectancyCheck`）

### 4.1 公式推导

设胜率 `p`、平均盈利 `W`、平均亏损 `L`（取正数）、盈亏比 `payoffRatio = W / L`：

```
期望值 E = p·W − (1 − p)·L  > 0
代入 W = payoffRatio · L：
      p · payoffRatio · L − (1 − p) · L > 0
      p · payoffRatio > 1 − p
      p · (1 + payoffRatio) > 1
  ⟹   p > 1 / (1 + payoffRatio) = requiredWinRate
```

### 4.2 稳定象限 1.25 : 1 → 44.4% 的推导

稳定象限契约：`t = clamp(2×ATR14%, 1%, 5%)`，`s = −0.8 × t`
→ `payoffRatio = t / |s| = 1 / 0.8 = 1.25`

```
requiredWinRate = 1 / (1 + 1.25) = 1 / 2.25 = 0.444444… ≈ 44.4%
```

| 止损系数 | 盈亏比 | 要求胜率 | 评价 |
| :-- | :-- | :-- | :-- |
| 0.5 | 2.00 | 33.3% | 胜率要求低，但止损太紧 → 实际胜率被扫单拉低 |
| **0.8（默认）** | **1.25** | **44.4%** | 平衡点 |
| 1.0 | 1.00 | 50.0% | 需要一半以上胜率，A 股 T+1 下很难稳定达到 |

### 4.3 判定算法

```text
expectancyCheck({ trades, payoffRatio }):
    n = trades.length
    if n < 20: return { verdict:'INSUFFICIENT_SAMPLE', note:`样本仅 ${n} 笔（<20），不足以判定` }
    wins   = trades.filter(t => t.pnl > 0)
    losses = trades.filter(t => t.pnl < 0)
    wr     = wins.length / n
    avgWin = mean(wins.pnl)   avgLoss = |mean(losses.pnl)|
    payoff = payoffRatio ?? (avgWin / avgLoss)
    required    = 1 / (1 + payoff)
    expectancy  = wr·avgWin − (1 − wr)·avgLoss
    verdict = (wr < required || expectancy <= 0) ? 'NOT_RECOMMENDED' : 'OK'
```

| 规则 | 说明 |
| :-- | :-- |
| 样本窗口 | 稳定象限滚动 **50** 笔；短线象限滚动 **30** 笔（design.md §5.5 / §6.5） |
| 最小样本 | `< 20` 笔 → `INSUFFICIENT_SAMPLE`，**不得据此宣称有效**，也不得据此停用 |
| 双条件 | 胜率不达标 **或** 期望收益 ≤ 0，任一即 `NOT_RECOMMENDED` |
| 后果 | `gate()` 第 8 步 → `ERR-RISK-006`，象限停用；输出 `verdict:"NOT_RECOMMENDED"` + 中文原因 |
| 统计口径 | 必须用**含费用**的实现盈亏 `pnl`（含费盈亏比更低，见 cost-model.md §2.4 算例） |

**算例**（稳定象限，滚动 50 笔，含费）：胜率 41.2%、平均盈利 574 元、平均亏损 500 元

```
payoffRatio = 574/500 = 1.148        requiredWinRate = 1/2.148 = 46.6%
winRate 41.2% < 46.6%  →  NOT_RECOMMENDED
expectancy = 0.412×574 − 0.588×500 = 236.49 − 294.00 = −57.51 元/笔  （≤0，双重不达标）
输出: "近 50 笔胜率 41.2% 低于盈亏比要求的 46.6%，当前该纪律为负期望，建议停用本象限"
```

> 这是 design.md 原则 **P6「诚实的失败」**的硬实现：
> **工具会拒绝帮用户做一件数学上亏钱的事**，而不是"看起来能用就给建议"。

---

## 5. 短线情绪总闸（`sentimentGate`）

### 5.1 判定（三条件 OR，任一命中即关闭）

```text
sentimentGate({ indexAboveMa5, yesterdayLimitUpPremium, blowUpRate }):
    reasons = []
    if indexAboveMa5 === false:            reasons.push('指数收盘跌破 5 日线')
    if yesterdayLimitUpPremium < 0:        reasons.push(`昨日涨停今日平均溢价 ${x}% < 0（亏钱效应）`)
    if blowUpRate > 0.40:                  reasons.push(`炸板率 ${x}% > 40%（情绪退潮）`)
    return { open: reasons.length === 0, reason: reasons.join('；') or '情绪正常' }
```

| 指标 | 定义 | 数据来源 | 阈值 |
| :-- | :-- | :-- | :-- |
| `indexAboveMa5` | 指数（默认 000300）收盘 ≥ 其 5 日均线 | `indexBars` | 跌破即关 |
| `yesterdayLimitUpPremium` | 昨日涨停股今日平均涨幅（赚钱效应） | 候选池统计（计划） | < 0 即关 |
| `blowUpRate` | 炸板率 = 盘中触及涨停但收盘未封住 / 触及涨停总数 | 盘中快照（计划） | > 0.40 即关 |

### 5.2 优先级与后果

```
情绪总闸（象限级） > 个股打分卡 > 仓位公式
```

- 关闭时：短线象限**当日空仓**，不输出任何买入指令；已持仓的离场规则（§3.2(c)(d)）**照常执行**。
- 拒绝码 `ERR-RISK-007`，`reason` 必须逐条列出命中的指标与数值。
- **算例**：指数跌破 5 日线 + 昨日涨停平均溢价 −1.2% + 炸板率 46%
  → `open:false`，`reason:"指数收盘跌破 5 日线；昨日涨停今日平均溢价 -1.2% < 0；炸板率 46% > 40%（情绪退潮）"`。

### 5.3 数据缺失时的行为（当前缺陷，必须修）

当前实现用 `Number(x) < 0` / `Number(x) > 0.4` 判定，参数缺失（`undefined` → `NaN`）时**比较为假 → 视为未触发 → 放行**。
这与 P6 冲突：**没有情绪数据时不应该默认"情绪正常"**。
建议改为：任一指标缺失 → `open:false` + `reason:"情绪指标数据不足（ERR-DATA-002）"`。
该项为**计划**（需先改 `interface.md` §5 的空值语义），见澄清项 R5。

---

## 6. override 流程

### 6.1 可改 / 不可改清单

| 对象 | 可否 override | 说明 |
| :-- | :-- | :-- |
| 短线 **5 日强制离场**（`hardMaxHoldDays`） | **绝对不可** | 唯一硬红线：它是区分"短线"与"套牢"的唯一边界。请求即 `ERR-OVERRIDE-001` |
| 短线 −3% 止损、稳定止损 | **不可放宽** | 可提前（收紧），不可延后/放宽 |
| 连亏熔断、周回撤熔断 | **不可** | 熔断期内不接受任何买入请求 |
| 期望值自检停用（`ERR-RISK-006`） | **不可**（象限级） | 需样本重新累积达标后自动恢复 |
| 情绪总闸 | **不可** | 象限级闸门 |
| 稳定象限契约 `takeProfitPct` / `stopLossPct` / `maxHoldDays` | **可**（需 `reason`） | `overrideContract({contractId, patch, reason})`，写审计，复盘逐条列出 |
| `maxSymbolPct` / `maxQuadrantPct` / `maxNewPerDay` | **可，只可下调** | 上调等于放宽红线，一律拒绝 |
| `cooldownDays` | **可，只可延长** | 设 0 视为放宽，拒绝 |
| 长期网格参数（`g`/`N`/`coreWeight`） | **可**（属契约参数，需 `reason`） | 中途改参数会破坏网格锚定，复盘重点检查 |
| 象限资金分配（`transfer`） | **可**（需 `reason`） | 写审计；"救火式"调拨在复盘单列 |

### 6.2 流程

```text
overrideContract({ contractId, patch, reason }):
    require reason 非空且长度 >= 8 字            # 空泛理由（"感觉"/"想改"）直接拒绝
    require contract.locked === true
    if patch 触及 hardRedLines: return ERR-OVERRIDE-001
    if patch 放宽 maxSymbolPct/maxQuadrantPct/maxNewPerDay/cooldownDays: return ERR-OVERRIDE-001
    before = pick(contract, keys(patch))
    contract.overrides.push({ at: now(), patch, reason })
    apply patch to contract
    auditAppend({ action:'CONTRACT.OVERRIDE', target:contractId, before, after:patch, reason })
```

### 6.3 审计字段（`audit.jsonl` 每行一条）

| 字段 | 类型 | 说明 |
| :-- | :-- | :-- |
| `ts` | ISO-8601 | 发生时刻（含时区） |
| `action` | string | `CONTRACT.OVERRIDE` / `RISK.BREAKER_ON` / `RISK.BREAKER_OFF` / `LEDGER.TRANSFER` / `RISK.DENY` |
| `target` | string | `contractId` / 象限名 / `symbol` |
| `before` | object | 修改前值（仅涉及字段） |
| `after` | object | 修改后值 |
| `reason` | string | 人工填写理由，**必填**；拒绝事件由插件填写拒绝原因 |
| `mode` / `symbol` | string | 便于复盘过滤（计划补充字段） |
| `actor` | string | 固定 `user`（插件永不自动 override） |

复盘（`kb_review`）必须输出：**override 清单**（逐条 before→after + 理由）与**纪律遵守率**
（= 未 override 且按指令单执行的笔数 / 总笔数）。

---

## 7. 合规红线（不可协商）

| # | 红线 | 具体含义 | 违反后果 |
| :-- | :-- | :-- | :-- |
| C1 | **不接券商接口** | 不接任何券商交易/资金 API，不存储券商账号、密码、Cookie、交易凭据；插件只产出"指令单"由人手动执行（design.md §1.1 只做到 L2） | 直接拒绝实现 |
| C2 | **不构成投资建议** | 所有输出带 `asOf` 与固定脚注"本内容为个人研究与纪律辅助工具输出，不构成任何投资建议"；数据陈旧 >1 交易日必须标 `stale:true` | 输出不合格 |
| C3 | **不代客理财、不收费荐股** | 无代客操作、无收益分成、无收费荐股、无"内部消息"；无资质即不碰（design.md §11） | 直接拒绝实现 |
| C4 | **不做收益承诺** | 禁止"保证收益""涨停准确率 XX%""稳赚"等任何口径；ETA 类输出必须附假设与局限 | 文案不合格 |
| C5 | **不伪造成交** | 停牌/一字涨停/跌停卖不出 → 进 `rejected` 留痕，绝不生成"看起来成交了"的记录（P6） | 最高级 bug |
| C6 | **数据合规** | 只用公开免 Key 接口，遵守限频与 robots；不抓取需登录/越权数据；不分发原始行情副本 | 直接拒绝实现 |
| C7 | **本地化存储** | 账本与审计只落本地 `$dataDir`，不上传第三方；`.dsh-data/` 与 `ledger.json` 必须 gitignore | 安全缺陷 |
| C8 | **短线负期望必须劝阻** | 检测出滚动期望 ≤0 时输出 `NOT_RECOMMENDED` 并停用，不得因用户坚持而放行 | 视为最高级 bug |

固定免责脚注（`renderPlanText` 必须追加）：

```
※ 以上为规则化指令单草稿，非投资建议。数据 as_of=<时间>，来源=<source>。
※ 股市有风险，历史回测不代表未来表现；短线象限在多数市场状态下为负期望。
※ 本工具不接入任何券商接口，所有下单由用户自行执行并承担结果。
```

---

## 8. 澄清项登记（与上游/实现的差异）

| # | 事项 | 上游/现状 | 本文口径 | 处置 |
| :-- | :-- | :-- | :-- | :-- |
| R1 | 闸门顺序中「象限启用」「象限上限」两步 | `interface.md` §5 列出，`src/risk.js` 未实现 | 按契约顺序文档化，标注**计划** | 实现时补 `quadrantValue` 检查与 `ERR-RISK-004` |
| R2 | 熔断时长 5 交易日 | design.md §5.4 有，`RED_LINES` 无字段 | 文档化为常量 `circuitBreakerDays = 5` | **计划**：在 `RED_LINES.stable` 增字段（先改 interface.md） |
| R3 | 周回撤阈值 `>` vs `>=` | design.md 写 ">3%"，实现用 `>=` | 以 `>=`（保守侧）为准 | 建议 design.md 统一为 `≥` |
| R4 | 交易日计数不含节假日 | ~~`tradingDaysBetween` 只跳周末~~ → 已接入 `src/calendar.js` 内置年度表（2024~2027，含 2024 除夕交易所休市），越界 `ERR-CALENDAR-001` | 真实交易日计数 | **已解决（2026-11-26）**：接口见 `interface.md` §11 |
| R5 | 情绪指标缺失时默认放行 | 实现 `NaN` 比较为假 → 放行 | 应改为缺失即关闭 | **计划**：先改 `interface.md` 空值语义 |
| R6 | 人工暂停象限的错误码 | 无专用码 | 暂复用 `ERR-RISK-002` 并在 reason 注明"人工暂停" | **计划**：新增 `ERR-RISK-008`（需先改 interface.md §10） |
| R7 | 超期持仓拒绝新开仓 | `interface.md` §5 要求，`gate()` 未实现 | 文档化为第 0c 步，标注**计划** | 实现时补 |
| R8 | `minWinRate` 与 `requiredWinRate` 并存 | `RED_LINES` 有 0.45，公式推导 44.4% | 以**实测 payoffRatio 推导**的 `requiredWinRate` 为准；0.45 仅作展示下限 | 建议 interface.md 注明派生关系 |

---

## 9. 风控自检清单（评审用）

- [ ] 所有买入信号都经过 `gate()`，无绕过路径
- [ ] 被拒信号全部进 `plan.rejected`，无静默丢弃
- [ ] 止损/强制离场路径不受风控阻断（恒放行）
- [ ] 硬红线（短线 5 日）在 `overrideContract` 里被显式拦截
- [ ] 所有"交易日"计数走 `src/calendar.js#tradingDaysBetween`（节假日已纳入），越界 `ERR-CALENDAR-001` 明确失败
- [ ] 熔断/冷静期解除后计数归零，不残留
- [ ] 期望值自检使用含费实现盈亏
- [ ] 每次 override 都有非空 `reason` 且写入 `audit.jsonl`
- [ ] 输出均带 `asOf` 与免责脚注
- [ ] 无任何券商接口/凭据相关代码路径
