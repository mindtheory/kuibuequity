/**
 * kuibuequity — 策略注册表
 *
 * 三象限共用统一 evaluate 接口（docs/interface.md §7），此处只做聚合与查找。
 */
import * as longTerm from './longTerm.js';
import * as stable from './stable.js';
import * as shortTerm from './shortTerm.js';

export const registry = {
  long: longTerm,
  stable,
  short: shortTerm,
};

export const MODES = ['long', 'stable', 'short'];

/** 按象限取策略模块；非法 mode 抛错（不静默降级） */
export function getStrategy(mode) {
  const mod = registry[mode];
  if (!mod) throw new Error(`ERR-SYMBOL-001: 未知象限 ${mode}（可选：${MODES.join('/')}）`);
  return mod;
}

/** 汇总三策略 meta（供 kb_* 工具自述） */
export function listMeta() {
  return MODES.map((m) => ({ mode: m, ...registry[m].meta }));
}
