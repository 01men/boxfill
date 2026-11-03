/**
 * DSH 端集成层。
 *
 * 这套工具的第一用户是仓库里的操作员，但**第二用户是机器**：
 * DSH 侧已有 dsh-lc-parser 这类插件，它拿到货号、箱规、目的港，
 * 需要把数据送进装箱工具、或把结果取走。插件不该去点页面上的按钮。
 *
 * 对外给两条通道，都不要求插件改这个工具的任何代码：
 *
 *   ① URL hash 预填：dsh-lc-parser 拼一个链接跳过来，用户点一下就带着数据进入
 *      h5/app.html#type=40HQ&sku=BX-1001&l=40&w=30&h=25&wt=12&qty=260&port=Jebel%20Ali
 *
 *   ② JS API：页面挂 window.BoxFiller，插件在同页/iframe 里直接调
 *      BoxFiller.upsertSku({...}) / solve() / getPlan() / exportCSV()
 *
 * 两条通道都做了**向后兼容**：不认识的新参数只忽略不报错。
 * 插件升级顺序不该由这边决定。
 */

import { normalizeDimsCm, uid } from './core/units.js';
import { solvePlan } from './core/engine.js';
import { buildBilling } from './core/billing.js';
import { buildLoadingPlanCsv, buildPackingListCsv, buildLoadingPlan } from './core/docs.js';
import { parseCSV, mapRow } from './core/store.js';
import { importCsvToStore } from './core/import.js';

/* ═══════════════════════════════════════════════════════════════════
   ① URL hash 预填
   ═══════════════════════════════════════════════════════════════════ */

/** hash 参数 → 字段映射。数量参数单位统一 cm / kg，锁死不混用（PRD 1.3） */
const NUM_MAP = {
  l: 'length', len: 'length', w: 'width', wid: 'width',
  h: 'height', hei: 'height', wt: 'weightKg', weight: 'weightKg',
  qty: 'boxes', boxes: 'boxes', pcs: 'pieces', pack: 'packQty',
};

/**
 * 解析 hash 预填。
 * @returns {{items:Array, boxType:string|null, port:string|null, order:object|null}|null}
 */
export function parseHash(hash) {
  const raw = String(hash || location.hash || '').replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);

  const out = { items: [], boxType: null, port: null, order: null };
  const num = k => { const v = p.get(k); return v != null && v !== '' && Number.isFinite(+v) ? +v : null; };

  // 柜型：容错匹配 "40HQ" / "40hq" / "40-HQ"
  const t = (p.get('type') || p.get('boxType') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t) {
    const hit = ['20GP', '40GP', '40HQ', '45HQ', '20OT', '40OT', '20FR', '40FR', '20RF', '40RH']
      .find(k => t === k || t.includes(k));
    if (hit) out.boxType = hit;
  }

  const l = num('l') ?? num('len');
  const w = num('w') ?? num('wid');
  const h = num('h') ?? num('hei');
  const wt = num('wt') ?? num('weight');
  const qty = num('qty') ?? num('boxes') ?? num('pcs');

  // 只给了 qty 没给尺寸 → 按总体积反推（沿用旧版 container-loader 的做法）
  let dimsCm = (l && w && h) ? normalizeDimsCm({ l, w, h }) : null;
  const cbm = num('cbm');
  if (!dimsCm && cbm && qty) {
    const per = Math.cbrt(cbm / qty) * 100;   // 立方根估一个近似的立方箱
    dimsCm = normalizeDimsCm({ l: per, w: per, h: per });
  }

  if (dimsCm && wt) {
    out.items.push({
      skuId: p.get('sku') || p.get('code') || `HASH_${uid('x')}`,
      code: p.get('sku') || p.get('code') || 'HASH-SKU',
      nameCn: p.get('name') || '',
      dimsCm, weightKg: wt,
      boxes: qty || 100,
      packQty: num('pack') || 1,
      pieces: num('pcs') || 0,
      source: 'hash',
    });
  }

  const sku = p.get('sku') || p.get('code');
  if (sku) {
    out.order = {
      code: p.get('order') || p.get('po') || 'HASH-ORDER',
      customer: p.get('customer') || '',
      port: p.get('port') || '',
      vessel: p.get('vessel') || '',
      cutOff: p.get('cutoff') || '',
      dueDate: p.get('due') || '',
    };
    out.port = p.get('port') || null;
  }
  return out;
}

/** 把解析结果落到 store 上。store 由调用方传入——这个模块不持有全局状态，
 *  这样它在 Node 下也能被测试，也不会有两套 store 打架。 */
export function applyHash(store) {
  const h = parseHash();
  if (!h || !store) return null;

  for (const it of h.items) {
    // 尺寸或重量对不上就直接跳过，不硬塞：宁可用户手工补，也不能把错数据带进来
    if (!(it.dimsCm && it.dimsCm.l > 0 && it.weightKg > 0)) continue;
    store.upsertSku({
      id: it.skuId, code: it.code, nameCn: it.nameCn,
      dimsCm: it.dimsCm, weightKg: it.weightKg, packQty: it.packQty,
      changeReason: '链接预填',
    });
  }
  if (h.order) {
    store.upsertOrder({
      code: h.order.code, customer: h.order.customer, port: h.order.port,
      vessel: h.order.vessel, cutOff: h.order.cutOff, dueDate: h.order.dueDate,
      lines: h.items.filter(i => i.dimsCm).map(i => ({ skuId: i.skuId, boxes: i.boxes })),
    });
  }
  return h;
}

