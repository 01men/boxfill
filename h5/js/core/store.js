/**
 * 主数据与本地存储（PRD 第 5 章 + 第 11 章离线与审计）。
 *
 * 这是整个系统的地基，也是最容易出事的一层。三条硬要求：
 *
 * 1. **离线优先**。仓库网络差是常态，测 20 箱、算 3 票都必须在断网下完成，
 *    联网后再同步。所以存储层不假设 localStorage 永远可用，也不假设联网。
 *
 * 2. **主数据不靠人工维护**（PRD 1.3）。SKU 靠三段匹配带出：条码 > 货号标签 OCR >
 *    尺寸+重量模糊匹配。三段都不中才弹"新 SKU"，让用户拍一张货号照就建档。
 *
 * 3. **改了要能回溯**（PRD 验收 C-26）。每个 SKU 的尺寸改动都留版本；
 *    每次测算都存一份参数快照。三个月后回头查"当时那柜是按哪个尺寸算的"，
 *    答不上来就等于没有审计。这条在后端上很容易被省掉，然后永远补不回来。
 *
 * 本模块不引用 DOM，Node 下可直接测试。
 */

import { normalizeDimsCm, uid, DEFAULT_SETTINGS, clone, GOODS_ATTRS } from './units.js';

const STORAGE_KEY = 'ybx.store.v2';
const SCHEMA_VERSION = 2;

