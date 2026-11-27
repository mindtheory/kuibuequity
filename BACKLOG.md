# BACKLOG — 自动驾驶任务清单

> 本文件是自动驾驶（超级智能体「跬步量化·自动驾驶」）的**唯一任务来源**。
> 每轮自动驾驶：取最靠前的未勾选任务 → 开发 → `node --test test/*.test.js` 全绿 →
> conventional commit → push → 把该条标记 `[x]` 并在 CHANGELOG 记录。
>
> 纪律（不可违反）：
> - 遵守 `docs/design.md` 原则 P1~P7 与 `docs/interface.md` 契约；契约变更先改文档再改代码
> - 不接券商接口、不碰资金、不存储凭据
> - 一次一个任务；测试不全绿不推送；禁止伪造数据与测试
> - 状态标记：`[ ]` 待做 / `[x]` 完成 / `[~]` 进行中（附 PR/commit）/ `[!]` 被外部条件阻塞

## P0（发布阻塞项）

- [!] **CI 工作流上线**：`.github/workflows/ci.yml` 已在本地，但当前 PAT 无 `workflow` scope，GitHub 拒推。
  解除条件：仓库所有者给 token 加 workflow 权限，或网页端直接粘贴该文件内容。解除后提交并删除本条。

## P1（核心可用性）

- [x] **kb_stable 契约落库联动**：`kb_stable action=contract` 原只返回自适应参数，未写入账本契约。
  stable 象限录入买入成交（kb_account trade）时自动生成锁定契约（t/s/D 来自 adaptiveTarget），
  并把 contractId 关联到持仓。补 3+ 测试。（2026-11-22 完成，commit bebf854；8 例新测试）
- [x] **短线候选池全市场扫描**：`kb_short scan` 的 `symbols` 留空即自动扫描全市场——接入东财
  clist 涨幅榜（分页/去重/页间退避）与 push2ex 涨停池（封单/连板/炸板/行业），纯函数
  `buildCandidatePool` 按 §6.2 纳入与剔除（ST/次新/流通市值/成交额/停牌/一字板，缺失字段保守剔除）；
  列表不可达 → ERR-DATA-001，涨停池不可达 → 降级仅涨幅榜 + warnings。
  （2026-11-23 完成，commit 8dd19ce；15 例新测试，全量 143 测试全绿）
- [x] **备选数据源适配器**：Tushare（需 Token，env `KUIBU_TUSHARE_TOKEN`）作为 dailyBars/dividends 的
  备源；market.js 增加 source 链（eastmoney → tushare），输出标注实际 source。无 Token 时静默跳过备源。
  （2026-11-23 完成，commit a6ce151；20 例新测试，全量 163 测试全绿）

## P2（体验与稳健）

- [x] **交易日历**：`src/calendar.js` 内置 2024~2027 年度表（法定节假日 + 交易所额外休市如 2024 除夕），
  5 日硬期限、时间止损、条件单有效期、stale 锚点全部改用真实交易日；越界 `ERR-CALENDAR-001`
  不回退只跳周末。（2026-11-26 完成，commit c6e2f60；12 例新测试，全量 191 测试全绿）
- [x] **分红再投选项**：longTerm `reinvest: true` 时除息现金按除息价折入底仓股数（整手），
  默认仍关闭；补手算对齐测试。（2026-11-26 完成，commit a2bf451；15 例新测试，全量 206 测试全绿）
- [x] **Web GUI 面板（M5，提前完成 2026-11-22）**：client 半区插件——侧栏「跬步量化」入口 + 主区驾驶舱
  （总览/持仓/指令单/个股体检/复盘 五 Tab，情绪总闸灯、成本转负进度条、条件单 CSV 导出、象限建账入口）。
  节点侧 `/api/kuibuequity/*` 8 路由 + loopback 守卫；3099 自检实例端到端验证通过。详见 docs/web-panel.md。
