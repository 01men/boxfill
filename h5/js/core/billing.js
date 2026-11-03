/**
 * 体积重与运费测算（PRD 第 8 章）。
 *
 * 抛货场景的命脉。一票货到底按重量还是体积收钱，不看别的，就看两个数：
 * 实重和体积重，取大的那个。所以这一层必须把口径算准——口径错了，
 * 报价错几万块，老板拿着单子去谈柜，回来发现亏了。
 *
 * 四个重量（PRD 8）：
 *   实重      Σ(箱数 × 单箱毛重)                     kg
 *   体积重    Σ(长cm × 宽cm × 高cm × 箱数) ÷ 系数    kg
 *   CBM       Σ(长m × 宽m × 高m × 箱数)              m³
 *   抛比      实重 / CBM                             kg/CBM，<167 即抛货
 *
 * 交叉验证：CBM × 1000 ÷ 系数 必须等于体积重。不等就说明单位在某处混用了，
 * 这是最常见也最贵的 bug，必须当场拦下（PRD 验收 C-13）。
 */

import { CONTAINERS, MAIN_CONTAINERS, resolvePayloadLimit, DENSITY_LIGHT_THRESHOLD, OVERSIZE_SUM_CM } from './units.js';

/** 渠道口径：全抛 / 半抛 / 免抛（PRD 8 渠道对照） */
export const CHANNELS = {
  'all-throw': { key: 'all-throw', name: '全抛（÷6000）', divisor: 6000, desc: '不论轻重一律按体积重计费' },
  'half-throw': { key: 'half-throw', name: '半抛（取均值）', divisor: 6000, halve: true, desc: '实重与体积重取均值后计费，货代与船东折中的口径' },
  'no-throw': { key: 'no-throw', name: '免抛（按实重）', divisor: null, desc: '有免抛协议时按实重计费' },
  air: { key: 'air', name: '空运（÷5000）', divisor: 5000, desc: '空运口径，系数 5000' },
};

/**
 * 四个重量 + 抛比 + 计费重。
 * @param {Array} items [{dimsCm, weightKg, boxes, pieces, code}]
 * @param {object} opts {divisor}
 */
export function measure(items, opts = {}) {
  const divisor = opts.divisor ?? 6000;
  let realKg = 0, volCm3 = 0, cbm = 0, pieces = 0, boxes = 0;

  for (const it of items) {
    const n = Number(it.boxes) || 0;
    const d = it.dimsCm;
    const l = Number(d.l) || 0, w = Number(d.w) || 0, h = Number(d.h) || 0;
    boxes += n;
    pieces += (Number(it.pieces) || n * (Number(it.packQty) || 1));
    realKg += (Number(it.weightKg) || 0) * n;
    const boxCm3 = l * w * h;
    volCm3 += boxCm3 * n;
    cbm += (boxCm3 / 1e6) * n;
  }

  const volumetricKg = divisor > 0 ? volCm3 / divisor : 0;
  const densityKgPerCbm = cbm > 0 ? realKg / cbm : 0;
  // 计费重取大者：抛货按体、重货按重，一票货只有一个口径生效
  const chargeableKg = Math.max(realKg, volumetricKg);

  // 交叉验证：单位一旦混用（cm 当 mm、系数写错），这两个数必然对不上
  const crossCheck = divisor > 0 && cbm > 0 ? (cbm * 1e6 / divisor) : volumetricKg;
  const crossOk = divisor <= 0 || volumetricKg <= 0
    ? true
    : Math.abs(crossCheck - volumetricKg) / Math.max(1, volumetricKg) < 0.01;

  return {
    boxes, pieces,
    realKg: +realKg.toFixed(2),
    volumetricKg: +volumetricKg.toFixed(2),
    cbm: +cbm.toFixed(3),
    densityKgPerCbm: +densityKgPerCbm.toFixed(1),
    chargeableKg: +chargeableKg.toFixed(2),
    // 空清单不该被判成"抛货"——抛货是相对而言的，没有货就谈不上
    isLight: cbm > 0 && densityKgPerCbm < DENSITY_LIGHT_THRESHOLD,
    divisor,
    crossOk,
    crossDiffKg: +(crossCheck - volumetricKg).toFixed(2),
  };
}

