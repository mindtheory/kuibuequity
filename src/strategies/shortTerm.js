/**
 * kuibuequity — 短线象限：次日强势打分 · ≤5 日强制离场
 *
 * 设计依据：docs/design.md §6
 * 边界声明：这是概率游戏，不是圣杯。插件把"凭感觉打板"变成"有打分、有仓位上限、
 * 有强制离场、有胜率考核"的可控赌博；胜率不达标时拒绝下注（P6）。
 */
import { sma } from '../indicators.js';
import { buildPlan } from '../plan.js';
import { sentimentGate, hardExitCheck, expectancyCheck } from '../risk.js';

export const meta = {
  mode: 'short',
  name: '次日强势 · 5 日强制离场',
  horizon: '1~5 交易日',
  description: '预测次日涨停/大涨的候选打分；5 日硬期限无条件清仓（不可 override）',
  configSchema: {
    minGainPct: { default: 0.05 },
    minTurnover: { default: 0.05 },
    minAmount: { default: 100000000 }, // 日均成交额 ≥1 亿
    minFloatCap: { default: 3000000000 }, // 流通市值 ≥30 亿
    minListDays: { default: 60 },
    hardMaxHoldDays: { default: 5 },
    stopLossPct: { default: -0.03 },
  },
};

const defaults = Object.fromEntries(Object.entries(meta.configSchema).map(([k, v]) => [k, v.default]));

/**
 * 打分卡（0~100，design.md §6.3）
 * 封单强度20 + 涨停时间15 + 连板高度15 + 量能结构12 + 板块效应15 + 资金流10 + 大盘情绪13
 * @param {object} c 候选：{ symbol, name, gainPct, turnover, volumeRatio, sealAmount,
 *                    floatCap, limitUp, firstLimitTime('HH:MM'|null, 一字=null),
 *                    boards(连板数), blown(炸板), mainNetInflow, sectorLimitUps,
 *                    listDays, amount20Avg }
 * @param {object} market { indexAboveMa5, yesterdayLimitUpPremium, blowUpRate }
 */
export function scoreOne(c, market = {}, config = {}) {
  const cfg = { ...defaults, ...config };
  const f = {};
  const reasons = [];
  const tradable = !(c.limitUp && c.blown === false && c.firstLimitTime === 'OPEN') && !c.suspended;

  // 一字涨停买不到 → 直接剔除（P6 不伪造成交）
  if (c.oneWordBoard) {
    return { symbol: c.symbol, name: c.name, score: 0, factors: {}, reasons: ['一字涨停无法成交，剔除'], tradable: false, note: 'ONE_WORD' };
  }

  // 硬性剔除
  const rejects = [];
  if (c.st) rejects.push('ST');
  if (Number(c.listDays) < cfg.minListDays) rejects.push('次新');
  if (Number(c.floatCap) < cfg.minFloatCap) rejects.push('流通市值不足');
  if (Number(c.amount20Avg) < cfg.minAmount) rejects.push('流动性不足');
  if (rejects.length) {
    return { symbol: c.symbol, name: c.name, score: 0, factors: {}, reasons: rejects, tradable: false, note: `剔除:${rejects.join('/')}` };
  }

  // 1) 封单强度 20：封单额/流通市值，>3% 满分；炸板 0
  f.seal = c.limitUp ? (c.blown ? 0 : Math.min(20, ((c.sealAmount || 0) / c.floatCap) / 0.03 * 20)) : Math.max(0, 10 - Math.abs(c.gainPct - 0.05) * 200);
  if (c.blown) reasons.push('盘中炸板');

  // 2) 涨停时间 15：早盘 > 午后 > 尾盘
  f.time = !c.limitUp ? 6 : timeScore(c.firstLimitTime);
  // 3) 连板高度 15：首板/二板最优，4 板以上递减
  const b = Number(c.boards) || 1;
  f.boards = b <= 2 ? 15 : b === 3 ? 11 : Math.max(3, 11 - (b - 3) * 3);
  // 4) 量能结构 12：换手 5%~15% 佳
  const to = Number(c.turnover) || 0;
  f.volume = to >= 0.05 && to <= 0.15 ? 12 : to < 0.05 ? 7 : Math.max(2, 12 - (to - 0.15) * 60);
  // 5) 板块效应 15：同板块涨停 ≥3 家才给分
  f.sector = (Number(c.sectorLimitUps) || 0) >= 3 ? 15 : (Number(c.sectorLimitUps) || 0) >= 1 ? 7 : 0;
  // 6) 资金流 10：主力净流入/成交额
  const flow = c.amount ? (c.mainNetInflow || 0) / c.amount : 0;
  f.flow = Math.max(0, Math.min(10, 5 + flow * 50));
  // 7) 大盘情绪 13
  f.market = (market.indexAboveMa5 ? 7 : 0) + (Number(market.yesterdayLimitUpPremium) > 0 ? 6 : 0);

  const score = Math.round(Object.values(f).reduce((a, x) => a + x, 0));
  if (score >= 70) reasons.push('强势候选');
  else if (score >= 55) reasons.push('中性偏强');
  else reasons.push('打分不足');
  return { symbol: c.symbol, name: c.name, score, factors: f, reasons, tradable, note: '' };
}