/* ═══════════════════════════════════════════════════════════════════
   ② JS API
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 挂 window.BoxFiller（本工具的 JS API 主名）。
 * @param {object} ctx {store, state, go, toast, modal, closeModal, getPlan, solve}
 */
export function installDshApi(ctx) {
  const api = {
    version: '2.0.0',

    /** 直接算，不碰界面。插件拿数据进来要结果，用这个。 */
    solve(input = {}) {
      const plan = solvePlan({
        items: input.items || [],
        boxType: input.boxType || 'AUTO',
        limits: input.limits || {},
        pallet: input.pallet === true ? ctx.store.getSettings().pallet : (input.pallet || false),
        availableRatio: input.availableRatio,
        timeLimitMs: input.timeLimitMs || 8000,
        settings: input.settings || ctx.store.getSettings(),
      });
      if (plan.error) return { ok: false, error: plan.error };
      const billing = input.withBilling === false ? null : buildBilling(input.items || [], {
        costs: input.costs || ctx.store.getSettings().costs,
        divisor: (input.settings || ctx.store.getSettings()).volumeDivisor,
        containers: plan.containers.length,
      });
      return {
        ok: true,
        plan,
        billing,
        summary: {
          boxType: plan.boxType,
          containers: plan.containers.length,
          boxes: plan.totals.boxes,
          cbm: plan.totals.cbm,
          weightKg: plan.totals.weightKg,
          utilVol: plan.totals.utilVol,
          utilWeight: plan.totals.utilWeight,
          density: plan.totals.densityKgPerCbm,
          isLight: plan.totals.densityKgPerCbm < 167,
          chargeableKg: plan.totals.chargeableKg,
          spill: plan.spill,
          violations: plan.violations,
        },
      };
    },

    /** 建/改 SKU（插件侧的主数据写入） */
    upsertSku(data) {
      if (!data || !(data.dimsCm && data.weightKg > 0)) {
        return { ok: false, error: 'dimsCm 与 weightKg 必填' };
      }
      const sku = ctx.store.upsertSku(data);
      return { ok: true, sku };
    },
    getSku(code) { return ctx.store.getSkuByCode(code); },
    listSkus() { return ctx.store.listSkus(); },

    /**
     * 导入 CSV / PI 文本（Excel 导出的内容直接丢进来）。
     * 实现下沉到 server/tools.js 的 importCsvToStore —— MCP 的 import_pi 工具
     * 调的是同一段代码，两边不会在"缺尺寸的行怎么处理"这种细节上分叉。
     */
    importCSV(text, opts) {
      return importCsvToStore(ctx.store, text, opts);
    },

    /** 当前界面上的方案（插件想拿已算好的结果时用） */
    getPlan() {
      const p = ctx.getPlan();
      return p ? { ok: true, plan: p, summary: summaryOf(p) } : { ok: false, error: '界面上还没有方案' };
    },

    /** 单据导出（返回字符串，插件自己决定怎么发） */
    export(kind = 'loading') {
      const plan = ctx.getPlan();
      if (!plan) return { ok: false, error: '还没有方案' };
      const docCtx = { plan, billing: null, orders: [], skus: ctx.store.listSkus(), settings: ctx.store.getSettings(), generatedAt: new Date().toISOString() };
      if (kind === 'packing') return { ok: true, type: 'text/csv', text: buildPackingListCsv(docCtx) };
      if (kind === 'html') return { ok: true, type: 'text/html', text: buildLoadingPlan(docCtx, { byLayer: true }) };
      return { ok: true, type: 'text/csv', text: buildLoadingPlanCsv(docCtx) };
    },

    /** 跳转到某一屏（插件把用户从 DSH 带过来后可以定位） */
    goto(screen) {
      if (['measure', 'calc', 'docs', 'data'].includes(screen)) ctx.go(screen);
      return { ok: true };
    },

    /** 往待装清单里塞数据（配合 hash 使用：先塞再让用户点「算」） */
    addLines(lines) {
      for (const l of lines || []) {
        const exist = ctx.state.lines.find(x => x.skuId === l.skuId);
        if (exist) exist.boxes += l.boxes;
        else ctx.state.lines.push({ skuId: l.skuId, code: l.code || l.skuId, boxes: l.boxes });
      }
      return { ok: true, total: ctx.state.lines.reduce((s, l) => s + l.boxes, 0) };
    },

    toast(msg) { ctx.toast(String(msg)); },
  };

  if (typeof window !== 'undefined') {
    window.BoxFiller = api;
    // 历史别名：早期插件按 YiwuBoxLoader 找入口，改版不砸别人的下游
    window.YiwuBoxLoader = api;
  }
  return api;
}

function summaryOf(plan) {
  return {
    boxType: plan.boxType,
    containers: plan.containers.length,
    boxes: plan.totals.boxes,
    cbm: plan.totals.cbm,
    weightKg: plan.totals.weightKg,
    utilVol: plan.totals.utilVol,
    utilWeight: plan.totals.utilWeight,
    violations: plan.violations,
  };
}

/** 生成给 DSH 用的分享链接（插件侧拿去拼跳转地址） */
export function buildShareLink(base, params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    p.set(k, String(v));
  }
  const hash = p.toString();
  return hash ? `${base}#${hash}` : base;
}
