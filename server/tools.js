/**
 * 共用工具层：MCP 服务器与 H5 共用的唯一业务入口。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 之前 H5 的入口是 dsh.js 里的 installDshApi，那是为了在**浏览器页面里**挂
 * window.BoxFiller 给插件调。如果 MCP 再照抄一份，两边就会各自演化——
 * 同一条订单，H5 算 2 柜、Agent 算 3 柜，而且谁也说不清哪个对。
 *
 * 所以规则很简单：**任何业务判断只允许出现在这一层**。
 * MCP 的 stdio / HTTP 两个服务器只是把这里的函数挂成 tool，
 * H5 的 window.BoxFiller 也调这里，core 层负责算，这里负责"把参数凑齐、
 * 把口径对齐、把不完整的输入挡在外面"。
 *
 * 本模块不碰 DOM、不碰 transport、不碰数据库：只接受 store（数据口）
 * 和纯参数，返回可 JSON 序列化的结果。因此它在 Node 下可直接测试。
 */

import { solvePlan, estimateContainers, boxFitsContainer } from '../h5/js/core/engine.js';
import { buildBilling } from '../h5/js/core/billing.js';
import { suggestConsolidation } from '../h5/js/core/consolidate.js';
import { CONTAINERS, MAIN_CONTAINERS, OVERSIZE_SUM_CM, normalizeDimsCm } from '../h5/js/core/units.js';
import { importCsvToStore } from '../h5/js/core/import.js';
import { analyzeImage } from './vision.js';
import {
  buildPackingListCsv, buildLoadingPlanCsv, buildPackingList,
  buildLoadingPlan, buildVgm, buildBalanceReport, buildCostSummary,
} from '../h5/js/core/docs.js';

/* ═══════════════════════════════════════════════════════════════════
   入参校验：Agent 会传脏数据，这里的第一职责是**挡下来并说清缺什么**
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 工具调用统一的错误形状。MCP 把它转成 isError 响应，
 * Agent 就能读到"缺什么字段"而不是一句 undefined。
 */
export class ToolError extends Error {
  constructor(msg, hint) {
    super(msg);
    this.name = 'ToolError';
    this.hint = hint || null;
  }
}

/**
 * 把宽松的 items 输入规范成引擎要的形状。
 *
 * Agent 常犯的三个错：尺寸写成字符串、漏毛重、boxes 写成小数。
 * 这里逐一拦下并给出可执行的提示，而不是让引擎算出 0 柜。
 */
function normalizeItems(input, { requireWeight = true } = {}) {
  const raw = input && (input.items || input.lines);
  if (!Array.isArray(raw) || !raw.length) {
    throw new ToolError('items 不能为空', '至少给一条：{ sku, dimsCm:{l,w,h}, weightKg, boxes }');
  }
  const items = [];
  for (const [i, it] of raw.entries()) {
    if (!it) throw new ToolError(`items[${i}] 是空的`);
    const d = it.dimsCm || it;
    const l = Number(d.l), w = Number(d.w), h = Number(d.h);
    if (!(l > 0 && w > 0 && h > 0)) {
      throw new ToolError(
        `items[${i}] 尺寸不完整或非正数`,
        `收到 l=${d.l} w=${d.w} h=${d.h}；单位是 cm，三边都要大于 0`,
      );
    }
    const weightKg = Number(it.weightKg != null ? it.weightKg : it.weight);
    if (requireWeight && !(weightKg > 0)) {
      throw new ToolError(`items[${i}] 缺毛重`, 'weightKg 单位 kg，必填——没有重量既排不了承重也算不出运费');
    }
    const boxes = Math.floor(Number(it.boxes != null ? it.boxes : it.qty));
    if (!(boxes > 0)) {
      throw new ToolError(`items[${i}] 箱数不合法`, `收到 ${it.boxes}；必须是大于 0 的整数`);
    }
    items.push({
      skuId: it.skuId || it.sku || it.code || `it${i}`,
      code: String(it.code || it.sku || `IT-${i + 1}`),
      nameCn: it.nameCn || it.name || '',
      dimsCm: normalizeDimsCm({ l, w, h }),
      weightKg,
      boxes,
      packQty: Math.max(1, Math.floor(Number(it.packQty) || 1)),
      netWeightKg: Number(it.netWeightKg) || 0,
      maxStack: Math.floor(Number(it.maxStack) || 0),
      noInvert: it.noInvert === true,
      fragile: it.fragile === true,
      attrs: it.attrs || {},
      unitValue: Number(it.unitValue) || 0,
    });
  }
  return items;
}