/** 内存存储：浏览器无痕模式、Node 测试、以及 localStorage 被禁时兜底 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    _map: map,
  };
}

function defaultStorage() {
  try {
    const probe = '__ybx_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return memoryStorage();
  }
}

function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    skus: [],
    orders: [],
    customers: [],
    plans: [],
    settings: clone(DEFAULT_SETTINGS),
    pending: [],          // 离线操作队列，联网后 flush
    updatedAt: null,
  };
}

export class Store {
  constructor(opts = {}) {
    this.storage = opts.storage || defaultStorage();
    this.now = opts.now || (() => Date.now());
    this._online = opts.online !== undefined ? opts.online : true;
    this._listeners = { change: [], network: [] };
    this.db = this._load();
  }

  /* ───────── 读写 ───────── */

  _load() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return emptyDb();
      const db = JSON.parse(raw);
      if (!db || db.schemaVersion !== SCHEMA_VERSION) {
        // 版本不符不做破坏性迁移：旧数据先整体留档再重置，
        // 静默改结构会让用户的历史方案回溯不到（PRD 11 审计）
        this.storage.setItem(`${STORAGE_KEY}.bak.${this.now()}`, raw);
        return emptyDb();
      }
      return Object.assign(emptyDb(), db);
    } catch {
      return emptyDb();
    }
  }

  save() {
    this.db.updatedAt = new Date(this.now()).toISOString();
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.db));
    } catch (err) {
      // 配额满或被禁：不能静默丢数据，抛给上层提示用户导出备份
      this._emit('change', { type: 'save-failed', error: String(err && err.message || err) });
      return false;
    }
    this._emit('change', { type: 'save' });
    return true;
  }

  on(evt, cb) {
    if (this._listeners[evt]) this._listeners[evt].push(cb);
    return () => this.off(evt, cb);
  }
  off(evt, cb) {
    if (this._listeners[evt]) this._listeners[evt] = this._listeners[evt].filter(f => f !== cb);
  }
  _emit(evt, payload) {
    for (const cb of this._listeners[evt] || []) {
      try { cb(payload); } catch { /* 单个监听器出错不能拖垮整层 */ }
    }
  }

  /* ───────── SKU ───────── */

  listSkus() { return this.db.skus; }
  getSku(id) { return this.db.skus.find(s => s.id === id) || null; }
  getSkuByCode(code) {
    const key = String(code || '').trim().toUpperCase();
    return this.db.skus.find(s => s.code.toUpperCase() === key
      || (s.aliases || []).some(a => a.toUpperCase() === key)) || null;
  }

  /**
   * 新建或更新 SKU。
   * 尺寸变了会自动留版本——这是 C-26 的落点：不能覆盖，要能回溯。
   */
  upsertSku(data) {
    const dims = normalizeDimsCm(data.dimsCm || {});
    const at = new Date(this.now()).toISOString();
    const existing = data.id ? this.getSku(data.id) : this.getSkuByCode(data.code);

    if (!existing) {
      const sku = {
        id: data.id || uid('sku'),
        code: String(data.code || '').trim() || uid('SKU'),
        nameCn: data.nameCn || '',
        nameEn: data.nameEn || '',
        dimsCm: dims,
        weightKg: Number(data.weightKg) || 0,
        packQty: Math.max(1, Math.floor(Number(data.packQty) || 1)),
        pieces: Number(data.pieces) || 0,
        netWeightKg: Number(data.netWeightKg) || 0,
        maxStack: Math.floor(Number(data.maxStack) || 0),      // 0 = 不限（见 units.js 说明）
        noInvert: !!data.noInvert,
        noInvertDimsCm: data.noInvert && data.noInvertDimsCm ? normalizeDimsCm(data.noInvertDimsCm) : null,
        fragile: !!data.fragile,
        unitValue: Number(data.unitValue) || 0,
        supplier: data.supplier || '',
        location: data.location || '',
        aliases: data.aliases || [],
        attrs: normalizeAttrs(data),
        version: 1,
        dimsHistory: [{ version: 1, dimsCm: dims, weightKg: Number(data.weightKg) || 0, at, reason: '建档' }],
        createdAt: at,
        updatedAt: at,
        measurements: [],   // 视觉采集的历史读数，用于识别"这箱是不是变大了"
      };
      this.db.skus.unshift(sku);
      this.save();
      return sku;
    }

    const dimsChanged = !sameDims(existing.dimsCm, dims);
    const weightChanged = Math.abs((existing.weightKg || 0) - (Number(data.weightKg) || 0)) > 1e-6;
    Object.assign(existing, {
      code: data.code || existing.code,
      nameCn: data.nameCn ?? existing.nameCn,
      nameEn: data.nameEn ?? existing.nameEn,
      dimsCm: dims,
      weightKg: Number(data.weightKg) || existing.weightKg,
      packQty: data.packQty != null ? Math.max(1, Math.floor(Number(data.packQty) || 1)) : existing.packQty,
      pieces: data.pieces ?? existing.pieces,
      netWeightKg: data.netWeightKg ?? existing.netWeightKg,
      maxStack: data.maxStack != null ? Math.floor(Number(data.maxStack) || 0) : existing.maxStack,
      noInvert: data.noInvert != null ? !!data.noInvert : existing.noInvert,
      fragile: data.fragile != null ? !!data.fragile : existing.fragile,
      unitValue: data.unitValue ?? existing.unitValue,
      supplier: data.supplier ?? existing.supplier,
      location: data.location ?? existing.location,
      aliases: data.aliases || existing.aliases,
      attrs: normalizeAttrs(data, existing.attrs),
      updatedAt: at,
    });

    if (dimsChanged || weightChanged) {
      existing.version += 1;
      existing.dimsHistory.push({
        version: existing.version,
        dimsCm: dims,
        weightKg: existing.weightKg,
        at,
        reason: data.changeReason || (dimsChanged ? '改尺寸' : '改重量'),
        previous: dimsChanged ? { dimsCm: clone(existing.dimsHistory[existing.dimsHistory.length - 2]?.dimsCm || {}), version: existing.version - 1 } : undefined,
      });
    }
    this.save();
    return existing;
  }

  deleteSku(id) {
    this.db.skus = this.db.skus.filter(s => s.id !== id);
    this.save();
  }

  /** 记一次视觉采集读数，用于后续的突变检测与均值校验 */
  recordMeasurement(skuId, m) {
    const sku = this.getSku(skuId);
    if (!sku) return null;
    sku.measurements = sku.measurements || [];
    sku.measurements.push({ at: new Date(this.now()).toISOString(), dimsCm: m.dimsCm, weightKg: m.weightKg, source: m.source || 'vision' });
    // 只留最近 20 条：这个统计量要的是"近期表现"，不是全量历史
    if (sku.measurements.length > 20) sku.measurements = sku.measurements.slice(-20);
    this.save();
    return sku;
  }

  /** 历史平均毛重：新 SKU 没有历史，返回 null（调用方按"首次"处理） */
  averageWeight(skuId) {
    const sku = this.getSku(skuId);
    if (!sku) return null;
    const ms = (sku.measurements || []).filter(m => m.weightKg > 0);
    if (ms.length < 3) return null;
    return ms.reduce((s, m) => s + m.weightKg, 0) / ms.length;
  }

  /**
   * 三段匹配（PRD 4.4）：条码 > 货号标签 OCR > 尺寸+重量模糊匹配。
   * 返回 {sku, method, candidates, confidence}；都不中时 method='none'，
   * UI 据此弹"新 SKU"卡片（拍一张货号照即建）。
   */
  matchSku({ code, dimsCm, weightKg } = {}) {
    // ① 条码 / 货号精确匹配：置信度 1，没有任何理由再往下猜
    if (code) {
      const hit = this.getSkuByCode(code);
      if (hit) return { sku: hit, method: 'barcode', confidence: 1, candidates: [hit] };
    }

    // ② 尺寸 + 重量模糊匹配
    if (!dimsCm) return { sku: null, method: 'none', confidence: 0, candidates: [] };
    const d = normalizeDimsCm(dimsCm);
    const w = Number(weightKg) || 0;
    const scored = this.db.skus
      .map(s => ({ sku: s, score: fuzzyScore(s, d, w) }))
      .filter(x => x.score < 0.35)
      .sort((a, b) => a.score - b.score);

    if (scored.length === 0) return { sku: null, method: 'none', confidence: 0, candidates: [] };
    // 模糊匹配的置信度不会给满：给满了用户就不会去看尺寸对不对，
    // 而"认错 SKU"比"多确认一次"的代价大得多（PRD 4.3 容错原则）
    return {
      sku: scored[0].sku,
      method: 'fuzzy',
      confidence: +(1 - scored[0].score).toFixed(3),
      candidates: scored.slice(0, 3).map(x => ({ sku: x.sku, score: +x.score.toFixed(3) })),
    };
  }

  /** 单箱毛重合理性校验（PRD 4.2.2 第 3 条 / 验收 V-05）：±30% 标红、±80% 拒绝 */
  checkWeightDeviation(skuId, weightKg) {
    const avg = this.averageWeight(skuId);
    if (avg == null || !weightKg) return { level: 'ok', reason: '首次采集，无历史均值可比' };
    const pct = (weightKg - avg) / avg;
    const abs = Math.abs(pct);
    if (abs > 0.8) return { level: 'reject', pct: +pct.toFixed(3), avg: +avg.toFixed(2), reason: `毛重 ${weightKg}kg 偏离历史均值 ${avg.toFixed(2)}kg 达 ${(pct * 100).toFixed(0)}%，请重新称重` };
    if (abs > 0.3) return { level: 'warn', pct: +pct.toFixed(3), avg: +avg.toFixed(2), reason: `毛重 ${weightKg}kg 偏离历史均值 ${avg.toFixed(2)}kg ${(pct * 100).toFixed(0)}%，确认无误再入库` };
    return { level: 'ok', pct: +pct.toFixed(3), avg: +avg.toFixed(2) };
  }

  /** 尺寸突变检测（PRD 3 / 验收"这箱比上次大了 18%"）：>15% 提示改包装 */
  checkDimensionJump(skuId, dimsCm) {
    const sku = this.getSku(skuId);
    if (!sku) return { level: 'ok' };
    const d = normalizeDimsCm(dimsCm);
    const base = sku.dimsCm;
    const ratios = [d.l / base.l, d.w / base.w, d.h / base.h].filter(r => Number.isFinite(r));
    if (!ratios.length) return { level: 'ok' };
    const pct = Math.max(...ratios) - 1;
    if (pct > 0.15) {
      return {
        level: 'warn', pct: +pct.toFixed(3),
        reason: `这箱比上次大了 ${(pct * 100).toFixed(0)}%，是改包装了吗？选「是」会更新主数据并留版本`,
      };
    }
    return { level: 'ok', pct: +pct.toFixed(3) };
  }

  /* ───────── 订单 / 客户 ───────── */

  listOrders() { return this.db.orders; }
  getOrder(id) { return this.db.orders.find(o => o.id === id) || null; }

  upsertOrder(data) {
    const at = new Date(this.now()).toISOString();
    const existing = data.id ? this.getOrder(data.id) : null;
    const order = {
      id: data.id || uid('ord'),
      code: data.code || uid('PO'),
      customer: data.customer || '',
      customerAllowMixed: data.customerAllowMixed !== false,
      port: data.port || '',
      vessel: data.vessel || '',
      cutOff: data.cutOff || '',
      dueDate: data.dueDate || '',
      currency: data.currency || 'CNY',
      notes: data.notes || '',
      lines: (data.lines || []).map(l => ({
        skuId: l.skuId, boxes: Math.max(0, Math.floor(Number(l.boxes) || 0)),
        pieces: Math.floor(Number(l.pieces) || 0),
      })).filter(l => l.boxes > 0),
      createdAt: existing ? existing.createdAt : at,
      updatedAt: at,
    };
    if (existing) Object.assign(existing, order, { id: existing.id, createdAt: existing.createdAt });
    else this.db.orders.unshift(order);
    this.save();
    return existing || order;
  }

  deleteOrder(id) {
    this.db.orders = this.db.orders.filter(o => o.id !== id);
    this.save();
  }

  listCustomers() { return this.db.customers; }
  upsertCustomer(data) {
    const c = {
      id: data.id || uid('cus'),
      name: data.name || '',
      allowMixed: data.allowMixed !== false,
      rejectMixedReason: data.rejectMixedReason || '',
      contact: data.contact || '',
      updatedAt: new Date(this.now()).toISOString(),
    };
    const i = this.db.customers.findIndex(x => x.id === c.id);
    if (i >= 0) this.db.customers[i] = c; else this.db.customers.push(c);
    this.save();
    return c;
  }

  /** 拒混装客户清单，供拼单规则引擎解释拦截原因（PRD 9.1 ③） */
  rejectMixedReasons() {
    const out = {};
    for (const c of this.db.customers) if (c.allowMixed === false) out[c.name] = c.rejectMixedReason;
    return out;
  }

  /* ───────── 方案历史与审计快照 ───────── */

  listPlans() { return this.db.plans; }
  getPlan(id) { return this.db.plans.find(p => p.id === id) || null; }

  /**
   * 存一份方案 + 参数快照。
   *
   * 快照存的是**当时那份主数据的副本**，不是 id。否则三个月后 SKU 改了尺寸，
   * 回看历史方案时读到的会是新尺寸，审计就变成了自欺欺人（PRD 验收 C-26）。
   */
  savePlan(plan, ctx = {}) {
    const record = clone(plan);
    // SKU 主数据由 store 自己查：调用方（UI、脚本）可能根本没建 skuMap，
    // 让快照依赖调用方是否传对参数，只会让审计在某些入口静默变成空
    const skuMap = ctx.skuMap || new Map(this.db.skus.map(s => [s.id, s]));
    record.snapshot = buildSnapshot(plan, { ...ctx, skuMap });
    record.savedAt = new Date(this.now()).toISOString();
    this.db.plans.unshift(record);
    // 只留最近 50 份：单份含完整排布坐标，再多会把 localStorage 撑爆
    if (this.db.plans.length > 50) this.db.plans.length = 50;
    this.save();
    return record;
  }

  deletePlan(id) {
    this.db.plans = this.db.plans.filter(p => p.id !== id);
    this.save();
  }

  /** 回溯：某份历史方案当时用的尺寸/重量，与现在的主数据差异（C-26） */
  diffPlanAgainstCurrent(planId) {
    const plan = this.getPlan(planId);
    if (!plan || !plan.snapshot) return null;
    const out = [];
    for (const s of plan.snapshot.skus) {
      const cur = this.getSku(s.id) || (s.code ? this.getSkuByCode(s.code) : null);
      if (!cur) { out.push({ code: s.code, status: 'missing' }); continue; }
      const dimsChanged = !sameDims(cur.dimsCm, s.dimsCm);
      const weightChanged = Math.abs((cur.weightKg || 0) - (s.weightKg || 0)) > 1e-6;
      out.push({
        code: s.code,
        status: dimsChanged || weightChanged ? 'changed' : 'same',
        then: { dimsCm: s.dimsCm, weightKg: s.weightKg, version: s.version },
        now: { dimsCm: cur.dimsCm, weightKg: cur.weightKg, version: cur.version },
      });
    }
    return out;
  }

  /* ───────── 设置 ───────── */

  getSettings() { return this.db.settings; }
  setSettings(patch) {
    this.db.settings = Object.assign(clone(DEFAULT_SETTINGS), this.db.settings, patch);
    if (patch && patch.costs) this.db.settings.costs = Object.assign({}, DEFAULT_SETTINGS.costs, patch.costs);
    this.save();
    return this.db.settings;
  }

  /* ───────── 离线 ───────── */

  isOnline() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return this._online;
  }
  setOnline(v) {
    this._online = !!v;
    this._emit('network', { online: this._online });
    // 恢复联网时立刻把本地队列清掉。纯本地部署没有后端可发，
    // 让 flush 变成异步会让调用方拿不到"同步了几条"，界面上就没法显示"已同步 N 条"
    return this._online ? this._flushSync() : 0;
  }
  /** 离线期间的操作先入队，联网后 flush。有后端时把队列 POST 出去即可 */
  enqueue(op) {
    this.db.pending.push({ id: uid('op'), at: new Date(this.now()).toISOString(), ...op });
    this.save();
    return this.db.pending.length;
  }
  pendingCount() { return this.db.pending.length; }

  _flushSync() {
    const n = this.db.pending.length;
    if (!n) return 0;
    this.db.pending = [];
    this.save();
    return n;
  }

  /** @param {(ops)=>Promise} sender 有则真发（失败会保留队列），无则只清队列 */
  async flush(sender) {
    if (!this.db.pending.length) return 0;
    if (typeof sender === 'function') {
      // 发送失败必须保留队列：宁可下次重发，也不能假装同步成功丢数据
      await sender(clone(this.db.pending));
    }
    return this._flushSync();
  }

  /* ───────── 导入导出 ───────── */

  exportJSON() { return JSON.stringify(this.db, null, 2); }

  importJSON(text, { merge = true } = {}) {
    const incoming = JSON.parse(text);
    if (!incoming || incoming.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`数据版本不匹配（期望 v${SCHEMA_VERSION}），已拒绝导入以免破坏现有主数据`);
    }
    if (!merge) this.db = Object.assign(emptyDb(), incoming);
    else {
      // 按 id 合并，后者覆盖前者：导入即"更新"
      const mergeBy = key => {
        const map = new Map(this.db[key].map(x => [x.id, x]));
        for (const x of incoming[key] || []) map.set(x.id, x);
        this.db[key] = [...map.values()];
      };
      mergeBy('skus'); mergeBy('orders'); mergeBy('customers');
      // 方案按 id 去重后取新的
      const pmap = new Map(this.db.plans.map(x => [x.id, x]));
      for (const x of incoming.plans || []) pmap.set(x.id, x);
      this.db.plans = [...pmap.values()].sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      this.db.settings = Object.assign(clone(DEFAULT_SETTINGS), this.db.settings, incoming.settings || {});
    }
    this.save();
    return { skus: this.db.skus.length, orders: this.db.orders.length, plans: this.db.plans.length };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   辅助
   ═══════════════════════════════════════════════════════════════════ */

