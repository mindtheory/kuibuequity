# 三策略算法详解（long / stable / short）

> 上游事实源：`docs/design.md`（设计冻结基线）、`docs/interface.md`（接口契约）。
> 本文只做**算法展开与算例**，不新增字段、不改口径；与上游冲突时以上游为准并回改本文。
>
> 实现状态说明：本文描述的是**契约算法**。凡 `src/` 尚未落地的部分，均标注「计划」，
> 不得据此认为功能已可用。

---

## 0. 三象限速查

| 维度 | 长期 `long` | 稳定 `stable` | 短线 `short` |
| :-- | :-- | :-- | :-- |
| 目标函数 | `costPerShare → ≤ 0`（成本转负） | 单笔 +t% 落袋，t∈[1%,5%] | 次日强势延续，≤5 交易日 |
| 收益来源 | 分红 + 网格价差 | 高频小额止盈复利 | 强势延续概率差 |
| 决策窗 | 收盘后（次日执行） | 收盘后 + 盘中条件单 | 收盘后打分，次日竞价/盘中执行 |
| 仓位骨架 | 底仓 70% + 活动仓 30% | `riskPerTrade / \|s\|` | 单票 ≤20% 象限、日新开 ≤2 只 |
| 唯一 KPI | 成本转负进度 / ETA | 滚动胜率 vs 要求胜率 | 滚动 30 笔期望值 |
| 硬红线 | 网格打停止加仓 | 契约锁定 | **5 日强制离场不可 override** |

统一入口（见 `interface.md` §7）：

```js
evaluate({ bars, position, account, config, indexBars, stats })
  => { signals: Signal[], plan: OrderPlan|null, diagnostics: object }
```

---

# 一、长期象限 `long`：股息网格 · 成本转负引擎

## 1.1 目标函数与适用人群

**目标函数**（不是收益率最大化）：

```
maximize   progress = clamp(1 − costPerShare / 建仓加权均价, 0, 1)
subject to 单票市值 ≤ 长期账户 × maxSymbolPct(0.40)
           长期象限 ≤ 总资金 × maxQuadrantPct(0.70)
           网格未打满（现价 > P0 × (1 − g×N)）
```

`costPerShare` 口径唯一，定义见 `docs/cost-model.md`。

**适用人群画像**：

| 特征 | 要求 | 不满足怎么办 |
| :-- | :-- | :-- |
| 资金性质 | 3～10 年不动用的闲钱（房贷/学费/医疗金不得入本象限） | 拒绝建账，提示先留应急金 |
| 心理承受 | 能接受浮亏 30% 且仍按网格机械加仓 | 建议只做稳定象限或不做 |
| 标的要求 | 连续分红 ≥10 年、股息率 ≥4%、非 ST、非强周期单季亏损股 | 打分不过，`diagnostics.reject` 说明原因 |
| 时间投入 | 每周 ≤30 分钟（收盘后看一次指令单） | 本象限天然低频，适合上班族 |
| 典型标的 | 大行（601398/601288/601988）、公用事业、高速公路、消费白马 | — |

**不适用**：题材股、周期顶部资源股、分红不连续的次新、任何"博一把"的钱。

## 1.2 完整伪代码

### (a) 入场（建仓期）

```text
LONG.ENTRY:
  require bars.length >= config.minBars            # 默认 120，不足 → ERR-DATA-002
  require bars.last.suspended == false             # 停牌 → ERR-PLAN-002
  require fundamentals.dividendYears >= 10         # 连续分红年数
  require dividendYield_5y >= config.minYield      # 默认 0.04
  require not ST and not 上市 < 250 日

  P0 = median(close[-60:])                         # 抗单日异动，不用最新价
  atrPct20 = atrPct(bars, 20).last
  g = clamp(atrPct20 * 1.2, 0.03, 0.08)            # 步长
  N = config.gridsPerSide                          # 默认 5，范围 3..8

  coreBudget   = account.cash * config.coreWeight   # 默认 0.70
  floatBudget  = account.cash * (1 - coreWeight)    # 默认 0.30

  coreQty = floor(coreBudget / price / 100) * 100   # 整手向下
  if coreQty < 100: return REJECTED('ERR-PLAN-001')

  qtyPerGrid = floor(floatBudget / N / P0 / 100) * 100
  if qtyPerGrid < 100: floatBudget 不足 → 只建底仓，活动仓置 0 并告警

  emit Signal(buy, symbol, coreQty, price, rule='LONG.ENTRY_CORE')
  emit gridPlan(...) 的 5 个下方买入条件单（不立即成交，挂条件单）
  write Contract{ mode:'long', takeProfitPct:null, stopLossPct:null,
                  maxHoldDays:null, grid:{P0,g,N,qtyPerGrid} }
```

### (b) 加仓（网格下方格 + 分红再投）

```text
LONG.ADD:
  # 收盘确认、次日执行（P3 无未来函数）
  for k in 1..N:
      trigger_k = P0 * (1 - g * k)
      if bars.last.close <= trigger_k and gridFilled[k] == false:
          if account.cash < qtyPerGrid * trigger_k: break   # 现金不足，停止
          if 熔断条件命中: break                            # 见 (d)
          emit Signal(buy, qtyPerGrid, price=trigger_k,
                      rule='LONG.GRID_BUY_K' + k)
          gridFilled[k] = true          # 由成交回报置位，不在信号阶段置位
          P0 = trigger_k                # 锚定跟随：成交后重置基准价
          break                          # 每次只补最深未成交的一格

  # 分红再投（默认关闭；已实现 src/strategies/longTerm.js#reinvestPlan，见 interface.md §7.1）
  dps = bars.last.dividendPerShare                 # 通道 1：回测/合成数据自带
  if dps <= 0:                                     # 通道 2：行情层日K不含分红，查分红历史
      dps = dividends[exDate == bars.last.date].cashPerShare
  if config.reinvest and dps > 0:
      cash = round2(dps * position.qty)            # 除息日当时持股数
      qty  = floor(cash / bars.last.close / 100) * 100   # 除息价用**未复权** close
      while qty >= 100 and bars.last.close*qty + tradeFee(buy) > cash: qty -= 100  # 不赊账
      if qty >= 100: emit Signal(buy, qty, price=bars.last.close, rule='LONG.REINVEST')
      else: rejected('LONG.REINVEST_TOO_SMALL')    # 不足 1 手不伪造成交
```

