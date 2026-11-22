# 参与开发

跬步量化（kuibuequity）是一个"纪律执行器"。所有贡献必须先读两份基线：

- `docs/design.md` —— 总体设计与不可妥协原则（P1~P7）
- `docs/interface.md` —— 接口契约（唯一事实源）

## 五条铁律

1. **纯函数内核**：`src/` 下除 `market.js`（行情层）与 `ledger.js`（落盘）外，全部必须是纯函数——
   不依赖 DSH、不依赖网络、不依赖时钟（时间一律由入参传入），保证 `node --test` 可独立验证。
2. **无未来函数**：任何策略/回测代码不得用 `bars[i+1]` 决定 `bars[i]` 的动作。
   信号在第 i 根收盘确认，第 i+1 根成交。违反视为最高级 bug。
3. **契约先行**：字段/单位/空值语义有歧义时，**先改 `docs/interface.md` 再改代码**，
   并在 CHANGELOG 记录契约变更。代码与文档冲突时以契约为准。
4. **诚实的失败**：数据不足、无法成交、负期望 → 明确抛 `ERR-*` 错误码或进 `rejected` 留痕，
   绝不伪造数据、伪造成交、给出"看起来能用"的乐观数字。
5. **只读 + 模拟**：不接券商接口、不碰资金、不存储凭据。任何试图引入实盘下单的 PR 直接拒绝。

## 开发环境

```bash
git clone <repo> && cd kuibuequity
node --test test/*.test.js     # 全量测试（Node >= 20，无第三方运行时依赖）

# 本地调试 DSH 插件（热加载，无需反复安装）
dsh --patch ./cordis.patch.yml --profile web
# 或安装为正式插件
dsh plugin --profile web add .
```

本地验证 `index.js` 需要 peer 包：把 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`
软链或安装到 `node_modules/`（发布环境由 DSH 宿主提供）。

## 测试要求

- 新增/修改策略：≥8 条用例，必须覆盖边界（数据不足、涨跌停、停牌）与红线（熔断、强制离场）
- 数值类改动：给出**手算对齐**用例（中间量写进注释，可人工验算）
- 禁止联网测试：行情层只测纯逻辑（解析/归一化/涨跌停计算/stale 判定）

## 提交规范

Conventional Commits，描述用中文：

```
feat(stable): 止盈目标增加波动率自适应 clamp
fix(backtest): 一字涨停买入不再伪造成交
docs(risk): 补充连亏熔断判定伪代码
test(costs): 分红摊薄手算对齐用例
refactor(market): 涨跌停改整数分运算
chore: 升级 CI Node 矩阵
```

一个提交一件事；行为变更必须带测试；契约变更必须在 PR 描述中单列。

## 文档同步

改了行为就要改文档：策略参数 → `docs/strategies.md`；费率口径 → `docs/cost-model.md`；
红线/闸门 → `docs/risk.md`；数据源 → `docs/data-sources.md`；用户可见变化 → `README.md` + `CHANGELOG.md`。