function sameDims(a, b) {
  const x = normalizeDimsCm(a || {}), y = normalizeDimsCm(b || {});
  return Math.abs(x.l - y.l) < 0.05 && Math.abs(x.w - y.w) < 0.05 && Math.abs(x.h - y.h) < 0.05;
}

/** 尺寸+重量模糊匹配的得分：0 = 完全一致，越大越不像。取三边相对差与重量相对差的最大值。 */
function fuzzyScore(sku, dimsCm, weightKg) {
  const s = sku.dimsCm, d = dimsCm;
  const dimDiff = Math.max(
    Math.abs(d.l - s.l) / Math.max(1, s.l),
    Math.abs(d.w - s.w) / Math.max(1, s.w),
    Math.abs(d.h - s.h) / Math.max(1, s.h),
  );
  let weightDiff = 0;
  if (weightKg && sku.weightKg) weightDiff = Math.abs(weightKg - sku.weightKg) / Math.max(0.5, sku.weightKg);
  // 尺寸权重更高：装错尺寸会直接毁掉一柜，装错重量只影响账
  return dimDiff * 0.7 + weightDiff * 0.3;
}

function normalizeAttrs(data, base = {}) {
  const src = data.attrs || {};
  const pick = k => {
    if (src[k] != null) return !!src[k];
    if (data[k] != null) return !!data[k];
    return !!base[k];
  };
  const out = {};
  for (const k of Object.keys(GOODS_ATTRS)) out[k] = pick(k);
  out.absorb = pick('absorb');
  if (data.fragile != null) out.fragile = !!data.fragile;
  out.general = !(out.liquid || out.odor || out.absorb || out.sharp || out.damp || out.unsanitary || out.food || out.danger) && !out.fragile;
  return out;
}

