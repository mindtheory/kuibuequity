# 数据源与数据质量（Data Sources）

> 上游事实源：`docs/design.md` §9、`docs/interface.md` §3（`src/market.js` 契约）。
> 原则：`market.js` 是**唯一允许联网的模块**；其余模块只接收已归一化的 `Bar`/`Quote`。
>
> **实测说明**：本文标注「✅ 本机实测」的端点为开发机（境外出口）直接验证通过；
> 标注「⚠️ 标准端点」的为东方财富网页在用的公开接口、URL 模板按公开口径书写，
> 但本机出口对 `push2his.eastmoney.com` 的 TLS 连接被中断（`SSL_read: unexpected eof`），
> **未在本机完成端到端验证**，接入时需在境内网络复测。不得据此宣称"已验证可用"。

---

## 1. 首选：东方财富免 Key 公开接口

特点：国内直连、无需注册/Token、JSON 返回、与网页同源。
公共约定：

| 项 | 值 | 说明 |
| :-- | :-- | :-- |
| 编码 | UTF-8 | 部分接口带 `cb=` 参数即返回 JSONP，**不要传 cb**，直接拿 JSON |
| 必带请求头 | `User-Agent`（浏览器 UA）、`Referer: https://quote.eastmoney.com/` | 缺 UA 常被 CDN 直接断连 |
| `ut` 参数 | `fa5fd1943c7b386f172d6893dbfba10b` | 网页侧公开标识串，**不是密钥**；部分端点可省略 |
| `fltt=2` | 浮点格式返回 | 不传时价格按整数×100/1000 缩放返回，极易读错 |
| `invt=2` | 品种类型 | 个股快照用 |
| 超时 | 默认 8000ms（`httpTimeoutMs`） | 见 `interface.md` §3 |

### 1.1 `secid` 构造规则（最容易错）

`secid = <市场前缀>.<代码>`

| 市场 | 前缀 | 示例 | 代码段 |
| :-- | :-- | :-- | :-- |
| 上交所（沪市 A/ETF/指数） | `1` | `1.601398`、`1.600036`、`1.000300` | 60x / 68x / 5xx / 000xxx 指数 |
| 深交所（深市 A/ETF/指数） | `0` | `0.000001`、`0.300750`、`0.399006` | 00x / 30x / 15x / 399xxx 指数 |
| 北交所 | `0` | `0.920002`、`0.430047` | 4xx / 8xx / 92xxxx |
| 港股 | `116` | `116.00700` | 5 位代码 |
| 美股 | `105` | `105.AAPL` | — |

`normalizeSymbol()` 归一化规则（`interface.md` §3）：

```
'601398' | 'sh601398' | '601398.SH' | 'SH601398'
  → { code:'601398', market:'SH', secid:'1.601398' }
判定：6/9 开头 → SH(1)；0/2/3 开头 → SZ(0)；4/8 开头 → BJ(0)
无法识别 → ERR-SYMBOL-001
```

### 1.2 实时快照（✅ 本机实测）

**批量快照 `ulist.np/get`**（推荐：一次多标的，减少请求数）

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
    ?secids=1.601398,0.000001
    &ut=fa5fd1943c7b386f172d6893dbfba10b
    &fltt=2&invt=2
    &fields=f2,f3,f4,f5,f6,f8,f10,f12,f14,f15,f16,f17,f18,f20,f21,f100,f107
```

实测返回（2026-11-21）：

```json
{"rc":0,"rt":11,"svr":181669382,"lt":1,"full":1,"data":{"total":2,"diff":[
  {"f2":9.4,"f3":3.3,"f12":"601398","f14":"工商银行"},
  {"f2":12.22,"f3":1.5,"f12":"000001","f14":"平安银行"}]}}
```

**单标的快照 `stock/get`**（字段更全，含涨跌停价）

```
GET https://push2.eastmoney.com/api/qt/stock/get
    ?secid=1.601398
    &ut=fa5fd1943c7b386f172d6893dbfba10b
    &invt=2&fltt=2
    &fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f62,f84,f85,f116,f117,f162,f167,f168,f169,f170,f171,f191,f192