/** 某渠道下的计费重：半抛口径是 (实重+体积重)/2，免抛直接用实重。 */
export function chargeableFor(m, channelKey) {
  const ch = CHANNELS[channelKey];
  if (!ch) return m.chargeableKg;
  if (ch.key === 'no-throw') return m.realKg;
  const vol = volumeWeightOf(m, ch.divisor);
  return ch.halve ? (m.realKg + vol) / 2 : Math.max(m.realKg, vol);
}

/** 按给定系数换算体积重。measure 只回传 CBM，这里由 CBM 反推（cm³ = CBM × 1e6）。 */
function volumeWeightOf(m, divisor) {
  if (!divisor || divisor <= 0) return m.realKg;
  return (m.cbm * 1e6) / divisor;
}

/**
 * 运费测算（PRD 8）。
 * costs 里的单价按柜收的（THC/DOC/BAF/托盘/加固/监装）与按量收的分开处理，
 * 因为货代报价单就是这样列的，混在一起算总额永远对不上账。
 */
export function freight(items, opts = {}) {
  const costs = opts.costs || {};
  const m = measure(items, { divisor: opts.divisor ?? 6000 });

  const divisor = opts.divisor ?? 6000;
  const channels = Object.keys(CHANNELS).map(key => {
    const ch = CHANNELS[key];
    const chargeable = chargeableFor(m, key);
    // 计费方数不是货物实测方数，而是**计费重折回方数**：
    // 船东的口径是「按 W/M，取大者」，报了每 CBM 单价就得拿计费重去折方数。
    // 直接用实测 cbm 乘单价，免抛口径会算得和全抛一模一样——渠道对照就白做了。
    // 折算系数统一用本票的基数（海运 6000），免抛时计费重变小 → 折出的方数也变小 → 运费更便宜，
    // 这正是免抛协议值钱的地方。
    const billedCbm = (chargeable * divisor) / 1e6;
    const byCbm = (costs.freightPerCbm || 0) * billedCbm;
    const byTon = (costs.freightPerTon || 0) * (chargeable / 1000);
    const base = costs.baseFreight || 0;
    const freightTotal = costs.freightPerCbm || costs.freightPerTon ? byCbm + byTon + base : 0;
    return {
      key, name: ch.name, desc: ch.desc,
      chargeableKg: +chargeable.toFixed(2),
      billedCbm: +billedCbm.toFixed(2),
      byCbm: +byCbm.toFixed(2),
      byTon: +byTon.toFixed(2),
      freight: +freightTotal.toFixed(2),
      diffVsBase: 0,
    };
  });

  // 差额相对"全抛"基准——PRD 8 的真实案例是全抛 25337 vs 免抛 10854，差 14483
  const base = channels.find(c => c.key === (opts.baseChannel || 'all-throw'));
  if (base) for (const c of channels) c.diffVsBase = +(base.freight - c.freight).toFixed(2);

  const recommended = channels.slice().sort((a, b) => a.freight - b.freight)[0];

  return {
    measure: m,
    channels,
    recommendedChannel: recommended.key,
    recommendedChannelName: recommended.name,
    maxDiff: +Math.max(...channels.map(c => Math.abs(c.diffVsBase))).toFixed(2),
    note: m.isLight
      ? `抛比 ${m.densityKgPerCbm} kg/CBM < ${DENSITY_LIGHT_THRESHOLD}，属抛货，按体积计费`
      : `抛比 ${m.densityKgPerCbm} kg/CBM ≥ ${DENSITY_LIGHT_THRESHOLD}，属重货，按重量计费`,
  };
}

/**
 * 箱型比选（PRD 8 / 验收 C-23）：同一票货跑多个柜型，按「每 CBM 单价」排序。
 *
 * 为什么要按每 CBM 单价而不是总价：40HQ 一定比 20GP 总价贵，
 * 但如果它能多装 1 倍的货，每 CBM 反而更便宜。老板比的是这个。
 */
