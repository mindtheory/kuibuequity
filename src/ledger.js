/**
 * kuibuequity — 象限账本（JSON 原子写 + 审计流水）
 *
 * 契约依据：docs/interface.md §4、docs/design.md §6.6（三象限资金物理隔离）
 * 原则：P4 成本口径唯一（费用回落 costs.tradeFee）、P5 事前承诺 > 事中判断（契约锁定 + override 必带 reason）、
 *       P6 诚实的失败（余额/持仓不足直接抛 ERR-*，绝不静默改数）。
 *
 * 落盘：
 *   $dataDir/ledger.json   状态快照（原子写：写 tmp → rename，避免半截文件）
 *   $dataDir/audit.jsonl   审计流水（追加，一行一条 JSON）
 */

import fs from 'node:fs';
import path from 'node:path';
import { tradeFee, holdingCost } from './costs.js';

/** 象限枚举固定三档（interface.md §4） */
export const QUADRANTS = ['long', 'stable', 'short'];

const LEDGER_FILE = 'ledger.json';
const AUDIT_FILE = 'audit.jsonl';

const round2 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 100) / 100 : null);
const round3 = (x) => (Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 1000) / 1000 : null);
const nowIso = () => new Date().toISOString();

/** 统一错误构造：message 前缀 ERR-* 码（interface.md §10），并挂 err.code 便于上层分支 */
function ledgerError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 空账本结构（文件不存在时的返回值，调用方可直接迭代） */
function emptyState() {
  return { quadrants: [], trades: [], contracts: [], transfers: [] };
}

/** 校验象限名合法 */
function assertQuadrant(quadrant) {
  if (!QUADRANTS.includes(quadrant)) {
    throw ledgerError('ERR-LEDGER-001', `未知象限 ${JSON.stringify(quadrant)}，只能是 ${QUADRANTS.join('/')}`);
  }
}

/** 自增 id：前缀 + 6 位序号（同一进程内稳定唯一，便于对账） */
function nextId(prefix, list) {
  return `${prefix}${String(list.length + 1).padStart(6, '0')}`;
}

/**
 * 创建账本实例
 * @param {string} dataDir 数据目录（不存在则创建）
 * @returns 契约 interface.md §4 声明的全部方法
 */
