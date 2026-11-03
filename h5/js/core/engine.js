/**
 * 多 SKU 装箱引擎（PRD 第 6 章）。
 *
 * 为什么是"分层码 + 矩形块"而不是通用 3D Bin Packing
 * ─────────────────────────────────────────────────────────
 * 真实装柜的物理规则决定了算法形态：
 *   1. 集装箱只能从门口往里码，一层铺满再往上堆（PRD 6.2 第 3 条「整层码放」，
 *      明确不允许斜放、悬空、为塞缝破坏层结构）；
 *   2. 因此"某层放不下的东西"不能靠调整该层来解决，只能等下一层或者换柜。
 *
 * 于是问题被拆成两层：每层是 **2D 矩形块装箱**（本层内每个 SKU 摆一个
 * nx×ny 的规整矩形块），层与层之间是简单的堆叠。这比通用 3D 装箱好在哪：
 * 它给出的方案**仓管照着摆就一定摆得出来**，而且每一层都能画成一张俯视图
 * 直接贴到操作台上——这正是 PRD 第 7 章 3D 图存在的意义。
 *
 * 代价是放弃了一部分理论最优（允许悬空塞缝能多装 3~5%），换来的是可执行性。
 * PRD 1.2 已经把产品定位为"工程可行解，非数学最优"。
 *
 * 单位：几何一律 mm 整数（原因见 units.js 顶部说明）。
 */

import {
  CONTAINERS, MAIN_CONTAINERS, dimsCmToMm, mm3ToCbm, cartonCbm,
  resolvePayloadLimit, clone, uid,
  OVERSIZE_SUM_MM, DEFAULT_MAX_STACK, FRAGILE_MAX_STACK,
  SAFETY_TOP_MM, DOOR_END_RESERVE_MM, DEFAULT_SETTINGS, GOODS_ATTRS,
} from './units.js';

const EPS = 1e-6;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ═══════════════════════════════════════════════════════════════════
   输入规整
   ═══════════════════════════════════════════════════════════════════ */

/** 把一条待装行规整成引擎内部用的货物描述，缺字段直接报错（PRD 11 容错：尺寸缺失不允许测算）。 */
function normalizeItem(raw, index) {
  const boxes = Math.floor(Number(raw.boxes) || 0);
  if (!raw.dimsCm) throw new Error(`第 ${index + 1} 个 SKU 缺外箱尺寸，无法测算`);
  const mm = dimsCmToMm(raw.dimsCm);
  if (!(mm.l > 0 && mm.w > 0 && mm.h > 0)) throw new Error(`${raw.code || raw.skuId || 'SKU'} 外箱尺寸不合法`);
  const weightKg = Number(raw.weightKg);
  if (!(weightKg > 0)) throw new Error(`${raw.code || raw.skuId || 'SKU'} 缺单箱毛重，无法测算`);
  if (boxes <= 0) throw new Error(`${raw.code || raw.skuId || 'SKU'} 箱数为 0，已拦截`);

  const attrs = raw.attrs || {};
  const fragile = !!(attrs.fragile || raw.fragile);
  // maxStack 留空 = 不限（按物理层数与顶部安全余量算）；显式填写才生效。
  // 易碎品是例外：硬压到 3 层，并在违规清单里留痕（PRD 验收 C-06）。
  const rawMaxStack = Math.floor(Number(raw.maxStack) || DEFAULT_MAX_STACK);
  const maxStack = fragile
    ? Math.min(rawMaxStack > 0 ? rawMaxStack : FRAGILE_MAX_STACK, FRAGILE_MAX_STACK)
    : (rawMaxStack > 0 ? rawMaxStack : Infinity);
  const stackCapped = fragile && rawMaxStack > FRAGILE_MAX_STACK;

  const packQty = Math.max(1, Math.floor(Number(raw.packQty) || 1));
  const natural = raw.noInvert && raw.noInvertDimsCm ? dimsCmToMm(raw.noInvertDimsCm) : mm;

  return {
    key: raw.skuId || raw.code || `item${index}`,
    skuId: raw.skuId || raw.code || `item${index}`,
    code: raw.code || raw.skuId || `ITEM${index + 1}`,
    nameCn: raw.nameCn || raw.name || raw.code || '',
    nameEn: raw.nameEn || '',
    mm,                                   // 归一后的三边（长≥宽≥高）
    cartonCbm: mm3ToCbm(mm.l * mm.w * mm.h),
    weightKg,
    boxes,
    remaining: boxes,
    piecesPerBox: packQty,
    pieces: boxes * packQty,
    netWeightKg: Number(raw.netWeightKg) || 0,
    maxStack,
    stackCapped,
    fragile,
    noInvert: !!raw.noInvert,
    natural,                              // 不可倒置时的自然朝向
    attrs: {
      liquid: !!(attrs.liquid || raw.liquid),
      odor: !!(attrs.odor || raw.odor),
      absorb: !!(attrs.absorb || raw.absorb),
      sharp: !!(attrs.sharp || raw.sharp),
      damp: !!(attrs.damp || raw.damp),
      unsanitary: !!(attrs.unsanitary || raw.unsanitary),
      food: !!(attrs.food || raw.food),
      danger: !!(attrs.danger || raw.danger),
      fragile,
      general: !(attrs.liquid || attrs.odor || attrs.absorb || attrs.sharp || attrs.damp ||
                 attrs.unsanitary || attrs.food || attrs.danger) && !fragile,
    },
    unitValue: Number(raw.unitValue) || 0,
    orderId: raw.orderId || '',
    stackLayers: 0,                       // 已占用的堆码层数
    placedContainers: 0,
  };
}

