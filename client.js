/**
 * kuibuequity — browser half (client plugin)
 *
 * 侧栏「跬步量化」入口 + 主区三象限驾驶舱。
 * 设计：docs/web-panel.md。挂载方式与 dsh-super-agents 同构（已验证）：
 *  - 绝不在等待客户端服务时 ctx.inject()；用 ctx.slots.inject（座位声明后才触发）
 *  - 所有宿主 API 访问都包 try/catch，面板永不向上抛错
 *  - 断网时行情区显示"行情源不可达"，账本区照常可用（诚实降级）
 */
window.__ModuleLoader__.load({
  id: "kuibuequity",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var inject = ["slots", "locale"];
    var PANEL_ID = "kuibuequity";
    var PANEL_ORDER = 27; // super-agents=26 之后
    var API = "/api/kuibuequity";

    var QUAD = {
      long: { label: "长期", hint: "股息网格 · 成本转负" },
      stable: { label: "稳定", hint: "1~5% 止盈纪律" },
      short: { label: "短线", hint: "≤5 日强制离场" },
    };
    var TABS = [
      { id: "overview", label: "总览" },
      { id: "positions", label: "持仓" },
      { id: "plan", label: "指令单" },
      { id: "check", label: "个股体检" },
      { id: "review", label: "复盘" },
    ];

    // ---------------- state controller ----------------
    function makeController() {
      var listeners = [];
      var state = {
        tab: "overview",
        loading: true,
        error: "",
        state0: null, // /state 返回
        sentiment: null, // {open, reason} 或 {error}
        planMode: "stable",
        planSymbol: "",
        planResult: null,
        planBusy: false,
        checkSymbol: "",
        checkResult: null,
        checkBusy: false,
        reviewPeriod: "week",
        reviewResult: null,
        reviewBusy: false,
        trade: { quadrant: "stable", symbol: "", side: "buy", price: "", qty: "", date: "" },
        tradeBusy: false,
        tradeReceipt: null,
        initCash: "",
      };
      return {
        state: state,
        subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
        emit: function () { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { /* ignore */ } } },
        set: function (patch) { Object.assign(state, patch); this.emit(); },
      };
    }

    function apiGet(path) {
      return fetch(path, { credentials: "same-origin" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }
    function apiPost(path, body) {
      return fetch(path, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (res) { return res.json(); });
    }

    function useTick(c) {
      var force = react.useState(0)[1];
      react.useEffect(function () { return c.subscribe(function () { force(function (n) { return n + 1; }); }); }, [c]);
    }

    // ---------------- styles（继承宿主前景色，rgba 边框适配明暗主题） ----------------
    var css = [
      ".kbWrap{padding:14px;display:flex;flex-direction:column;gap:12px;font-size:13px;max-width:1080px}",
      ".kbHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".kbTitle{font-size:16px;font-weight:700}",
      ".kbDot{width:10px;height:10px;border-radius:50%;display:inline-block}",
      ".kbDot.on{background:#2e7d32}.kbDot.off{background:#c62828}.kbDot.unknown{background:#9e9e9e}",
      ".kbTabs{display:flex;gap:4px;border-bottom:1px solid rgba(128,128,128,.3)}",
      ".kbTab{padding:6px 14px;cursor:pointer;border:none;background:transparent;font-size:13px;color:inherit;opacity:.65;border-bottom:2px solid transparent}",
      ".kbTab.active{opacity:1;border-bottom-color:currentColor;font-weight:600}",
      ".kbCard{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}",
      ".kbGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}",
      ".kbRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".kbBtn{border:1px solid rgba(128,128,128,.4);background:transparent;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:12px;color:inherit}",
      ".kbBtn:disabled{opacity:.5;cursor:default}",
      ".kbBtn.primary{border-color:currentColor;font-weight:600}",
      ".kbInput,.kbSelect{border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:5px 8px;font-size:12px;background:transparent;color:inherit;font-family:inherit}",
      ".kbInput{width:110px}",
      ".kbBar{height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;flex:1;min-width:80px}",
      ".kbBarFill{height:100%;background:#2e7d32;border-radius:3px}",
      ".kbBarFill.neg{background:#1565c0}",
      ".kbTable{width:100%;border-collapse:collapse;font-size:12px}",
      ".kbTable th,.kbTable td{border-bottom:1px solid rgba(128,128,128,.2);padding:5px 8px;text-align:left}",
      ".kbTable th{opacity:.65;font-weight:600}",
      ".kbNeg{color:#2e7d32;font-weight:700}",
      ".kbMono{font-family:ui-monospace,monospace;font-size:11px;opacity:.75}",
      ".kbErr{color:#c62828;font-size:12px}",
      ".kbMuted{opacity:.6;font-size:12px}",
      ".kbPre{white-space:pre-wrap;word-break:break-word;border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:8px;font-size:12px;font-family:ui-monospace,monospace}",
      ".kbStat{display:flex;flex-direction:column;gap:2px}",
      ".kbStatV{font-size:18px;font-weight:700}",
      ".kbStatL{font-size:11px;opacity:.6}",
      ".kbBadge{font-size:10px;padding:1px 8px;border-radius:99px;border:1px solid rgba(128,128,128,.4)}",
      ".kbBadge.stale{color:#ef6c00;border-color:#ef6c00}",
    ].join("\n");

    function fmtPct(x) { return x == null ? "—" : (x * 100).toFixed(1) + "%"; }
    function fmtMoney(x) { return x == null ? "—" : Number(x).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }

    // ---------------- 总览 ----------------
    function Overview(props) {
      var s = props.controller.state;
      var st = s.state0;
      if (!st) return h("div", { className: "kbMuted" }, "账本未初始化：先在「持仓」录入或让 AI 用 kb_account 建账。");
      var byQuad = {};
      (st.positions || []).forEach(function (p) { (byQuad[p.quadrant] = byQuad[p.quadrant] || []).push(p); });
      return h("div", { className: "kbGrid" },
        Object.keys(QUAD).map(function (q) {
          var acc = (st.accounts || []).find(function (a) { return a.quadrant === q; }) || {};
          var poss = byQuad[q] || [];
          var mv = poss.reduce(function (a, p) { return a + (p.qty || 0) * (p.costPerShare != null ? Math.max(0, p.costPerShare) : 0); }, 0);
          var negCount = poss.filter(function (p) { return p.negative; }).length;
          var progress = poss.length ? poss.reduce(function (a, p) { return a + (p.progress || 0); }, 0) / poss.length : 0;
          return h("div", { className: "kbCard", key: q },
            h("div", { className: "kbRow" },
              h("span", { style: { fontWeight: 700 } }, QUAD[q].label),
              h("span", { className: "kbMuted" }, QUAD[q].hint)
            ),
            h("div", { className: "kbRow" },
              h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, fmtMoney(acc.cash)), h("span", { className: "kbStatL" }, "现金(元)")),
              h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, poss.length), h("span", { className: "kbStatL" }, "持仓数")),
              q === "long"
                ? h("div", { className: "kbStat" }, h("span", { className: "kbStatV" + (negCount ? " kbNeg" : "") }, negCount), h("span", { className: "kbStatL" }, "成本已转负"))
                : h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, (st.contracts || []).filter(function (c) { return c.quadrant === q; }).length), h("span", { className: "kbStatL" }, "锁定契约"))
            ),
            q === "long" && poss.length
              ? h("div", { className: "kbRow" },
                  h("span", { className: "kbMuted" }, "成本转负进度"),
                  h("div", { className: "kbBar" }, h("div", { className: "kbBarFill", style: { width: Math.round(progress * 100) + "%" } })),
                  h("span", { className: "kbMono" }, fmtPct(progress)))
              : null
          );
        })
      );
    }

    // ---------------- 持仓 + 录入 ----------------
    function Positions(props) {
      var c = props.controller;
      var s = c.state;
      var st = s.state0;
      var t = s.trade;
      var setTrade = function (patch) { c.set({ trade: Object.assign({}, t, patch) }); };
      var submit = function () {
        c.set({ tradeBusy: true, tradeReceipt: null });
        apiPost(API + "/trade", {
          quadrant: t.quadrant, symbol: t.symbol.trim(), side: t.side,
          price: Number(t.price), qty: Number(t.qty), date: t.date || undefined,
        }).then(function (r) {
          c.set({ tradeBusy: false, tradeReceipt: r.ok ? { ok: true, text: "已录入：" + r.trade.symbol + " " + r.trade.side + " " + r.trade.qty + " 股 @" + r.trade.price + "，费用 " + r.trade.fee + " 元" } : { ok: false, text: (r.code || "ERR") + " " + r.message } });
          return apiGet(API + "/state");
        }).then(function (r) { if (r.ok) c.set({ state0: r }); }).catch(function (e) { c.set({ tradeBusy: false, tradeReceipt: { ok: false, text: String(e.message || e) } }); });
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { className: "kbCard" },
          h("div", { style: { fontWeight: 700 } }, "象限建账（首次使用）"),
          h("div", { className: "kbRow" },
            h("span", { className: "kbMuted" }, "为 long / stable / short 三象限各设初始资金（元），资金物理隔离："),
            Object.keys(QUAD).map(function (q) {
              return h("button", {
                key: q, className: "kbBtn",
                disabled: !(Number(s.initCash) > 0),
                onClick: function () {
                  apiPost(API + "/init", { quadrant: q, cash: Number(s.initCash), totalAsset: Number(s.initCash) })
                    .then(function (r) { c.set({ tradeReceipt: r.ok ? { ok: true, text: QUAD[q].label + " 象限已建账 " + fmtMoney(r.account.cash) + " 元" } : { ok: false, text: (r.code || "") + " " + r.message } }); return apiGet(API + "/state"); })
                    .then(function (r) { if (r.ok) c.set({ state0: r }); })
                    .catch(function (e) { c.set({ tradeReceipt: { ok: false, text: String(e.message || e) } }); });
                },
              }, QUAD[q].label + " 建账");
            }),
            h("input", { className: "kbInput", placeholder: "每象限金额", value: s.initCash, onChange: function (e) { c.set({ initCash: e.target.value }); } })
          )
        ),
        h("div", { className: "kbCard" },
          h("div", { style: { fontWeight: 700 } }, "持仓"),
          st && (st.positions || []).length
            ? h("table", { className: "kbTable" },
                h("thead", null, h("tr", null, ["象限", "代码", "数量", "均价", "有效成本", "已收分红", "进度"].map(function (x) { return h("th", { key: x }, x); }))),
                h("tbody", null, st.positions.map(function (p, i) {
                  return h("tr", { key: p.quadrant + p.symbol + i },
                    h("td", null, QUAD[p.quadrant] ? QUAD[p.quadrant].label : p.quadrant),
                    h("td", null, p.symbol),
                    h("td", null, p.qty),
                    h("td", null, fmtMoney(p.avgPrice)),
                    h("td", { className: p.negative ? "kbNeg" : "" }, p.negative ? "负成本 " + fmtMoney(p.costPerShare) : fmtMoney(p.costPerShare)),
                    h("td", null, fmtMoney(p.dividends)),
                    h("td", null, h("div", { className: "kbRow", style: { gap: 4 } }, h("div", { className: "kbBar" }, h("div", { className: "kbBarFill", style: { width: Math.round((p.progress || 0) * 100) + "%" } })), h("span", { className: "kbMono" }, fmtPct(p.progress))))
                  );
                })))
            : h("div", { className: "kbMuted" }, "暂无持仓"),
          h("div", { className: "kbMuted" }, "有效成本 = (总买入+费用 − 总卖出+费用 − 分红) / 持股数；≤0 即成本转负（任何价格卖出都是纯赚）")
        ),
        h("div", { className: "kbCard" },
          h("div", { style: { fontWeight: 700 } }, "录入成交（本地账本，不接券商）"),
          h("div", { className: "kbRow" },
            h("select", { className: "kbSelect", value: t.quadrant, onChange: function (e) { setTrade({ quadrant: e.target.value }); } },
              Object.keys(QUAD).map(function (q) { return h("option", { key: q, value: q }, QUAD[q].label); })),
            h("input", { className: "kbInput", placeholder: "代码 601398", value: t.symbol, onChange: function (e) { setTrade({ symbol: e.target.value }); } }),
            h("select", { className: "kbSelect", value: t.side, onChange: function (e) { setTrade({ side: e.target.value }); } },
              h("option", { value: "buy" }, "买入"), h("option", { value: "sell" }, "卖出")),
            h("input", { className: "kbInput", placeholder: "价格", value: t.price, onChange: function (e) { setTrade({ price: e.target.value }); } }),
            h("input", { className: "kbInput", placeholder: "数量(股)", value: t.qty, onChange: function (e) { setTrade({ qty: e.target.value }); } }),
            h("input", { className: "kbInput", placeholder: "日期(空=今天)", value: t.date, onChange: function (e) { setTrade({ date: e.target.value }); } }),
            h("button", { className: "kbBtn primary", disabled: s.tradeBusy || !t.symbol || !(Number(t.price) > 0) || !(Number(t.qty) > 0), onClick: submit }, "录入")
          ),
          s.tradeReceipt ? h("div", { className: s.tradeReceipt.ok ? "kbMuted" : "kbErr" }, s.tradeReceipt.text) : null
        )
      );
    }

    // ---------------- 指令单 ----------------
    function PlanTab(props) {
      var c = props.controller;
      var s = c.state;
      var gen = function () {
        c.set({ planBusy: true, planResult: null });
        apiPost(API + "/plan", { mode: s.planMode, symbol: s.planSymbol.trim() })
          .then(function (r) { c.set({ planBusy: false, planResult: r }); })
          .catch(function (e) { c.set({ planBusy: false, planResult: { ok: false, code: "ERR-NET", message: String(e.message || e) } }); });
      };
      var exportCsv = function () {
        var co = (s.planResult && s.planResult.conditionOrders) || [];
        if (!co.length) return;
        var lines = ["symbol,side,triggerPrice,orderPrice,qty,validUntil"];
        co.forEach(function (o) { lines.push([o.symbol, o.side, o.triggerPrice ?? "", o.orderPrice ?? "", o.qty, o.validUntil ?? ""].join(",")); });
        var blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "kuibuequity-condition-orders.csv";
        a.click();
        URL.revokeObjectURL(a.href);
      };
      var r = s.planResult;
      return h("div", { className: "kbCard" },
        h("div", { style: { fontWeight: 700 } }, "生成次日指令单（收盘确认、次日执行）"),
        h("div", { className: "kbRow" },
          h("select", { className: "kbSelect", value: s.planMode, onChange: function (e) { c.set({ planMode: e.target.value }); } },
            Object.keys(QUAD).map(function (q) { return h("option", { key: q, value: q }, QUAD[q].label); })),
          h("input", { className: "kbInput", placeholder: "代码", value: s.planSymbol, onChange: function (e) { c.set({ planSymbol: e.target.value }); } }),
          h("button", { className: "kbBtn primary", disabled: s.planBusy || !s.planSymbol.trim(), onClick: gen }, s.planBusy ? "生成中…" : "生成"),
          r && r.ok && r.conditionOrders && r.conditionOrders.length ? h("button", { className: "kbBtn", onClick: exportCsv }, "导出条件单 CSV") : null
        ),
        r && !r.ok ? h("div", { className: "kbErr" }, (r.code || "") + " " + (r.message || "")) : null,
        r && r.ok && r.plan
          ? h("div", null,
              h("div", { className: "kbRow" },
                h("span", { className: "kbMono" }, "as_of " + (r.asOf || "")),
                r.stale ? h("span", { className: "kbBadge stale" }, "数据陈旧") : null),
              r.plan.orders.length
                ? h("table", { className: "kbTable" },
                    h("thead", null, h("tr", null, ["方向", "代码", "数量", "委托价", "依据"].map(function (x) { return h("th", { key: x }, x); }))),
                    h("tbody", null, r.plan.orders.map(function (o, i) {
                      return h("tr", { key: i },
                        h("td", null, o.side === "buy" ? "买入" : "卖出"),
                        h("td", null, o.symbol), h("td", null, o.qty), h("td", null, o.price ?? "市价"),
                        h("td", { className: "kbMono" }, o.note || ""));
                    })))
                : h("div", { className: "kbMuted" }, "今日无指令（条件未触发或空仓等待）"),
              (r.plan.rejected || []).length
                ? h("div", { style: { marginTop: 8 } }, h("div", { className: "kbMuted" }, "被挡下（留痕）："),
                    r.plan.rejected.map(function (x, i) { return h("div", { key: i, className: "kbErr" }, "· " + (x.symbol || "") + " [" + x.rule + "] " + x.reason); }))
                : null)
          : null
      );
    }

    // ---------------- 个股体检 ----------------
    function CheckTab(props) {
      var c = props.controller;
      var s = c.state;
      var run = function () {
        c.set({ checkBusy: true, checkResult: null });
        apiPost(API + "/check", { symbol: s.checkSymbol.trim() })
          .then(function (r) { c.set({ checkBusy: false, checkResult: r }); })
          .catch(function (e) { c.set({ checkBusy: false, checkResult: { ok: false, code: "ERR-NET", message: String(e.message || e) } }); });
      };
      var r = s.checkResult;
      return h("div", { className: "kbCard" },
        h("div", { style: { fontWeight: 700 } }, "持仓体检（止盈/止损/时间到期 · 条件单参数）"),
        h("div", { className: "kbRow" },
          h("input", { className: "kbInput", placeholder: "代码", value: s.checkSymbol, onChange: function (e) { c.set({ checkSymbol: e.target.value }); } }),
          h("button", { className: "kbBtn primary", disabled: s.checkBusy || !s.checkSymbol.trim(), onClick: run }, s.checkBusy ? "体检中…" : "体检")),
        r && !r.ok ? h("div", { className: "kbErr" }, (r.code || "") + " " + (r.message || "")) : null,
        r && r.ok
          ? h("div", null,
              h("div", { className: "kbRow" },
                h("span", { className: "kbStatV" }, r.action === "hold" ? "持有" : r.action === "take_profit" ? "止盈" : r.action === "stop_loss" ? "止损" : r.action === "time_exit" ? "时间到期" : r.action),
                h("span", { className: "kbMono" }, r.hitRule || ""),
                h("span", { className: "kbMono" }, "as_of " + (r.asOf || "")),
                r.stale ? h("span", { className: "kbBadge stale" }, "数据陈旧") : null),
              h("div", { style: { marginTop: 6 } }, r.detail || ""),
              r.conditionOrders && r.conditionOrders.length
                ? h("div", { style: { marginTop: 8 } }, h("div", { className: "kbMuted" }, "券商条件单（一次挂好，盘中不决策）："),
                    h("table", { className: "kbTable" },
                      h("thead", null, h("tr", null, ["类型", "触发价", "数量"].map(function (x) { return h("th", { key: x }, x); }))),
                      h("tbody", null, r.conditionOrders.map(function (o, i) {
                        return h("tr", { key: i }, h("td", null, o.type === "take_profit" ? "止盈" : "止损"), h("td", null, o.triggerPrice), h("td", null, o.qty ?? "全部"));
                      }))))
                : null)
          : null
      );
    }

    // ---------------- 复盘 ----------------
    function ReviewTab(props) {
      var c = props.controller;
      var s = c.state;
      var run = function () {
        c.set({ reviewBusy: true, reviewResult: null });
        apiGet(API + "/review?period=" + s.reviewPeriod)
          .then(function (r) { c.set({ reviewBusy: false, reviewResult: r }); })
          .catch(function (e) { c.set({ reviewBusy: false, reviewResult: { ok: false, message: String(e.message || e) } }); });
      };
      var r = s.reviewResult;
      return h("div", { className: "kbCard" },
        h("div", { style: { fontWeight: 700 } }, "复盘（胜率 vs 盈亏比要求 · override 清单）"),
        h("div", { className: "kbRow" },
          h("select", { className: "kbSelect", value: s.reviewPeriod, onChange: function (e) { c.set({ reviewPeriod: e.target.value }); } },
            h("option", { value: "week" }, "近一周"), h("option", { value: "month" }, "近一月"), h("option", { value: "all" }, "全部")),
          h("button", { className: "kbBtn primary", disabled: s.reviewBusy, onClick: run }, "统计")),
        r && r.ok
          ? h("div", { className: "kbRow", style: { marginTop: 8 } },
              h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, r.trades), h("span", { className: "kbStatL" }, "成交笔数")),
              h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, fmtPct(r.winRate)), h("span", { className: "kbStatL" }, "胜率")),
              h("div", { className: "kbStat" }, h("span", { className: "kbStatV" }, r.payoffRatio != null ? r.payoffRatio.toFixed(2) : "—"), h("span", { className: "kbStatL" }, "盈亏比")),
              h("div", { style: { flexBasis: "100%" }, className: "kbMuted" }, r.disciplineNote))
          : r && !r.ok ? h("div", { className: "kbErr" }, r.message) : null
      );
    }

    // ---------------- 面板主体 ----------------
    function PanelView(props) {
      var c = props.controller;
      var s = c.state;
      useTick(c);

      var refresh = react.useCallback(function () {
        apiGet(API + "/state").then(function (r) { c.set({ state0: r.ok ? r : null, error: r.ok ? "" : (r.code + " " + r.message), loading: false }); }).catch(function (e) { c.set({ error: String(e.message || e), loading: false }); });
        apiGet(API + "/sentiment").then(function (r) { c.set({ sentiment: r.ok ? r : { open: null, reason: r.message } }); }).catch(function () { c.set({ sentiment: { open: null, reason: "行情源不可达" } }); });
      }, [c]);

      react.useEffect(function () { refresh(); var id = setInterval(refresh, 30000); return function () { clearInterval(id); }; }, [refresh]);

      var sent = s.sentiment;
      var dotClass = !sent ? "unknown" : sent.open === true ? "on" : sent.open === false ? "off" : "unknown";
      var st = s.state0;

      return h("div", { className: "kbWrap" },
        h("style", null, css),
        h("div", { className: "kbHead" },
          h("span", { className: "kbTitle" }, "跬步量化"),
          h("span", { className: "kbRow", style: { gap: 4 } }, h("span", { className: "kbDot " + dotClass }), h("span", { className: "kbMuted" }, sent ? (sent.open === true ? "情绪正常" : sent.open === false ? "情绪退潮·短线停" : sent.reason) : "情绪检测中")),
          st ? h("span", { className: "kbMono" }, "账本 " + String(st.asOf || "").slice(0, 16).replace("T", " ")) : null,
          h("span", { style: { flex: 1 } }),
          h("button", { className: "kbBtn", onClick: refresh }, "刷新")
        ),
        s.error ? h("div", { className: "kbErr" }, s.error) : null,
        h("div", { className: "kbTabs" }, TABS.map(function (t) {
          return h("button", { key: t.id, className: "kbTab" + (s.tab === t.id ? " active" : ""), onClick: function () { c.set({ tab: t.id }); } }, t.label);
        })),
        s.loading && !st
          ? h("div", { className: "kbMuted" }, "加载中…")
          : s.tab === "overview" ? h(Overview, { controller: c })
          : s.tab === "positions" ? h(Positions, { controller: c })
          : s.tab === "plan" ? h(PlanTab, { controller: c })
          : s.tab === "check" ? h(CheckTab, { controller: c })
          : h(ReviewTab, { controller: c }),
        h("div", { className: "kbMuted", style: { marginTop: 8 } }, "三象限纪律执行器：只读行情 + 本地账本 + 人工下单，不接券商。本面板不构成投资建议。")
      );
    }

    // ---------------- 侧栏图标 ----------------
    function SidebarIcon(props) {
      var size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M3 20h18" }),
        h("path", { d: "M5 20v-6" }), h("path", { d: "M9.5 20v-9" }), h("path", { d: "M14 20v-4" }), h("path", { d: "M18.5 20v-12" }),
        h("path", { d: "M5 11l4.5-3 4.5 2 4.5-5" })
      );
    }

    function slotDeclared(ctx, name) {
      try {
        var slots = ctx && ctx.slots;
        if (!slots) return false;
        if (typeof slots.specDynamic === "function") return !!slots.specDynamic(name);
        if (typeof slots.spec === "function") return !!slots.spec(name);
      } catch (e) { /* treat as undeclared */ }
      return false;
    }

    function MainPanelPage(props) {
      useTick(props.controller);
      return h(PanelView, { controller: props.controller });
    }

    function apply(ctx) {
      var controller = makeController();
      var disposers = [];
      if (ctx && ctx.slots && typeof ctx.slots.inject === "function" && slotDeclared(ctx, "sidebar.panellist") && slotDeclared(ctx, "main")) {
        try {
          disposers.push(ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: PANEL_ID,
              inject: function () { return { controller: controller }; },
            }, MainPanelPage);
          }));
          disposers.push(ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: function () { return "跬步量化"; },
            }, SidebarIcon);
          }));
        } catch (err) {
          console.warn("[kuibuequity] panel seat failed:", err);
        }
      }
      return function () {
        for (var i = 0; i < disposers.length; i++) { try { disposers[i](); } catch (e) { /* ignore */ } }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
