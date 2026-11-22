/**
 * kuibuequity（跬步量化）— DSH 插件入口
 *
 * 定位（docs/design.md §0）：纪律执行器，不是预测器。三象限（long/stable/short）
 * 各配一套事前写死的规则；插件只计算、生成指令单、盯红线，下单由人完成（P1 只读+模拟+人工执行）。
 *
 * 形态：函数形态插件（name/inject/Config/apply），全部能力注册为 kb_* Tool。
 * 防御：strategies/backtest/ledger/plan 由并行开发，统一动态 import；
 *       模块缺失时工具返回明确 ERR-MODULE-001，index.js 本身始终可独立加载。
 */
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { quote, dailyBars, dividends, indexBars } from './src/market.js';
import { RED_LINES, gate, expectancyCheck, sentimentGate, hardExitCheck } from './src/risk.js';
import { resolveFee, tradeFee } from './src/costs.js';
import { winRate, payoffRatio, maxDrawdown } from './src/indicators.js';
import { registerWebRoutes } from './src/webapi.js';

const name = 'kuibuequity';
const inject = ['tools', 'systemPrompt'];

// 默认值与 cordis.patch.yml 对齐
// 注意：本机 schemastery 无 z.enum，枚举类字段用 string 声明、运行时校验取值
const Config = z.object({
  dataDir: z.string().default(''),
  adjust: z.string().default('qfq'),
  httpTimeoutMs: z.number().default(10000),
  commissionRate: z.number().default(0.00025),
  commissionMin: z.number().default(5),
  stampTaxRate: z.number().default(0.0005),
  slippageBps: z.number().default(0),
  quadrantSplit: z
    .object({
      long: z.number().default(0.6),
      stable: z.number().default(0.3),
      short: z.number().default(0.1),
    })
    .default({ long: 0.6, stable: 0.3, short: 0.1 }),
  allowLanState: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  },
};

function json(value) {
  return JSON.stringify(value, null, 2);
}

/** 从异常提取 {code,message}：'ERR-XXX-NNN: xxx' 前缀优先，其余归 ERR-INTERNAL */
function toErr(e) {
  const msg = String((e && e.message) || e || 'unknown error');
  const m = msg.match(/^(ERR-[A-Z]+-\d{3}):\s*(.*)$/s);
  if (m) return { ok: false, code: m[1], message: m[2] };
  return { ok: false, code: 'ERR-INTERNAL', message: msg };
}

/** 动态加载并行开发中的模块；失败返回 null（调用方给 ERR-MODULE-001） */
const moduleCache = new Map();
async function tryImport(spec) {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  let mod = null;
  try {
    mod = await import(spec);
  } catch {
    mod = null;
  }
  moduleCache.set(spec, mod);
  return mod;
}

function moduleMissing(label, spec) {
  return {
    ok: false,
    code: 'ERR-MODULE-001',
    message: `${label} 模块尚未实现或加载失败（${spec}）。该模块由并行开发提供，就绪后重启插件即可。`,
  };
}

function resolveDataDir(config) {
  const raw = config?.dataDir && String(config.dataDir).trim();
  if (raw) return path.resolve(raw);
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '/tmp', '.dsh');
  return path.join(home, 'kuibuequity');
}

