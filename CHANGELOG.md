# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **复盘增强（P2，`src/review.js#reviewReport` 纯函数）**：`kb_review` 与 `/api/kuibuequity/review`
  改为共用同一套口径（此前两处各写一套 `new Date()` 日期过滤，窗口会漂移），`asOf` 显式传入
  便于事后对账，工具新增可选 `asOf` 参数。
  - **按象限纪律遵守率**：分母 = 期内有效锁定契约数（`createdAt` 在期内，或期前契约但期内有
    override —— 说明它当期仍在被改），分子 = 期内 override 次数，
    `rate = max(0, 1 − override/契约数)`。同一契约被改 3 次 = 3 次违反 / 1 次机会 →
    遵守率夹 0、`capped:true`、`overrideRate` 如实给 3 并记 `REVIEW.OVERRIDE_EXCEEDS_CONTRACTS`
    （**不把多次 override 稀释成"只违规一次"**）；期内无契约 → `null`，不输出假的 100%
    （"0 次违规"与"没有机会违规"不是一回事）。
  - **短线超期未离场清单**：`holdDays = tradingDaysBetween(openDate, asOf)`（真实交易日，非"跳周末"），
    `dueDate = addTradingDays(openDate, 5)`，`mustExitNow = holdDays >= 5`（与 `risk.hardExitCheck`
    同口径），`overdue` 只在 `holdDays > 5` 成立。第 5 个交易日进 `dueToday`（今天必须走，还不算
    违规），`>5` 才进 `items` —— 既不把"到期"记成"已违规"，也不放过真超期。
  - **诚实失败**：`asOf` 非法/溢出日、任一短线持仓 `openDate` 缺失/非法/超出日历覆盖 →
    `ERR-CALENDAR-001`（5 日硬期限无法核验时不产出看起来正常的复盘）；`period`/`quadrant` 非法 →
    `ERR-REVIEW-001`；缺日期记录计入并记 `REVIEW.MISSING_DATE`，晚于 `asOf` 的记录排除并记
    `REVIEW.RECORD_AFTER_ASOF`。无短线持仓时不触碰日历（断网、跨年可复盘）。
  - 文档：`docs/interface.md` 新增 §12（签名/口径/warnings 码）与 §10 `ERR-REVIEW-001`；
    `docs/risk.md` §6.2 遵守率口径指向 §12；`docs/design.md` 工具表、`README.md`、
    `docs/strategies.md` §5 实现状态同步。
- **测试** `test/review.test.js` 17 例 + `test/plugin.test.js` 2 例集成通路自检：周期起点手算
  （week 2026-11-28→11-21；month 2026-03-31→02-28 月末夹取；all→null）、override 3 次不稀释、
  期外契约剔除而期前契约因期内 override 计入、三象限隔离、短线 11/20 建仓 asOf 11/30 逐日手算
  （11/23、24、25、26、27、30 = 6 日 → 超期 1 日、应离场 11/27）、第 5 日 `dueToday`、
  无短线持仓时 2028 越界仍可复盘、非法 asOf/period/quadrant 与 openDate 越界硬失败；
  全量 225 测试全绿。

- **分红再投（P2，`src/strategies/longTerm.js#reinvestPlan` 纯函数）**：`config.reinvest` 开启时把除息日
  现金分红按**除息价**折成底仓股数（整手），默认关闭（现金回收比再投更快把成本压负）。
  - 除息来源双通道：`bars.at(-1).dividendPerShare`（回测/合成数据）→ `dividends[]` 中
    `exDate === 最后一根 bar` 的实施方案。行情层日K恒无分红（`market.js` 为避免重复计入），
    所以**实盘只走第二条**——`kb_longterm action=plan` 现在会读账本持仓并拉分红历史
    （此前 `position` 恒为 `null`、无 dividends，再投与网格卖出在实盘都不可能触发）。
  - 价格口径：除息价一律取**未复权 `bar.close`**；用 `adjClose` 折算会把股数算多
    （例：close=6.00/adjClose=5.00、现金 3000 元 → 正确 400 股，误用 600 股），等于伪造成交。
  - 整手 + 不赊账：`qty` 从 `floor(cash/price/100)*100` 起逐手回退，直到
    `price×qty + tradeFee(buy) ≤ cash`（佣金 5 元起步，费用会把最后一手吃掉）；
    最终 < 1 手 → 不生成指令，进 `rejected` `LONG.REINVEST_TOO_SMALL`，现金留账上。
  - `evaluate` 同日网格买入与再投同为买入 → 指令单同向去重**保留网格买入**，再投留痕
    `LONG.REINVEST_DEDUPED`（不静默丢单，也不伪造第二笔成交）；`diagnostics.reinvest` 恒带出明细。
  - `dilutionReport` 新增 `reinvestEnabled`，开启时 `note` 追加"再投不增加 totalRecovered、
    成本转负慢于该 ETA"——ETA 公式不为再投打折，只如实提醒。