- [ ] **kb_review 增强**：按象限输出纪律遵守率（契约 override 次数 / 应触发次数）、
  短线超期未离场检测（持仓 >5 交易日清单）。

## P3（远期，需老板拍板后才做）

- [ ] 组合层再平衡：三象限资金比例季度再平衡建议（quadrantSplit 偏离 >10% 时提示）
- [ ] 税务/费用优化提示：卖出批次选择（FIFO vs 成本最高优先）对成本转负速度的影响模拟
- [ ] 多账户支持（家人账户分账本）

## 已完成（归档）

- [x] v0.1.0：设计冻结、纯函数内核、三象限策略、行情层、8 工具注册、112 测试全绿（2026-11-22，tag v0.1.0）
- [x] P1 kb_stable 契约落库联动：stable 买入自动按 adaptiveTarget 锁定 t/s/D 契约，成交 ↔ 契约 ↔ 持仓
  contractId 自洽，加仓复用既有契约，override 走既有审计（2026-11-22，commit bebf854，120 测试全绿）
- [x] P1 短线候选池全市场扫描：`kb_short scan` 自动拉涨幅榜+涨停池并剔除 ST/次新/低市值/低成交额/
  一字板，涨停池不可用降级仅涨幅榜并 warning（2026-11-23，commit 8dd19ce，143 测试全绿）
- [x] P1 备选数据源适配器：`dailyBars`/`dividends` 源链（eastmoney → tushare），Tushare qfq/hfq
  用 daily+adj_factor（缺因子即 ERR-DATA-001，不冒充复权）、dividend 仅取实施方案；返回实际
  `source`/`sourceChain`/`attempts`/`warnings`，无 Token 静默跳过（2026-11-23，commit a6ce151，163 测试全绿）
- [x] P1 条件单导出 CSV：`kb_stable action=export` 把已锁定契约（t/s/D）+ stable 持仓转成券商条件单
  CSV（止盈/止损各 1 条，触发价=round2(entry×(1+t|1+s))、委托价=触发价、数量=持仓、有效期=entry+maxHoldDays
  个交易日），UTF-8 BOM+CRLF+RFC4180，Excel 直开；纯函数 `conditionOrdersFromContracts`/`renderConditionOrdersCsv`，
  无契约/契约不完整/无可导出行诚实报错，不伪造 CSV（2026-11-24，commit b39d1d9，179 测试全绿）
- [x] P2 分红再投选项：`longTerm.reinvestPlan` 把除息现金按**未复权除息价**折成整手底仓股数
  （非 adjClose，否则股数算歪=伪造成交），qty 从整手起按"含费用买得起"逐手回退（佣金 5 元起步），
  不足 1 手进 rejected `LONG.REINVEST_TOO_SMALL`；除息来源双通道（bar.dividendPerShare / dividends[]
  命中 exDate）——行情层日K恒无分红，实盘只走后者；`kb_longterm action=plan` 现在读账本持仓 +
  分红历史（此前 position 恒 null，再投与网格卖出在实盘都不可能触发）；同日网格买入与再投同向
  去重保留网格买入、再投留痕 `LONG.REINVEST_DEDUPED`；默认关闭，`dilutionReport` 如实提醒
  "再投会拖慢成本转负"（2026-11-26，commit a2bf451，206 测试全绿）
- [x] P2 交易日历：`src/calendar.js` 纯函数年度表（2024~2027，法定节假日 + 2024 除夕交易所休市，
  周末调休上班日不算交易日），`risk.hardExitCheck`（短线 5 日）、`stable.checkPosition`（时间止损，
  此前工具层 holdDays 恒 0 未真正生效）、`plan` 条件单 validUntil、`market.computeStale` 四处接入；
  非法/溢出日与越界年份一律 ERR-CALENDAR-001，绝不回退"只跳周末"；条件单越界 → 有效期留空 +
  warning STABLE.CALENDAR_UNCOVERED（2026-11-26，commit c6e2f60，191 测试全绿）