> **为什么除息价必须用未复权 close**：每股分红是未复权口径；用前复权价折算会让股数凭空变多，
> 等于伪造一笔买不到（也买不起）的成交。**为什么要求"含费用买得起"**：佣金 5 元起步，
> 分红现金常常刚好差那几元，少买一手才是真实可执行的指令。

> **为什么成交后重置 P0**：不重置则下跌途中格子间距被拉大，越跌越买不到；
> 重置后网格跟随价格中枢，代价是单边下跌时更快触达"网格打满"熔断——这正是我们想要的信号。

### (c) 减仓（网格上方格）

```text
LONG.REDUCE:
  for k in 1..N:
      trigger_k = P0 * (1 + g * k)
      if bars.last.close >= trigger_k and floatPosition >= qtyPerGrid:
          emit Signal(sell, qtyPerGrid, price=trigger_k,
                      rule='LONG.GRID_SELL_K' + k)
          P0 = trigger_k
          break
  # 底仓只在两种情况卖：基本面恶化（见 d）或象限再平衡（人工 transfer）
  # 底仓永不为"赚一点"而卖 —— 它负责"涨上去不踏空"
```

### (d) 离场 / 冻结

```text
LONG.EXIT:
  # 1) 网格打满熔断（单边下跌）
  if bars.last.close < P0 * (1 - g * N):
      freezeGrid(); emit only sell signals
      diagnostics.halt = 'LONG.GRID_EXHAUSTED'   # 停止加仓，转人工复核

  # 2) 基本面恶化
  if 连续 2 年扣非亏损 or 股息率同比降幅 > 0.40 or isST:
      freezeGrid(); mode = '只出不进'
      diagnostics.halt = 'LONG.FUNDAMENTAL_DETERIORATED'

  # 3) 停牌
  if bars.last.suspended:
      当日全部指令 → plan.rejected('ERR-PLAN-002')   # 不伪造成交

  # 4) 本象限没有"止盈离场"这个概念
  #    costPerShare <= 0 时输出 progress=1.0 与提示：
  #    "本金已收回，后续任何价格卖出均为纯赚；是否清仓由人决定，插件不主动发卖出指令"
```

## 1.3 参数表

| 参数 | 默认值 | 取值范围 | 调整建议 |
| :-- | :-- | :-- | :-- |
| `minBars` | 120 | 60～250 | 上市不足 120 日不做长期象限，别为凑数放宽 |
| `minYield` | 0.040 | 0.03～0.08 | 上调到 5.5% 只做高股息大行；下调到 3% 会放进分红不稳定的票 |
| `dividendYears` | 10 | 5～20 | 越长越稳，但会把优质次新全部排除 |
| `coreWeight` | 0.70 | 0.50～0.90 | 越怕踏空越高；越怕套牢越低。0.9 以上等于放弃网格 |
| `gridsPerSide` (N) | 5 | 3～8 | N 越大越抗跌但每格资金越小，N×q×P0 必须 ≤ 活动仓预算 |
| `stepFactor` | 1.2 | 0.8～2.0 | `g = clamp(ATR20% × stepFactor, 3%, 8%)`；调大→成交更少、单格毛利更高 |
| `g`（派生） | 3%～8% | 硬夹逼 [0.03, 0.08] | 低于 3% 会被费用吃掉（见 §1.4 例：单格净收益 5.94%） |
| `reinvest` | false | true/false | 目标是成本转负 → 现金回收更快；只有"复利滚存"诉求时才开。已实现：除息现金按未复权 close 折整手股数（含费买不起就少买一手），不足 1 手进 rejected |
| `maxSymbolPct` | 0.40 | 0.20～0.40 | **只可下调**，上调属硬红线放宽，需 override + 审计 |
| `maxQuadrantPct` | 0.70 | 0.40～0.70 | 同上 |
| `gridAnnualGross` | 0.15 | 0.05～0.25 | ETA 输入，必须用回测/实盘校准，不许拍脑袋 |
| `costDrag` | 0.006 | 0～0.02 | 网格费用拖累，来自 `costs.js` 实测 |

## 1.4 算例 A：网格参数与成本转负 ETA（工商银行 601398）

**输入**（题设 + 合理假设，均可替换）：

| 输入 | 值 | 来源 |
| :-- | :-- | :-- |
| 现价 | 6.10 | 题设 |
| 年化股息率 d | 5.5% | 题设（近 5 年平均口径） |
| ATR20% | 2.5% | 题设 |
| 近 60 日收盘中位数 P0 | 6.20 | 假设（示例用） |
| 长期账户现金 | 100,000 元 | 假设 |
| coreWeight / floatWeight | 0.70 / 0.30 | 默认 |
| N | 5 | 默认 |
| 网格年化毛收益 g_annual | 15% | 假设，需回测校准 |
| costDrag | 0.6% | 假设 |

**第 1 步：步长与格数**

```
g = clamp(2.5% × 1.2, 3%, 8%) = clamp(3.0%, 3%, 8%) = 3.0%
```

**第 2 步：网格价位**（P0 = 6.20，保留 3 位小数）

| 格 | 下方买入价 `P0×(1−g·k)` | 计算 | 上方卖出价 `P0×(1+g·k)` | 计算 |
| :-- | :-- | :-- | :-- | :-- |
| k=1 | 6.014 | 6.20×0.97 | 6.386 | 6.20×1.03 |
| k=2 | 5.828 | 6.20×0.94 | 6.572 | 6.20×1.06 |
| k=3 | 5.642 | 6.20×0.91 | 6.758 | 6.20×1.09 |
| k=4 | 5.456 | 6.20×0.88 | 6.944 | 6.20×1.12 |
| k=5 | 5.270 | 6.20×0.85 | 7.130 | 6.20×1.15 |