function timeScore(t) {
  if (t === 'OPEN' || t === null) return 15; // 一字/开盘板
  const hm = String(t).slice(0, 5);
  if (hm <= '10:30') return 13;
  if (hm <= '13:30') return 9;
  if (hm <= '14:30') return 5;
  return 2; // 尾盘板
}

/** 候选池打分入口（收盘后跑） */
export function scoreCandidates({ candidates = [], market = {}, config = {}, topN = 10 }) {
  const gate = sentimentGate(market);
  if (!gate.open) {
    return { open: false, reason: gate.reason, candidates: [], note: '情绪总闸关闭：今日短线空仓，不输出任何买入指令' };
  }
  const scored = candidates
    .map((c) => scoreOne(c, market, config))
    .filter((c) => c.tradable)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return { open: true, reason: gate.reason, candidates: scored };
}

/** 离场计划：5 日硬期限不可 override */
export function exitPlan({ position, bars, contract }) {
  const last = bars?.[bars.length - 1];
  const px = last ? last.adjClose ?? last.close : null;
  const entry = Number(contract?.entry?.price ?? position?.avgPrice);
  const ret = px && entry ? px / entry - 1 : null;
  const hard = hardExitCheck({ openDate: contract?.entry?.date || position?.openDate, asOf: last?.date });
  if (hard.mustExit) {
    return { action: 'force_exit', mustExit: true, deadline: `${last.date} 收盘前`, reason: hard.note };
  }
  if (ret !== null && ret <= -0.03) {
    return { action: 'stop_loss', mustExit: false, deadline: '立即', reason: `浮亏 ${(ret * 100).toFixed(1)}% ≤ -3%，无条件止损（条件单前置）` };
  }
  return { action: 'hold', mustExit: false, deadline: hard.remaining ? `剩余 ${hard.remaining} 交易日` : null, reason: hard.note };
}

export function evaluate({ bars, position, contract, account, config = {}, symbol, market, stats }) {
  const cfg = { ...defaults, ...config };
  const signals = [];
  const rejected = [];
  const last = bars?.[bars.length - 1];

  // 情绪总闸优先于一切个股信号
  const gate = sentimentGate(market || {});
  if (!gate.open) rejected.push({ symbol, rule: 'SHORT.SENTIMENT_GATE', reason: gate.reason });

  // 期望值自检
  const exp = stats?.trades ? expectancyCheck({ trades: stats.trades, payoffRatio: stats.payoffRatio }) : null;
  if (exp?.verdict === 'NOT_RECOMMENDED') rejected.push({ symbol, rule: 'SHORT.EXPECTANCY', reason: exp.note });

  if (position && (contract || position.openDate)) {
    const ep = exitPlan({ position, bars, contract });
    if (ep.action === 'force_exit' || ep.action === 'stop_loss') {
      signals.push({
        mode: 'short', symbol, action: ep.action === 'force_exit' ? 'force_exit' : 'stop_loss',
        qty: position.qty, price: px(last), reason: ep.reason,
        rule: ep.action === 'force_exit' ? 'SHORT.HARD_EXIT_5D' : 'SHORT.STOP_LOSS', confidence: 1,
      });
    }
  } else if (gate.open && exp?.verdict !== 'NOT_RECOMMENDED' && Array.isArray(bars) && bars.length >= 5) {
    // 单票快速打分（无候选池时按日线近似）
    const closes = bars.map((b) => b.adjClose ?? b.close);
    const gain = closes.at(-1) / closes.at(-2) - 1;
    const volMa5 = sma(bars.map((b) => b.volume), 5).at(-1);
    const fake = {
      symbol, name: '', gainPct: gain, turnover: 0.08, volumeRatio: volMa5 ? last.volume / volMa5 : 1,
      limitUp: !!last.limitUp, blown: false, firstLimitTime: last.limitUp ? '10:00' : null, boards: 1,
      floatCap: 1e10, amount20Avg: bars.slice(-20).reduce((a, b) => a + (b.amount || 0), 0) / 20,
      listDays: bars.length, st: false, oneWordBoard: false, sealAmount: 0, mainNetInflow: 0,
      amount: last.amount, sectorLimitUps: 3,
    };
    const s = scoreOne(fake, market || {}, cfg);
    if (s.score >= 70) {
      const equity = Number(account?.equity) || Number(account?.cash) || 0;
      const qty = Math.floor((equity * 0.2) / px(last) / 100) * 100;
      if (qty >= 100) {
        signals.push({
          mode: 'short', symbol, action: 'buy', qty, price: px(last),
          reason: `SHORT.SCORE ${s.score} 分：${s.reasons.join('，')}；5 日硬期限`, rule: 'SHORT.ENTRY', confidence: s.score / 100,
        });
      } else {
        rejected.push({ symbol, rule: 'ERR-PLAN-001', reason: '账户资金不足 1 手' });
      }
    } else {
      rejected.push({ symbol, rule: 'SHORT.SCORE_LOW', reason: `打分 ${s.score} < 70，不入选` });
    }
  }

  const plan = buildPlan({ mode: 'short', asOf: last?.date, signals, rejected });
  return { signals, plan, diagnostics: { sentiment: gate, expectancy: exp } };
}

const px = (bar) => (bar ? bar.adjClose ?? bar.close : null);