export function makeLedger(dataDir) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw ledgerError('ERR-LEDGER-001', 'makeLedger 需要一个非空的 dataDir 路径');
  }
  const ledgerPath = path.join(dataDir, LEDGER_FILE);
  const auditPath = path.join(dataDir, AUDIT_FILE);

  // ---------- 落盘 ----------

  /** 原子写：先写同目录 tmp 文件，fsync 后 rename 覆盖（rename 在同文件系统内是原子的） */
  function save(state) {
    if (!state || typeof state !== 'object') throw ledgerError('ERR-LEDGER-001', 'save 需要一个状态对象');
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, ledgerPath);
    return state;
  }

  /** 读盘：文件不存在 → 空结构；JSON 损坏 → 抛错（绝不静默清空用户账本） */
  function load() {
    if (!fs.existsSync(ledgerPath)) return emptyState();
    let raw;
    try {
      raw = fs.readFileSync(ledgerPath, 'utf8');
    } catch (e) {
      throw ledgerError('ERR-LEDGER-001', `账本不可读：${e.message}`);
    }
    if (!raw || !raw.trim()) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw ledgerError('ERR-LEDGER-001', `账本 JSON 已损坏，拒绝覆盖写入：${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw ledgerError('ERR-LEDGER-001', '账本内容不是对象');
    const base = emptyState();
    for (const k of Object.keys(base)) {
      if (Array.isArray(parsed[k])) base[k] = parsed[k];
    }
    return base;
  }

  // ---------- 审计 ----------

  /** 追加一条审计（audit.jsonl，一行一条 JSON） */
  function auditAppend({ action, target, before, after, reason }) {
    const row = {
      at: nowIso(),
      action: action ?? null,
      target: target ?? null,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      reason: reason ?? null,
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(row)}\n`);
    return row;
  }

  /** 读审计（文件缺失返回空数组；坏行跳过不炸整表） */
  function audit() {
    if (!fs.existsSync(auditPath)) return [];
    const out = [];
    for (const line of fs.readFileSync(auditPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 坏行忽略：审计是流水，不因单行损坏而整体不可读 */
      }
    }
    return out;
  }

  // ---------- 象限账户 ----------

  /** 全部象限账户（副本，避免调用方直接改内存） */
  function accounts() {
    return load().quadrants.map((q) => ({ ...q }));
  }

  function findQuadrant(state, quadrant) {
    return state.quadrants.find((q) => q.quadrant === quadrant);
  }

  /**
   * 建账（幂等：已存在则重置现金并写审计，便于对账修正）
   * @param {{quadrant:string, cash:number, totalAsset?:number}} p
   */
  function initAccount({ quadrant, cash, totalAsset }) {
    assertQuadrant(quadrant);
    const c = Number(cash);
    if (!Number.isFinite(c) || c < 0) throw ledgerError('ERR-LEDGER-002', `初始现金必须 >= 0，收到 ${JSON.stringify(cash)}`);
    const state = load();
    const existing = findQuadrant(state, quadrant);
    const before = existing ? { cash: existing.cash } : null;
    if (existing) {
      existing.cash = round2(c);
      existing.initialCash = round2(c);
      if (totalAsset != null) existing.totalAsset = round2(Number(totalAsset));
      existing.updatedAt = nowIso();
      auditAppend({ action: 'account.reinit', target: quadrant, before, after: { cash: existing.cash }, reason: '重复建账：重置现金' });
      save(state);
      return { ...existing };
    }
    const acc = { quadrant, cash: round2(c), initialCash: round2(c), updatedAt: nowIso() };
    if (totalAsset != null) acc.totalAsset = round2(Number(totalAsset));
    state.quadrants.push(acc);
    auditAppend({ action: 'account.init', target: quadrant, before: null, after: { cash: acc.cash }, reason: '建账' });
    save(state);
    return { ...acc };
  }

  /** 取象限，不存在则 ERR-LEDGER-001 */
  function requireQuadrant(state, quadrant) {
    assertQuadrant(quadrant);
    const acc = findQuadrant(state, quadrant);
    if (!acc) throw ledgerError('ERR-LEDGER-001', `象限 ${quadrant} 未建账，请先 initAccount`);
    return acc;
  }

  // ---------- 成交流水 ----------

  /**
   * 录入一笔成交并联动现金与审计
   * @param {{quadrant:string, symbol:string, side:'buy'|'sell', price:number, qty:number,
   *          fee?:number, date?:string, note?:string, name?:string, dividend?:number}} p
   *        dividend = 该笔持有期间的**每股**现金分红（可选，契约未列字段，见文件末"实现取舍"）
   */
  function recordTrade({ quadrant, symbol, side, price, qty, fee, date, note, name, dividend }) {
    if (side !== 'buy' && side !== 'sell') throw ledgerError('ERR-LEDGER-001', `side 必须是 buy/sell，收到 ${JSON.stringify(side)}`);
    if (!symbol || typeof symbol !== 'string') throw ledgerError('ERR-SYMBOL-001', 'recordTrade 需要 symbol');
    const p = Number(price);
    const q = Number(qty);
    if (!(p > 0) || !(q > 0) || !Number.isInteger(q)) {
      throw ledgerError('ERR-LEDGER-001', `price 必须 > 0、qty 必须为正整数，收到 price=${price} qty=${qty}`);
    }
    const state = load();
    const acc = requireQuadrant(state, quadrant);

    // 费用口径唯一：调用方未给 fee 时回落 costs.tradeFee（P4）
    const f = fee == null ? tradeFee({ side, price: p, qty: q }) : round2(Number(fee));
    if (!Number.isFinite(f) || f < 0) throw ledgerError('ERR-LEDGER-001', `fee 非法：${JSON.stringify(fee)}`);

    const amount = round2(p * q);
    const before = { cash: acc.cash };

    if (side === 'buy') {
      const need = round2(amount + f);
      if (need > acc.cash + 1e-9) {
        throw ledgerError('ERR-LEDGER-002', `象限 ${quadrant} 现金不足：需 ${need} 元（含费用 ${f}），仅有 ${acc.cash} 元`);
      }
      acc.cash = round2(acc.cash - need);
    } else {
      // 卖出：先校验持仓（含本象限同标的历史流水闭合）
      const held = heldQty(state, quadrant, symbol);
      if (q > held) {
        throw ledgerError('ERR-LEDGER-003', `象限 ${quadrant} 的 ${symbol} 持仓 ${held} 股，无法卖出 ${q} 股`);
      }
      acc.cash = round2(acc.cash + round2(amount - f));
    }
    acc.updatedAt = nowIso();

    const trade = {
      id: nextId('T', state.trades),
      quadrant,
      symbol,
      side,
      price: round3(p),
      qty: q,
      fee: f,
      amount,
      date: date ?? nowIso().slice(0, 10),
      createdAt: nowIso(),
      note: note ?? null,
    };
    if (name) trade.name = name;
    // 每股分红透传（可选）：positions() 据此把分红计入 holdingCost 的"已回收"
    if (Number(dividend) > 0) trade.dividend = Number(dividend);
    state.trades.push(trade);

    auditAppend({
      action: `trade.${side}`,
      target: `${quadrant}/${symbol}`,
      before,
      after: { cash: acc.cash, qty: q, price: trade.price, fee: f },
      reason: note ?? null,
    });
    save(state);
    return { ...trade };
  }

  /** 某象限某标的的当前持仓股数（由流水推得） */
  function heldQty(state, quadrant, symbol) {
    let qty = 0;
    for (const t of state.trades) {
      if (t.quadrant !== quadrant || t.symbol !== symbol) continue;
      qty += t.side === 'buy' ? Number(t.qty) : -Number(t.qty);
    }
    return Math.max(0, Math.round(qty));
  }

  /** 成交流水（可按象限过滤） */
  function trades(quadrant) {
    const list = load().trades;
    return (quadrant ? list.filter((t) => t.quadrant === quadrant) : list).map((t) => ({ ...t }));
  }

  // ---------- 持仓（成本口径唯一：costs.holdingCost） ----------

  /**
   * 当前持仓（qty>0），costPerShare / negative / dividends 全部走 costs.holdingCost
   * @param {string} [quadrant] 省略则返回全部象限
   */
  function positions(quadrant) {
    const state = load();
    /** @type {Map<string, {quadrant:string, symbol:string, lots:Array, firstDate:string|null, name:string|null}>} */
    const groups = new Map();
    for (const t of state.trades) {
      if (quadrant && t.quadrant !== quadrant) continue;
      const key = `${t.quadrant}|${t.symbol}`;
      if (!groups.has(key)) {
        groups.set(key, { quadrant: t.quadrant, symbol: t.symbol, lots: [], firstDate: null, name: null });
      }
      const g = groups.get(key);
      g.lots.push({
        side: t.side,
        price: Number(t.price),
        qty: Number(t.qty),
        fee: Number(t.fee) || 0,
        // 分红（每股）由外部录入到 trade.dividend 时透传给 holdingCost；账本本身不推断分红
        dividend: Number(t.dividend) > 0 ? Number(t.dividend) : undefined,
      });
      if (t.date && (g.firstDate === null || String(t.date) < String(g.firstDate))) g.firstDate = t.date;
      if (t.name) g.name = t.name;
    }

    const out = [];
    for (const g of groups.values()) {
      const hc = holdingCost({ lots: g.lots, opts: { includeDividend: true } });
      if (hc.shares <= 0) continue; // 已清仓的不算持仓
      const contract =
        state.contracts
          .filter((c) => c.quadrant === g.quadrant && c.symbol === g.symbol)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .pop() || null;
      out.push({
        quadrant: g.quadrant,
        symbol: g.symbol,
        name: g.name ?? null,
        qty: hc.shares,
        avgPrice: hc.avgEntryPrice,
        costPerShare: hc.costPerShare,
        negative: hc.negative,
        dividends: hc.dividends,
        openDate: g.firstDate,
        contractId: contract ? contract.id : null,
      });
    }
    return out.sort((a, b) => `${a.quadrant}/${a.symbol}`.localeCompare(`${b.quadrant}/${b.symbol}`));
  }

  // ---------- 事前契约（P5） ----------

  function contracts() {
    return load().contracts.map((c) => ({ ...c }));
  }

  /**
   * 新建事前契约：建仓时锁定止盈/止损/期限，locked 恒为 true
   * @param {object} c Contract 的输入子集
   */
  function addContract(c) {
    if (!c || typeof c !== 'object') throw ledgerError('ERR-CONTRACT-001', 'addContract 需要一个契约对象');
    const { quadrant, symbol } = c;
    assertQuadrant(quadrant);
    if (!symbol || typeof symbol !== 'string') throw ledgerError('ERR-SYMBOL-001', '契约需要 symbol');
    const state = load();
    requireQuadrant(state, quadrant); // 契约必须挂在已建账的象限上

    const entry = c.entry && typeof c.entry === 'object' ? c.entry : {};
    const contract = {
      id: nextId('C', state.contracts),
      quadrant,
      symbol,
      mode: c.mode ?? quadrant,
      entry: {
        price: entry.price == null ? null : round3(Number(entry.price)),
        qty: entry.qty == null ? null : Math.round(Number(entry.qty)),
        date: entry.date ?? null,
      },
      takeProfitPct: c.takeProfitPct == null ? null : Number(c.takeProfitPct),
      stopLossPct: c.stopLossPct == null ? null : Number(c.stopLossPct),
      maxHoldDays: c.maxHoldDays == null ? null : Math.round(Number(c.maxHoldDays)),
      locked: true, // 事前承诺：创建即锁定，修改只能走 overrideContract
      createdAt: nowIso(),
      overrides: [],
    };
    state.contracts.push(contract);
    auditAppend({
      action: 'contract.add',
      target: `${quadrant}/${symbol}`,
      before: null,
      after: { id: contract.id, takeProfitPct: contract.takeProfitPct, stopLossPct: contract.stopLossPct, maxHoldDays: contract.maxHoldDays, locked: true },
      reason: c.note ?? '建立事前契约',
    });
    save(state);
    return { ...contract };
  }

  /** 契约可 override 的字段白名单（其余字段忽略，防止绕过锁定改历史） */
  const OVERRIDABLE = ['takeProfitPct', 'stopLossPct', 'maxHoldDays', 'entry', 'note'];

  /**
   * 修改已锁定契约：必须带 reason，逐条写审计（P5：事中改主意要留痕）
   * 硬红线：短线 maxHoldDays 不得放宽超过 5 个交易日 → ERR-OVERRIDE-001
   * @param {{contractId:string, patch:object, reason:string}} p
   */
  function overrideContract({ contractId, patch, reason }) {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw ledgerError('ERR-CONTRACT-001', '契约已锁定，修改必须走 override 并填写 reason');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw ledgerError('ERR-CONTRACT-001', 'override 需要一个 patch 对象');
    }
    const state = load();
    const contract = state.contracts.find((c) => c.id === contractId);
    if (!contract) throw ledgerError('ERR-CONTRACT-001', `契约 ${JSON.stringify(contractId)} 不存在`);

    const clean = {};
    for (const k of Object.keys(patch)) {
      if (OVERRIDABLE.includes(k)) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) {
      throw ledgerError('ERR-CONTRACT-001', `override 无可改字段，允许：${OVERRIDABLE.join('/')}`);
    }
    // 硬红线：短线 5 日强制离场不接受 override（design.md §6.5）
    if (contract.mode === 'short' && clean.maxHoldDays != null && Number(clean.maxHoldDays) > 5) {
      throw ledgerError('ERR-OVERRIDE-001', `短线强制离场期限不可放宽（请求 ${clean.maxHoldDays} 日 > 5 日硬红线）`);
    }

    const before = {};
    for (const k of Object.keys(clean)) before[k] = contract[k] ?? null;

    if (clean.takeProfitPct != null) contract.takeProfitPct = Number(clean.takeProfitPct);
    if (clean.stopLossPct != null) contract.stopLossPct = Number(clean.stopLossPct);
    if (clean.maxHoldDays != null) contract.maxHoldDays = Math.round(Number(clean.maxHoldDays));
    if (clean.entry && typeof clean.entry === 'object') {
      contract.entry = {
        price: clean.entry.price == null ? contract.entry.price : round3(Number(clean.entry.price)),
        qty: clean.entry.qty == null ? contract.entry.qty : Math.round(Number(clean.entry.qty)),
        date: clean.entry.date ?? contract.entry.date,
      };
    }
    if (clean.note != null) contract.note = String(clean.note);
    contract.locked = true; // 锁定状态不因 override 而解除
    contract.updatedAt = nowIso();
    contract.overrides.push({ at: nowIso(), patch: clean, reason: reason.trim() });

    const after = {};
    for (const k of Object.keys(clean)) after[k] = contract[k] ?? null;

    auditAppend({
      action: 'contract.override',
      target: `${contract.quadrant}/${contract.symbol}`,
      before,
      after,
      reason: reason.trim(),
    });
    save(state);
    return { ...contract };
  }

  // ---------- 跨象限调拨 ----------

  function transfers() {
    return load().transfers.map((t) => ({ ...t }));
  }

  /**
   * 跨象限调拨：必须显式声明 from/to/reason，余额不足直接拒绝（design.md §6.6）
   * @param {{from:string, to:string, amount:number, reason:string}} p
   */
  function transfer({ from, to, amount, reason }) {
    assertQuadrant(from);
    assertQuadrant(to);
    if (from === to) {
      throw ledgerError('ERR-LEDGER-001', `调拨的 from/to 必须是两个不同象限（收到 ${from} → ${to}）`);
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw ledgerError('ERR-LEDGER-001', '跨象限调拨必须填写 reason');
    }
    const amt = Number(amount);
    if (!(amt > 0)) throw ledgerError('ERR-LEDGER-002', `调拨金额必须 > 0，收到 ${JSON.stringify(amount)}`);
    const state = load();
    const src = requireQuadrant(state, from);
    const dst = requireQuadrant(state, to);
    if (round2(amt) > src.cash + 1e-9) {
      throw ledgerError('ERR-LEDGER-002', `象限 ${from} 现金不足：要调出 ${round2(amt)} 元，仅有 ${src.cash} 元`);
    }
    src.cash = round2(src.cash - amt);
    dst.cash = round2(dst.cash + amt);
    src.updatedAt = nowIso();
    dst.updatedAt = nowIso();

    const row = {
      id: nextId('X', state.transfers),
      from,
      to,
      amount: round2(amt),
      reason: reason.trim(),
      createdAt: nowIso(),
    };
    state.transfers.push(row);
    auditAppend({
      action: 'transfer',
      target: `${from}->${to}`,
      before: { [from]: round2(src.cash + amt), [to]: round2(dst.cash - amt) },
      after: { [from]: src.cash, [to]: dst.cash },
      reason: row.reason,
    });
    save(state);
    return { ...row };
  }

  return {
    load,
    save,
    accounts,
    initAccount,
    recordTrade,
    positions,
    contracts,
    addContract,
    overrideContract,
    transfers,
    transfer,
    trades,
    audit,
    auditAppend,
  };
}