```

> ⚠️ **两套字段编号不要混用**：`ulist.np/get` 用短编号（`f2`=最新价、`f3`=涨跌幅），
> `stock/get` 用长编号（`f43`=最新价、`f170`=涨跌幅）。照抄别人的 fields 列表会得到全 `null`。

### 1.3 日 K 线（⚠️ 标准端点，本机 TLS 被中断）

```
GET https://push2his.eastmoney.com/api/qt/stock/kline/get
    ?secid=1.601398
    &ut=fa5fd1943c7b386f172d6893dbfba10b
    &fields1=f1,f2,f3,f4,f5,f6
    &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
    &klt=101          # 101 = 日K（本项目默认）
    &fqt=1            # 1 = 前复权
    &end=20500101     # 结束日期；填远期表示"取到最新"
    &lmt=250          # 取最近 250 根
```

**`klt` 周期表**：

| klt | 周期 | 本项目用途 |
| :-- | :-- | :-- |
| 1 / 5 / 15 / 30 / 60 | 分钟 | ❌ 不使用（design.md §11 明确不做分钟级） |
| **101** | **日 K** | ✅ 主用（指标、回测、策略全部基于它） |
| 102 | 周 K | 可选：长期象限年度趋势参考 |
| 103 | 月 K | 可选：分红/股息率跨年统计 |

> 注：任务书示例写的 `klt=102` 是**周 K**；本项目的 `dailyBars()` 必须用 `klt=101`。

**`fqt` 复权表**：

| fqt | 含义 | 用途 |
| :-- | :-- | :-- |
| 0 | 不复权 | 展示真实成交价、判断涨跌停（配合 §5） |
| **1** | **前复权** | ✅ 指标计算与回测（`dailyBars` 默认 `adjust:'qfq'`） |
| 2 | 后复权 | 长期累计收益展示（不参与信号计算） |

`fields1`（元信息）：`f1` 市场编号、`f2` 代码、`f3` 名称、`f4`/`f5` 品种与货币、`f6` 报价精度。
`fields2`（K 线列，**顺序即返回顺序**）：

| 字段 | 含义 | 映射到 `Bar` |
| :-- | :-- | :-- |
| f51 | 日期 `YYYY-MM-DD` | `date` |
| f52 | 开盘价 | `open` |
| f53 | 收盘价 | `close` / `adjClose`（fqt=1 时） |
| f54 | 最高价 | `high` |
| f55 | 最低价 | `low` |
| f56 | 成交量（**手**） | `volume`（需 ×100 转**股**） |
| f57 | 成交额（元） | `amount` |
| f58 | 振幅 % | — |
| f59 | 涨跌幅 % | — |
| f60 | 涨跌额 | — |
| f61 | 换手率 % | — |

返回形态：`data.klines` 为**逗号分隔字符串数组**，需按 `fields2` 顺序 split：

```
"data":{"code":"601398","market":1,"klines":[
  "2026-11-20,9.09,9.10,9.28,9.08,4859062,4457321024.00,2.20,1.11,0.10,0.18", ... ]}
```

**镜像主机**：`push2his.eastmoney.com` 不通时可依次尝试 `1.push2his.eastmoney.com` … `99.push2his.eastmoney.com`
（同一集群的不同 CDN 节点，路径与参数完全一致）。实现里应把镜像列表做成可配数组，逐个降级。

### 1.4 分红送配（✅ 本机实测）

```
GET https://datacenter-web.eastmoney.com/api/data/v1/get
    ?reportName=RPT_SHAREBONUS_DET
    &columns=ALL
    &pageSize=20
    &sortColumns=EX_DIVIDEND_DATE
    &sortTypes=-1
    &filter=(SECURITY_CODE="601398")
```

实测返回（2026-11-21，节选）：

```json
{"result":{"pages":12,"data":[{
  "SECURITY_CODE":"601398","SECURITY_NAME_ABBR":"工商银行",
  "REPORT_DATE":"2026-06-30 00:00:00",
  "PRETAX_BONUS_RMB":1.511,
  "IMPL_PLAN_PROFILE":"10派1.511元(含税,扣税后1.3599元)",
  "ASSIGN_PROGRESS":"实施分配",
  "EX_DIVIDEND_DATE":"2026-10-21 00:00:00",
  "EQUITY_RECORD_DATE":"2026-10-20 00:00:00",
  "DIVIDENT_RATIO":0.017610722611,
  "BONUS_RATIO":null,"IT_RATIO":null,"PER_CAPITAL_RESERVE":null }]}}