- **工具面**：`kb_longterm` 新增 `reinvest` 参数（默认 false），`action=grid/dilution/plan` 全部透传。
- **测试** `test/reinvest.test.js` 15 例：手算对齐（0.6×5000=3000 元，除息价 5.80 → 500 股、费 5.03
  = 佣金 5 + 过户 0.029；除息价 6.00 → 含费回退 400 股）、费用吃掉最后一手（1000 元/10.00 → 0 股）、
  未复权 vs 前复权 400≠600、
  无持仓/缺价/非除息日/分红历史通道、evaluate 集成与同日去重留痕、dilutionReport 提示不动 ETA；
  全量 206 测试全绿
- 文档：`docs/interface.md` §7/§7.1（`reinvestPlan` 签名、口径、4 个 rule 码）、
  `docs/strategies.md` §1.2(b) 伪代码与 §5 实现状态同步

- **交易日历（P2，`src/calendar.js` 纯函数）**：内置 2024-01-01~2027-12-31 年度表（法定节假日落在
  工作日的日期 + 交易所额外休市，如 2024 除夕 2/9；A 股周末调休上班日并不开市，不补为交易日），
  把"只跳周末"换成真实交易日计时；非法日期（含 `2026-02-30` 溢出日）与越界年份一律
  `ERR-CALENDAR-001`，**绝不回退到只跳周末**（回退会把春节/国庆算成交易日，硬红线提前砍仓 = 伪造计数）。
  - `risk.hardExitCheck`（短线 5 日硬红线）改用真实交易日：2026 春节持仓 2/10→2/24 为 4 个交易日
    （旧口径 11），不会提前砍仓；`risk.tradingDaysBetween` 改为 re-export（唯一实现在 calendar）。
  - `strategies/stable.checkPosition` 时间止损 `holdDays`：契约未显式给时按 `entry.date → 最后一根
    bar` 的真实交易日计算（此前工具层恒为 0，时间止损实际从未触发）；拿不到日期 → `null`，不误触发。
  - `plan.conditionOrdersFromContracts` 的 `validUntil` 用真实交易日；走出覆盖范围 → 有效期留空 +
    warning `STABLE.CALENDAR_UNCOVERED`（不编造日期、也不整单丢弃）。
  - `market.computeStale` 锚定最近交易日（`lastTradingDayOnOrBefore`）：国庆期间 9/30 的数据不再被
    误判陈旧；日历未覆盖年份回退"最近工作日"，只高估陈旧、不把旧数据说成新鲜。
  - 年度维护流程写入 `docs/interface.md` §11（契约：覆盖率/年度表/错误语义/6 个函数）；
    `docs/risk.md` §3.4 年度计数表与澄清项 R4 关闭、`docs/strategies.md` 时间止损与硬红线口径、
    `docs/data-sources.md` stale 判定与实现状态表、`docs/design.md` 目录树同步。
- **测试** `test/calendar.test.js` 12 例：年度表自洽（只含真实工作日/升序/年份对齐）、年度交易日
  手算（2024 262−20=242、2025 261−18=243、2026 261−19=242、2027 261−18=243）、跨春节/国庆/清明
  计数与 +N 交易日手算、2024 除夕特例、溢出日与越界 `ERR-CALENDAR-001`、三条消费链路对齐与越界
  降级、stale 锚点回归；全量 191 测试全绿

- **条件单导出 CSV（`kb_stable action=export`）**：把已锁定契约（t/s/D）与当前 stable 持仓转成券商
  条件单导入 CSV——每个标的止盈/止损各 1 条（`symbol,side,triggerPrice,orderPrice,qty,validUntil`），
  `triggerPrice = round2(entry.price × (1+t | 1+s))`（与 `checkPosition` 同一舍入口径）、
  `orderPrice = triggerPrice`、`qty` 取当前持仓股数、`validUntil = entry.date + maxHoldDays 个交易日`
  （只跳周末；节假日待 P2 交易日历接入，非法日期留空不伪造）。CSV 带 UTF-8 BOM + CRLF、RFC4180 转义，
  Excel 双击可读；`symbol` 可选（给了就只导该标的）。诚实失败：持仓无契约 → warning
  `STABLE.NO_CONTRACT`、契约缺 entry/t/s → `STABLE.CONTRACT_INCOMPLETE`，无可导出行 → `ERR-EXPORT-001`，
  失败时绝不返回伪造 CSV；导出只读本地账本、不联网，`asOfKind='exportedAt'` 明示 asOf 是导出时间。