/*
 * 实现取舍（与 interface.md §4 的偏离/补充，需在 CHANGELOG 记录）：
 * 1. recordTrade 额外接受可选 dividend（每股现金分红）：契约的 Trade 类型未列该字段，
 *    但 Position.dividends 需要分红来源；账本不自行推断分红，只透传给 costs.holdingCost。
 * 2. initAccount 对已存在象限采取"重置现金 + 写审计"的幂等语义（而非报错），便于对账修正；
 *    任何重置都会在 audit.jsonl 留下 account.reinit 记录。
 * 3. overrideContract 只接受白名单字段（takeProfitPct/stopLossPct/maxHoldDays/entry/note），
 *    并额外实现 design.md §6.5 的硬红线：短线 maxHoldDays 不可放宽超过 5 日 → ERR-OVERRIDE-001。
 *    契约 locked 恒为 true，override 不会解锁。
 * 4. transfer 额外要求 reason（design.md §6.6 要求调拨写审计，无理由无法复盘）。
 * 5. 卖出持仓校验按"同象限同标的流水净额"推得（跨象限物理隔离，禁止用别的象限持仓抵卖）。
 * 6. 金额落盘统一 2 位小数、价格 3 位小数（interface.md 约定）；比较时留 1e-9 容差避免浮点误判。
 */