```

字段映射到 `dividends()` 契约（`interface.md` §3）：

| 东财字段 | 含义 | 映射 | 注意 |
| :-- | :-- | :-- | :-- |
| `EX_DIVIDEND_DATE` | **除息日** | `exDate` | 分红入账时点（见 cost-model.md §3.3） |
| `EQUITY_RECORD_DATE` | 股权登记日 | — | **不能**用作入账时点 |
| `PRETAX_BONUS_RMB` | **每 10 股**税前派息（元） | `cashPerShare = /10` | ⚠️ 是"10 派"口径，必须除以 10 |
| `BONUS_RATIO` | 送股比例（10 送 x） | `bonusShares = /10` | 无现金流入 |
| `IT_RATIO` | 转增比例（10 转 x） | `capitalizeShares = /10` | 无现金流入 |
| `ASSIGN_PROGRESS` | 方案进度 | 过滤 | 只取「实施分配」「实施完成」，剔除「董事会预案」「股东大会通过」 |
| `DIVIDENT_RATIO` | 股息率（该次派息/当期价） | 参考 | 不等于"年化股息率"，需自行按 5 年平均 |
| `IMPL_PLAN_PROFILE` | 方案文字 | 校验 | 可用于交叉核对 `PRETAX_BONUS_RMB` |

**股息率计算口径**（长期象限 `dividendYield`）：

```
近 5 年平均股息率 = mean over 5 years ( Σ该年度除息的 cashPerShare / 当年除息日收盘价 )
```

### 1.5 涨停池 / 炸板池（✅ 本机实测，短线象限关键源）

```
GET https://push2ex.eastmoney.com/getTopicZTPool
    ?ut=7eea3edcaed734bea9cbfc24409ed989
    &dpt=wz.ztzt
    &Pageindex=0&pagesize=200
    &sort=fbt:asc
    &date=20261120          # YYYYMMDD，可取历史
```

实测返回（节选）与打分卡映射：

```json
{"data":{"tc":28,"qdate":20261120,"pool":[{
  "c":"603324","n":"盛剑科技","m":1,"p":27710,"zdp":10.0039,
  "amount":673088896,"ltsz":4042291018.2,"tshare":4183747797.2,
  "hs":17.1433,"lbc":4,"fbt":92501,"lbt":140749,
  "fund":43397739,"zbc":4,"hybk":"环保设备","zttj":{"days":4,"ct":4}}]}}
```

| 字段 | 含义 | 打分卡因子 |
| :-- | :-- | :-- |
| `p` | 价格 ×1000 | 还原 `price = p/1000` |
| `zdp` | 涨跌幅 % | 候选池门槛 |
| `ltsz` | 流通市值（元） | 封单强度分母、池子过滤（<30 亿剔除） |
| `hs` | 换手率 % | **量能结构** |
| `lbc` | **连板数** | **连板高度** |
| `fbt` / `lbt` | 首次/最后封板时间 `HHMMSS` | **涨停时间**（92501 = 09:25:01 一字/早盘） |
| `fund` | **封单金额（元）** | **封单强度** = `fund / ltsz` |
| `zbc` | **炸板次数** | 炸板 → 封单强度记 0 |
| `hybk` | 所属行业板块 | **板块效应**（同板块涨停家数统计） |
| `amount` | 成交额 | 池子过滤（<1 亿剔除） |

炸板池：`getTopicZBPool`（同域同参数风格）→ 用于计算 `blowUpRate = 炸板数 / (涨停数 + 炸板数)`。

### 1.6 板块/列表排行（✅ 本机实测）

```
GET https://push2.eastmoney.com/api/qt/clist/get
    ?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3
    &fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048
    &fields=f2,f3,f8,f12,f14,f20,f21,f62,f184