**第 3 步：每格量**

```
coreBudget  = 100,000 × 0.70 = 70,000 元
floatBudget = 100,000 × 0.30 = 30,000 元
coreQty     = floor(70,000 / 6.10 / 100) × 100 = floor(114.75) × 100 = 11,400 股
qtyPerGrid  = floor(30,000 / 5 / 6.20 / 100) × 100 = floor(9.677) × 100 = 900 股
校验：900 × 6.20 × 5 格 = 27,900 元 ≤ 30,000 ✓
```

底仓建仓成本（6.10 × 11,400 = 69,540.00 元）：

```
佣金   = max(69,540 × 0.00025, 5) = 17.39
过户费 = 69,540 × 0.00001 = 0.70
买入费用 = 18.08        totalIn = 69,540.00 + 18.08 = 69,558.08
```

**第 4 步：一轮网格的净收益（验证步长不能太窄）**

假设价格下探 k=1 成交买入 900 股 @6.014，随后回升至 k=1 卖出 900 股 @6.386：

```
买入：金额 900 × 6.014 = 5,412.60
      佣金 max(1.35, 5) = 5.00（最低佣金生效）  过户费 0.05  → 费用 5.05
卖出：金额 900 × 6.386 = 5,747.40
      佣金 max(1.44, 5) = 5.00  印花税 5,747.40×0.0005 = 2.87  过户费 0.06 → 费用 7.93

毛利 = 5,747.40 − 5,412.60 = 334.80
费用 = 5.05 + 7.93 = 12.98
净利 = 321.82        单格净收益率 = 321.82 / 5,417.65 = 5.94%
```

> 结论：3% 步长的**双边总幅 6%**，扣费后净得 5.94%，费用吃掉约 0.06pp。
> 若把 g 压到 1.5%（双边 3%），净利仅约 150 元、费用占比翻倍 → 这就是 `g` 硬夹在 ≥3% 的原因。

**第 5 步：分红入账**（除息日持股 11,400 股，网格仓已平）

```
每股派息 = 6.10 × 5.5% = 0.3355 元/股（示例反推值；实际以公告为准）
现金分红 = 11,400 × 0.3355 = 3,824.70 元
```

**第 6 步：当前有效成本与进度**

```
totalIn        = 69,558.08 + 5,417.65 = 74,975.73
totalRecovered = 5,739.47（卖 5,747.40 − 费 7.93） + 3,824.70 = 9,564.17
shares         = 11,400
costPerShare   = (74,975.73 − 9,564.17) / 11,400 = 65,411.56 / 11,400 = 5.738
建仓加权均价    = (69,540 + 5,412.60) / 12,300 = 74,952.60 / 12,300 = 6.094
progress       = 1 − 5.738 / 6.094 = 5.84%
```

**第 7 步：年化摊薄率与 ETA**

```
annualDilutionRate = d + w × g_annual − costDrag
                   = 5.5% + 0.30 × 15% − 0.6% = 5.5% + 4.5% − 0.6% = 9.4%

每年回收现金 = 现价 × 摊薄率 × 持股数 = 6.10 × 9.4% × 11,400 = 0.5734 × 11,400 = 6,536.76 元
ETA = costPerShare × shares / 每年回收现金
    = 65,411.56 / 6,536.76 = 10.01 年
```

> ⚠️ **与 design.md §4.5 的口径差异（已登记）**：design.md 的对数式
> `ln(1 − costPerShare/现价) / ln(1 + 年化摊薄率)` 在 `costPerShare > 0` 时分子恒为负、
> 分母恒为正，**结果恒为负数**，无法给出正 ETA（代入 5.738/6.10/9.4% 得 −31.4）。
> 本文与 `src/costs.js` 采用「每年按现价×摊薄率回收现金」的**线性现金解**，
> 数学上可验算、可逐笔对账。该差异需在 CHANGELOG 记为契约澄清，并建议修订 design.md 示例。

## 1.5 算例 B：逐年摊薄进度表（同一标的，价格不变）

待摊余额（`costPerShare × shares`）初始 65,411.56 元，每年回收 6,536.76 元：

| 年末 | 待摊余额（元） | costPerShare | progress | 备注 |
| :-- | :-- | :-- | :-- | :-- |
| 0 | 65,411.56 | 5.738 | 5.84% | 算例 A 期末 |
| 1 | 58,874.80 | 5.164 | 15.26% | 1 − 5.164/6.094 |
| 2 | 52,338.04 | 4.591 | 24.66% | |
| 3 | 45,801.28 | 4.018 | 34.07% | |
| 4 | 39,264.52 | 3.444 | 43.49% | |
| 5 | 32,727.76 | 2.871 | 52.89% | 过半 |
| 6 | 26,191.00 | 2.298 | 62.29% | |
| 7 | 19,654.24 | 1.724 | 71.71% | |
| 8 | 13,117.48 | 1.151 | 81.11% | |
| 9 | 6,580.72 | 0.577 | 90.53% | |
| 10 | 43.96 | 0.004 | 99.94% | 接近转负 |
| 11 | −6,492.80 | −0.569 | 100% | **成本转负** |

手工验算锚点：`65,411.56 − 10 × 6,536.76 = 43.96` ✓（与 ETA=10.01 年一致）

**敏感性**（同一待摊余额 65,411.56 元）：

| 摊薄率构成 | annualDilutionRate | ETA |
| :-- | :-- | :-- |
| 只靠分红（d=5.5%，网格停摆） | 5.5% − 0.6% = 4.9% | 65,411.56 / (6.10×4.9%×11,400) = 19.2 年 |
| 题设（网格 15%） | 9.4% | 10.01 年 |
| 网格效率提到 25% | 5.5% + 7.5% − 0.6% = 12.4% | 7.59 年 |
| 分红被砍半（d=2.75%） | 2.75% + 4.5% − 0.6% = 6.65% | 14.15 年 |

> 读法：**ETA 对分红率最敏感**（分红减半 → 时间 +41%）。所以长期象限的第一红线是"基本面恶化冻结网格"，
> 而不是价格跌了多少。

