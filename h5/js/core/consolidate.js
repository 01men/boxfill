/**
 * 多订单拼单（PRD 第 9 章）。
 *
 * 拼单是这套系统里**最值钱**的一条：不是把两个半柜凑成一个柜省一次运费，
 * 而是"抛货单 + 重货单"互补——把体积线和重量线同时吃满。
 *
 *   抛货单 A：22 CBM / 3.2 t  （体积占满，重量只用 1/8）
 *   重货单 B： 6 CBM / 18  t  （重量占满，体积只用 1/11）
 *   单独发：A 占 1 柜、B 占 1 柜 = 2 柜
 *   拼一起：A+B = 28 CBM / 21.2t → 40HQ 一柜装下 = 1 柜，省 1 个柜 ≈ ¥18000
 *
 * 规则按优先级依次判断，前一条不满足直接放弃（PRD 9.1）：
 *   ① 目的港 ② 截关 ③ 客户许可 ④ 货物兼容 ← 硬约束
 *   ⑤ 密度互补 ⑥ 交期 ⑦ 拣货路径 ← 优化项
 */

import { cartonCbm, resolvePayloadLimit, CONTAINERS } from './units.js';
import { solvePlan } from './engine.js';

/** 单个订单的体量画像：后续所有判断都基于这几个数，不再碰原始 SKU */
export function profileOrder(order, skuMap) {
  let cbm = 0, weightKg = 0, pieces = 0;
  const items = [];
  for (const line of order.lines || []) {
    const sku = skuMap.get(line.skuId);
    if (!sku) continue;
    const boxes = Number(line.boxes) || 0;
    if (boxes <= 0) continue;
    cbm += cartonCbm(sku.dimsCm) * boxes;
    weightKg += (Number(sku.weightKg) || 0) * boxes;
    pieces += boxes * (Number(sku.packQty) || 1);
    items.push({
      skuId: sku.id, code: sku.code, nameCn: sku.nameCn,
      dimsCm: sku.dimsCm, weightKg: sku.weightKg, boxes,
      packQty: sku.packQty, netWeightKg: sku.netWeightKg,
      maxStack: sku.maxStack, noInvert: sku.noInvert, fragile: sku.fragile,
      attrs: sku.attrs, unitValue: sku.unitValue,
    });
  }
  return {
    order,
    cbm: +cbm.toFixed(3),
    weightKg: +weightKg.toFixed(2),
    pieces,
    density: cbm > 0 ? +(weightKg / cbm).toFixed(1) : 0,
    items,
  };
}

/** 两条订单的硬约束检查；返回 {ok, reasons[]}，reasons 为空即可拼 */
export function checkHardRules(a, b, opts = {}) {
  const reasons = [];
  const A = a.order, B = b.order;

  // ① 目的港
  if (norm(A.port) !== norm(B.port)) {
    reasons.push({ level: 'hard', code: '①', msg: `目的港不同（${A.port || '未填'} vs ${B.port || '未填'}），不能拼` });
  }
  // ② 船期 / 截关兼容（含 1–2 天缓冲）
  const bufferDays = opts.bufferDays ?? 1;
  const ca = cutoffOf(A), cb = cutoffOf(B);
  if (ca && cb) {
    const diffDays = Math.abs(new Date(ca) - new Date(cb)) / 86400000;
    if (diffDays > bufferDays) {
      reasons.push({ level: 'hard', code: '②', msg: `截关相差 ${diffDays.toFixed(0)} 天，超出 ${bufferDays} 天缓冲` });
    }
  } else if (norm(A.vessel) !== norm(B.vessel)) {
    reasons.push({ level: 'hard', code: '②', msg: `船期不同（${A.vessel || '未填'} vs ${B.vessel || '未填'}）` });
  }
  // ③ 客户许可
  if (A.customerAllowMixed === false || B.customerAllowMixed === false) {
    const who = A.customerAllowMixed === false ? A : B;
    const reason = opts.rejectReasons && opts.rejectReasons[who.customer];
    reasons.push({ level: 'hard', code: '③', msg: `${who.customer || '客户'} 明确拒绝混装${reason ? '：' + reason : ''}` });
  }
  // ④ 货物兼容：性质冲突货禁同柜
  for (const r of conflictBetween(a.items, b.items)) {
    reasons.push({ level: 'hard', code: '④', msg: `货物冲突：${r}` });
  }
  return { ok: reasons.length === 0, reasons };
}

const norm = s => String(s || '').trim().toUpperCase();
const cutoffOf = o => o.cutOff || o.cutoff || o.etd || null;

