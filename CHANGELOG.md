# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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

- `ledger.recordTrade` 新增可选参数 `contract`（契约草案），返回值 `Trade` 可含 `contractId`；
  草案 `quadrant/symbol` 与成交不一致 → `ERR-CONTRACT-001`，整笔不落库。
- `stable.buildLockedContract({ bars, symbol, entry, config })` 纳入接口契约（§7.2）；
  entry 必须来自真实成交，bars 不足仍由 `adaptiveTarget` 抛 `ERR-DATA-002`（P6 不编造 t/s）。
- `kb_account`/`kb_stable` 工具描述与 `days` 参数同步；行情不可用时 `kb_account trade` 照常记账，
  但返回 `warning: ERR-DATA-001` 且不生成契约（诚实失败，不伪造止盈止损）。

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