## 1.6 长期象限常见误用与反模式

| 反模式 | 为什么错 | 插件的拦截 |
| :-- | :-- | :-- |
| 用长期象限买题材股"套了就当长线" | 目标函数要求分红现金流，题材股无分红 → 摊薄率≈0 → ETA 返回 `null` | `annualDilutionRate ≤ 0 → null`（P6 诚实失败） |
| 底仓也参与网格高抛低吸 | 涨上去踏空，网格变成唯一仓位，单边上涨直接亏大钱 | 底仓/活动仓分账，网格只从 `floatPosition` 出 |
| 下跌途中把 `g` 调大"少买几格" | 事后改参数 = 事中判断，正是设计要消灭的东西 | 参数属契约，改需 `override + reason` 写审计 |
| 分红再投当成"成本转负加速器" | 再投把现金又变回股票，`totalRecovered` 不增，进度反而更慢 | `reinvest` 默认 false，输出提示两者差异 |
| 网格打满后追加现金"再撑 5 格" | 单边下跌里这是无底洞，正是 §4.6 熔断要防的 | `LONG.GRID_EXHAUSTED` 冻结买入，只出不进 |
| 用前复权价 + 分红双重计算 | 前复权已抹平除息跳空，再计分红 = 重复计算 | 分红只在 `costs.js` 入账一次（见 cost-model.md） |

---

# 二、稳定象限 `stable`：1%～5% 反人性止盈纪律

## 2.1 目标函数与适用人群

**目标函数**：

```
maximize   expectancy = winRate × avgWin − (1 − winRate) × avgLoss
subject to winRate ≥ requiredWinRate = 1 / (1 + payoffRatio)   # 1.25 → 44.4%
           每笔最大亏损 ≤ 象限账户 × riskPerTrade(0.01)
           单票 ≤ maxSymbolPct(0.25)，象限 ≤ maxQuadrantPct(0.30)
           持仓 ≤ maxHoldDays(15)
```

注意目标不是"总收益最大"，而是**期望值为正且方差可控**：稳定象限靠周转率吃饭，
一次 −20% 需要连续 5 笔 +5% 才回得来。

**适用人群画像**：

| 特征 | 要求 |
| :-- | :-- |
| 资金性质 | 中期闲钱（3～12 个月），可承受单票 −2% 账户冲击 |
| 时间投入 | 每天收盘后 10 分钟生成指令单 + 挂两张条件单；**盘中不看盘** |
| 心理要求 | 能接受"卖飞"（卖出后又涨 10%）而不追回来 |
| 标的要求 | 日均成交额 >5000 万、非 ST、上市 >120 日、有趋势（close>MA60） |
| 不适合 | 无法接受"每周只赚 1%～2%"的人；想一把梭的人 |

## 2.2 完整伪代码

### (a) 入场（五道门，全过才发买入指令）

```text
STABLE.ENTRY:
  # 门 0：象限级熔断（优先级最高）
  if sentimentGate 关闭 or 连亏熔断中 or 冷静期中: return REJECTED(ERR-RISK-001/002/007)

  # 门 1：大盘过滤
  require indexBars.last.close > sma(indexBars.close, 20).last     # 弱市不做

  # 门 2：个股趋势
  require bars.last.close > sma(bars.close, 60).last
  require slope(sma(bars.close, 20), 10).last > 0                  # MA20 斜率向上

  # 门 3：回调企稳
  require exists i in last 5 bars: close[i] < MA20[i]              # 近 5 日跌破过 MA20
  require bars.last.close >= bars.last.MA20                        # 重新站回
  require bars.last.close > bars.last.open                         # 当日收阳

  # 门 4：量能
  volRatio = bars.last.volume / mean(volume[-5:])
  require 0.8 <= volRatio <= 3.0

  # 门 5：流动性与资格
  require mean(amount[-20:]) > 50_000_000
  require not ST and listDays > 120

  # 全部通过 → 计算契约参数
  { t, s, D, positionPct } = adaptiveTarget(bars, config)
  qty = floor(account.equity * positionPct / price / 100) * 100
  if qty < 100: return REJECTED('ERR-PLAN-001')

  write Contract{ takeProfitPct:t, stopLossPct:s, maxHoldDays:D, locked:true }
  emit Signal(buy, qty, price, rule='STABLE.ENTRY')
  emit 两张条件单（建仓当日一次挂好）：
     { side:'sell', triggerPrice: entry*(1+t), orderPrice:'市价', qty }
     { side:'sell', triggerPrice: entry*(1+s), orderPrice:'市价', qty }
```

### (b) 加仓（稳定象限默认禁止）

```text
STABLE.ADD:
  # 设计立场：稳定象限不做"摊低成本"，因为摊低会破坏 riskPerTrade 的数学前提
  # （每笔最大亏损必须等于 账户×1%；加仓会让实际风险变成两笔之和）
  if config.allowPyramiding == false:            # 默认 false
      return REJECTED('ERR-CONTRACT-001', '稳定象限禁止加仓摊低，需 override')

  # 若显式开启金字塔（不推荐）：只允许在浮盈 > t/2 时加，且加仓后总风险仍 ≤ riskPerTrade
  require position.unrealizedPct > t / 2
  require (position.risk + newRisk) <= account.equity * riskPerTrade
```

### (c) 减仓（只允许三种理由）

```text
STABLE.REDUCE:
  if bars.last.close >= entry * (1 + t):
      emit Signal(take_profit, qty=all, rule='STABLE.TP_HIT')     # 默认一次清仓
  elif bars.last.high >= entry * (1 + t * 0.7) and bars.last.close < bars.last.open:
      emit Signal(sell, qty=half, rule='STABLE.TP_PARTIAL')       # 冲高分批（可选）
  elif 时间止损: holdDays >= D and 未触发 t/s:
      emit Signal(sell, qty=all, rule='STABLE.TIME_EXIT')         # 释放资金效率
  else: hold
```