/** 两个订单之间是否有性质冲突的货（危险品/食品/不洁） */
export function conflictBetween(itemsA, itemsB) {
  const out = [];
  const mask = items => {
    const m = {};
    for (const it of items) for (const [k, v] of Object.entries(it.attrs || {})) if (v) m[k] = true;
    return m;
  };
  const ma = mask(itemsA), mb = mask(itemsB);
  const pairs = [
    ['danger', 'food', '危险品与食品'],
    ['danger', 'unsanitary', '危险品与不洁货'],
    ['food', 'unsanitary', '食品与不洁货'],
  ];
  for (const [x, y, label] of pairs) {
    if ((ma[x] && mb[y]) || (ma[y] && mb[x])) out.push(label);
  }
  return out;
}

/** 优化项：密度互补与交期、拣货 */
export function checkSoftRules(a, b, skuMap) {
  const notes = [];
  const light = a.density < 167 ? a : (b.density < 167 ? b : null);
  const heavy = light === a ? b : (light === b ? a : null);
  if (light && heavy && light.density < 167 && heavy.density > 400) {
    notes.push({ level: 'good', code: '⑤', msg: `密度互补：${light.order.code} 抛货（${light.density} kg/CBM）+ ${heavy.order.code} 重货（${heavy.density} kg/CBM），体积与重量两条线同时吃满` });
  }
  const da = a.order.dueDate, db = b.order.dueDate;
  if (da && db && da !== db) {
    const days = Math.round(Math.abs(new Date(da) - new Date(db)) / 86400000);
    const late = new Date(da) < new Date(db) ? a : b;
    notes.push({
      level: 'warn', code: '⑥',
      msg: `${late.order.code} 交期 ${late.order.dueDate}，拼单将延误 ${days} 天，是否继续？`,
    });
  }
  return notes;
}

/**
 * 主入口：给一组待发订单，找出值得拼的组合。
 *
 * 用贪心而不是穷举组合：订单数可能十几个，全组合是 2^n。
 * 分组只按目的港——船期/截关的兼容性交给硬约束②判断：同港不同船、
 * 但截关相差在缓冲期内的两单是可拼的，按「港+船」分组会把它们永远隔开。
 *
 * 组内两步走：
 *   ① 两两贪心锁定"合并后最省柜"的组合；
 *   ② 向已锁定的组继续吸收第三、第四单——只要并入后省的柜数还在增加
 *      （新成员单独发的柜数 > 并入后增加的柜数）就继续收。
 * 三张 60% 满的抛货单拼进一个柜，靠的就是第二步。
 */