/** 一个 SKU 的全部候选朝向（6 种排列，去重）。order 决定优先试哪种摆法。 */
function orientations(item, order = 'fit') {
  const { l, w, h } = item.mm;
  let list = [
    { l, w, h, name: 'L×W×H' },
    { l: w, w: h, h: l, name: 'W×H×L' },
    { l: w, w: l, h, name: 'W×L×H' },
    { l, w: h, h: w, name: 'L×H×W' },
    { l: h, w: l, h: w, name: 'H×L×W' },
    { l: h, w: w, h: l, name: 'H×W×L' },
  ];
  // 去重：正方体之类会产出 6 个完全相同的朝向，白白让搜索空间膨胀 6 倍
  const seen = new Set();
  list = list.filter(o => {
    const k = `${o.l}x${o.w}x${o.h}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (item.noInvert) {
    const nat = item.natural;
    list = list.filter(o => o.l === nat.l && o.w === nat.w && o.h === nat.h);
  }
  if (order === 'lowest') list.sort((a, b) => a.h - b.h);          // 层薄一点，换更多层数
  else if (order === 'flat') list.sort((a, b) => (a.l * a.w) - (b.l * b.w)); // 底面积小的先试，先把碎空间填掉
  else list.sort((a, b) => (a.l * a.w * a.h) - (b.l * b.w * b.h)); // 体积小的先试
  return list;
}

/* ═══════════════════════════════════════════════════════════════════
   空闲矩形（2D）
   ═══════════════════════════════════════════════════════════════════ */

const overlaps = (a, b) =>
  a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;

/** 从空闲矩形列表中挖掉一个 void（竖向禁区：本层不能放东西的区域）。 */
function subtractVoid(free, v) {
  const out = [];
  for (const r of free) {
    if (!overlaps(r, v)) { out.push(r); continue; }
    if (v.x > r.x + EPS) out.push({ x: r.x, y: r.y, w: v.x - r.x, h: r.h });
    if (r.x + r.w > v.x + v.w + EPS) out.push({ x: v.x + v.w, y: r.y, w: r.x + r.w - (v.x + v.w), h: r.h });
    const mx = Math.max(r.x, v.x);
    const mw = Math.min(r.x + r.w, v.x + v.w) - mx;
    if (mw > EPS) {
      if (v.y > r.y + EPS) out.push({ x: mx, y: r.y, w: mw, h: v.y - r.y });
      if (r.y + r.h > v.y + v.h + EPS) out.push({ x: mx, y: v.y + v.h, w: mw, h: r.y + r.h - (v.y + v.h) });
    }
  }
  return out.filter(r => r.w > EPS && r.h > EPS);
}

/** 放完一个矩形块后把它占掉的区域从空闲列表里挖掉。 */
function consumeRect(free, used) {
  return subtractVoid(free, used);
}

/** 选一个能塞下 nx×ny 块的空闲矩形：能放最多箱优先，其次剩余面积最小（塞缝优先）。 */
function pickFreeRect(free, o) {
  let best = null;
  for (const r of free) {
    const nx = Math.floor((r.w + EPS) / o.l);
    const ny = Math.floor((r.h + EPS) / o.w);
    if (nx <= 0 || ny <= 0) continue;
    const fits = nx * ny;
    const waste = r.w * r.h - fits * o.l * o.w;
    if (!best || fits > best.fits || (fits === best.fits && waste < best.waste - EPS)) {
      best = { rect: r, nx, ny, fits, waste };
    }
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════
   策略：这一层先码哪个 SKU
   ═══════════════════════════════════════════════════════════════════ */

const STRATEGIES = [
  {
    key: 'volume', name: '体积优先', oriOrder: 'fit',
    desc: '大箱优先打底，小箱补缝，先把容积吃满',
    sort: (a, b) => b.mm.l * b.mm.w * b.mm.h - a.mm.l * a.mm.w * a.mm.h,
  },
  {
    key: 'weight', name: '重量优先', oriOrder: 'lowest',
    desc: '按密度降序，重货先入柜底（CTU Code 重下轻上）',
    sort: (a, b) => (b.weightKg / b.cartonCbm) - (a.weightKg / a.cartonCbm),
  },
  {
    key: 'divisible', name: '整除优先', oriOrder: 'fit',
    desc: '优先选与柜内长宽整除余数最小的朝向，减少弃位',
    sort: (a, b, ctx) => remainderScore(a, ctx) - remainderScore(b, ctx),
  },
  {
    key: 'compat', name: '混装亲和', oriOrder: 'fit',
    desc: '同属性货物集中，减少换柜与混装禁忌',
    sort: (a, b, ctx) => (compatGroup(a) - compatGroup(b)) || (b.mm.l * b.mm.w * b.mm.h - a.mm.l * a.mm.w * a.mm.h),
  },
];

function remainderScore(item, ctx) {
  let best = Infinity;
  for (const o of orientations(item, 'fit')) {
    const rL = ctx.container.L % o.l;
    const rW = ctx.container.W % o.w;
    best = Math.min(best, rL + rW);
  }
  return Number.isFinite(best) ? best : 1e9;
}

function compatGroup(item) {
  // 用属性集合的哈希分桶，同桶的货尽量同柜，避免"香水和毛绒混在一柜"再靠告警拦截
  const tags = Object.entries(item.attrs).filter(([, v]) => v).map(([k]) => k).sort().join(',');
  let h = 0;
  for (let i = 0; i < tags.length; i++) h = (h * 31 + tags.charCodeAt(i)) % 7;
  return h;
}

function strategyByKey(key) {
  return STRATEGIES.find(s => s.key === key) || STRATEGIES[0];
}

/* ═══════════════════════════════════════════════════════════════════
   装一个柜
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 分层贪心装一个柜。
 * @returns Container（含 layers / items / freeRects / cavity / distribution / balance）
 */
function packContainer(container, cargo, cfg, strategy, deadline) {
  const limit = resolvePayloadLimit(container, cfg.limits);
  const usableCbm = container.theoCbm * (cfg.availableRatio ?? container.usableRatio);
  const pallet = cfg.pallet;
  const palletMode = !!pallet;
  const cellL = pallet ? pallet.l : 0, cellW = pallet ? pallet.w : 0;

  const layers = [];
  const layerAttrTrace = [];          // 每层的属性，用于液体/气味禁忌回溯告警
  const containerAttrMask = {};       // 柜内出现过的属性，用于同柜冲突判定
  let weight = 0, cbm = 0, z = 0;
  let voids = [];                     // 竖向禁区（不可倒置货上方必须留空）
  let timedOut = false;

  while (true) {
    if (now() > deadline) { timedOut = true; break; }

    const usableH = container.H - (palletMode ? 0 : cfg.safetyTopMm);
    const remainH = usableH - z;
    if (remainH <= EPS) break;
    if (weight >= limit.kg - EPS) break;
    if (cbm >= usableCbm - EPS) break;
    if (palletMode && layers.length >= pallet.stackMax) break;

    // 液体尽量置顶（PRD 6.2 第 8 条「液体不压固体」）：已放过液体的层之上只许再放液体
    const liquidBelow = layerAttrTrace.some(t => t.liquid);
    if (liquidBelow && cfg.liquidPolicy === 'top') {
      // 不阻断，只是不再放固体——通过候选过滤实现，见下
    }

    const layer = packOneLayer({
      container, cargo, cfg, strategy, z, remainH,
      weightLeft: limit.kg - weight,
      cbmLeft: usableCbm - cbm,
      voids, palletMode, pallet, cellL, cellW,
      excludeSolidAboveLiquid: liquidBelow && cfg.liquidPolicy === 'top',
    });
    if (layer.boxes.length === 0) break;

    layers.push(layer);
    weight += layer.weightKg;
    cbm += layer.cbm;
    z += layer.h;
    voids = layer.noStackRects;
    layerAttrTrace.push(layer.attrs);
    for (const k of Object.keys(layer.attrs)) if (layer.attrs[k]) containerAttrMask[k] = true;
    if (cfg.onProgress) cfg.onProgress({ z, weight, cbm, layers: layers.length });
  }

  return finalizeContainer({
    container, cargo, layers, layerAttrTrace, containerAttrMask,
    weight, cbm, timedOut, limit, usableCbm, palletMode, cfg,
  });
}

/** 铺一层：每个 SKU 在本层摆一个 nx×ny 的规整矩形块。 */
function packOneLayer(ctx) {
  const { container, cargo, cfg, strategy, z, remainH, weightLeft, cbmLeft, voids,
          palletMode, pallet, cellL, cellW, excludeSolidAboveLiquid } = ctx;

  const gap = cfg.gapMm || 0;
  // 本层的落位基准面
  let free;
  if (palletMode) {
    // 托盘模式：柜底先摆托盘网格，每个托盘是一个独立落位区
    const cells = [];
    const stepL = cellL + 20, stepW = cellW + 20;   // 托盘之间留 20mm 叉车作业缝
    const nx = Math.floor((container.L + 20) / stepL);
    const ny = Math.floor((container.W + 20) / stepW);
    const usedL = nx * stepL - 20, usedW = ny * stepW - 20;
    const ox = (container.L - usedL) / 2, oy = (container.W - usedW) / 2;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      cells.push({ x: Math.round(ox + ix * stepL), y: Math.round(oy + iy * stepW), w: cellL, h: cellW, pallet: true });
    }
    free = cells;
  } else {
    free = [{ x: 0, y: 0, w: container.L, h: container.W }];
    for (const v of voids) free = subtractVoid(free, v);
  }

  const layerBoxes = [];
  const layerNoStack = [];
  const layerAttrs = { liquid: false, odor: false, absorb: false, sharp: false, danger: false, food: false, unsanitary: false, damp: false, general: false };
  let layerH = 0;
  let layerWeight = 0, layerCbm = 0;
  const usedSkus = new Set();

  // 候选：本层还能放（有余量、堆码层数未超、非禁止组合）的货物，按策略排序
  const candidates = cargo
    .filter(it => it.remaining > 0 && it.stackLayers < it.maxStack && !usedSkus.has(it.key))
    .filter(it => !(excludeSolidAboveLiquid && !it.attrs.liquid))
    .slice()
    .sort((a, b) => strategy.sort(a, b, { container }));

  for (const item of candidates) {
    if (usedSkus.has(item.key)) continue;

    // 不可倒置的货必须落在柜底（PRD 验收 C-07）
    if (item.noInvert && z > EPS) continue;

    // 液体置顶策略：本层若已放过非液体，则液体不参与（避免液体压固体）
    if (cfg.liquidPolicy === 'top' && item.attrs.liquid && layerAttrs.general) continue;

    const heightBase = palletMode ? pallet.h : 0;

    // 朝向选择：不能"拿到第一个放得下的就用"。
    // 层高一旦定死，这一层就同时决定了还能往上码几层——983×781×588 每层 18 箱但只够码 3 层，
    // 换成 983×588×781 每层 24 箱能码满 3 层，总量差 33%。所以按
    //「本层箱数 × 剩余高度还能码几层」预估总收益再选朝向。
    let chosen = null;
    for (const o of orientations(item, strategy.oriOrder)) {
      const ol = o.l + gap, ow = o.w + gap, oh = o.h + gap;
      if (heightBase + oh > remainH + EPS) continue;
      if (palletMode && (o.l > cellL + EPS || o.w > cellW + EPS)) continue;

      const pick = pickFreeRect(free, o);
      if (!pick) continue;

      const capByCargo = Math.min(
        item.remaining,
        Math.floor((weightLeft - layerWeight) / item.weightKg + EPS),
        Math.floor((cbmLeft - layerCbm) / item.cartonCbm + EPS),
      );
      if (capByCargo <= 0) continue;

      const n = Math.min(pick.fits, capByCargo);
      // 剩余高度按同朝向还能再码几层来估（托盘模式每层还要加托盘高）
      const stepH = oh + (palletMode ? pallet.h : 0);
      const layersLeft = Math.floor((remainH / stepH) + EPS);
      const value = n * layersLeft;

      if (!chosen
        || value > chosen.value + EPS
        || (Math.abs(value - chosen.value) <= EPS && n > chosen.n + EPS)
        || (Math.abs(value - chosen.value) <= EPS && n === chosen.n && oh < chosen.oh - EPS)) {
        chosen = { o, pick, n, value, ol, ow, oh };
      }
    }

    if (chosen) {
      const { o, pick, n, ol, ow, oh } = chosen;
      const rows = Math.ceil(n / pick.nx);
      const usedRect = {
        x: pick.rect.x, y: pick.rect.y,
        w: Math.min(pick.rect.w, pick.nx * ol),
        h: Math.min(pick.rect.h, rows * ow),
      };

      // 实际落位数必须按 n 收口。n 是"余量/限重/可用容积三者夹逼"出来的，
      // 这里若只靠 item.remaining 收口，一旦余量先耗尽就会突破可用容积——
      // 表现为装出一柜 29.8 CBM 却宣称可用容积只有 27.9 的超载方案。
      let placedHere = 0;
      outer:
      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < pick.nx; ix++) {
          if (placedHere >= n || item.remaining <= 0) break outer;
          layerBoxes.push({
            x: pick.rect.x + ix * ol,
            y: pick.rect.y + iy * ow,
            z: z + heightBase,
            w: ol, h: ow, d: oh,
            skuId: item.skuId, code: item.code, oriName: o.name,
          });
          placedHere += 1;
          item.remaining -= 1;
          layerWeight += item.weightKg;
          layerCbm += item.cartonCbm;
        }
      }
      if (placedHere === 0) continue;

      // 同一 SKU 只允许在本层出现一个矩形块（整层码放）
      usedSkus.add(item.key);
      item.stackLayers += 1;
      layerH = Math.max(layerH, oh);
      for (const [k, v] of Object.entries(item.attrs)) if (v) layerAttrs[k] = true;
      free = consumeRect(free, usedRect);
      // 不可倒置的货上方必须留空（PRD 验收 C-07：底部必须是柜底）
      if (item.noInvert && !palletMode) layerNoStack.push({ ...usedRect });
    }
  }

  if (layerBoxes.length === 0) return { boxes: [], h: 0, weightKg: 0, cbm: 0, noStackRects: voids, attrs: layerAttrs };

  const h = layerH + (palletMode ? pallet.h : 0);
  return {
    z, h,
    boxes: layerBoxes,
    weightKg: layerWeight,
    cbm: layerCbm,
    noStackRects: layerNoStack.length ? layerNoStack : voids,
    attrs: layerAttrs,
    cargoH: layerH,
  };
}

/** 收尾：聚合、剩余空间量化、配重剖面、违规扫描。 */
function finalizeContainer(input) {
  const { container, cargo, layers, layerAttrTrace, containerAttrMask,
          weight, cbm, timedOut, limit, usableCbm, palletMode, cfg } = input;

  layers.forEach((l, i) => { l.index = i + 1; });

  // 按 SKU 聚合。cargo 是这一轮实际跑的货物数组（重量/体积/装箱数都在这里）
  const byId = new Map(cargo.map(c => [c.skuId, c]));
  const bySku = new Map();
  for (const l of layers) for (const b of l.boxes) {
    const src = byId.get(b.skuId);
    let e = bySku.get(b.skuId);
    if (!e) {
      e = {
        skuId: b.skuId, code: b.code,
        nameCn: src ? src.nameCn : b.code, nameEn: src ? src.nameEn : '',
        boxes: 0, weightKg: 0, cbm: 0, pieces: 0,
        noInvert: src ? src.noInvert : false,
        stackTop: src ? src.stackLayers : 0,
        unitValue: src ? src.unitValue : 0,
      };
      bySku.set(b.skuId, e);
    }
    e.boxes += 1;
    e.weightKg += src ? src.weightKg : 0;
    e.cbm += src ? src.cartonCbm : 0;
    e.pieces += src ? src.piecesPerBox : 0;
  }

  const items = [...bySku.values()].map(e => ({
    ...e,
    weightKg: +e.weightKg.toFixed(2),
    cbm: +e.cbm.toFixed(4),
    pieces: Math.round(e.pieces),
    value: +(e.boxes * (e.unitValue || 0)).toFixed(2),
  }));

  // 剩余空间：只认**顶层**的空洞。整层码放下，中间层的缝是封死的，塞不进去，
  // 报给用户当"可入洞"就是在骗人（PRD 6.4 要求量化到具体尺寸）。
  let freeRects = [];
  let cavity = null;
  const topLayer = layers[layers.length - 1];
  if (topLayer) {
    const remainH = container.H - (topLayer.z + topLayer.h) - (palletMode ? 0 : cfg.safetyTopMm);
    freeRects = computeTopVoid(topLayer, container, palletMode);
    if (remainH > EPS) {
      for (const r of freeRects) {
        const cand = { l: Math.round(r.w), w: Math.round(r.h), h: Math.round(remainH) };
        if (!cavity || cand.l * cand.w > cavity.l * cavity.w) cavity = cand;
      }
    }
  }

  // 占位体积 = 实际摆满的块（含竖向禁区）→ 碎片空间率
  let occupiedVol = 0;
  for (const l of layers) {
    const area = l.boxes.reduce((s, b) => s + b.w * b.h, 0)
      + (l.noStackRects || []).reduce((s, r) => s + r.w * r.h, 0);
    occupiedVol += area * l.h;
  }
  const cargoVol = cbm * 1e9;
  const fragmentsRatio = occupiedVol > EPS ? Math.max(0, 1 - cargoVol / occupiedVol) : 0;

  // 配重剖面：沿柜长切 10 段
  const segments = 10;
  const distribution = Array.from({ length: segments }, (_, i) => ({
    from: Math.round(container.L * i / segments),
    to: Math.round(container.L * (i + 1) / segments),
    kg: 0,
  }));
  for (const l of layers) for (const b of l.boxes) {
    const it = cargo.find(c => c.skuId === b.skuId);
    const w = it ? it.weightKg : 0;
    // 箱体跨段时按重叠长度分摊，避免"整箱记在起点"导致剖面失真
    for (const seg of distribution) {
      const ov = Math.min(b.x + b.w, seg.to) - Math.max(b.x, seg.from);
      if (ov > 0) seg.kg += w * (ov / b.w);
    }
  }
  for (const seg of distribution) seg.kg = +seg.kg.toFixed(1);

  const halfL = container.L / 2, halfW = container.W / 2;
  let doorHalf = 0, headHalf = 0, leftHalf = 0, rightHalf = 0;
  for (const l of layers) for (const b of l.boxes) {
    const it = cargo.find(c => c.skuId === b.skuId);
    const w = it ? it.weightKg : 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (cx < halfL) doorHalf += w; else headHalf += w;
    if (cy < halfW) leftHalf += w; else rightHalf += w;
  }
  const total = weight || 1;
  const balance = {
    frontDiffKg: Math.round(Math.abs(doorHalf - headHalf)),
    sideDiffKg: Math.round(Math.abs(leftHalf - rightHalf)),
    endMaxRatio: +Math.max(doorHalf / total, headHalf / total).toFixed(3),
    passed: Math.abs(doorHalf - headHalf) <= 800 && Math.abs(leftHalf - rightHalf) <= 500
      && Math.max(doorHalf / total, headHalf / total) <= 0.6 + EPS,
  };

  return {
    index: 0, boxType: container.code,
    L: container.L, W: container.W, H: container.H,
    doorW: container.doorW, doorH: container.doorH,
    tareKg: container.tareKg,
    maxPayloadKg: limit.kg,
    limitSources: limit.sources,
    usableCbm: +usableCbm.toFixed(2),
    palletized: palletMode,
    items,
    layers,
    freeRects,
    cavity,
    fragmentsRatio: +fragmentsRatio.toFixed(4),
    weightKg: +weight.toFixed(2),
    cbm: +cbm.toFixed(3),
    utilVol: container.theoCbm > 0 ? cbm / container.theoCbm : 0,
    utilWeight: limit.kg > 0 ? weight / limit.kg : 0,
    attrMask: containerAttrMask,
    layerAttrTrace,
    distribution,
    balance,
    timedOut,
  };
}

/** 顶层空洞：把最后一层"没放东西"的区域算出来。 */
function computeTopVoid(topLayer, container, palletMode) {
  // 起点是整个柜底，逐个挖掉顶层放下的矩形块
  let free = [{ x: 0, y: 0, w: container.L, h: container.W }];
  for (const b of topLayer.boxes) free = subtractVoid(free, { x: b.x, y: b.y, w: b.w, h: b.h });
  if (palletMode) {
    // 托盘模式下整块托盘台面算占用：托盘本身占掉了地面，空隙在托盘之间
    free = free.filter(r => !(r.w > container.L * 0.5 && r.h > container.W * 0.5));
  }
  return free.filter(r => r.w > 20 && r.h > 20);
}

/* ═══════════════════════════════════════════════════════════════════
   整票测算入口
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 整票货测算。
 * @param {object} input
 *   items: 待装行数组 [{skuId, code, dimsCm, weightKg, boxes, maxStack, noInvert, attrs, packQty, ...}]
 *   boxType: 'AUTO' | '40HQ' ...   AUTO = 箱型比选（PRD 8 / C-23）
 *   limits: {laneLimitKg, carrierLimitKg, truckLimitKg}
 *   pallet: null | {l,w,h,stackMax}
 *   timeLimitMs: 硬超时（PRD 11：8 秒）
 * @returns Plan
 */
export function solvePlan(input = {}) {
  const started = now();
  const settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const cfg = {
    gapMm: input.gapMm || 0,
    safetyTopMm: input.safetyTopMm ?? SAFETY_TOP_MM,
    doorEndReserveMm: input.doorEndReserveMm ?? DOOR_END_RESERVE_MM,
    pallet: input.pallet === false ? null : (input.pallet || (settings.pallet && settings.pallet.enabled ? settings.pallet : null)),
    availableRatio: input.availableRatio ?? settings.availableRatio,
    liquidPolicy: input.liquidPolicy || settings.liquidPolicy,
    limits: input.limits || {},
    timeLimitMs: input.timeLimitMs ?? 8000,
    oversizeFee: settings.costs.oversizeFeePerBox,
    onProgress: input.onProgress,
  };

  let items;
  try {
    items = (input.items || []).map(normalizeItem);
  } catch (err) {
    return { error: err.message, containers: [], totals: null, violations: [] };
  }
  if (items.length === 0) return { error: '没有待装货物', containers: [], totals: null, violations: [] };

  const candidates = input.boxType === 'AUTO' || !input.boxType
    ? MAIN_CONTAINERS
    : [input.boxType];

  const deadline = started + cfg.timeLimitMs;
  let best = null;
  const runs = [];
  let timedOut = false;

  for (const code of candidates) {
    const container = CONTAINERS[code];
    if (!container) continue;
    const strategyKeys = input.strategy ? [input.strategy] : STRATEGIES.map(s => s.key);
    for (const key of strategyKeys) {
      if (now() > deadline) { timedOut = true; break; }
      const run = runOne(items, container, cfg, strategyByKey(key));
      run.strategy = key;
      run.strategyName = strategyByKey(key).name;
      run.boxType = code;
      runs.push(run);
      if (!best || run.score > best.score) best = run;
    }
    if (now() > deadline) { timedOut = true; break; }
  }

  if (!best) return { error: '无法生成方案：箱型与货型不匹配', containers: [], totals: null, violations: [] };

  return assemblePlan({
    best, runs, items, cfg, container: CONTAINERS[best.boxType],
    volumeDivisor: settings.volumeDivisor, timedOut,
    elapsedMs: now() - started,
  });
}

/** 跑一次「柜型 × 策略」完整装柜。 */
function runOne(templateItems, container, cfg, strategy) {
  // 每次重跑都从原始箱数开始：装箱会就地扣减 remaining，不还原就会第二次跑出空柜
  const cargo = templateItems.map(it => ({ ...it }));
  const containers = [];
  let guard = 0;

  while (cargo.some(c => c.remaining > 0)) {
    if (++guard > 200) break;                       // 兜底：绝不允许无限开柜
    // 堆码层数是**柜内**约束：同一个 SKU 跨柜时，每一柜都可以从第 1 层重新码起，
    // 不重置会让"跨 3 个柜的大批量 SKU"在第 2 个柜就撞上限，少装一大截货。
    for (const it of cargo) it.stackLayers = 0;
    const c = packContainer(container, cargo, cfg, strategy, now() + cfg.timeLimitMs);
    if (c.layers.length === 0 || c.weightKg <= 0) break;   // 放不下任何东西 → 停
    c.index = containers.length + 1;
    containers.push(c);
    if (c.timedOut) break;
  }

  const spill = cargo
    .filter(c => c.remaining > 0)
    .map(c => ({ skuId: c.skuId, code: c.code, nameCn: c.nameCn, boxes: c.remaining, cbm: +(c.remaining * c.cartonCbm).toFixed(3) }));

  const totals = aggregate(containers);
  // 打分：体积与重量利用率同时看。只看体积，重货方案会被误判成"装得差"——
  // 重量先触顶的货本来就装不满容积，那不是排布问题（PRD 1.2）。
  const score = totals.utilVol + totals.utilWeight * 0.6 + totals.boxes * 1e-6;

  return { boxType: container.code, containers, totals, spill, score, cargo };
}

function aggregate(containers) {
  const t = { boxes: 0, weightKg: 0, cbm: 0, containerCount: containers.length, utilization: 0 };
  for (const c of containers) {
    t.boxes += c.items.reduce((s, i) => s + i.boxes, 0);
    t.weightKg += c.weightKg;
    t.cbm += c.cbm;
  }
  t.weightKg = +t.weightKg.toFixed(2);
  t.cbm = +t.cbm.toFixed(3);
  let theo = 0, payload = 0;
  for (const c of containers) { theo += c.L * c.W * c.H / 1e9; payload += c.maxPayloadKg; }
  t.utilVol = theo > 0 ? t.cbm / theo : 0;
  t.utilWeight = payload > 0 ? t.weightKg / payload : 0;
  return t;
}

/** 把最优 run 包装成对外的 Plan 结构（docs / billing / UI 都按这个契约读）。 */
function assemblePlan({ best, runs, items, cfg, container, volumeDivisor, timedOut, elapsedMs }) {
  const containers = best.containers;
  const spill = best.spill;

  let boxes = 0, weightKg = 0, cbm = 0;
  for (const c of containers) {
    boxes += c.items.reduce((s, i) => s + i.boxes, 0);
    weightKg += c.weightKg;
    cbm += c.cbm;
  }

  // 体积重：Σ(cm³)/系数（PRD 8）。按整票货算——甩单那部分最后还是要走的，
  // 运费也照付，所以计费口径必须是"这票货总共多少方"，不是"这一柜装了多少方"。
  let volCm3 = 0;
  for (const it of items) volCm3 += (it.mm.l / 10) * (it.mm.w / 10) * (it.mm.h / 10) * it.boxes;
  const volumetricKg = volumeDivisor === Infinity ? 0 : volCm3 / volumeDivisor;
  const densityKgPerCbm = cbm > 0 ? weightKg / cbm : 0;
  const chargeableKg = Math.max(weightKg, volumetricKg);

  const theoTotal = containers.reduce((s, c) => s + c.L * c.W * c.H / 1e9, 0);
  const payloadTotal = containers.reduce((s, c) => s + c.maxPayloadKg, 0);

  const totals = {
    boxes,
    weightKg: +weightKg.toFixed(2),
    cbm: +cbm.toFixed(3),
    volumetricKg: +volumetricKg.toFixed(2),
    densityKgPerCbm: +densityKgPerCbm.toFixed(1),
    chargeableKg: +chargeableKg.toFixed(2),
    utilVol: theoTotal > 0 ? +(cbm / theoTotal).toFixed(4) : 0,
    utilWeight: payloadTotal > 0 ? +(weightKg / payloadTotal).toFixed(4) : 0,
    containerCount: containers.length,
    pieces: items.reduce((s, i) => s + i.pieces, 0),
  };

  const violations = scanViolations({ containers, items, spill, cfg, volumeDivisor, cbm, volumetricKg });
  if (timedOut) {
    violations.push({ level: 'warn', code: 'V-TIMEOUT', msg: `求解超过 ${Math.round(cfg.timeLimitMs / 1000)} 秒，已返回当前最优解。建议分批测算或减少 SKU 数。` });
  }

  return {
    id: uid('plan'),
    createdAt: new Date().toISOString(),
    boxType: best.boxType,
    strategy: best.strategy,
    strategyName: best.strategyName,
    container: {
      code: container.code, nameCn: container.nameCn,
      L: container.L, W: container.W, H: container.H,
      doorW: container.doorW, doorH: container.doorH,
      theoCbm: container.theoCbm,
      availCbm: +(container.theoCbm * (cfg.availableRatio ?? container.usableRatio)).toFixed(2),
      tareKg: container.tareKg,
      maxPayloadKg: containers[0] ? containers[0].maxPayloadKg : container.maxPayloadKg,
      limitSources: containers[0] ? containers[0].limitSources : ['箱型上限'],
    },
    containers,
    totals,
    spill,
    violations,
    alternatives: runs
      .filter(r => r !== best)
      .map(r => ({ boxType: r.boxType, strategy: r.strategy, containers: r.containers.length, utilVol: r.totals.utilVol, boxes: r.totals.boxes }))
      .sort((a, b) => b.utilVol - a.utilVol)
      .slice(0, 8),
    elapsedMs: Math.round(elapsedMs),
    partial: timedOut || spill.length > 0,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   违规扫描（PRD 6.2 十条约束 + 第十四章验收用例）
   ═══════════════════════════════════════════════════════════════════ */

function scanViolations({ containers, items, spill, cfg, volumeDivisor, cbm, volumetricKg }) {
  const out = [];
  const add = (level, code, msg) => out.push({ level, code, msg });

  for (const it of items) {
    const sum = it.mm.l + it.mm.w + it.mm.h;
    if (sum > OVERSIZE_SUM_MM) {
      add('warn', 'C-10', `${it.code} 外箱 (${sum / 10}×2) cm 超过 330 cm，超长附加费约 ¥${cfg.oversizeFee ?? 500}/箱`);
    }
    if (it.fragile && it.stackCapped) {
      add('warn', 'C-06', `${it.code} 易碎品堆码上限被设为 ${it.maxStack > 0 ? it.maxStack : 5} 层，已强制按 ${FRAGILE_MAX_STACK} 层执行`);
    }
  }

  for (const c of containers) {
    const first = CONTAINERS[c.boxType];
    if (first) {
      for (const it of c.items) {
        const src = items.find(i => i.skuId === it.skuId);
        if (!src) continue;
        if (src.mm.l > first.doorW || src.mm.h > first.doorH) {
          add('warn', 'C-01', `${it.code} 有一边超过 ${c.boxType} 门框 ${first.doorW}×${first.doorH} mm，需开顶柜或框架柜`);
        }
      }
    }

    // 不可倒置必须在柜底
    for (const l of c.layers) {
      for (const b of l.boxes) {
        const src = items.find(i => i.skuId === b.skuId);
        if (src && src.noInvert && l.z > EPS) {
          add('error', 'C-07', `${b.code} 标了「不可倒置」但没落在柜底`);
        }
      }
    }

    // 混装禁忌：气味 ↔ 吸味（PRD 验收 C-08）
    if (c.attrMask.odor && c.attrMask.absorb) {
      add('warn', 'C-08', `第 ${c.index} 柜同时有「有气味」与「吸味」货物，须隔离`);
    }
    // 液体压固体（PRD 验收 C-09）
    for (let i = 1; i < c.layerAttrTrace.length; i++) {
      const below = c.layerAttrTrace[i - 1], above = c.layerAttrTrace[i];
      if (below.liquid && above.general) {
        add('warn', 'C-09', `第 ${c.index} 柜第 ${i} 层：液体箱压在固体箱上`);
      }
    }
    // 配重（PRD 验收 C-11 / C-12）
    if (c.balance.frontDiffKg > 800) {
      add('warn', 'C-11', `第 ${c.index} 柜前后差 ${c.balance.frontDiffKg} kg，须 ≤800 kg，请调整`);
    }
    if (c.balance.endMaxRatio > 0.6 + EPS) {
      add('warn', 'C-12', `第 ${c.index} 柜违反 CTU 60/50 规则：单端占 ${(c.balance.endMaxRatio * 100).toFixed(0)}% 总重`);
    }
    if (c.fragmentsRatio > 0.15) {
      add('info', 'V-FRAG', `第 ${c.index} 柜碎片空间率 ${(c.fragmentsRatio * 100).toFixed(0)}%，排布不佳，建议手动微调`);
    }
  }

  // 体积重口径交叉验证：÷6000 与 CBM×167 必须一致（PRD 验收 C-13）
  if (cbm > 0 && Number.isFinite(volumeDivisor)) {
    const byCbm = cbm * 1000 / (volumeDivisor / 1000);
    if (Math.abs(byCbm - volumetricKg) / Math.max(1, volumetricKg) > 0.01) {
      add('warn', 'C-13', `体积重口径不一致：÷${volumeDivisor} 得 ${volumetricKg.toFixed(1)} kg，CBM 折算得 ${byCbm.toFixed(1)} kg，请检查单位`);
    }
  }

  if (spill.length > 0) {
    add('warn', 'C-SPILL', `${spill.length} 个 SKU 没能装进去（合计 ${spill.reduce((s, x) => s + x.cbm, 0).toFixed(2)} CBM），见甩单建议`);
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   离线降级估算（PRD 4.5：断网时按体积估算柜数，误差约 ±2 箱）
   ═══════════════════════════════════════════════════════════════════ */

export function estimateContainers(items, boxType = '40HQ') {
  const c = CONTAINERS[boxType];
  if (!c) throw new Error(`未知柜型：${boxType}`);
  let cbm = 0, weightKg = 0;
  for (const it of items) {
    const boxes = Number(it.boxes) || 0;
    cbm += cartonCbm(it.dimsCm) * boxes;
    weightKg += (Number(it.weightKg) || 0) * boxes;
  }
  const limit = resolvePayloadLimit(c, {});
  const byVolume = cbm / c.availCbm;
  const byWeight = weightKg / limit.kg;
  const count = Math.max(1, Math.ceil(Math.max(byVolume, byWeight) - 1e-9));
  return {
    boxType, containerCount: count, cbm: +cbm.toFixed(2), weightKg: +weightKg.toFixed(1),
    byVolume: +byVolume.toFixed(2), byWeight: +byWeight.toFixed(2),
    approximate: true,
    note: '离线估算：按体积与重量分别折算柜数，未做实际排布，误差约 ±2 箱。联网后会自动重算精确方案。',
  };
}

/** 单个纸箱能否装进柜子（门框 + 内尺寸），用于快速预检与甩单判断。 */
export function boxFitsContainer(dimsCm, boxType) {
  const c = CONTAINERS[boxType];
  if (!c) return { fits: false, reason: `未知柜型 ${boxType}` };
  const m = dimsCmToMm(dimsCm);
  if (m.l <= c.doorW && m.w <= c.W && m.h <= c.doorH) return { fits: true, doorOk: true };
  if (m.l <= c.L && m.w <= c.W && m.h <= c.H) {
    return { fits: true, doorOk: false, reason: `${boxType} 装得下，但有一边超过门框，需开顶或框架柜` };
  }
  return { fits: false, reason: `${boxType} 装不下（内尺寸 ${c.L}×${c.W}×${c.H} mm）` };
}
