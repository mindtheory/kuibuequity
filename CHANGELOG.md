# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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