/** 方案快照：把"算这份方案时用的主数据"整份拷进去 */
function buildSnapshot(plan, ctx) {
  const skus = [];
  for (const it of (ctx.items || [])) {
    const sku = ctx.skuMap ? ctx.skuMap.get(it.skuId) : null;
    skus.push({
      id: it.skuId,
      code: it.code,
      dimsCm: clone(it.dimsCm || (sku && sku.dimsCm) || {}),
      weightKg: it.weightKg != null ? it.weightKg : (sku ? sku.weightKg : null),
      boxes: it.boxes,
      version: sku ? sku.version : null,
    });
  }
  return {
    takenAt: new Date().toISOString(),
    container: clone(plan.container || {}),
    settings: clone(ctx.settings || {}),
    limits: clone(ctx.limits || {}),
    orders: (ctx.orders || []).map(o => ({ id: o.id, code: o.code, customer: o.customer, port: o.port, vessel: o.vessel, cutOff: o.cutOff })),
    skus,
  };
}

/** 解析 CSV 文本为对象数组；支持带引号、逗号与换行的字段，以及 Excel 的 BOM */
export function parseCSV(text) {
  let s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(x => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

/** 把对象数组写成 CSV（Excel 友好：BOM + CRLF + 引号转义） */
export function toCSV(rows, headers) {
  if (!rows || !rows.length) return '';
  const cols = headers || Object.keys(rows[0]);
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(',')];
  for (const r of rows) body.push(cols.map(c => esc(r[c])).join(','));
  return '﻿' + body.join('\r\n');
}

/** 常见列名别名 → 内部字段。外贸 PI / Excel 表头五花八门，别指望统一 */
const COLUMN_ALIASES = {
  sku: ['sku', 'sku编码', '货号', '编码', '商品编码', 'item', 'code', '商品编号'],
  nameCn: ['品名', '中文品名', '商品名称', 'name', 'description', '货物名称'],
  nameEn: ['英文品名', 'english name', 'name_en', '英文名称'],
  length: ['长', '长度', '长cm', 'l', 'length', '箱长'],
  width: ['宽', '宽度', '宽cm', 'w', 'width', '箱宽'],
  height: ['高', '高度', '高cm', 'h', 'height', '箱高'],
  weightKg: ['毛重', '单箱毛重', '重量', 'weight', 'weightkg', '每箱重量'],
  boxes: ['箱数', '装箱数', 'boxes', 'cartons', '数量', 'qty'],
  pieces: ['件数', '数量(件)', 'pcs', 'pieces', '总件数'],
  packQty: ['装箱数(件/箱)', '每箱件数', 'packqty', '装箱量'],
  port: ['目的港', 'port', '目的码头'],
  vessel: ['船期', '船名航次', 'vessel', 'voyage', '船期航次'],
  customer: ['客户', '客户名称', 'customer', 'buyer'],
  cutOff: ['截关', '截关时间', 'cutoff', 'cut-off', 'etd'],
  unitValue: ['货值', '单价', '单箱货值', 'value', 'unitvalue'],
  supplier: ['供应商', 'supplier', 'factory'],
};

/** 把一行 CSV / PI 解析结果映射到内部字段；认不出的列原样保留在 raw 里 */
export function mapRow(row) {
  const out = { raw: row };
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const key of Object.keys(row)) {
      const norm = String(key).trim().toLowerCase().replace(/[\s_-]/g, '');
      if (aliases.some(a => a.toLowerCase().replace(/[\s_-]/g, '') === norm)) {
        out[field] = row[key];
        break;
      }
    }
  }
  const l = Number(out.length), w = Number(out.width), h = Number(out.height);
  if (l > 0 && w > 0 && h > 0) out.dimsCm = normalizeDimsCm({ l, w, h });
  out.weightKg = Number(out.weightKg) || 0;
  out.boxes = Math.floor(Number(out.boxes) || 0);
  return out;
}