export function suggestConsolidation(orders, skuMap, opts = {}) {
  const profiles = orders.map(o => profileOrder(o, skuMap)).filter(p => p.cbm > 0);
  const groups = new Map();
  for (const p of profiles) {
    const key = norm(p.order.port);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // 单独发的柜数每单只算一次，后面反复用到
  const aloneCache = new Map();
  const aloneContainers = p => {
    if (!aloneCache.has(p)) aloneCache.set(p, planFor(p.items, opts).containers || 1);
    return aloneCache.get(p);
  };

  const groupsOut = [];
  for (const [port, list] of groups) {
    const used = new Set();
    const picks = [];

    // ① 两两贪心：每轮找"合并后最省柜"的一对
    let guard = 0;
    while (guard++ < 50) {
      let best = null;
      for (let i = 0; i < list.length; i++) {
        if (used.has(i)) continue;
        for (let j = i + 1; j < list.length; j++) {
          if (used.has(j)) continue;
          const A = list[i], B = list[j];
          if (!checkHardRules(A, B, opts).ok) continue;
          const saving = savingOfGroup([A, B], aloneContainers, opts);
          if (saving.savedContainers <= 0) continue;
          if (!best || saving.savedContainers > best.saving.savedContainers
            || (saving.savedContainers === best.saving.savedContainers && saving.savedMoney > best.saving.savedMoney)) {
            best = { members: [A, B], saving };
          }
        }
      }
      if (!best) break;
      for (const m of best.members) used.add(list.indexOf(m));
      picks.push(best);
    }

    // ② 吸收更多成员：省柜数还在涨就继续收，直到收无可收
    let absorbing = true;
    while (absorbing) {
      absorbing = false;
      for (const pick of picks) {
        for (let k = 0; k < list.length; k++) {
          if (used.has(k)) continue;
          const cand = list[k];
          if (!pick.members.every(m => checkHardRules(m, cand, opts).ok)) continue;
          const next = savingOfGroup([...pick.members, cand], aloneContainers, opts);
          if (next.savedContainers > pick.saving.savedContainers) {
            pick.members.push(cand);
            pick.saving = next;
            used.add(k);
            absorbing = true;
          }
        }
      }
    }

    // 没被拼上的订单：单独成组，并给出甩单建议
    const solo = list.filter((_, i) => !used.has(i)).map(p => ({ profile: p, ...soloAdvice(p, opts) }));

    groupsOut.push({
      port,
      suggestions: picks.map(pk => {
        const notes = [];
        for (let i = 0; i < pk.members.length; i++) {
          for (let j = i + 1; j < pk.members.length; j++) notes.push(...checkSoftRules(pk.members[i], pk.members[j], skuMap));
        }
        const mergedContainers = pk.saving.mergedContainers;
        const containerCost = opts.containerCost || 0;
        return {
          orderIds: pk.members.map(m => m.order.id),
          orders: pk.members.map(m => ({
            orderId: m.order.id, code: m.order.code, customer: m.order.customer,
            cbm: m.cbm, weightKg: m.weightKg, density: m.density,
          })),
          items: mergeItems(pk.members),
          ...pk.saving,
          costSplit: containerCost > 0 ? splitConsolCost(pk.members, mergedContainers * containerCost, opts) : [],
          notes,
        };
      }),
      solo,
      orderCount: list.length,
    });
  }
  return { groups: groupsOut, totalOrders: profiles.length };
}

/**
 * 一组成员合并后省几个柜、省多少钱。
 * 单独发的柜数走缓存；合并那次必须真实排布——拼单比选用同一套引擎，
 * 否则"合并后省一柜"和实际装柜对不上。
 */
function savingOfGroup(members, aloneContainers, opts = {}) {
  const after = planFor(mergeItems(members), opts);
  const aloneTotal = members.reduce((s, m) => s + aloneContainers(m), 0);
  const savedContainers = aloneTotal - (after.containers || 1);
  const savedMoney = savedContainers * (opts.containerCost || 0);
  return {
    aloneContainers: aloneTotal,
    mergedContainers: after.containers || 1,
    savedContainers,
    savedMoney: +savedMoney.toFixed(2),
    containerCost: opts.containerCost || 0,
    combinedCbm: after.cbm,
    combinedWeightKg: after.weightKg,
    // 对外给的是**柜内占用率**而不是"相对理论容积的利用率"。合并两单只占 1 个柜时，
    // 按理论容积算出来永远是 30~40%，用户看了只觉得"柜还是空的"，
    // 而真正要回答的问题是：这 1 个柜的容积和承重各用掉多少。
    volumeFillPct: after.availCbm ? +Math.min(1, after.cbm / after.availCbm).toFixed(3) : 0,
    weightFillPct: after.maxPayloadKg ? +Math.min(1, after.weightKg / after.maxPayloadKg).toFixed(3) : 0,
    availCbm: after.availCbm || 0,
    maxPayloadKg: after.maxPayloadKg || 0,
    utilVol: after.utilVol,
    utilWeight: after.utilWeight,
    boxType: after.boxType || opts.boxType || '40HQ',
  };
}

/**
 * 拼柜费用分摊：一柜的成本怎么在成员之间拆账。
 *
 * 按「谁占用哪条线谁付钱」分：每个成员算两个占用率——体积线（占可用容积）
 * 与承重线（占限重），取较大者作为计费度量。抛货按体积分、重货按重量分、
 * 两条线都压的取大者，谁也不占谁便宜。金额四舍五入后把尾差记到最后一个成员，
 * 合计严格等于总成本——对不上账的分摊单没人认。
 */
export function splitConsolCost(members, totalCost, opts = {}) {
  // 兜底：AUTO 不是真实柜型，CONTAINERS 里没有这一项。
  // 拼柜场景下 opts.boxType 有可能来自"自动比选"而不是具体柜型，
  // 拿到 undefined 的容器会让整条分摊崩掉——用 40HQ 兜底比抛异常有用。
  const boxKey = CONTAINERS[opts.boxType] ? opts.boxType : '40HQ';
  const g = CONTAINERS[boxKey];
  const availCbm = g.theoCbm * (opts.availableRatio ?? g.usableRatio);
  const limit = resolvePayloadLimit(g, opts.limits || {});
  const rows = (members || []).map(m => {
    const volUse = availCbm > 0 ? m.cbm / availCbm : 0;
    const wtUse = limit.kg > 0 ? m.weightKg / limit.kg : 0;
    return { m, volUse, wtUse, metric: Math.max(volUse, wtUse) };
  });
  const totalMetric = rows.reduce((s, r) => s + r.metric, 0);
  const out = rows.map(r => ({
    orderId: r.m.order.id, code: r.m.order.code, customer: r.m.order.customer,
    cbm: r.m.cbm, weightKg: r.m.weightKg,
    basis: r.volUse >= r.wtUse ? 'volume' : 'weight',
    share: 0, amount: 0,
  }));
  if (!(totalMetric > 0) || !(totalCost > 0)) return out;
  let assigned = 0;
  rows.forEach((r, i) => {
    out[i].share = +(r.metric / totalMetric).toFixed(4);
    const amount = i === rows.length - 1
      ? Math.round((totalCost - assigned) * 100) / 100
      : Math.round(totalCost * out[i].share * 100) / 100;
    out[i].amount = amount;
    assigned += amount;
  });
  return out;
}

/** 单个订单自己装不下时给的三选一（PRD 9.2 甩单建议） */
function soloAdvice(p, opts = {}) {
  const alone = planFor(p.items, opts);
  const boxKey = CONTAINERS[opts.boxType] ? opts.boxType : '40HQ';
  const g = CONTAINERS[boxKey];
  const availCbm = g.theoCbm * (opts.availableRatio ?? g.usableRatio);
  const limit = resolvePayloadLimit(g, opts.limits || {});
  // 余量按最后一柜算：单柜时就是这柜剩下的空间，多柜时是尾柜还能再拼多少
  const lastCbm = alone.lastLoadedCbm || 0;
  const remainCbm = Math.max(0, +(availCbm - lastCbm).toFixed(2));
  const remainKg = Math.max(0, Math.round(limit.kg - (alone.loadedKg || 0)));
  const oneFits = (alone.containers || 1) === 1;
  return {
    containers: alone.containers || 1,
    utilVol: alone.utilVol,
    remainCbm,
    remainKg,
    hint: oneFits
      ? `单独 1 柜，柜内还有 ${remainCbm.toFixed(1)} CBM / ${remainKg} kg 余量——等同目的港的订单拼进来最划算`
      : (p.cbm > availCbm
        ? `按体积算装不下一柜（超出 ${(p.cbm - availCbm).toFixed(2)} CBM），考虑换 45HQ / 等下一水 / 压缩包装`
        : `单独要 ${alone.containers} 柜，最后一柜还剩 ${remainCbm.toFixed(1)} CBM 余量没吃满，可拼单 / 换 45HQ / 压缩包装`),
    options: [
      { key: 'bigger', label: `换 45HQ（多 ${(CONTAINERS['45HQ'].availCbm - availCbm).toFixed(1)} CBM）` },
      { key: 'wait', label: '等下一水，与同目的港订单拼柜' },
      { key: 'repack', label: '压缩包装（见纸箱优化建议）' },
    ],
  };
}

/** 合并两个订单的货量（同 SKU 累加） */
export function mergeItems(profiles) {
  const map = new Map();
  for (const p of profiles) {
    for (const it of p.items) {
      const cur = map.get(it.skuId);
      if (cur) {
        cur.boxes += it.boxes;
        // 属性取并集：任何一个订单标了易碎/液体，合并后就得按最严的来
        for (const [k, v] of Object.entries(it.attrs || {})) if (v) cur.attrs[k] = true;
        cur.noInvert = cur.noInvert || it.noInvert;
        cur.fragile = cur.fragile || it.fragile;
      } else {
        map.set(it.skuId, { ...it, attrs: { ...(it.attrs || {}) }, codes: [it.code] });
      }
    }
  }
  return [...map.values()];
}

/** 用真实引擎跑一次，只取柜数与利用率——拼单比选必须用同一套排布逻辑，
 *  否则"合并后省一柜"和实际装柜对不上，用户按拼单方案去装却装不下。 */
function planFor(items, opts = {}) {
  const plan = solvePlan({
    items,
    boxType: opts.boxType || 'AUTO',
    limits: opts.limits || {},
    availableRatio: opts.availableRatio,
    pallet: opts.pallet || false,
    timeLimitMs: opts.timeLimitMs || 3000,
  });
  if (plan.error) {
    return { containers: 0, cbm: 0, weightKg: 0, utilVol: 0, utilWeight: 0, loadedCbm: 0, lastLoadedCbm: 0, loadedKg: 0, availCbm: 0, maxPayloadKg: 0, error: plan.error };
  }
  const c = plan.containers[0];
  const last = plan.containers[plan.containers.length - 1];
  return {
    containers: plan.containers.length,
    cbm: plan.totals.cbm,
    weightKg: plan.totals.weightKg,
    utilVol: plan.totals.utilVol,
    utilWeight: plan.totals.utilWeight,
    loadedCbm: c ? c.cbm : 0,
    lastLoadedCbm: last ? last.cbm : 0,
    loadedKg: c ? c.weightKg : 0,
    // 容量口径取第一柜：拼单推荐关心的就是"这 1 个柜能装下吗"
    availCbm: (c && c.usableCbm) || plan.container.availCbm || 0,
    maxPayloadKg: (c && c.maxPayloadKg) || plan.container.maxPayloadKg || 0,
    boxType: plan.boxType,
  };
}