- **纯函数** `src/plan.js#conditionOrdersFromContracts`（契约+持仓→条件单，优先 `position.contractId`
  精确匹配、否则取最新契约，同标的去重）与 `#renderConditionOrdersCsv`（RFC4180、BOM 可关）。
- **测试** `test/export-csv.test.js` 14 例（触发价手算 10.40/9.68、10.01→10.41/9.69、15 个交易日
  → 2026-12-11、契约选取、去重、无契约/契约不完整/非法日期诚实降级、BOM/CRLF/转义/null 空单元格）
  + `test/plugin.test.js` 2 例（`kb_stable export` 端到端、无可导出标的 ERR-EXPORT-001）；
  全量 179 测试全绿
- 文档：`docs/interface.md` §6 新增两个纯函数签名与条件单导出口径（含警告码/CSV 格式），
  README/design.md 工具表同步 `export` action

- **备选数据源适配器（Tushare 备源 + 数据源链）**：`src/market.js` 的 `dailyBars()`/`dividends()`
  改为按 `sources` 顺序尝试，默认 `['eastmoney','tushare']`；产出的 `source` 为**实际生效源**，
  另返回 `sourceChain`、`attempts`（逐源留痕：`ok` / `skipped:'NO_TOKEN'` / `code` / `message`）与
  `warnings`。Tushare 走 `https://api.tushare.pro` POST：日K用 `daily` + `adj_factor`
  （qfq=price×f÷窗口最新f、hfq=price×f、none=原价；任一交易日缺因子即 ERR-DATA-001，
  绝不把未复权价冒充复权价），分红用 `dividend`（仅 `div_proc==='实施'`，税前 `cash_div_tax`，
  `stk_bo_rate`/`stk_co_rate` 映射送股/转增，按 `exDate` 降序）
- **纯函数** `tushareRows` / `parseTushareDailyRow` / `barsFromTushare` / `parseTushareDividendRow` /
  `resolveTushareToken` / `tushareDateRange`（无网络、无时钟，日期窗由显式 `now` 传入）；
  Token 解析优先级：入参 > env `KUIBU_TUSHARE_TOKEN` > 兼容 `TUSHARE_TOKEN`，空白即视为未配置
- **测试** `test/data-source-chain.test.js` 20 例：手算对齐前复权（10.00×2.0/2.2=9.0909、
  11.00×2.2/2.2=11）、hfq/none 口径、vol 手→股/amount 千元→元、复权因子缺失拒绝冒充、
  仅「实施」入契约、日期窗边界、东财不可达→Tushare 接替、无 Token 静默跳过且不联网、
  未知源名拒绝、全源失败 ERR-DATA-001 汇总且不回显 Token、`sources:['tushare']` 不触东财、
  东财成功不触发备源、`indexBars` 只走东财
- 文档：`docs/interface.md` §3 签名/返回字段 + 新增 §3.1 数据源链契约与备源纯函数；
  `docs/data-sources.md` §7/§8 同步实现状态；`docs/design.md` §9 数据层补源链说明

- **短线候选池全市场扫描**：`kb_short action=scan` 的 `symbols` 留空即自动扫描全市场——
  `src/market.js` 新增 `listStocks()`（东财 clist 涨幅榜，免 Key；分页 ≤`maxPages`、
  页间退避 `pageSleepMs`、按代码去重）与 `limitUpPool()`（东财 push2ex 涨停池：封单/连板/
  涨停时间/炸板/行业），配套纯函数 `parseClistRow()` / `parseLimitUpRow()`
- **候选池纯函数** `src/strategies/shortTerm.js#buildCandidatePool`：纳入（涨停/涨幅≥5%/
  换手≥5%/量比≥2）与剔除（停牌、ST、次新<60 自然日、流通市值<30 亿、成交额<1 亿、一字板）
  全部无网络/无时钟；上市日/市值/成交额缺失时保守剔除并写明原因，不用默认值冒充真数据；
  涨停池富化连板高度、封单额、炸板、同行业涨停家数
- **测试** `test/short-pool.test.js` 15 例：字段映射、分页去重、第一页结构异常 ERR-DATA-001、
  后续页失败保留部分结果、涨停池无数据不伪造、四条纳入、九条剔除、涨停池富化、
  `kb_short scan` 端到端（全市场 / 涨停池降级 warning / 列表不可达 ERR-DATA-001 / 手工候选池）