```

| 参数 | 含义 |
| :-- | :-- |
| `pn` / `pz` | 页码 / 每页条数 |
| `po` | 1 降序 / 0 升序 |
| `fid` | 排序字段（`f3` 涨跌幅） |
| `fs` | 板块筛选表达式（深主板 `m:0+t:6`、深创 `m:0+t:80`、沪主 `m:1+t:2`、科创 `m:1+t:23`、北交所 `m:0+t:81+s:2048`） |
| `fields` | `f62` 主力净流入（元）、`f184` 主力净流入占比 % → **资金流**因子 |

实测：`total:1642`，返回 `data.diff` 数组（`np=1` 时为对象数组，否则为 `{"0":{...}}` 形态，实现需兼容）。

### 1.7 指数序列（大盘过滤 / 情绪总闸）

```
GET https://push2his.eastmoney.com/api/qt/stock/kline/get
    ?secid=1.000300&fields1=f1,f2,f3,f4,f5,f6
    &fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&end=20500101&lmt=60
```

常用指数：`1.000300` 沪深300（默认）、`1.000001` 上证指数、`0.399006` 创业板指、`0.399001` 深证成指。
指数**不复权**（`fqt=0`），`indexBars()` 用于 `close > MA20` 与 `close ≥ MA5` 两个闸门。

### 1.8 端点清单汇总

| # | 用途 | 方法 | 主机 | 路径 | 实测 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 批量实时快照 | GET | `push2.eastmoney.com` | `/api/qt/ulist.np/get` | ✅ |
| 2 | 单标的快照（含涨跌停价） | GET | `push2.eastmoney.com` | `/api/qt/stock/get` | ⚠️ |
| 3 | 列表/排行/资金流 | GET | `push2.eastmoney.com` | `/api/qt/clist/get` | ✅ |
| 4 | 日 K（前复权） | GET | `push2his.eastmoney.com` | `/api/qt/stock/kline/get` | ⚠️ |
| 5 | 分红送配 | GET | `datacenter-web.eastmoney.com` | `/api/data/v1/get?reportName=RPT_SHAREBONUS_DET` | ✅ |
| 6 | 涨停池 | GET | `push2ex.eastmoney.com` | `/getTopicZTPool` | ✅ |
| 7 | 炸板池 | GET | `push2ex.eastmoney.com` | `/getTopicZBPool` | ⚠️ |
| 8 | 龙虎榜（资金流校验） | GET | `datacenter-web.eastmoney.com` | `/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW` | ✅ |
| 9 | 指数日 K | GET | `push2his.eastmoney.com` | `/api/qt/stock/kline/get`（`secid=1.000300`） | ⚠️ |

> ⚠️ 项在本机（境外出口）出现 TLS 中断，**境内网络下为正常可用**；
> 实现时按 §3 的镜像降级 + 重试策略处理，并在 `market.js` 里把不可达明确抛 `ERR-DATA-001`。

---

## 2. 字段 → `Bar` 映射表（`dailyBars()` 归一化）

| `Bar` 字段 | 类型 | 来源 | 转换规则 |
| :-- | :-- | :-- | :-- |
| `date` | string | f51 | 原样 `YYYY-MM-DD` |
| `open`/`high`/`low`/`close` | number | f52/f54/f55/f53 | `fqt=1` 时为前复权价；保留 3 位小数 |
| `adjClose` | number | f53（fqt=1） | **指标计算一律用这个**（design.md §3.2） |
| `volume` | number(股) | f56（手） | **× 100** 转股 |
| `amount` | number(元) | f57 | 原样 |
| `limitUp` | bool | 派生 | 见 §5.2 一字/封板判定 |
| `limitDown` | bool | 派生 | 同上 |
| `suspended` | bool | 派生 | 见 §5.1 |
| `dividendPerShare` | number | 分红接口 §1.4 | 按 `exDate` 对齐到该日；无则 `0` |

`Quote`（实时快照）映射：`f43→price`、`f46→open`、`f44→high`、`f45→low`、`f60→prevClose`、
`f170→changePct`、`f47→volume(手→股)`、`f48→amount`、`f168→turnoverRate`、`f51→limitUpPrice`、`f52→limitDownPrice`、
`f57→symbol`、`f58→name`；`asOf` 取响应时刻，`stale` 按 §6.3 判定。

**空值约定**（`interface.md` 约定）：未知一律 `null`，不得用 `0` 或 `"NaN"` 代替。
`dividendPerShare` 是唯一例外：**无分红填 `0`**（0 有明确语义）。

---

## 3. 限频与重试策略

### 3.1 限频（保守值，宁慢勿封）

| 项 | 限制 | 说明 |
| :-- | :-- | :-- |
| 全局并发 | ≤ 2 | 同一时刻最多 2 个在途请求（`Promise` 队列） |
| 全局 QPS | ≤ 2 req/s | 令牌桶，容量 2、补充 2/s |
| 单主机最小间隔 | ≥ 500ms | 含镜像主机 |
| 单次批量 | `secids` ≤ 50 只/请求 | 用批量接口替代 N 次单请求 |
| 全量自选股刷新 | ≥ 60s 一次 | 收盘后一次性拉取，不做轮询 |
| 日 K 拉取 | 每标的每日 ≤ 2 次 | 命中本地缓存则不请求（缓存 TTL = 当日收盘后失效） |

### 3.2 重试（指数退避 ≤3 次）

```
attempt 0: 立即
attempt 1: 等待 500ms  (+0~200ms 抖动)
attempt 2: 等待 1000ms (+0~400ms)
attempt 3: 等待 2000ms (+0~800ms)
失败 → throw new Error('ERR-DATA-001: <host> <path> 连续 4 次失败: <lastError>')
```

| 规则 | 内容 |
| :-- | :-- |
| 可重试错误 | 连接超时、TLS 中断、`5xx`、`rc != 0` 且 `rc` 非"代码不存在"、返回体非 JSON |
| **不可重试** | `4xx`（除 429）、`rc:5400`（代码不存在，直接 `ERR-SYMBOL-001`）、空 `data` 且明确"无此标的" |
| 镜像降级 | `push2his` → `1.push2his` → `9.push2his` …（每次重试换主机） |
| 半截数据 | **禁止返回部分结果**：任一页失败即整体失败（P6） |
| 熔断 | 同一主机连续 5 次失败 → 冷却 60s 不再请求，直接抛 `ERR-DATA-001` |
| 绝不 | 用缓存冒充实时的（`stale` 必须显式），也不伪造价格 |

### 3.3 本地缓存

| 数据 | TTL | 说明 |
| :-- | :-- | :-- |
| 实时快照 | 0（不缓存） | 每次现取；失败即报错 |
| 日 K | 至当日 15:30 后失效 | 收盘后需重取以纳入当日 bar |
| 分红送配 | 24h | 低频变化 |
| 涨停池 | 当日有效 | 收盘后固化 |
| 交易日历 | 年（国务院年度通知） | **已实现**：内置年度表（`src/calendar.js`，2024~2027），不联网、不缓存，每年更新源码 |

---

## 4. 复权口径（与成本口径的衔接）

| 场景 | 用什么价 | 分红怎么处理 |
| :-- | :-- | :-- |
| 指标计算（MA/ATR/RSI/MACD/BOLL） | **前复权**（`fqt=1`，`adjClose`） | 前复权已抹平除息跳空，**不再单独考虑** |
| 网格触发价、止盈止损价 | **前复权**（保持与指标同一坐标系） | 除息跳空不得被误判为网格信号（design.md §4.4） |
| 涨跌停判定 | **不复权**（`fqt=0`）或按当日 prevClose 推算 | 复权价算出的涨跌停价会错 |
| 成本核算 `holdingCost` | **真实成交价**（不复权） | **分红单独入账一次**（除息日 × 当时持股数） |
| 回测收益 | 前复权价 + 分红现金入账 | 两者相加，**不得重复** |

**核心禁令**（cost-model.md §7）：前复权价 + 分红**双重摊薄** = progress 虚高。
前复权解决的是"价格序列连续性"，分红入账解决的是"现金回收"，两者维度不同、不可互相替代。

---

## 5. 停牌与涨跌停判定规则

### 5.1 停牌

| 判定 | 规则 |
| :-- | :-- |
| 快照 | `price` 为 `null`/`0` 或 `volume == 0` 且非开盘前时段 → `suspended = true` |
| 日 K | 当日无 bar（东财停牌日通常**不生成** bar）→ 需按交易日历补 `suspended` 占位 bar，否则指标错位 |
| 后果 | 当日全部指令转 `rejected`（`ERR-PLAN-002`），**不伪造成交** |

### 5.2 涨跌停幅度（主板/创业板/科创板/北交所/ST）

| 板块 | 代码段 | 涨跌幅限制 | 备注 |
| :-- | :-- | :-- | :-- |
| 沪市主板 | 60xxxx | **±10%** | — |
| 深市主板 | 00xxxx | **±10%** | — |
| 创业板 | 30xxxx | **±20%** | 新股上市前 5 日不设限 |
| 科创板 | 68xxxx | **±20%** | 新股上市前 5 日不设限 |
| ST / *ST | 任意 | **±5%** | 沪市 ST 含风险警示板规则；创业板 ST 仍 ±20%（以交易所规则为准） |
| 北交所 | 4xxxxx / 8xxxxx / 92xxxx | **±30%** | 上市首日不设限 |

**涨跌停价计算**（A 股最小变动单位 0.01 元，**四舍五入到分**）：

```
limitUpPrice   = round2( prevClose × (1 + limitPct) )
limitDownPrice = round2( prevClose × (1 − limitPct) )
limitPct ∈ {0.10, 0.20, 0.05, 0.30}   // 按上表选
```

**验算示例**：

| 场景 | prevClose | limitPct | 计算 | 涨停价 | 跌停价 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 主板 | 6.10 | 10% | 6.10×1.10 = 6.710 | **6.71** | 6.10×0.90 = 5.490 → **5.49** |
| 主板 | 3.33 | 10% | 3.33×1.10 = 3.663 | **3.66** | 3.33×0.90 = 2.997 → **3.00** |
| 创业板 | 20.00 | 20% | 20×1.20 = 24.00 | **24.00** | **16.00** |
| ST | 4.00 | 5% | 4.00×1.05 = 4.20 | **4.20** | **3.80** |
| 北交所 | 10.00 | 30% | 10×1.30 = 13.00 | **13.00** | **7.00** |

> 注意 `3.33 → 3.66`（3.663 舍去）与 `2.997 → 3.00`：必须**四舍五入到 0.01**，
> 用 `floor` 会在低价股上算出错误涨停价，导致误判"未涨停"。

**封板/一字板判定**：

```
limitUp   = (high == limitUpPrice) and (close == limitUpPrice)     # 收盘仍封住
limitDown = (low  == limitDownPrice) and (close == limitDownPrice)
一字板（买不到/卖不掉） = (high == low == close == limitUpPrice)
```

> 任务书表述 `high == low == limit` 即此意。工程上建议**同时**用交易所返回的涨跌停价
> （`stock/get` 的 `f51`/`f52`）而非自行推算，推算仅作为兜底（f51/f52 缺失时）。

**回测/模拟盘成交语义**（design.md §7）：

| 情形 | 处理 |
| :-- | :-- |
| 一字涨停 | 买入**不成交**（买不到） |
| 涨停但盘中打开过 | 买入按涨停价成交（保守：不给更低价） |
| 一字跌停 | 卖出**不成交** |
| 盘中打开的跌停 | 卖出按跌停价成交 |
| 停牌 | 跳过，不产生成交 |

### 5.3 一字板在短线候选池的处理

`short` 象限候选池**直接剔除当日一字涨停**（design.md §6.2）：
打分再高也买不到，纳入只会产生无法执行的指令单 —— 这是 P6「诚实的失败」在数据层的体现。

---

## 6. 数据质量检查清单

### 6.1 拉取后立即校验（`market.js` 内部）

- [ ] HTTP 200 且 `rc === 0`（东财业务码）
- [ ] `data` 非 `null`；`klines` 长度 > 0
- [ ] bar 数 ≥ 策略最小要求（`minBars`），否则 `ERR-DATA-002`
- [ ] 日期**严格升序**、无重复日期
- [ ] `high ≥ max(open, close)` 且 `low ≤ min(open, close)`（OHLC 自洽）
- [ ] `low > 0`、`volume ≥ 0`、`amount ≥ 0`
- [ ] 单日 `|涨跌幅| > 板块限制 + 0.5%` → 标记异常（可能除权未处理或数据错误）
- [ ] 相邻 bar 价格跳变 > 60% 且非除权日 → 标记可疑（复权因子异常）
- [ ] 最后一根 bar 日期 = 最近交易日，否则 `stale: true`
- [ ] 分红记录 `ASSIGN_PROGRESS ∈ {实施分配, 实施完成}` 才纳入
- [ ] `PRETAX_BONUS_RMB` 已 **÷10** 转成每股
- [ ] 响应记录 `source`（含主机名）与 `asOf`

### 6.2 跨源交叉校验（计划）

| 校验 | 方法 |
| :-- | :-- |
| 收盘价 | 东财 vs 腾讯 `qt.gtimg.cn/q=sh601398`（✅ 本机实测可用）差异 > 0.5% 告警 |
| 分红 | 东财 `RPT_SHAREBONUS_DET` vs 巨潮公告文字（`IMPL_PLAN_PROFILE` 自洽校验） |
| 涨停池家数 | `getTopicZTPool.tc` vs `clist` 按 `f3 ≥ 涨停幅` 统计 |
| 资金流 | `f62` 主力净流入 vs 龙虎榜成交额占比 |

### 6.3 陈旧（stale）判定

```
lastTradingDay = 交易日历上 ≤ today 的最后一个交易日（src/calendar.js#lastTradingDayOnOrBefore）
stale = (asOf 的日期 < lastTradingDay)
      或 (盘中时段 asOf 落后当前 > 5 分钟)