`holdDays` 口径（`interface.md` §11）：优先用契约上显式记录的 `holdDays`；缺失时按
`src/calendar.js#tradingDaysBetween(entry.date, bars.last.date)` 用**真实交易日**计算
（周末 + 法定节假日 + 交易所额外休市都跳过，如 2026 春节 2/16~2/23 不计入）。
两头都拿不到日期 → `holdDays=null`：不按 0 天冒充"刚建仓"，也不误触发时间止损。

### (d) 离场（止损优先于一切，且不接受讨价还价）

```text
STABLE.EXIT:
  if bars.last.low <= entry * (1 + s):          # s 为负数
      emit Signal(stop_loss, qty=all, price=entry*(1+s), rule='STABLE.SL_HIT')
      # gate() 对 stop_loss / force_exit 恒放行：止损永不被风控挡下
  if bars.last.holdDays >= D:
      emit Signal(sell, qty=all, rule='STABLE.TIME_EXIT')

  on 平仓:
      stats.cooldownUntil[symbol] = asOf + 3 交易日     # 冷静期
      if pnl < 0: stats.consecutiveLosses += 1 else = 0
      重算 weeklyDrawdown → 若 ≥3% 触发象限停 5 交易日
```

## 2.3 参数表

| 参数 | 默认值 | 取值范围 | 调整建议 |
| :-- | :-- | :-- | :-- |
| `volFactor` | 2.0 | 1.5～3.0 | `t = clamp(volFactor × atrPct, 1%, 5%)`；调大→成交更少、单笔更肥 |
| `targetMinPct` / `targetMaxPct` | 1% / 5% | 0.5%～8% | 上限超过 5% 后胜率快速衰减，不建议放宽 |
| `stopFactor` | 0.8 | 0.6～1.0 | `s = −stopFactor × t`；0.8 ⇒ 盈亏比 1.25:1 |
| `maxHoldDays` | 15 | 5～20 | 越短周转越快但更容易"时间止损"卖在启动前 |
| `riskPerTrade` | 0.010 | 0.005～0.02 | **只可下调**。0.02 意味着连亏 4 笔即 −8% |
| `maxSymbolPct` | 0.25 | 0.10～0.25 | 只可下调 |
| `maxQuadrantPct` | 0.30 | 0.10～0.30 | 只可下调 |
| `maxConsecutiveLoss` | 4 | 3～6 | 越小越保守 |
| `weeklyDrawdownPct` | 0.03 | 0.02～0.05 | 与 riskPerTrade 联动：3% ≈ 3 笔满额止损 |
| `cooldownDays` | 3 | 1～5 | 对抗"不服气"，不建议设 0 |
| `minWinRate` | 0.45 | 派生 | 由 `1/(1+payoffRatio)` 推导，不独立调 |
| `allowPyramiding` | false | false/true | 强烈建议保持 false |

## 2.4 算例 A：仓位公式（题设：t=2.4%、s=−1.9%、账户 10 万、riskPerTrade=1%）

**第 0 步：这两个数字从哪来（不是拍脑袋）**

```
atrPct = ATR14 / close = 1.2%（假设）
t = clamp(2.0 × 1.2%, 1%, 5%) = 2.4%          ✓ 题设
s = −0.8 × 2.4% = −1.92% → 按 0.1pp 取整 = −1.9%  ✓ 题设
盈亏比 = 2.4 / 1.9 = 1.263 ≈ 1.25 : 1
```

**第 1 步：每笔最大亏损**

```
每笔最大亏损 = 账户 × riskPerTrade = 100,000 × 1% = 1,000 元
```

**第 2 步：理论仓位**

```
positionPct = riskPerTrade / |s| = 1% / 1.9% = 0.526315… ≈ 52.63%
仓位金额    = 100,000 × 52.63% = 52,631.58 元
验算：52,631.58 × 1.9% = 1,000.00 元 ✓ 正好等于风险预算
```

**第 3 步：被 `maxSymbolPct` 截断**

```
单票上限 = 100,000 × 25% = 25,000 元
实际投入 = min(52,631.58, 25,000) = 25,000 元
实际风险 = 25,000 × 1.9% = 475 元 = 账户的 0.475%（低于预算，安全侧）
```

**第 4 步：整手与费用（设成交价 10.00）**

```
qty = floor(25,000 / 10.00 / 100) × 100 = 2,500 股
买入金额 = 25,000.00
买入费用 = 佣金 max(6.25, 5)=6.25 + 过户费 0.25 = 6.50      成本 = 25,006.50
```

**第 5 步：止盈 / 止损两种结局**

```
止盈 +2.4% → 卖价 10.24，金额 25,600.00
  费用 = 佣金 6.40 + 印花税 12.80 + 过户费 0.26 = 19.46
  净得 = 25,580.54        pnl = +574.04（+2.30%）

止损 −1.9% → 卖价 9.81，金额 24,525.00
  费用 = 佣金 6.13 + 印花税 12.26 + 过户费 0.25 = 18.64
  净得 = 24,506.36        pnl = −500.14（−2.00%）
```

**第 6 步：费用吃掉盈亏比（关键结论）**

```
名义盈亏比 = 2.4 / 1.9 = 1.263
含费盈亏比 = 574.04 / 500.14 = 1.148
要求胜率   = 1 / (1 + 1.148) = 46.6%      （名义 1.25 只需 44.4%）
```

> 结论：**25,000 元级别的单笔，最低佣金 5 元 + 印花税把盈亏比从 1.263 压到 1.148，
> 要求胜率从 44.4% 抬到 46.6%。** 小资金做稳定象限更难，原因就在这几块钱的固定费用上。
> 若账户只有 3 万，单票 7,500 元，费用占比再翻倍 → 建议把 `targetMinPct` 上调到 2%。

**第 7 步：若不被截断（对比）**

```
投入 52,631.58 → qty = floor(5263.157/100)×100 = 5,200 股 = 52,000 元
实际风险 = 52,000 × 1.9% = 988 元 ≈ 0.99% 账户 ✓ 贴合预算
```

## 2.5 算例 B：连亏熔断 + 周回撤判定

账户 100,000，`riskPerTrade=1%`、`maxConsecutiveLoss=4`、`weeklyDrawdownPct=3%`、`cooldownDays=3`。

