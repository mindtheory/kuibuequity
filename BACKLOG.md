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

- [ ] **kb_stable 契约落库联动**：`kb_stable action=contract` 目前只返回自适应参数，未写入账本契约。
  应在 stable 象限录入买入成交（kb_account trade）时自动生成锁定契约（t/s/D 来自 adaptiveTarget），
  并把 contractId 关联到持仓。补 3+ 测试。
- [ ] **短线候选池全市场扫描**：`kb_short scan` 现需手工传 symbols。接入东财 clist 列表接口
  （涨幅榜/涨停池，免 Key），自动构建候选池（含剔除规则：ST/次新/流通市值/成交额/一字板）。
  注意限频与分页；断网时保持 ERR-DATA-001 优雅降级。
- [ ] **备选数据源适配器**：Tushare（需 Token，env `KUIBU_TUSHARE_TOKEN`）作为 dailyBars/dividends 的
  备源；market.js 增加 source 链（eastmoney → tushare），输出标注实际 source。无 Token 时静默跳过备源。
- [ ] **条件单导出 CSV**：`toConditionOrders` 基础上加 `kb_stable action=export`，输出券商条件单
  导入格式 CSV（触发价/委托价/数量/有效期），UTF-8 BOM，Excel 可直接打开。

## P2（体验与稳健）

- [ ] **交易日历**：`tradingDaysBetween` 现只跳周末；接入节假日表（静态 JSON，每年维护，
  或东财交易日历接口），5 日硬期限与时间止损的计数必须用真实交易日。
- [ ] **分红再投选项**：longTerm `reinvest: true` 时除息现金按除息价折入底仓股数（整手），
  默认仍关闭；补手算对齐测试。
- [ ] **Web GUI 面板（M5）**：client 半区插件——三象限账本卡片、持仓成本转负进度条、
  当日指令单看板、情绪总闸指示灯。参考 dsh-super-agents 的 client.js 注入方式。
- [ ] **kb_review 增强**：按象限输出纪律遵守率（契约 override 次数 / 应触发次数）、
  短线超期未离场检测（持仓 >5 交易日清单）。

## P3（远期，需老板拍板后才做）

- [ ] 组合层再平衡：三象限资金比例季度再平衡建议（quadrantSplit 偏离 >10% 时提示）
- [ ] 税务/费用优化提示：卖出批次选择（FIFO vs 成本最高优先）对成本转负速度的影响模拟
- [ ] 多账户支持（家人账户分账本）

## 已完成（归档）

- [x] v0.1.0：设计冻结、纯函数内核、三象限策略、行情层、8 工具注册、112 测试全绿（2026-11-22，tag v0.1.0）