- 文档：`docs/interface.md` §3 新增 `listStocks`/`limitUpPool`/`parseClistRow`/`parseLimitUpRow`
  与 StockRow/LimitUpRow 契约，§7.3 新增 `buildCandidatePool`；`docs/data-sources.md` §8
  实现状态对齐（并记录境外出口 TLS 间歇中断的降级口径）
- **Web GUI 面板（M5）**：`client.js` 浏览器半区——DSH 侧栏「跬步量化」入口 + 主区三象限驾驶舱
  （总览/持仓/指令单/个股体检/复盘 五 Tab；情绪总闸灯、成本转负进度条、条件单 CSV 导出、象限建账入口）
- **面板 API** `src/webapi.js`：`/api/kuibuequity/{state,init,trade,quote,sentiment,plan,check,review}`
  8 路由；loopback 守卫（allowLanState 默认 false）；错误统一 `{ok:false,code,message}`
- 设计文档 `docs/web-panel.md`（挂载方式、与参考插件的优化差异、API 表、安全边界）
- 测试：webapi 路由 8 条（mock webServer 端到端 handler 调用）；3099 自检实例验证
  插件挂载、state/init/trade 写链路、断网 sentiment 优雅降级、client.js 进入分发 bundle
- **契约落库联动**：`kb_account action=trade` 在 `stable` 象限录入买入成交时，自动按 `adaptiveTarget`
  的 t/s/D 生成并锁定建仓契约（`src/strategies/stable.js` 新增纯函数 `buildLockedContract`），
  与成交在**同一次 `save()`** 内落库；`trade.contractId` 与 `positions().contractId` 由同一契约表推导，
  成交 → 契约 → 持仓三者 id 自洽。加仓复用既有契约 id（`contract.reuse` 审计），不自动改 t/s/D。
- **补建契约**：`kb_stable action=contract` 在既有 stable 持仓尚无契约时（如建仓时行情不可用）补建并锁定，
  已有契约则原样返回、不重复创建。
- **测试**：`test/contract-link.test.js` 8 条用例（ATR 手算对齐 t=4%/s=−3.2%、clamp、草案诚实失败、
  原子落库与 id 自洽、加仓复用、不一致整笔回滚、override 审计）。

### Changed（契约变更，`docs/interface.md` 已同步）

- `dailyBars()`/`dividends()` 新增可选参数 `sources`（默认 `['eastmoney','tushare']`）、
  `tushareToken`、`retryDelaysMs`；返回值新增 `sourceChain`/`attempts`/`warnings`（`dividends` 另加 `count`）。
  未知源名或空链 → `ERR-DATA-001`（拼写错误不得静默跳过）；全部源失败 → 汇总各源原因后 `ERR-DATA-001`，
  不返回半截或未复权冒充数据；无 Token 时 Tushare 静默跳过（`attempts` 记 `skipped:'NO_TOKEN'`）。
  `indexBars()` 明确只走东财（Tushare 指数需 `index_daily`，未纳入契约）。
- `kb_short` 新增 `pages` 参数（自动扫描抓取页数，默认 2）；`scan` 返回新增 `mode`
  （`full-market`|`manual`）、`pool`（候选池统计/剔除明细前 20 条/涨停池行数）、`warnings`
  （涨停池降级、列表未覆盖全市场等）。`symbols` 语义改为"手工候选池"，留空即自动扫描，
  不再报"本插件不自动拉全市场列表"。
- 短线扫描的诚实降级：涨幅榜不可达 → 直接 `ERR-DATA-001`（不伪造候选池）；涨停池不可达 →
  退化为仅涨幅榜并返回 `warnings`，封单/连板因子缺数据时不得补非零值（打分因此偏保守）。
- `ledger.recordTrade` 新增可选参数 `contract`（契约草案），返回值 `Trade` 可含 `contractId`；
  草案 `quadrant/symbol` 与成交不一致 → `ERR-CONTRACT-001`，整笔不落库。
- `stable.buildLockedContract({ bars, symbol, entry, config })` 纳入接口契约（§7.2）；
  entry 必须来自真实成交，bars 不足仍由 `adaptiveTarget` 抛 `ERR-DATA-002`（P6 不编造 t/s）。
- `kb_account`/`kb_stable` 工具描述与 `days` 参数同步；行情不可用时 `kb_account trade` 照常记账，
  但返回 `warning: ERR-DATA-001` 且不生成契约（诚实失败，不伪造止盈止损）。

### Fixed