export function compareBoxTypes(items, opts = {}) {
  const costs = opts.costs || {};
  const m = measure(items, { divisor: opts.divisor ?? 6000 });
  const types = opts.types || MAIN_CONTAINERS;
  const ratio = opts.availableRatio ?? null;

  const rows = types.map(code => {
    const c = CONTAINERS[code];
    if (!c) return null;
    const limit = resolvePayloadLimit(c, opts.limits || {});
    const availCbm = c.theoCbm * (ratio ?? c.usableRatio);
    const byVolume = m.cbm / availCbm;
    const byWeight = m.realKg / limit.kg;
    const containers = Math.max(1, Math.ceil(Math.max(byVolume, byWeight) - 1e-9));
    // 真实装货量：整柜容量装满，最后一柜装剩下的
    const loadedCbm = Math.min(m.cbm, (containers - 1) * availCbm + m.cbm);
    const totalCost = containers * perContainerCost(costs, code)
      + (costs.freightPerCbm || 0) * m.cbm;
    return {
      boxType: code, name: c.nameCn,
      availCbm: +availCbm.toFixed(2),
      maxPayloadKg: limit.kg,
      limitSources: limit.sources,
      containers,
      cbm: +m.cbm.toFixed(2),
      weightKg: +m.realKg.toFixed(1),
      loadedCbm: +loadedCbm.toFixed(2),
      costPerCbm: m.cbm > 0 ? +(totalCost / m.cbm).toFixed(2) : 0,
      costPerKg: m.realKg > 0 ? +(totalCost / m.realKg).toFixed(2) : 0,
      totalCost: +totalCost.toFixed(2),
      fits: byVolume <= 1 && byWeight <= 1,
    };
  }).filter(Boolean);

  const sorted = rows.slice().sort((a, b) => a.costPerCbm - b.costPerCbm);
  for (const r of rows) {
    const s = sorted.find(x => x.boxType === r.boxType);
    r.rank = sorted.indexOf(s) + 1;
  }
  return { measure: m, rows: sorted, recommended: sorted[0] || null };
}

/** 单柜固定费用：THC + DOC + BAF + 托盘 + 加固 + 监装 */
export function perContainerCost(costs = {}, boxType) {
  const per = (costs.thc || 0) + (costs.doc || 0) + (costs.baf || 0)
    + (costs.palletFee || 0) + (costs.reinforcementFee || 0) + (costs.monitorFee || 0);
  return per;
}

/**
 * 附加费（PRD 8）：超长、超重、托盘、加固、监装，按柜归集。
 * 超长判定用行业口径 (L+W+H)×2 > 330cm。
 */
export function surcharges(items, opts = {}) {
  const costs = opts.costs || {};
  const out = [];
  const limit = opts.payloadLimitKg;

  const oversizeBoxes = [];
  for (const it of items) {
    const d = it.dimsCm;
    const sum = (Number(d.l) + Number(d.w) + Number(d.h)) || 0;   // cm
    // 行业口径：(L+W+H)×2 > 330cm。dimsCm 是 cm，阈值必须也是 cm——
    // 拿 mm 的阈值去比 cm 的数，永远判不出超长，附加费就永远收不到。
    if (sum * 2 > OVERSIZE_SUM_CM) oversizeBoxes.push({ code: it.code, boxes: it.boxes, sumCm: sum * 2 });
  }
  if (oversizeBoxes.length > 0) {
    const boxes = oversizeBoxes.reduce((s, x) => s + x.boxes, 0);
    out.push({
      name: '超长附加费', amount: +(boxes * (costs.oversizeFeePerBox ?? 500)).toFixed(2),
      note: `${boxes} 箱周长 >330cm（${oversizeBoxes.map(x => x.code).join('、')}），约 ¥${costs.oversizeFeePerBox ?? 500}/箱`,
      boxes,
    });
  }

  if (limit && opts.realKg > limit) {
    const over = opts.realKg - limit;
    out.push({
      name: '超重费', amount: +(over * (costs.overWeightFeePerKg || 0)).toFixed(2),
      note: `超出限重 ${over.toFixed(0)} kg，按 ¥${costs.overWeightFeePerKg || 0}/kg 计`,
    });
  }

  const palletCount = opts.palletCount || 0;
  if (palletCount > 0 && (costs.palletFee || 0) > 0) {
    out.push({ name: '托盘费', amount: +(palletCount * costs.palletFee).toFixed(2), note: `${palletCount} 个托盘 × ¥${costs.palletFee}` });
  }
  if ((costs.monitorFee || 0) > 0 && opts.containers) {
    out.push({ name: '监装费', amount: +(opts.containers * costs.monitorFee).toFixed(2), note: `${opts.containers} 柜 × ¥${costs.monitorFee}` });
  }
  return out;
}