const DISCLAIMER = '本输出为个人研究与纪律辅助工具结果，不构成任何投资建议；股市有风险，盈亏自负。';

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const resolved = config || {};
  const dataDir = resolveDataDir(resolved);
  const fee = resolveFee({
    commissionRate: resolved.commissionRate,
    commissionMin: resolved.commissionMin,
    stampTaxRate: resolved.stampTaxRate,
    slippageBps: resolved.slippageBps,
  });
  const timeoutMs = Number(resolved.httpTimeoutMs) || 10000;
  const adjust = ['qfq', 'hfq', 'none'].includes(resolved.adjust) ? resolved.adjust : 'qfq';

  // ---- kb_market：行情（实时快照 / 日K / 分红送配 / 指数） ----
  ctx.tools.register(defineTool({
    name: 'kb_market',
    description:
      '跬步量化·行情层（东方财富免 Key，只读）。action=quote 实时快照（含涨跌停价/停牌/陈旧标记）；bars 日K（默认前复权 250 根）；dividends 分红送配历史；index 指数收盘序列（默认沪深300）。所有输出带 asOf 与 stale 标记。',
    parameters: {
      action: { type: 'string', required: true, enum: ['quote', 'bars', 'dividends', 'index'], description: '操作' },
      symbol: { type: 'string', description: '证券代码：600036 / sh600036 / 600036.SH；action=index 时默认 000300' },
      days: { type: 'integer', description: 'bars/index 的 K 线根数，默认 250（index 默认 60）' },
      adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权口径，默认取插件配置（qfq）' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const { action, symbol } = args;
        if (action === 'quote') {
          if (!symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: 'quote 需要 symbol' };
          const q = await quote(symbol, { timeoutMs });
          return { ok: true, ...q, footnotes: [DISCLAIMER] };
        }
        if (action === 'bars') {
          if (!symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: 'bars 需要 symbol' };
          const res = await dailyBars(symbol, { days: args.days || 250, adjust: args.adjust || adjust, timeoutMs });
          return { ok: true, ...res, footnotes: [DISCLAIMER] };
        }
        if (action === 'dividends') {
          if (!symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: 'dividends 需要 symbol' };
          const res = await dividends(symbol, { timeoutMs });
          return { ok: true, ...res, footnotes: [DISCLAIMER] };
        }
        if (action === 'index') {
          const res = await indexBars(args.symbol || '000300', { days: args.days || 60, timeoutMs });
          return { ok: true, ...res, footnotes: [DISCLAIMER] };
        }
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_account：象限账户与持仓 ----
  ctx.tools.register(defineTool({
    name: 'kb_account',
    description:
      '跬步量化·象限账本（long/stable/short 资金物理隔离）。action=status 三象限现金与持仓；init 建账（quadrant/cash/totalAsset）；trade 录入成交（symbol/side/price/qty，费用自动按插件费率算；stable 买入会自动生成并锁定止盈/止损/期限契约，t/s/D 取自 adaptiveTarget，与成交原子落库）；transfer 跨象限调拨（必须 reason，写审计）；contracts 查事前契约。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'init', 'trade', 'transfer', 'contracts'], description: '操作' },
      quadrant: { type: 'string', enum: ['long', 'stable', 'short'], description: '象限' },
      symbol: { type: 'string', description: 'trade 必填' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'trade 必填' },
      price: { type: 'number', description: '成交价（元/股）' },
      qty: { type: 'integer', description: '成交数量（股）' },
      fee: { type: 'number', description: '手续费（元）；留空按插件费率自动计算' },
      date: { type: 'string', description: '成交日期 YYYY-MM-DD，默认今天' },
      days: { type: 'integer', description: 'trade：stable 买入生成契约时取用的日K根数，默认 250' },
      cash: { type: 'number', description: 'init：初始现金' },
      totalAsset: { type: 'number', description: 'init：象限总资产' },
      amount: { type: 'number', description: 'transfer：调拨金额（元）' },
      to: { type: 'string', enum: ['long', 'stable', 'short'], description: 'transfer：目标象限' },
      reason: { type: 'string', description: 'transfer 必填理由（写审计）' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const ledgerMod = await tryImport('./src/ledger.js');
        if (!ledgerMod || typeof ledgerMod.makeLedger !== 'function') return moduleMissing('账本', './src/ledger.js');
        const ledger = ledgerMod.makeLedger(dataDir);
        const { action } = args;
        if (action === 'status') {
          return { ok: true, accounts: ledger.accounts(), positions: ledger.positions(), fee, asOf: new Date().toISOString() };
        }
        if (action === 'init') {
          if (!args.quadrant) return { ok: false, code: 'ERR-INTERNAL', message: 'init 需要 quadrant' };
          const q = ledger.initAccount({ quadrant: args.quadrant, cash: args.cash || 0, totalAsset: args.totalAsset });
          return { ok: true, account: q };
        }
        if (action === 'trade') {
          const { quadrant, symbol, side, price, qty } = args;
          if (!quadrant || !symbol || !side || !(price > 0) || !(qty > 0)) {
            return { ok: false, code: 'ERR-INTERNAL', message: 'trade 需要 quadrant/symbol/side/price/qty' };
          }
          const autoFee = args.fee != null ? args.fee : tradeFee({ side, price, qty, fee });
          // 稳定象限买入：自动生成锁定契约（t/s/D 来自 adaptiveTarget），与成交同一次 save()
          let contractDraft = null;
          let warning = null;
          if (quadrant === 'stable' && side === 'buy') {
            const strat = await tryImport('./src/strategies/index.js');
            const stable = strat && strat.registry && strat.registry.stable;
            if (stable && typeof stable.buildLockedContract === 'function') {
              try {
                const barsRes = await dailyBars(symbol, { days: args.days || 250, adjust, timeoutMs });
                contractDraft = stable.buildLockedContract({
                  bars: barsRes.bars,
                  symbol,
                  entry: { price, qty, date: args.date },
                  config: {},
                });
              } catch (e) {
                const err = toErr(e);
                // P6 诚实的失败：拿不到波动率就不编造 t/s，成交照记但明确告知契约缺失
                warning = {
                  code: err.code,
                  message: `行情/ATR 不可用，未能按 adaptiveTarget 锁定建仓契约（不编造 t/s）：${err.message}。成交已记账，恢复数据后请用 kb_stable action=contract 补建契约。`,
                };
              }
            } else {
              warning = { code: 'ERR-MODULE-001', message: '稳定策略模块不可用，未能生成建仓契约' };
            }
          }
          const t = ledger.recordTrade({ quadrant, symbol, side, price, qty, fee: autoFee, date: args.date, note: args.reason || '', contract: contractDraft });
          const persisted = t.contractId ? (ledger.contracts() || []).find((c) => c.id === t.contractId) || null : null;
          const out = { ok: true, trade: t };
          if (persisted) {
            out.contract = {
              id: persisted.id,
              takeProfitPct: persisted.takeProfitPct,
              stopLossPct: persisted.stopLossPct,
              maxHoldDays: persisted.maxHoldDays,
              entry: persisted.entry,
              locked: persisted.locked,
              source: persisted.source ?? null,
            };
          }
          if (warning) out.warning = warning;
          return out;
        }
        if (action === 'transfer') {
          if (!args.quadrant || !args.to || !(args.amount > 0) || !args.reason) {
            return { ok: false, code: 'ERR-INTERNAL', message: 'transfer 需要 quadrant/to/amount/reason（跨象限调拨必须留痕）' };
          }
          return { ok: true, transfer: ledger.transfer({ from: args.quadrant, to: args.to, amount: args.amount, reason: args.reason }) };
        }
        if (action === 'contracts') return { ok: true, contracts: ledger.contracts() };
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_longterm：长期象限（股息网格 · 成本转负） ----
  ctx.tools.register(defineTool({
    name: 'kb_longterm',
    description:
      '跬步量化·长期象限：高股息底仓+网格摊薄，目标把持仓成本做成负数。action=grid 生成网格参数（基准价/步长/上下格/每格量）；dilution 成本转负 ETA 与分红摊薄模拟；plan 生成次日网格指令单。',
    parameters: {
      action: { type: 'string', required: true, enum: ['grid', 'dilution', 'plan'], description: '操作' },
      symbol: { type: 'string', required: true, description: '标的代码' },
      budget: { type: 'number', description: 'grid：活动仓预算（元），默认按象限现金×quadrantSplit' },
      days: { type: 'integer', description: '取用的日K根数，默认 250' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const strat = await tryImport('./src/strategies/index.js');
        if (!strat || !strat.registry || !strat.registry.long) return moduleMissing('长期策略', './src/strategies/index.js');
        const long = strat.registry.long;
        if (!args.symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: '需要 symbol' };
        const barsRes = await dailyBars(args.symbol, { days: args.days || 250, adjust, timeoutMs });
        const bars = barsRes.bars;
        if (args.action === 'grid') {
          if (typeof long.gridPlan !== 'function') return moduleMissing('gridPlan', './src/strategies/longTerm.js');
          const plan = long.gridPlan({ bars, budget: args.budget, config: {} });
          return { ok: true, symbol: barsRes.symbol, asOf: barsRes.asOf, stale: barsRes.stale, ...plan, footnotes: [DISCLAIMER] };
        }
        if (args.action === 'dilution') {
          if (typeof long.dilutionReport !== 'function') return moduleMissing('dilutionReport', './src/strategies/longTerm.js');
          const div = await dividends(args.symbol, { timeoutMs }).catch(() => ({ items: [] }));
          const ledgerMod = await tryImport('./src/ledger.js');
          const lots = ledgerMod && ledgerMod.makeLedger ? ledgerMod.makeLedger(dataDir).trades('long').filter((t) => t.symbol === args.symbol) : [];
          const rep = long.dilutionReport({ bars, dividends: div.items, lots, config: {} });
          return { ok: true, symbol: barsRes.symbol, asOf: barsRes.asOf, ...rep, footnotes: [DISCLAIMER] };
        }
        if (args.action === 'plan') {
          if (typeof long.evaluate !== 'function') return moduleMissing('long.evaluate', './src/strategies/longTerm.js');
          const res = long.evaluate({ bars, position: null, account: null, config: {}, indexBars: null, stats: null });
          return { ok: true, symbol: barsRes.symbol, asOf: barsRes.asOf, stale: barsRes.stale, ...res, footnotes: [DISCLAIMER] };
        }
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${args.action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_stable：稳定象限（1~5% 止盈纪律） ----
  ctx.tools.register(defineTool({
    name: 'kb_stable',
    description:
      '跬步量化·稳定象限：赚 1%~5% 就走的反人性纪律。action=contract 建仓契约（止盈/止损/期限锁定，override 需理由）；check 持仓体检（是否触发止盈/止损/时间止损，输出条件单参数）；expectancy 期望值自检（胜率不足会直接劝阻）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['contract', 'check', 'expectancy'], description: '操作' },
      symbol: { type: 'string', description: '标的代码（contract/check 必填）' },
      targetPct: { type: 'number', description: '止盈目标（百分数，如 3 表示 3%）；留空按 ATR 自适应' },
      days: { type: 'integer', description: '取用的日K根数，默认 250' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const strat = await tryImport('./src/strategies/index.js');
        if (!strat || !strat.registry || !strat.registry.stable) return moduleMissing('稳定策略', './src/strategies/index.js');
        const stable = strat.registry.stable;
        if (args.action === 'expectancy') {
          const ledgerMod = await tryImport('./src/ledger.js');
          const trades = ledgerMod && ledgerMod.makeLedger ? ledgerMod.makeLedger(dataDir).trades('stable') : [];
          return { ok: true, ...expectancyCheck({ trades, payoffRatio: 1.25 }), footnotes: [DISCLAIMER] };
        }
        if (!args.symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: '需要 symbol' };
        const barsRes = await dailyBars(args.symbol, { days: args.days || 250, adjust, timeoutMs });
        if (args.action === 'contract') {
          if (typeof stable.adaptiveTarget !== 'function') return moduleMissing('adaptiveTarget', './src/strategies/stable.js');
          const cfg = args.targetPct ? { targetPct: args.targetPct / 100 } : {};
          const t = stable.adaptiveTarget({ bars: barsRes.bars, config: cfg });
          // 落库联动：已有 stable 持仓但尚无契约（如建仓时行情不可用）→ 此时补建并锁定
          let persisted = null;
          let alreadyLocked = null;
          const ledgerMod = await tryImport('./src/ledger.js');
          if (ledgerMod && typeof ledgerMod.makeLedger === 'function' && typeof stable.buildLockedContract === 'function') {
            const ledger = ledgerMod.makeLedger(dataDir);
            const pos = (ledger.positions('stable') || []).find((p) => p.symbol === args.symbol) || null;
            const existing = pos?.contractId ? (ledger.contracts() || []).find((c) => c.id === pos.contractId) || null : null;
            if (pos && !existing) {
              persisted = ledger.addContract(
                stable.buildLockedContract({
                  bars: barsRes.bars,
                  symbol: args.symbol,
                  entry: { price: pos.avgPrice, qty: pos.qty, date: pos.openDate },
                  config: cfg,
                }),
              );
            } else if (existing) {
              alreadyLocked = existing;
            }
          }
          return {
            ok: true,
            symbol: args.symbol,
            asOf: barsRes.asOf,
            contract: persisted ?? alreadyLocked ?? t,
            persisted: Boolean(persisted),
            note: persisted
              ? '已为既有持仓补建并锁定契约（t/s/D 来自 adaptiveTarget）；修改需 override+reason'
              : alreadyLocked
                ? '该持仓已有锁定契约，未重复创建；修改需 override+reason（写审计）'
                : '参数预览：录入 stable 买入成交（kb_account action=trade）时会自动锁定契约',
            footnotes: [DISCLAIMER],
          };
        }
        if (args.action === 'check') {
          if (typeof stable.checkPosition !== 'function') return moduleMissing('checkPosition', './src/strategies/stable.js');
          const ledgerMod = await tryImport('./src/ledger.js');
          let contract = null;
          let position = null;
          if (ledgerMod && ledgerMod.makeLedger) {
            const ledger = ledgerMod.makeLedger(dataDir);
            contract = (ledger.contracts() || []).find((c) => c.symbol === args.symbol) || null;
            position = (ledger.positions('stable') || []).find((p) => p.symbol === args.symbol) || null;
          }
          const res = stable.checkPosition({ bars: barsRes.bars, contract, position });
          return { ok: true, symbol: args.symbol, asOf: barsRes.asOf, ...res, footnotes: [DISCLAIMER] };
        }
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${args.action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_short：短线象限（次日强势 · ≤5 日强制离场） ----
  ctx.tools.register(defineTool({
    name: 'kb_short',
    description:
      '跬步量化·短线象限：情绪冰点总闸优先，个股打分其次，5 日强制离场不可 override。action=sentiment 情绪总闸状态；scan 候选池打分（收盘后跑）；exit 持仓离场提醒（含 5 日硬期限倒计时）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['sentiment', 'scan', 'exit'], description: '操作' },
      symbols: { type: 'string', description: 'scan：逗号分隔的候选代码；留空则只输出总闸状态' },
      topN: { type: 'integer', description: 'scan：返回前 N 名，默认 10' },
      symbol: { type: 'string', description: 'exit：持仓标的' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        if (args.action === 'sentiment') {
          const idx = await indexBars('000300', { days: 10, timeoutMs });
          const closes = idx.bars.map((b) => b.close);
          const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length);
          const g = sentimentGate({ indexAboveMa5: closes[closes.length - 1] >= ma5 });
          return { ok: true, index: { symbol: idx.symbol, asOf: idx.asOf, close: closes[closes.length - 1], ma5: Math.round(ma5 * 100) / 100 }, ...g, footnotes: [DISCLAIMER] };
        }
        const strat = await tryImport('./src/strategies/index.js');
        if (!strat || !strat.registry || !strat.registry.short) return moduleMissing('短线策略', './src/strategies/index.js');
        const short = strat.registry.short;
        if (args.action === 'scan') {
          if (typeof short.scoreCandidates !== 'function') return moduleMissing('scoreCandidates', './src/strategies/shortTerm.js');
          if (!args.symbols) return { ok: false, code: 'ERR-INTERNAL', message: 'scan 需要 symbols（逗号分隔候选池；本插件不自动拉全市场列表）' };
          const list = String(args.symbols).split(/[,，\s]+/).filter(Boolean);
          const candidates = [];
          for (const s of list) {
            try {
              const q = await quote(s, { timeoutMs });
              const barsRes = await dailyBars(s, { days: 60, adjust, timeoutMs });
              const bars = barsRes.bars;
              const last = bars[bars.length - 1] || {};
              const closes = bars.map((b) => b.adjClose ?? b.close);
              const vols = bars.map((b) => b.volume);
              const volMa5 = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
              candidates.push({
                symbol: q.symbol, name: q.name,
                gainPct: q.changePct != null ? q.changePct / 100 : (closes.length > 1 ? closes.at(-1) / closes.at(-2) - 1 : 0),
                turnover: q.turnoverRate ?? 0,
                volumeRatio: volMa5 > 0 ? (q.volume ?? last.volume ?? 0) / volMa5 : 1,
                limitUp: q.limitUp != null && q.price >= q.limitUp - 1e-9,
                blown: false, firstLimitTime: null, boards: 1,
                floatCap: q.floatCap ?? 1e10, st: /ST/i.test(q.name || ''),
                oneWordBoard: false, sealAmount: 0, mainNetInflow: 0,
                amount: q.amount ?? last.amount ?? 0,
                amount20Avg: bars.slice(-20).reduce((a, b) => a + (b.amount || 0), 0) / Math.max(1, Math.min(20, bars.length)),
                listDays: bars.length, sectorLimitUps: 0,
              });
            } catch { /* 单票行情失败：跳过该票，不拖垮整池（P6：不伪造成交） */ }
          }
          const idx = await indexBars('000300', { days: 60, timeoutMs });
          const idxCloses = idx.bars.map((b) => b.adjClose ?? b.close);
          const ma5 = idxCloses.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, idxCloses.length);
          const market = { indexAboveMa5: idxCloses.at(-1) >= ma5, yesterdayLimitUpPremium: null, blowUpRate: null };
          const ranked = short.scoreCandidates({ candidates, market, config: {}, topN: args.topN || 10 });
          return { ok: true, sentimentOpen: ranked.open, sentimentReason: ranked.reason, candidates: ranked.candidates, asOf: idx.asOf, footnotes: [DISCLAIMER] };
        }
        if (args.action === 'exit') {
          if (!args.symbol) return { ok: false, code: 'ERR-SYMBOL-001', message: 'exit 需要 symbol' };
          const ledgerMod = await tryImport('./src/ledger.js');
          let position = null;
          if (ledgerMod && ledgerMod.makeLedger) {
            position = (ledgerMod.makeLedger(dataDir).positions('short') || []).find((p) => p.symbol === args.symbol) || null;
          }
          const barsRes = await dailyBars(args.symbol, { days: 30, adjust, timeoutMs });
          const hard = hardExitCheck({ openDate: position?.openDate, asOf: barsRes.asOf });
          let res = { action: 'hold', mustExit: hard.mustExit, deadline: null, reason: hard.note };
          if (typeof short.exitPlan === 'function') {
            res = { ...short.exitPlan({ position, bars: barsRes.bars, contract: null }), mustExit: hard.mustExit || false };
          }
          return { ok: true, symbol: args.symbol, asOf: barsRes.asOf, hardExit: hard, ...res, footnotes: ['短线 5 日强制离场为硬红线，不接受 override。', DISCLAIMER] };
        }
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${args.action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_backtest：统一回测 ----
  ctx.tools.register(defineTool({
    name: 'kb_backtest',
    description:
      '跬步量化·回测（无未来函数：信号收盘确认、次日成交；T+1/涨跌停/整手/停牌/费用全算）。mode=long|stable|short，用对应策略在该标的日K上产信号并撮合，输出总收益/年化/最大回撤/夏普/胜率/盈亏比/成本转负进度。',
    parameters: {
      mode: { type: 'string', required: true, enum: ['long', 'stable', 'short'], description: '象限' },
      symbol: { type: 'string', required: true, description: '标的代码' },
      days: { type: 'integer', description: '回测区间（日K根数），默认 250' },
      initialCash: { type: 'number', description: '初始资金，默认 100000' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const bt = await tryImport('./src/backtest.js');
        if (!bt || typeof bt.runBacktest !== 'function') return moduleMissing('回测引擎', './src/backtest.js');
        const strat = await tryImport('./src/strategies/index.js');
        const reg = strat && strat.registry && strat.registry[args.mode];
        if (!reg || typeof reg.evaluate !== 'function') return moduleMissing(`${args.mode} 策略`, './src/strategies/index.js');
        const barsRes = await dailyBars(args.symbol, { days: args.days || 250, adjust, timeoutMs });
        const evaluated = reg.evaluate({ bars: barsRes.bars, position: null, account: null, config: {}, indexBars: null, stats: null });
        const res = bt.runBacktest({
          bars: barsRes.bars,
          signals: evaluated.signals || [],
          initialCash: args.initialCash || 100000,
          fee,
          mode: args.mode,
        });
        return { ok: true, symbol: barsRes.symbol, mode: args.mode, dataAsOf: barsRes.asOf, stale: barsRes.stale, ...res, footnotes: ['历史回测不代表未来表现。', DISCLAIMER] };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_risk：风控闸门与红线 ----
  ctx.tools.register(defineTool({
    name: 'kb_risk',
    description:
      '跬步量化·风控闸门。action=redlines 查询三象限红线；check 对一笔拟买入信号过闸门（单票/象限上限、冷静期、连亏熔断、当日新开仓数）；expectancy 期望值自检。硬红线：短线 5 日强制离场不可 override。',
    parameters: {
      action: { type: 'string', required: true, enum: ['redlines', 'check', 'expectancy'], description: '操作' },
      mode: { type: 'string', enum: ['long', 'stable', 'short'], description: 'check/expectancy 必填' },
      actionName: { type: 'string', enum: ['buy', 'sell', 'force_exit'], description: 'check：拟执行动作，默认 buy' },
      signalValue: { type: 'number', description: 'check：拟买入金额（元）' },
      accountValue: { type: 'number', description: 'check：象限当前总资产（元）' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        if (args.action === 'redlines') return { ok: true, redLines: RED_LINES, hardRedLine: '短线 5 日强制离场不接受 override（ERR-OVERRIDE-001）', footnotes: [DISCLAIMER] };
        if (args.action === 'expectancy') {
          const ledgerMod = await tryImport('./src/ledger.js');
          const trades = ledgerMod && ledgerMod.makeLedger ? ledgerMod.makeLedger(dataDir).trades(args.mode || 'stable') : [];
          return { ok: true, ...expectancyCheck({ trades, payoffRatio: args.mode === 'short' ? 1 : 1.25 }), footnotes: [DISCLAIMER] };
        }
        if (args.action === 'check') {
          if (!args.mode) return { ok: false, code: 'ERR-INTERNAL', message: 'check 需要 mode' };
          const res = gate({
            mode: args.mode,
            action: args.actionName || 'buy',
            quadrant: args.mode,
            signal: { qty: 1, price: args.signalValue || 0 },
            account: { equity: args.accountValue || 0, symbolValue: {} },
            stats: null,
            config: {},
          });
          return { ok: true, gate: res, footnotes: [DISCLAIMER] };
        }
        return { ok: false, code: 'ERR-INTERNAL', message: `未知 action: ${args.action}` };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- kb_review：周/月复盘 ----
  ctx.tools.register(defineTool({
    name: 'kb_review',
    description:
      '跬步量化·复盘：按周期统计胜率、盈亏比、最大回撤、override 清单与纪律遵守率（短线超期未离场次数）。period=week|month|all。数据来自本地账本，账本模块未就绪时返回 ERR-MODULE-001。',
    parameters: {
      period: { type: 'string', enum: ['week', 'month', 'all'], description: '复盘周期，默认 week' },
      quadrant: { type: 'string', enum: ['long', 'stable', 'short'], description: '只看某象限（可选）' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const ledgerMod = await tryImport('./src/ledger.js');
        if (!ledgerMod || typeof ledgerMod.makeLedger !== 'function') return moduleMissing('账本', './src/ledger.js');
        const ledger = ledgerMod.makeLedger(dataDir);
        const period = args.period || 'week';
        const cutoff = new Date();
        if (period === 'week') cutoff.setDate(cutoff.getDate() - 7);
        else if (period === 'month') cutoff.setMonth(cutoff.getMonth() - 1);
        const inPeriod = (d) => !d || period === 'all' || new Date(d) >= cutoff;
        const trades = (ledger.trades(args.quadrant) || []).filter((t) => inPeriod(t.date));
        const closed = trades.filter((t) => typeof t.pnl === 'number');
        const overrides = (ledger.contracts() || []).flatMap((c) => (c.overrides || []).filter((o) => inPeriod(o.at)).map((o) => ({ contractId: c.id, symbol: c.symbol, ...o })));
        const equity = closed.map((t) => t.pnl);
        return {
          ok: true,
          period,
          quadrant: args.quadrant || 'all',
          trades: trades.length,
          winRate: winRate(closed),
          payoffRatio: payoffRatio(closed),
          maxDrawdown: equity.length ? maxDrawdown(equity) : null,
          overrides,
          disciplineNote: overrides.length ? `本期有 ${overrides.length} 次契约 override，逐条核对理由` : '本期无契约 override，纪律遵守',
          footnotes: [DISCLAIMER],
        };
      } catch (e) {
        return toErr(e);
      }
    },
  }));

  // ---- systemPrompt：让模型知道三象限纪律与工具面 ----
  // ---- Web 面板 API（/api/kuibuequity/*，loopback 守卫）----
  try {
    registerWebRoutes({ ctx, config: resolved, dataDir, fee, timeoutMs, adjust });
  } catch (err) {
    console.warn('[kuibuequity] web routes failed:', err && err.message);
  }

  ctx.systemPrompt.section({
    name: 'kuibuequity',
    order: 170,
    text: () => [
      '本机装有 kuibuequity（跬步量化）插件：三象限纪律执行器（只读行情+模拟+人工下单，不接券商）。',
      '纪律：long=高股息网格摊薄成本至负数（年）；stable=赚 1%~5% 止盈、止损与期限事前锁定（日~周）；short=次日强势、≤5 日强制离场且不可 override（1~5 日）。三象限资金物理隔离，禁止跨象限救火。',
      '所有输出必须带 as_of 且不构成投资建议；数据 stale 时先提示再使用；风控拒绝（ERR-RISK-*）或期望值不达标（NOT_RECOMMENDED）时如实转述，不得替用户绕过红线。',
      '可用工具：kb_market（行情/日K/分红/指数）、kb_account（象限账本）、kb_longterm（网格/成本转负）、kb_stable（契约/持仓体检/期望值）、kb_short（情绪总闸/打分/离场）、kb_backtest（回测）、kb_risk（红线/闸门）、kb_review（复盘）。',
    ].join('\n'),
  });
}

export { name, inject, Config };
export { apply };