- 联网降级用例不再依赖"运行环境恰好断网"：`test/plugin.test.js`、`test/webapi.test.js`
  统一用 `globalThis.fetch` 打桩（断网 → 拒绝 / 日K → 固定桩），
  `kb_account` 的 stable 契约断言改为手算对齐（TR=0.2 → t=4%、s=−3.2%）；
  原 `s === −0.8t` 在 t 舍入到 4 位后必然不精确相等，联网环境下会误报。
  测试套件因此在联网/断网机器上都可复现同一结果。

## [0.1.0] - 2026-11-22

首个版本：设计冻结 + 纯函数内核 + 三象限策略 + 行情层 + DSH 工具注册。

### Added

- **设计基线**：`docs/design.md`（三象限总体设计、原则 P1~P7）、`docs/interface.md`（接口契约唯一事实源）、
  `docs/strategies.md`、`docs/cost-model.md`、`docs/risk.md`、`docs/data-sources.md`
- **成本内核** `src/costs.js`：A 股佣金/印花税/过户费/滑点；`holdingCost` 有效持仓成本（分红按除息日持股入账）；
  `costToNegativeEta` 成本转负 ETA（无摊薄来源时诚实返回 null）
- **指标库** `src/indicators.js`：SMA/EMA/RSI(Wilder)/MACD/BOLL/ATR/slope/maxDrawdown/sharpe/winRate/payoffRatio，
  输出与输入索引对齐、前导 null；RSI 与 Wilder 经典值对齐测试
- **回测引擎** `src/backtest.js`：无未来函数（信号收盘确认、次日成交）、T+1、整手、一字涨停/跌停/停牌不成交、
  费用与滑点、分红入账、short 模式 5 日强制离场；metrics 含成本转负进度
- **象限账本** `src/ledger.js`：long/stable/short 物理分账、原子写 JSON、审计 JSONL、契约锁定与 override 审计、
  跨象限调拨强制 reason、硬红线 ERR-OVERRIDE-001
- **三策略** `src/strategies/`：
  - `longTerm` 股息网格 · 成本转负引擎（60 日中位基准、ATR 自适应步长、单边下跌熔断）
  - `stable` 1~5% 反人性止盈（目标自适应、盈亏比 1.25:1、条件单前置、期望值自检 NOT_RECOMMENDED）
  - `shortTerm` 次日强势打分（七因子打分卡、情绪总闸、5 日硬期限强制离场）
- **风控闸门** `src/risk.js`：RED_LINES 全表、冷静期/连亏熔断/单票上限/当日开仓数/期望值自检、情绪总闸
- **指令单** `src/plan.js`：整手取整、被拒留痕、条件单导出（券商 L1 自动化）、免责脚注
- **行情层** `src/market.js`：东方财富免 Key（实时快照/日K/分红送配/指数），重试退避、60s 缓存、
  涨跌停整数分运算、stale 标记、失败 ERR-DATA-001 诚实返回
- **DSH 入口** `index.js`：注册 8 个工具（kb_market/kb_account/kb_longterm/kb_stable/kb_short/kb_backtest/kb_risk/kb_review）
  + systemPrompt 纪律说明；peer 模块动态 import 防御
- **测试**：`node --test test/*.test.js` 100 用例全绿（core 16 / risk 10 / strategies 20 / engine 34 / market 20）
- **工程配套**：`cordis.patch.yml`、`.github/workflows/ci.yml`（Node 20/22 矩阵）、README、LICENSE(MIT)

### 契约偏离（实现取舍，均已在源码"实现取舍"注释中留档）

- backtest：同一开盘先买后卖撮合（保证 T+1 可测，不计当日卖老仓腾现金）；单一 K 线序列标的，
  异 symbol 信号记 skipped/ERR-SYMBOL-001；feeRatio=总费用/初始资金（8 位精度）；
  分红只进现金与 holdingCost 不进 pnl；metrics 附加 initialCash/finalEquity/totalFees/dividends 等复盘字段
- ledger：recordTrade 接受可选 dividend（每股）；initAccount 对已存在象限幂等重置+审计；
  override 白名单字段 + ERR-OVERRIDE-001 硬红线；transfer 强制 reason；跨象限物理隔离不可互卖
- market：日K 用 klt=101（klt=102 实测为周线，早期资料笔误）；涨跌停整数分运算避免浮点误差；
  push2 对部分出口 IP 间歇断连，失败按 ERR-DATA-001 诚实返回

### Security

- 不接入任何券商交易接口，不存储任何资金凭据（设计原则 P1）
- 所有输出带 as_of 与"非投资建议"免责脚注