/**
 * 纸箱优化建议（PRD 9.3）：把箱子改小一点，体积重降多少、省多少钱。
 *
 * 这是包装厂不会主动告诉你的事——他们的兴趣是让你多买纸板。
 * 做法是枚举一个收缩比例，把三边同比例缩小后重算体积重与装箱数。
 */
export function cartonOptimization(items, opts = {}) {
  const costs = opts.costs || {};
  const divisor = opts.divisor ?? 6000;
  const rate = opts.freightPerKg || 0;
  const out = [];

  for (const it of items) {
    const n = it.boxes;
    if (!n) continue;
    const d = it.dimsCm;
    const realKg = Number(it.weightKg) || 0;
    const volumetric = divisor > 0 ? (d.l * d.w * d.h) / divisor : 0;
    // 实重已经压过体积重（重货 / 免抛口径）时，缩箱子一分钱都省不下来。
    // 照样给建议等于骗老板去跟包装厂谈判，谈完发现运费没变。
    if (divisor <= 0 || realKg >= volumetric) continue;

    for (const shrink of [0.10, 0.08, 0.05]) {
      const l = +(d.l * (1 - shrink)).toFixed(1);
      const w = +(d.w * (1 - shrink)).toFixed(1);
      const h = +(d.h * (1 - shrink)).toFixed(1);
      const newVolumetric = (l * w * h) / divisor;
      // 省下的是**计费重**里由体积决定的那一段，不是全部体积重
      const savedKgPerBox = Math.max(0, volumetric - newVolumetric);
      const savedKg = savedKgPerBox * n;
      const savedMoney = savedKg * rate;
      if (savedMoney < (opts.minSaving || 1)) continue;
      out.push({
        code: it.code, nameCn: it.nameCn || it.code,
        from: { l: d.l, w: d.w, h: d.h }, to: { l, w, h },
        shrinkPct: Math.round(shrink * 100),
        volumetricFrom: +volumetric.toFixed(2),
        volumetricTo: +newVolumetric.toFixed(2),
        savedKgPerBox: +savedKgPerBox.toFixed(2),
        savedKg: Math.round(savedKg),
        savedMoney: +savedMoney.toFixed(2),
      });
      break;   // 每个 SKU 只给一条最优建议，否则三档刷屏
    }
  }
  return out.sort((a, b) => b.savedMoney - a.savedMoney);
}

/**
 * 汇总成单据层直接可用的 billing 结构。
 * docs.js 与 UI 都按这个形状读，不要各自再算一遍——两处算 inevitably 会打架。
 */
export function buildBilling(items, opts = {}) {
  const f = freight(items, opts);
  const cmp = compareBoxTypes(items, opts);
  const sur = surcharges(items, {
    ...opts,
    realKg: f.measure.realKg,
    payloadLimitKg: opts.payloadLimitKg,
    containers: opts.containers || (cmp.recommended ? cmp.recommended.containers : 1),
    palletCount: opts.palletCount || 0,
  });
  const carton = cartonOptimization(items, opts);

  const recommended = f.channels.find(c => c.key === f.recommendedChannel);
  const totalCost = (recommended ? recommended.freight : 0)
    + sur.reduce((s, x) => s + x.amount, 0)
    + (opts.fixedCosts || 0);

  return {
    measure: f.measure,
    channels: f.channels,
    recommendedChannel: f.recommendedChannel,
    recommendedChannelName: f.recommendedChannelName,
    maxDiff: f.maxDiff,
    note: f.note,
    boxTypeCompare: cmp.rows,
    recommendedBoxType: cmp.recommended ? cmp.recommended.boxType : null,
    surcharges: sur,
    cartonOptimization: carton,
    cartonOptimizationTotal: +carton.reduce((s, x) => s + x.savedMoney, 0).toFixed(2),
    totalCost: +totalCost.toFixed(2),
  };
}