| # | 日期 | 标的 | 结果（元） | 连亏 | 本周累计盈亏 | 判定 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 周一 | 600xxx | −475 | 1 | −475 | 正常 |
| 2 | 周二 | 000xxx | −500 | 2 | −975 | 正常 |
| 3 | 周三 | 002xxx | +574 | 0 | −401 | 连亏归零 |
| 4 | 周四 | 601xxx | −500 | 1 | −901 | 正常 |
| 5 | 周五 | 300xxx | −500 | 2 | **−1,401** | 回撤 1.40% < 3%，仍放行 |

下一周继续：

| # | 结果 | 连亏 | 本周累计 | 判定 |
| :-- | :-- | :-- | :-- | :-- |
| 6 | −500 | 3 | −500 | 正常 |
| 7 | −500 | 4 | −1,000 | **连亏 4 ≥ 4 → ERR-RISK-002，象限停 5 交易日** |

若第 7 笔换成 −2,600（满额仓 + 跳空），本周累计 = −3,100 → **回撤 3.10% ≥ 3% → ERR-RISK-002**，
两条熔断任一命中即停，不看另一条。

**冷静期算例**：600xxx 于 11-20（周五）平仓 → 冷静期至 11-25（下周三）收盘；
11-23 再次想买入 600xxx → `ERR-RISK-001`，`reason: "600xxx 处于冷静期（至 2026-11-25）"`。

## 2.6 稳定象限常见误用与反模式

| 反模式 | 为什么错 | 拦截 |
| :-- | :-- | :-- |
| 盘中把止盈从 2.4% 改成 5%"再等等" | 契约锁定的意义就是消灭这个动作 | `ERR-CONTRACT-001`，改需 override + reason，复盘逐条列出 |
| 跌到止损线手动撤单 | 把 −1.9% 拖成 −15%，一次吃掉 8 笔盈利 | 止损条件单在建仓当日就挂好；`gate()` 对 `stop_loss` 恒放行 |
| 加仓摊低成本 | 每笔风险 1% 的前提被破坏，实际风险变 2% | 默认禁止（`allowPyramiding=false`） |
| 平仓当天追回同一票"不服气" | 冷静期专治此项，且此时标的往往仍在下跌趋势 | `ERR-RISK-001` |
| 连亏 4 笔后加倍下注 | 熔断线存在的唯一理由 | `ERR-RISK-002` |
| 胜率 41% 还继续做 | 数学上负期望，做得越多亏得越多 | `expectancyCheck → NOT_RECOMMENDED` → `ERR-RISK-006` |
| 用高波动票重仓（t=5% 却按 t=2% 的仓位买） | 仓位与止损不匹配，一笔 −5% 而非 −1% | 仓位由 `riskPerTrade/|s|` 强制反推，不接受手填仓位 |

---

# 三、短线象限 `short`：次日强势打分 · ≤5 日强制离场

## 3.1 目标函数与适用人群

**目标函数**：

```
maximize   E = P(次日高开或涨停) × avgWin − P(次日低开) × avgLoss
subject to 滚动 30 笔 winRate ≥ 0.45 且 expectancy > 0
           单票 ≤ 短线账户 × 20%，同日新开仓 ≤ 2 只，短线账户 ≤ 总资金 20%
           持仓 ≤ 5 交易日（硬红线，不可 override）
           sentimentGate.open == true
```

**适用人群画像**（本象限是三个里最窄的）：

| 特征 | 要求 |
| :-- | :-- |
| 资金性质 | **可全损也不心疼**的钱，≤ 总资金 10%（design.md 默认）～20%（红线） |
| 时间投入 | 必须盯盘：竞价 9:15–9:30、开盘 5 分钟、尾盘 14:30–15:00 |
| 心理要求 | 能在 −3% 无条件砍；能接受 5 日强制离场时"正好在涨" |
| 经验门槛 | 至少 30 笔模拟盘记录且胜率 ≥45% 才允许实盘（模拟盘 L2 就是为此存在） |
| 不适合 | 上班族、情绪化者、把短线当翻身手段的人 —— 插件会在期望值不达标时直接拒绝 |

> **诚实声明**（design.md §6.1）：本象限在多数市场状态下为**负期望**。
> 插件不预测涨停，只把"凭感觉打板"变成"有打分、有上限、有强制离场、有胜率考核的可控赌博"，
> 并在检测出负期望时**拒绝下注**。

## 3.2 完整伪代码

### (a) 入场（候选池 → 打分 → 闸门 → 指令单）

```text
SHORT.ENTRY:
  # 第 0 步：情绪总闸（比任何个股打分优先）
  sg = sentimentGate({ indexAboveMa5, yesterdayLimitUpPremium, blowUpRate })
  if not sg.open: return plan.rejected('ERR-RISK-007', sg.reason)   # 全象限空仓

  # 第 1 步：候选池
  pool = { s | s.limitUp or s.changePct >= 0.05 or s.turnoverRate >= 0.05 or s.volRatio >= 2 }
  pool -= { ST/*ST, listDays < 60, floatMktCap < 3e9, avgAmount < 1e8, suspended }
  pool -= { 当日一字涨停 (high == low == limitUp) }     # 买不到，P6 不伪造成交

  # 第 2 步：打分卡（见 §3.3）
  for s in pool: s.score = scorecard(s)
  candidates = sort(pool by score desc)[0:topN]
  candidates = filter(score >= config.minScore)        # 默认 70

  # 第 3 步：闸门（顺序见 risk.md）
  for c in candidates:
      g = gate({ mode:'short', action:'buy', signal:c, account, stats })
      if not g.allowed: plan.rejected(c, g.code, g.reason); continue

  # 第 4 步：仓位与指令
  for c in take(candidates, config.maxNewPerDay):      # ≤2 只
      budget = min(短线账户 × 0.20, 短线账户现金 / 剩余名额)
      budget = budget * (c.score >= 85 ? 1.0 : 0.5)    # 打分不足 85 只上半仓
      qty = floor(budget / c.price / 100) * 100
      if qty < 100: plan.rejected('ERR-PLAN-001'); continue
      emit Signal(buy, qty, price=c.price, rule='SHORT.ENTRY', confidence=c.score/100)
      write Contract{ maxHoldDays:5, locked:true }
```