/** 柜型校验：AUTO 放行，其余必须在柜型库里 */
function normalizeBoxType(boxType) {
  const t = String(boxType || 'AUTO').toUpperCase();
  if (t === 'AUTO') return 'AUTO';
  if (!CONTAINERS[t]) {
    throw new ToolError(
      `未知柜型 ${boxType}`,
      `可用：${MAIN_CONTAINERS.join(' / ')}，或 AUTO 自动比选`,
    );
  }
  return t;
}

/** 限重参数：只取明确的正数，字段缺失就是不限制 */
function normalizeLimits(limits = {}) {
  const out = {};
  for (const k of ['laneLimitKg', 'carrierLimitKg', 'truckLimitKg']) {
    const v = Number(limits[k]);
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   工具实现
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 算装柜方案：几个柜、装得下装不下、还能塞什么、有什么违规。
 * 这是整个工具集的主入口，其余工具都是它的补充。
 */
export function toolPlanContainers(ctx, input = {}) {
  const items = normalizeItems(input);
  const boxType = normalizeBoxType(input.boxType);
  const plan = solvePlan({
    items,
    boxType,
    limits: normalizeLimits(input.limits),
    availableRatio: input.availableRatio,
    pallet: input.pallet === true,
    timeLimitMs: input.timeLimitMs || 8000,
    settings: ctx.store.getSettings(),
  });
  if (plan.error) throw new ToolError(plan.error);

  return {
    boxType: plan.boxType,
    containers: plan.containers.length,
    strategy: plan.strategyName,
    totals: {
      boxes: plan.totals.boxes,
      cbm: plan.totals.cbm,
      weightKg: plan.totals.weightKg,
      utilVol: plan.totals.utilVol,
      utilWeight: plan.totals.utilWeight,
      densityKgPerCbm: plan.totals.densityKgPerCbm,
      isLight: plan.totals.densityKgPerCbm < 167,
    },
    // 每柜明细：Agent 判断"要不要换个柜型"靠的是尾柜的剩余空间
    perContainer: plan.containers.map(c => ({
      index: c.index,
      cbm: c.cbm,
      weightKg: c.weightKg,
      skus: c.items.map(it => ({ code: it.code, boxes: it.boxes, weightKg: it.weightKg })),
      cavityCm: c.cavity ? { l: c.cavity.l / 10, w: c.cavity.w / 10, h: c.cavity.h / 10 } : null,
      fragmentsRatio: c.fragmentsRatio,
    })),
    spill: plan.spill.map(s => ({ code: s.code, boxes: s.boxes, cbm: s.cbm })),
    violations: plan.violations.map(v => ({ level: v.level, msg: v.msg })),
    elapsedMs: plan.elapsedMs,
  };
}

/** 运费：四个重量、渠道比价、箱型比选、附加费、纸箱优化 */
export function toolCalcFreight(ctx, input = {}) {
  const items = normalizeItems(input, { requireWeight: true });
  const settings = ctx.store.getSettings();
  // 柜数没给就自己跑一次排布：运费里的"每柜固定费/THC"都按柜数摊
  let containers = Math.floor(Number(input.containers) || 0);
  if (!(containers > 0)) {
    const p = solvePlan({
      items, boxType: normalizeBoxType(input.boxType),
      limits: normalizeLimits(input.limits), timeLimitMs: 5000, settings,
    });
    containers = p.error ? 1 : p.containers.length;
  }
  const costs = input.costs ? { ...settings.costs, ...input.costs } : settings.costs;
  const b = buildBilling(items, {
    costs,
    divisor: Number(input.divisor) || settings.volumeDivisor,
    containers,
    limits: normalizeLimits(input.limits),
    boxType: normalizeBoxType(input.boxType),
  });
  return {
    containers,
    measure: b.measure,                       // 四个重量与抛比
    recommendedChannel: b.recommendedChannel,
    recommendedBoxType: b.recommendedBoxType,
    channels: b.channels.map(c => ({
      key: c.key, name: c.name, chargeableKg: c.chargeableKg, freight: c.freight,
    })),
    boxTypeCompare: b.boxTypeCompare,
    surcharges: b.surcharges,
    cartonOptimization: b.cartonOptimization,
  };
}

/**
 * 拼单建议：从主数据里挑订单组成一柜，并给出省几个柜、怎么分账。
 * orderCodes 不给就按主数据里全部订单算。
 */
export function toolSuggestConsolidation(ctx, input = {}) {
  const skuMap = new Map(ctx.store.listSkus().map(s => [s.id, s]));
  let orders = ctx.store.listOrders();
  if (Array.isArray(input.orderCodes) && input.orderCodes.length) {
    const want = new Set(input.orderCodes.map(String));
    orders = orders.filter(o => want.has(o.code));
    if (!orders.length) {
      throw new ToolError(
        `主数据里没有订单：${[...want].join(', ')}`,
        '先用 import_pi 导入订单，或不传 orderCodes 直接对全部订单算',
      );
    }
  }
  if (orders.length < 2) {
    throw new ToolError(
      `只有 ${orders.length} 票货，凑不成拼单`,
      '拼单至少要两票；单票想优化装柜请用 plan_containers',
    );
  }
  const res = suggestConsolidation(orders, skuMap, {
    containerCost: Number(input.containerCost) || 18000,
    rejectReasons: ctx.store.rejectMixedReasons(),
    boxType: normalizeBoxType(input.boxType === 'AUTO' ? '40HQ' : input.boxType),
    timeLimitMs: input.timeLimitMs || 5000,
  });
  return {
    containerCost: Number(input.containerCost) || 18000,
    groups: res.groups.map(g => ({
      port: g.port,
      orderCount: g.orderCount,
      suggestions: g.suggestions.map(s => ({
        orders: s.orders.map(o => ({ code: o.code, customer: o.customer, cbm: o.cbm, weightKg: o.weightKg })),
        aloneContainers: s.aloneContainers,
        mergedContainers: s.mergedContainers,
        savedContainers: s.savedContainers,
        savedMoney: s.savedMoney,
        volumeFillPct: s.volumeFillPct,
        weightFillPct: s.weightFillPct,
        // 费用怎么拆——拼柜后必然要分账，少了这个 Agent 只能回一句"建议拼柜"
        costSplit: s.costSplit,
        notes: s.notes.map(n => ({ level: n.level, msg: n.msg })),
      })),
      solo: g.solo.map(s => ({
        code: s.profile.order.code,
        containers: s.containers,
        remainCbm: s.remainCbm,
        remainKg: s.remainKg,
        hint: s.hint,
        options: s.options.map(o => o.label),
      })),
    })),
  };
}

/** 柜型适配：某个箱规能不能进这个柜、过不过得了门框 */
export function toolCheckFits(ctx, input = {}) {
  const boxType = normalizeBoxType(input.boxType === 'AUTO' ? '40HQ' : input.boxType);
  const c = CONTAINERS[boxType];
  const list = Array.isArray(input.dimsList) && input.dimsList.length
    ? input.dimsList
    : [input.dimsCm].filter(Boolean);
  if (!list.length) throw new ToolError('没给箱规', '传 dimsCm:{l,w,h} 或 dimsList: 多个箱规');
  return {
    boxType: {
      code: c.code, nameCn: c.nameCn,
      innerCm: { l: c.L / 10, w: c.W / 10, h: c.H / 10 },
      doorCm: { l: c.doorW / 10, h: c.doorH / 10 },
      availCbm: c.availCbm, maxPayloadKg: c.maxPayloadKg, tareKg: c.tareKg,
    },
    results: list.map(d => {
      const dimsCm = normalizeDimsCm(d);
      const r = boxFitsContainer(dimsCm, boxType);
      // 超长费口径必须与 billing.js 一致：(L+W+H)×2 > 330cm（周长），
      // 漏乘 2 会让这里判出来的结果和实际附加费对不上
      const sumCm = (dimsCm.l + dimsCm.w + dimsCm.h) * 2;
      return {
        dimsCm,
        fits: r.fits,
        doorOk: r.doorOk,
        oversize: sumCm > OVERSIZE_SUM_CM,
        reason: r.reason || null,
      };
    }),
  };
}

/** 柜型库查询：Agent 不知道有哪些柜时先问它 */
export function toolListContainers() {
  return {
    containers: Object.values(CONTAINERS).map(c => ({
      code: c.code, nameCn: c.nameCn,
      innerCm: { l: c.L / 10, w: c.W / 10, h: c.H / 10 },
      doorCm: { l: c.doorW / 10, h: c.doorH / 10 },
      availCbm: c.availCbm, theoCbm: c.theoCbm,
      maxPayloadKg: c.maxPayloadKg, tareKg: c.tareKg,
      usableRatio: c.usableRatio,
      openTop: !!c.openTop, frame: !!c.frame,
    })),
    mainContainers: MAIN_CONTAINERS.slice(),
    unit: { dim: 'cm', weight: 'kg', volume: 'CBM' },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   单据生成
   ═══════════════════════════════════════════════════════════════════ */

const DOC_KINDS = {
  packing: { label: '装箱单 Packing List', render: c => buildPackingList(c), ext: 'html' },
  packing_csv: { label: '装箱单 CSV', render: c => buildPackingListCsv(c), ext: 'csv' },
  loading: { label: '装柜清单 Loading Plan', render: c => buildLoadingPlan(c, { byLayer: true }), ext: 'html' },
  loading_csv: { label: '装柜清单 CSV', render: c => buildLoadingPlanCsv(c), ext: 'csv' },
  vgm: { label: 'VGM 申报数据', render: c => buildVgm(c).html, ext: 'html' },
  balance: { label: '配重报告', render: c => buildBalanceReport(c).html, ext: 'html' },
  cost: { label: '费用汇总', render: c => buildCostSummary(c).html, ext: 'html' },
};

/**
 * 生成单据。plan 不给就用主数据里最近一次方案——
 * Agent 的常见用法是"算完顺手出单"，不该要求它把整个方案再传一遍。
 */
export function toolGenDocs(ctx, input = {}) {
  const kind = String(input.kind || 'packing');
  const spec = DOC_KINDS[kind];
  if (!spec) {
    throw new ToolError(
      `未知单据类型 ${kind}`,
      `可用：${Object.keys(DOC_KINDS).join(' / ')}`,
    );
  }
  let plan = input.plan || null;
  if (!plan) {
    const saved = ctx.store.listPlans()[0];
    if (!saved) {
      throw new ToolError(
        '还没有任何方案',
        '先调 plan_containers，或给本工具传 plan 参数',
      );
    }
    plan = saved;
  }
  const docCtx = {
    plan,
    billing: null,
    orders: Array.isArray(input.orderCodes) && input.orderCodes.length
      ? ctx.store.listOrders().filter(o => input.orderCodes.includes(o.code))
      : ctx.store.listOrders(),
    skus: ctx.store.listSkus(),
    settings: ctx.store.getSettings(),
    generatedAt: new Date().toISOString(),
  };
  let text;
  try {
    text = spec.render(docCtx);
  } catch (err) {
    // 单据层缺字段比算错更难查：把原文带上去，别只回一句"生成失败"
    throw new ToolError(`单据生成失败：${err.message}`, '检查该方案的 SKU 是否还在主数据里');
  }
  return { kind, label: spec.label, format: spec.ext, content: text };
}

/* ═══════════════════════════════════════════════════════════════════
   主数据读写
   ═══════════════════════════════════════════════════════════════════ */

/** 建档 / 改档。传已有 code 即视为更新，会留版本可回溯 */
export function toolUpsertSku(ctx, input = {}) {
  const code = String(input.code || '').trim();
  if (!code) throw new ToolError('缺货号', 'code 必填');
  const dimsCm = normalizeDimsCm(input.dimsCm || {});
  if (!(dimsCm.l > 0)) throw new ToolError('缺尺寸', 'dimsCm:{l,w,h}，单位 cm');
  const weightKg = Number(input.weightKg);
  if (!(weightKg > 0)) throw new ToolError('缺毛重', 'weightKg，单位 kg，必填');
  const existed = ctx.store.getSkuByCode(code);
  const sku = ctx.store.upsertSku({
    id: existed ? existed.id : undefined,
    code,
    nameCn: input.nameCn || input.name || '',
    nameEn: input.nameEn || '',
    dimsCm,
    weightKg,
    packQty: input.packQty,
    netWeightKg: input.netWeightKg,
    maxStack: input.maxStack,
    noInvert: input.noInvert,
    fragile: input.fragile,
    attrs: input.attrs,
    unitValue: input.unitValue,
    supplier: input.supplier,
    location: input.location,
    changeReason: input.changeReason || 'MCP 建档',
  });
  return {
    id: sku.id, code: sku.code, version: sku.version,
    created: !existed,
    dimsCm: sku.dimsCm, weightKg: sku.weightKg,
  };
}

/**
 * 导入 PI/CSV：中文表头自动识别，缺的 SKU 自动建档。
 * 实现本身在 core/import.js，H5 的 window.BoxFiller.importCSV 也调它——
 * 两边不允许各有一份。
 */
export function toolImportPi(ctx, input = {}) {
  const text = String(input.content || input.csv || '');
  if (!text.trim()) throw new ToolError('内容为空', '传 content：CSV 或 PI 导出的文本');
  return importCsvToStore(ctx.store, text, { makeOrders: input.makeOrders !== false });
}

/** 查主数据 */
export function toolListSkus(ctx, input = {}) {
  const q = String(input.query || '').trim().toLowerCase();
  let skus = ctx.store.listSkus();
  if (q) skus = skus.filter(s => s.code.toLowerCase().includes(q) || (s.nameCn || '').toLowerCase().includes(q));
  return {
    count: skus.length,
    skus: skus.slice(0, input.limit || 200).map(s => ({
      id: s.id, code: s.code, nameCn: s.nameCn,
      dimsCm: s.dimsCm, weightKg: s.weightKg, packQty: s.packQty,
      version: s.version, attrs: s.attrs,
    })),
  };
}

/** 查订单 */
export function toolListOrders(ctx, input = {}) {
  const q = String(input.query || '').trim().toLowerCase();
  let orders = ctx.store.listOrders();
  if (q) orders = orders.filter(o => String(o.code).toLowerCase().includes(q) || String(o.customer).toLowerCase().includes(q));
  return {
    count: orders.length,
    orders: orders.slice(0, input.limit || 200).map(o => ({
      id: o.id, code: o.code, customer: o.customer, port: o.port, vessel: o.vessel,
      cutOff: o.cutOff, dueDate: o.dueDate,
      allowMixed: o.customerAllowMixed !== false,
      lines: o.lines.length,
      boxes: o.lines.reduce((s, l) => s + l.boxes, 0),
    })),
  };
}

/**
 * MCP 版照片解析。与 REST 端点 /api/vision/analyze 调的是同一个 analyzeImage——
 * Agent 与 H5 对同一张照片拿到同一个答案。
 */
export function toolAnalyzePhoto(ctx, input = {}) {
  const b64 = String(input.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) throw new ToolError('缺少 imageBase64', '把 PNG 编成 base64 传入（先缩到 1600px 内）');
  let imagePng;
  try {
    imagePng = Buffer.from(b64, 'base64');
  } catch {
    throw new ToolError('imageBase64 不是合法 base64');
  }
  try {
    return analyzeImage(imagePng, {
      roi: input.roi,
      refRealCm: input.refRealCm,
      refPx: input.refPx,
      scaleRegion: input.scaleRegion,
      scaleUnit: input.scaleUnit,
      tareKg: input.tareKg,
    });
  } catch (err) {
    if (err && err.name === 'VisionError') {
      throw new ToolError(err.message, err.hint);
    }
    throw err;
  }
}

/** 主数据按货号聚合后的箱规清单——Agent 要算账时通常只要这个 */
export function toolGetBoxes(ctx, input = {}) {  const skuMap = new Map(ctx.store.listSkus().map(s => [s.id, s]));
  const boxes = [];
  for (const o of ctx.store.listOrders()) {
    if (input.orderCode && o.code !== input.orderCode) continue;
    for (const line of o.lines) {
      const sku = skuMap.get(line.skuId);
      if (!sku) continue;
      boxes.push({
        orderCode: o.code, port: o.port,
        code: sku.code, nameCn: sku.nameCn,
        dimsCm: sku.dimsCm, weightKg: sku.weightKg, boxes: line.boxes,
        packQty: sku.packQty, attrs: sku.attrs,
      });
    }
  }
  const totalCbm = boxes.reduce((s, b) => s + (b.dimsCm.l * b.dimsCm.w * b.dimsCm.h) / 1e6 * b.boxes, 0);
  const totalKg = boxes.reduce((s, b) => s + b.weightKg * b.boxes, 0);
  return {
    count: boxes.length,
    totalCbm: +totalCbm.toFixed(2),
    totalWeightKg: +totalKg.toFixed(1),
    densityKgPerCbm: totalCbm > 0 ? +(totalKg / totalCbm).toFixed(1) : 0,
    boxes,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   注册表：stdio / HTTP 两个服务器共用这一份
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 工具清单。每个条目自带 JSON Schema（MCP 协议要求），
 * 两个 transport 都从这里生成，不存在"两份工具定义"的问题。
 */
export const TOOLS = [
  {
    name: 'list_containers',
    title: '查询柜型库',
    description: '列出所有可用柜型的内尺寸、门框尺寸、可用容积与限重。单位：cm / kg / CBM。不确定有哪些柜型时先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolListContainers,
  },
  {
    name: 'plan_containers',
    title: '测算装柜方案',
    description: '给一组纸箱，算出需要几个柜、每柜装了什么、体积与承重利用率、装不下的甩单、以及合规违规项。这是本工具集的主入口。尺寸 cm、重量 kg。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '纸箱清单',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: '货号' },
              nameCn: { type: 'string' },
              dimsCm: {
                type: 'object',
                description: '外箱三边，单位 cm',
                properties: { l: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
                required: ['l', 'w', 'h'],
              },
              weightKg: { type: 'number', description: '单箱毛重，单位 kg' },
              boxes: { type: 'integer', description: '箱数', minimum: 1 },
              packQty: { type: 'integer', description: '装箱数（件/箱）' },
              noInvert: { type: 'boolean', description: '不可倒置，必须放柜底' },
              fragile: { type: 'boolean', description: '易碎，硬性限堆 3 层' },
              attrs: { type: 'object', description: '货物属性：danger/food/liquid/odor/absorb 等，用于混装禁忌判定' },
            },
            required: ['dimsCm', 'weightKg', 'boxes'],
          },
        },
        boxType: { type: 'string', description: '柜型：20GP/40GP/40HQ/45HQ 等，或 AUTO 自动比选' },
        limits: {
          type: 'object',
          description: '限重覆盖，与箱型上限取最小',
          properties: {
            laneLimitKg: { type: 'number' }, carrierLimitKg: { type: 'number' }, truckLimitKg: { type: 'number' },
          },
        },
        pallet: { type: 'boolean', description: '是否使用托盘' },
        timeLimitMs: { type: 'number', description: '寻优时间上限，默认 8000' },
      },
      required: ['items'],
    },
    handler: toolPlanContainers,
  },
  {
    name: 'calc_freight',
    title: '测算运费',
    description: '按抛比判定抛货/重货，给出四个重量、各渠道运费、箱型比价、附加费与纸箱优化建议。费率走主数据设置，也可用 costs 临时覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', description: '同 plan_containers 的 items' },
        boxType: { type: 'string' },
        containers: { type: 'integer', description: '已知柜数；不给会自动排一次' },
        costs: { type: 'object', description: '费率覆盖：freightPerCbm / freightPerTon / thc / doc / baf 等' },
        divisor: { type: 'number', description: '体积重除数，海运默认 6000' },
      },
      required: ['items'],
    },
    handler: toolCalcFreight,
  },
  {
    name: 'suggest_consolidation',
    title: '拼单建议与费用分摊',
    description: '在主数据订单里找值得拼的组合：先过目的港/截关/客户许可/货物性质硬约束，再贪心合并并吸收更多订单，输出省几个柜、柜内占用率，以及一柜成本如何在各订单间分摊。',
    inputSchema: {
      type: 'object',
      properties: {
        orderCodes: { type: 'array', items: { type: 'string' }, description: '指定参与拼单的订单号；不给则用全部订单' },
        containerCost: { type: 'number', description: '单柜成本 ¥，用于算省多少钱，默认 18000' },
        boxType: { type: 'string' },
      },
    },
    handler: toolSuggestConsolidation,
  },
  {
    name: 'check_fits',
    title: '箱规柜型适配',
    description: '判断某个（或多个）箱规能否装进指定柜型、过不过得了门框，并提示是否触发超长附加费。',
    inputSchema: {
      type: 'object',
      properties: {
        boxType: { type: 'string', description: '默认 40HQ' },
        dimsCm: { type: 'object', description: '单个箱规', properties: { l: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
        dimsList: { type: 'array', description: '批量箱规', items: { type: 'object' } },
      },
    },
    handler: toolCheckFits,
  },
  {
    name: 'gen_docs',
    title: '生成单据',
    description: '生成装箱单 / 装柜清单 / VGM / 配重报告 / 费用汇总。plan 不传则用主数据里最近一次方案。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(DOC_KINDS), description: '单据类型' },
        orderCodes: { type: 'array', items: { type: 'string' } },
        plan: { type: 'object', description: '可选：直接传入方案对象；不给就用最近一次' },
      },
    },
    handler: toolGenDocs,
  },
  {
    name: 'upsert_sku',
    title: '建立/更新 SKU 主数据',
    description: '按货号建档或更新纸箱规格。尺寸或重量变更会自动留版本，可回溯。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '货号' },
        nameCn: { type: 'string' },
        dimsCm: { type: 'object', properties: { l: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['l', 'w', 'h'] },
        weightKg: { type: 'number', required: false },
        packQty: { type: 'integer' },
        noInvert: { type: 'boolean' },
        fragile: { type: 'boolean' },
        attrs: { type: 'object' },
        supplier: { type: 'string' },
      },
      required: ['code', 'dimsCm'],
    },
    handler: toolUpsertSku,
  },
  {
    name: 'import_pi',
    title: '导入 PI / CSV',
    description: '导入 PI 或 Excel 导出的 CSV。自动识别中文表头，缺失的 SKU 自动建档，可按订单号分组生成订单。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'CSV 文本' },
        makeOrders: { type: 'boolean', description: '是否按订单号生成订单，默认 true' },
      },
      required: ['content'],
    },
    handler: toolImportPi,
  },
  {
    name: 'list_skus',
    title: '查询 SKU 主数据',
    description: '按货号或品名搜索已建档的纸箱规格（单个 SKU 的尺寸与重量）。要看某张订单具体要发哪些货、总体积多大，请用 get_order_boxes。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    handler: toolListSkus,
  },
  {
    name: 'list_orders',
    title: '查询订单',
    description: '按订单号或客户搜索订单，含目的港、船期、箱数。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    handler: toolListOrders,
  },
  {
    name: 'get_order_boxes',
    title: '取订单的箱规清单',
    description: '把订单展开成"每个 SKU 多少箱"的清单，并汇总总体积、总重量与抛比。算账前先调它，比让 Agent 猜尺寸可靠。',
    inputSchema: {
      type: 'object',
      properties: { orderCode: { type: 'string', description: '只取某一单；不给则取全部' } },
    },
    handler: toolGetBoxes,
  },
  {
    name: 'analyze_photo',
    title: '解析纸箱照片（实验功能，仅供参考）',
    description: '从一张俯拍照里估算纸箱的长×宽（cm）与秤屏读数（kg）。解析结果仅供参考，不作为结算或出货依据。必须传 base64 编码的 PNG；照片里要有已知长度的参照物（如 A4 纸，用 refRealCm/refPx 告知像素比例），否则量不出厘米。高度在单张俯视图里测不出，重量读不出时返回 null——都不猜。返回值固定带免责声明且 editable:true：结果只是建议，必须让用户核对修改后才能入库。',
    inputSchema: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: 'PNG 图片的 base64（可带 data: 前缀）；先缩到 1600px 内再编码' },
        roi: {
          type: 'object',
          description: '箱体在画面里的区域（0~1 相对坐标），画面里有多个矩形时必传，否则可能量到别的物件',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        refRealCm: { type: 'number', description: '参照物的真实长度 cm（A4 长边 = 29.7）' },
        refPx: { type: 'number', description: '参照物在画面里的像素长度；与 refRealCm 配对才有尺寸' },
        scaleRegion: {
          type: 'object',
          description: '电子秤显示屏区域（0~1 相对坐标）；给了才尝试读重',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        scaleUnit: { type: 'string', description: '秤的单位：kg / lb / g，默认 kg' },
        tareKg: { type: 'number', description: '皮重 kg' },
      },
      required: ['imageBase64'],
    },
    handler: toolAnalyzePhoto,
  },
];

/** 按名字取工具，给两个服务器用同一套分发逻辑 */
export function getTool(name) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new ToolError(`未知工具 ${name}`, `可用工具：${TOOLS.map(x => x.name).join(', ')}`);
  return t;
}

/**
 * 统一分发入口。H5 的 window.BoxFiller 也走这里，
 * 所以两边调用的一定是同一段代码。
 */
export async function callTool(ctx, name, args = {}) {
  const tool = getTool(name);
  try {
    return await tool.handler(ctx, args || {});
  } catch (err) {
    if (err instanceof ToolError) throw err;
    // 算法内部异常一律转成 ToolError：MCP 侧只需要知道"失败了 + 为什么"
    throw new ToolError(`${tool.name} 执行失败：${err.message}`);
  }
}