```

实现说明：`market.computeStale` 已锚定真实交易日（节假日不算交易日——国庆期间 9/30 的数据
不会因为日历翻到 10/5 就被误判陈旧）；若当年年度表尚未维护（日历未覆盖），回退"最近工作日"，
只会**高估**陈旧，绝不把旧数据说成新鲜。年度维护流程见 `interface.md` §11。

后果（design.md P7）：`stale: true` + 脚注"数据截至 <asOf>，已落后 N 个交易日，指令单仅供参考"；
超过 1 个交易日仍要生成买入指令时 → `ERR-DATA-003` 直接拒绝。

### 6.4 已知坑（实测/社区共识）

| 坑 | 现象 | 处理 |
| :-- | :-- | :-- |
| `fltt` 未传 | 价格返回 9400 表示 9.40 | 固定带 `fltt=2` |
| `ulist` 与 `stock/get` 字段编号不同 | 照抄 fields 得到 `null` | 分两套常量维护 |
| `np=1` 与否改变 `diff` 结构 | 数组 vs 对象 | 两种形态都解析 |
| 停牌日无 bar | 指标窗口错位 | 按交易日历补占位 bar |
| 前复权因子随新分红**回溯变化** | 历史 `adjClose` 整体平移 | 每次全量重取，不增量拼接 |
| 分红 `PRETAX_BONUS_RMB` 是"10 派" | 股息率算大 10 倍 | 统一 ÷10 并加断言 |
| 北交所 `secid` 前缀 | 用 `1.` 取不到 | 4/8/92 开头 → `0.` |
| 指数用 `fqt=1` | 指数无复权概念，返回异常 | 指数固定 `fqt=0` |
| 收盘后当日 bar 延迟 | 15:00 立刻取可能拿不到当日 bar | 15:30 后固化，之前标 `stale` |
| 境外出口 TLS 被断 | `SSL_read: unexpected eof` | 镜像降级 + 明确 `ERR-DATA-001`（本机实测现象） |

---

## 7. 备选数据源对比

| 维度 | 东方财富（首选） | AkShare | Tushare Pro |
| :-- | :-- | :-- | :-- |
| 接入成本 | 免 Key，HTTP 直连 | 免 Key，需 `pip` 装 Python 包 | 需注册 + Token，积分制 |
| 语言 | 任意（HTTP） | Python（需跨语言桥） | 多语言 HTTP/SDK |
| 与本项目依赖策略 | ✅ **零第三方依赖**（符合 design.md §2） | ❌ 引入 Python 运行时 | ⚠️ 可 HTTP，但 Token 需保管 |
| 日线/复权 | ✅ 齐全（fqt 0/1/2） | ✅ 齐全 | ✅ 齐全（`pro_bar`） |
| 分红送配 | ✅ `RPT_SHAREBONUS_DET` | ✅ `stock_history_dividend` | ✅ `dividend` |
| 涨停池/炸板池 | ✅ `getTopicZTPool`（含封单/连板/炸板次数） | ✅ `stock_zt_pool_em`（同源封装） | ⚠️ 需积分，字段较全 |
| 实时快照 | ✅ 批量 `ulist.np` | ✅（同源） | ⚠️ 需积分 |
| 稳定性/合规 | 网页同源，**无 SLA，随时可能改字段** | 依赖上游爬虫，接口易变 | 有 SLA，商用需授权 |
| 成本 | 免费 | 免费 | 免费额度小，好用需付费 |
| 限频 | 未公开（保守 2 QPS） | 未公开（同源） | 明确按积分（如 500 次/分钟） |
| 本项目定位 | **主源** | **离线研究/对账**（不进运行时） | **可选对账源**（用户自带 Token，本地配置） |

**结论**：运行时主源仍只用东方财富（零依赖原则）；AkShare 仅作为**研究脚本**在仓库外做交叉校验；
Tushare 已作为 `dailyBars`/`dividends` 的**可选备源**接入源链（`eastmoney → tushare`，见 `interface.md` §3.1）。
Token 由用户本地环境变量提供（`KUIBU_TUSHARE_TOKEN`，兼容旧名 `TUSHARE_TOKEN`），
只用于请求体，**不得写入代码或账本、不进日志与错误消息**；未配置 Token 时备源静默跳过，不影响主源。

---

## 8. 实现状态对照（v0.2.0-dev）

| 能力 | 契约 | 状态 |
| :-- | :-- | :-- |
| `normalizeSymbol` | interface.md §3 | ✅ 已实现 + 单测（test/market.test.js） |
| `quote()` | interface.md §3 | ✅ 已实现（60s TTL 缓存；单测用 fetch 桩，不依赖外网） |
| `dailyBars()` | interface.md §3 | ✅ 已实现（klt=101；源链见下行） |
| `dividends()` | interface.md §3 | ✅ 已实现（字段映射见 §1.4；源链见下行） |
| Tushare 备源（daily + adj_factor） | interface.md §3.1 | ✅ 已实现（qfq=price×f÷最新f / hfq=price×f / none；缺因子即 ERR-DATA-001） |
| Tushare 备源（dividend） | interface.md §3.1 | ✅ 已实现（仅「实施」方案，税前 cash_div_tax，按 exDate 降序） |
| 数据源链 `sources` + `attempts` | interface.md §3.1 | ✅ 已实现（默认 eastmoney→tushare；无 Token 静默跳过；未知源 ERR-DATA-001） |
| `indexBars()` | interface.md §3 | ✅ 已实现（只走东财：Tushare 指数需 `index_daily`，未纳入契约） |
| `listStocks()`（clist 涨幅榜） | interface.md §3 | ✅ 已实现（分页 + 页间退避 + 去重） |
| 涨停池 `limitUpPool()` | interface.md §3 | ✅ 已实现（封单/连板/炸板/行业） |
| 炸板池 | 未列入 interface.md | **计划**（需先补契约） |
| 短线候选池 `buildCandidatePool` | interface.md §7.3 | ✅ 已实现（纯函数：ST/次新/市值/成交额/一字板剔除） |
| 限频/重试/镜像降级 | interface.md §3 要求 | 重试 ✅ / 页间退避 ✅ / 镜像降级待接 |
| 交易日历 | interface.md §11 | ✅ 已实现（纯函数内置年度表 2024~2027；周末+法定节假日+2024 除夕交易所休市；越界 ERR-CALENDAR-001） |

> 契约缺口（仍待补）：炸板池与昨日涨停溢价
> （情绪总闸的 `yesterdayLimitUpPremium` / `blowUpRate` 两个输入）。
> 按"契约先行"原则，需先补 `interface.md` 再实现，本文只做记录，不擅自定义字段名。
>
> 运行时注意：本机（境外出口）对 `push2ex.eastmoney.com` 间歇 TLS 中断、`push2` 亦偶发断开。
> 所有联网函数按 P6 抛 `ERR-DATA-001`：`kb_short scan` 在列表不可达时直接失败；
> 涨停池不可达时退化为「仅涨幅榜」并返回 `warnings`，绝不伪造封单/连板数据。