### (b) 加仓（禁止）

```text
SHORT.ADD:
  return REJECTED('ERR-CONTRACT-001', '短线象限禁止任何加仓')
  # 理由：加仓 = 延长持有期/放大风险，与"≤5 日、单票 20%"两条红线在数学上冲突
```

### (c) 减仓（盘中规则，写死）

```text
SHORT.REDUCE:
  # T+1：当日买入不可卖，以下规则自次日起生效
  if 次日高开 > 3% and 开盘 5 分钟未破开盘价: hold 观察
  elif 冲高后跌破开盘价: emit Signal(sell, qty=half, rule='SHORT.TRIM_BREAK_OPEN')
  elif 次日涨停: hold 至开板，开板即卖全部（不赌连板）rule='SHORT.OPEN_BOARD_SELL'
```

### (d) 离场（含唯一硬红线）

```text
SHORT.EXIT:
  if 浮亏 <= -3%: emit stop_loss(qty=all) rule='SHORT.SL_3PCT'   # 条件单前置，恒放行
  if 冲高跌破开盘价: 见 (c) 减半
  if tradingDaysBetween(openDate, asOf) >= 5:
      emit force_exit(qty=all, price='收盘前市价') rule='SHORT.HARD_EXIT_5D'
      # gate() 对 force_exit 恒放行；任何 override 请求 → ERR-OVERRIDE-001
      # 硬红线计数用真实交易日（src/calendar.js）：春节/国庆整段休市不算持仓天数，
      # 越出日历覆盖范围 → ERR-CALENDAR-001（绝不回退到只跳周末、提前砍仓）
  on 平仓:
      更新滚动 30 笔统计 → expectancyCheck(payoffRatio 实测)
      if verdict == NOT_RECOMMENDED: 象限停用 ERR-RISK-006
```

## 3.3 打分卡（0～100，权重可配）

| 因子 | 权重 | 打分依据（系数 × 权重；系数取值 0~1） |
| :-- | :-- | :-- |
| 封单强度 | 20 | 封单额/流通市值：≥3% → 1.0；1%~3% 线性（1%→0.3，3%→1.0）；<1% → 0.3；炸板 → 0 |
| 涨停时间 | 15 | 一字/09:25–10:00 → 1.0；10:00–13:30 → 0.8；13:30–14:30 → 0.5；14:30 后 → 0.3 |
| 连板高度 | 15 | 首板/二板 → 1.0；三板 → 0.7；四板 → 0.55；≥五板 → 0.4（高位风险溢价递减） |
| 量能结构 | 12 | 换手 5%~15% → 1.0（缩量板优于天量板）；3%~5% 或 15%~20% → 0.6；<3% 或 >25% → 0.4 |
| 板块效应 | 15 | 同板块涨停 ≥5 家 → 1.0；3~4 家 → 0.8；<3 家 → 0（题材未确认） |
| 资金流 | 10 | 主力净流入/成交额：≥15% → 1.0；5%~15% 线性（5%→0.4，15%→1.0）；0~5% → 0.2；净流出 → 0 |
| 大盘情绪 | 13 | 指数在 5 日线上方记 0.5，否则 0；再加昨日涨停今日平均溢价项（0~0.5 线性，≥3% 记满 0.5） |

`minScore` 默认 **70**（低于此分不进指令单）；≥85 才允许满仓（单票上限）。

## 3.4 参数表

| 参数 | 默认值 | 取值范围 | 调整建议 |
| :-- | :-- | :-- | :-- |
| `minScore` | 70 | 60～85 | 上调→更少更精；低于 60 等于放弃筛选 |
| `topN` | 5 | 3～10 | 只影响展示条数，实际下单受 `maxNewPerDay` 限制 |
| `maxSymbolPct` | 0.20 | 0.05～0.20 | 只可下调 |
| `maxQuadrantPct` | 0.20 | 0.05～0.20 | 只可下调（design.md 默认 10%，红线 20%） |
| `maxNewPerDay` | 2 | 1～2 | 只可下调 |
| `hardMaxHoldDays` | 5 | **固定 5** | **不可调、不可 override** |
| `stopLossPct` | 0.03 | 0.02～0.05 | 只可下调 |
| `blowUpRateLimit` | 0.40 | 0.30～0.50 | 情绪总闸阈值 |
| `minWinRate` | 0.45 | 派生 | 由期望值自检推导 |
| `poolMinChangePct` | 0.05 | 0.03～0.07 | 候选池纳入门槛 |
| `poolMinFloatCap` | 3e9 | ≥2e9 | 上调可过滤小票操纵风险 |

## 3.5 算例 A：打分卡逐项求和

**标的 A：某 PCB 题材二板（11-21 收盘）**

流通市值 45 亿，封单 1.80 亿，涨停时间 10:15，换手 9.2%，同板块涨停 5 家，
主力净流入 3,600 万 / 成交额 3.0 亿，指数在 5 日线上方，昨日涨停今日平均溢价 +2.1%。

| 因子 | 权重 | 原始值 | 系数 | 得分 |
| :-- | :-- | :-- | :-- | :-- |
| 封单强度 | 20 | 1.80/45 = 4.00% ≥3% | 1.00 | 20.00 |
| 涨停时间 | 15 | 10:15 早盘板 | 0.80 | 12.00 |
| 连板高度 | 15 | 二板（最优） | 1.00 | 15.00 |
| 量能结构 | 12 | 换手 9.2%（5%~15%） | 1.00 | 12.00 |
| 板块效应 | 15 | 同板块 5 家 ≥5 | 1.00 | 15.00 |
| 资金流 | 10 | 3,600/30,000 = 12.0% → 0.4+(12−5)/10×0.6 | 0.82 | 8.20 |
| 大盘情绪 | 13 | 站上 5 日线 0.5 + 溢价 2.1%/3%×0.5 = 0.35 | 0.85 | 11.05 |
| **合计** | **100** | | | **93.25 → 93** |

