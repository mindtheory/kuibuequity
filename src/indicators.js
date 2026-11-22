/**
 * kuibuequity — 技术指标（纯函数）
 *
 * 设计依据：docs/interface.md §2
 * 约定：输出长度 === 输入长度；前导不可计算位置填 null（索引对齐）。
 * 不依赖任何第三方库，可用 node --test 独立验证。
 */

function assertSeries(values) {
  if (!Array.isArray(values)) throw new Error('ERR-IND-001: values 必须是数组');
}
const ok = (x) => Number.isFinite(x);

/** 简单移动平均 */
export function sma(values, period) {
  assertSeries(values);
  if (!(period >= 1)) throw new Error('ERR-IND-002: period 必须 >= 1');
  const out = new Array(values.length).fill(null);
  // 逐窗口重算：窗口内含非法值则该位置为 null
  for (let i = 0; i < values.length; i++) {
    if (i >= period - 1) {
      let s = 0;
      let bad = false;
      for (let j = i - period + 1; j <= i; j++) {
        if (!ok(values[j])) { bad = true; break; }
        s += values[j];
      }
      out[i] = bad ? null : s / period;
    }
  }
  return out;
}

/** 指数移动平均：alpha = 2/(period+1)，首值播种 */
export function ema(values, period) {
  assertSeries(values);
  if (!(period >= 1)) throw new Error('ERR-IND-002: period 必须 >= 1');
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (!ok(values[i])) { out[i] = null; continue; }
    prev = prev === null ? values[i] : alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** RSI（Wilder 平滑，标准算法） */
export function rsi(values, period = 14) {
  assertSeries(values);
  if (!(period >= 2)) throw new Error('ERR-IND-002: rsi period 必须 >= 2');
  const out = new Array(values.length).fill(null);
  let avgGain = null;
  let avgLoss = null;
  for (let i = 1; i < values.length; i++) {
    if (!ok(values[i]) || !ok(values[i - 1])) continue;
    const chg = values[i] - values[i - 1];
    const gain = Math.max(chg, 0);
    const loss = Math.max(-chg, 0);
    if (avgGain === null) {
      // 前 period 个变动做种子
      if (i === period) {
        let g = 0;
        let l = 0;
        for (let j = 1; j <= period; j++) {
          const c = values[j] - values[j - 1];
          g += Math.max(c, 0);
          l += Math.max(-c, 0);
        }
        avgGain = g / period;
        avgLoss = l / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD：dif / dea / hist（hist = dif - dea） */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  assertSeries(values);
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const dif = values.map((_, i) =>
    ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  // 对 dif 的非 null 段做 ema 作为 dea
  const valid = dif.map((v) => (v === null ? NaN : v));
  const deaRaw = ema(valid, signal);
  const dea = dif.map((v, i) => (v === null ? null : deaRaw[i]));
  const hist = dif.map((v, i) => (v !== null && dea[i] !== null ? v - dea[i] : null));
  return { dif, dea, hist };
}

/** 布林带：mid/upper/lower/width */
export function boll(values, period = 20, k = 2) {
  assertSeries(values);
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const width = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let bad = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (!ok(values[j])) { bad = true; break; }
      s += values[j];
    }
    if (bad) continue;
    const m = s / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (values[j] - m) ** 2;
    const sd = Math.sqrt(varSum / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
    width[i] = m !== 0 ? (upper[i] - lower[i]) / m : null;
  }
  return { mid, upper, lower, width };
}

/** ATR（Wilder 平滑）；bars: [{high, low, close}] */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars)) throw new Error('ERR-IND-001: bars 必须是数组');
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] || {};
    if (!ok(b.high) || !ok(b.low) || !ok(b.close)) continue;
    const pc = i > 0 && ok(bars[i - 1]?.close) ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (i < period) {
      // 前 period 根用 TR 均值播种
      if (i === period - 1) {
        let s = 0;
        for (let j = 0; j < period; j++) {
          const bj = bars[j];
          const pcj = j > 0 ? bars[j - 1].close : bj.close;
          s += Math.max(bj.high - bj.low, Math.abs(bj.high - pcj), Math.abs(bj.low - pcj));
        }
        prev = s / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

/** ATR / close（波动率百分比，小数） */
export function atrPct(bars, period = 14) {
  const a = atr(bars, period);
  return a.map((v, i) => {
    const c = bars[i]?.close;
    return v !== null && ok(c) && c > 0 ? v / c : null;
  });
}

/** 最近 period 点最小二乘斜率 / 均值（归一化斜率） */
export function slope(values, period) {
  assertSeries(values);
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, bad = false;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = values[i - period + 1 + j];
      if (!ok(y)) { bad = true; break; }
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    if (bad) continue;
    const n = period;
    const denom = n * sxx - sx * sx;
    if (denom === 0) continue;
    const k = (n * sxy - sx * sy) / denom;
    const mean = sy / n;
    out[i] = mean !== 0 ? k / mean : null;
  }
  return out;
}

/** 最大回撤（正数小数，如 0.23） */
export function maxDrawdown(equity) {
  assertSeries(equity);
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (!ok(v)) continue;
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

/** 年化夏普（rf 默认 0，periodsPerYear 默认 244 个交易日） */
export function sharpe(returns, rf = 0, periodsPerYear = 244) {
  assertSeries(returns);
  const xs = returns.filter(ok);
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length - rf / periodsPerYear;
  const varSum = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  const sd = Math.sqrt(varSum);
  if (sd === 0) return null;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

/** 胜率 0..1；空数组返回 null */
export function winRate(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const wins = trades.filter((t) => Number(t?.pnl) > 0).length;
  return wins / trades.length;
}

/** 盈亏比（平均盈利 / 平均亏损绝对值）；无亏损样本返回 null */
export function payoffRatio(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const wins = trades.map((t) => Number(t?.pnl)).filter((v) => v > 0);
  const losses = trades.map((t) => Number(t?.pnl)).filter((v) => v < 0);
  if (losses.length === 0 || wins.length === 0) return null;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  if (avgLoss === 0) return null;
  return avgWin / avgLoss;
}