判定：93 ≥ 85 → **入选且可满仓**（≥70 入选，≥85 满仓）。

仓位（短线账户 50,000，成交价 12.30）：

```
单票上限 = 50,000 × 20% = 10,000 元
qty = floor(10,000 / 12.30 / 100) × 100 = floor(8.13) × 100 = 800 股
实际投入 = 800 × 12.30 = 9,840 元 ≤ 10,000 ✓
```

**标的 B：尾盘回封的五板（同日）**

流通市值 60 亿，封单 0.40 亿，涨停时间 14:42，换手 28%，同板块涨停 2 家，主力净流出 900 万，大盘情绪同上。

| 因子 | 权重 | 原始值 | 系数 | 得分 |
| :-- | :-- | :-- | :-- | :-- |
| 封单强度 | 20 | 0.40/60 = 0.67% <1% | 0.30 | 6.0 |
| 涨停时间 | 15 | 14:42 尾盘板 | 0.30 | 4.5 |
| 连板高度 | 15 | 五板 | 0.40 | 6.0 |
| 量能结构 | 12 | 换手 28% 天量 | 0.40 | 4.8 |
| 板块效应 | 15 | 同板块 2 家 <3 | 0.00 | 0.0 |
| 资金流 | 10 | 净流出 | 0.00 | 0.0 |
| 大盘情绪 | 13 | 同上 | 0.85 | 11.05 |
| **合计** | **100** | | | **32.35 → 32** |

判定：32 < 70 → **不入选**，进 `plan.rejected`，`reason: "打分 32 < 70，尾盘天量五板且板块未确认"`。

**情绪总闸算例**：某日指数跌破 5 日线、昨日涨停今日平均溢价 −1.2%、炸板率 46% →
`sentimentGate.open = false`，`reason: "指数收盘跌破 5 日线；昨日涨停今日平均溢价 -1.2% < 0；炸板率 46% > 40%"`
→ 当日**标的 A 的 90 分也不发买入指令**，全部 `ERR-RISK-007`。

## 3.6 短线象限常见误用与反模式

| 反模式 | 为什么错 | 拦截 |
| :-- | :-- | :-- |
| **把短线套牢票转成长期持有** | 这是三象限里最致命的一步：短线仓位没有分红支撑，转长期等于把 −3% 的纪律性止损换成 −40% 的开放式亏损；同时污染长期象限的 `costPerShare` 与 ETA 统计 | **账本层面禁止**：持仓带 `quadrant` 标签，跨象限改标签无接口；`transfer` 只搬现金不搬持仓；5 日硬期限到期 `force_exit` 恒放行，任何"转长期"请求返回 `ERR-OVERRIDE-001` |
| 用长期的钱补短线亏损 | 破坏象限隔离，等于把纪律账户当提款机 | 跨象限调拨需显式 `transfer + reason` 写审计；"救火"式调拨在复盘里单列 |
| 5 日到期时"再给一天" | 5 日是区分"短线"与"套牢"的唯一边界 | 唯一硬红线，`gate()` 不接受 override |
| 一字板挂单买不到就追高开 5% | 一字板买不到是设计前提（P6），追高开等于用最高价买最热的票 | 候选池剔除一字板；指令单价格受 `slippageBps` 约束 |
| 连板股"再板就加仓" | 加仓禁止；四板以上打分递减而非递增 | `SHORT.ADD` 直接拒绝；连板高度系数递减 |
| 情绪退潮时"这只票独立性强" | 情绪总闸比个股打分优先，这是设计明文 | `ERR-RISK-007` |
| 胜率 41% 时"这次不一样" | 滚动 30 笔负期望时继续做 = 加速亏损 | `ERR-RISK-006`，象限停用 |
| 盘中临时改止损到 −8%"给它空间" | 契约锁定 | `ERR-CONTRACT-001` |

---

## 4. 跨象限通用规则（三策略共用）

| 规则 | 说明 |
| :-- | :-- |
| 无未来函数 | 信号在 bar i 收盘确认，成交在 bar i+1（开盘或收盘，可配）。任何 `bars[i+1]` 参与 `bars[i]` 决策视为 bug |
| 单一决策窗 | 收盘后生成次日计划；盘中只允许触发已挂条件单（稳定/短线） |
| 整手 | 买入向下取整到 100 股（科创板 200 股起），不足 1 手 → `ERR-PLAN-001` 进 `rejected` |
| 不伪造成交 | 停牌/一字涨停/跌停卖不成交 → 进 `rejected` 留痕，绝不静默丢弃 |
| 输出带 as_of | 每条 Signal 与 OrderPlan 带 `asOf`；数据陈旧 >1 交易日 → `stale:true` + 脚注 |
| 免责脚注 | 所有指令单固定追加"非投资建议，风险自负" |
| 成本口径唯一 | 三策略一律调用 `src/costs.js`，禁止在策略内自行加费用 |

## 5. 实现状态对照（截至 v0.1.0）

| 算法 | 契约位置 | 实现状态 |
| :-- | :-- | :-- |
| `holdingCost` / `costToNegativeEta` / `annualDilutionRate` | interface.md §1 | 已有骨架（`src/costs.js`） |
| `RED_LINES` / `gate` / `expectancyCheck` / `sentimentGate` | interface.md §5 | 已有骨架（`src/risk.js`）；**象限仓位上限检查为计划** |
| `gridPlan` / `dilutionReport` / `reinvestPlan` | interface.md §7.1 | ✅ 已实现（`src/strategies/longTerm.js`；分红再投默认关闭，整手 + 含费可负担，除息价用未复权 close） |
| `adaptiveTarget` / `checkPosition` | interface.md §7.2 | 计划 |
| `scoreCandidates` / `exitPlan` | interface.md §7.3 | 计划 |
| 回测引擎（T+1/涨跌停/整手/分红） | interface.md §8 | 计划 |

> 上表随实现推进需同步更新；文档不得先于代码宣称"已实现"。
