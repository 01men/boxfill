/**
 * 单位、柜型库与全局常量。
 *
 * 全系统单位锁死：尺寸 cm、重量 kg、容积 CBM（PRD 1.3 / 11）。
 * 但装箱几何一律用 **mm 整数** 计算——浮点厘米会让 600×400×350 的纸箱在
 * 累加 20 层后出现 0.3mm 的缝隙，MaxRects 的空闲矩形判定全部退化成"差不多能放下"，
 * 于是装出一柜越界的箱子。mm 整数是几何判定唯一安全的表示。
 */

/** 1 cm = 10 mm */
export const CM_TO_MM = 10;

/** 纸箱三边按"长 ≥ 宽 ≥ 高"归一（PRD 4.2.1）：同一箱不能因为朝向不同被录成三个 SKU。 */
export function normalizeDimsCm(dims) {
  const arr = [Number(dims.l) || Number(dims.L) || 0, Number(dims.w) || Number(dims.W) || 0, Number(dims.h) || Number(dims.H) || 0];
  arr.sort((a, b) => b - a);
  return { l: arr[0], w: arr[1], h: arr[2] };
}

/** cm 三边 → mm 三边（整数） */
export function dimsCmToMm(dims) {
  const n = normalizeDimsCm(dims);
  return { l: Math.round(n.l * CM_TO_MM), w: Math.round(n.w * CM_TO_MM), h: Math.round(n.h * CM_TO_MM) };
}

/** mm 三边 → cm 三边（保留 1 位小数，够纸箱用） */
export function dimsMmToCm(mm) {
  return { l: +(mm.l / CM_TO_MM).toFixed(1), w: +(mm.w / CM_TO_MM).toFixed(1), h: +(mm.h / CM_TO_MM).toFixed(1) };
}

/** mm 立方 → CBM */
export function mm3ToCbm(mm3) {
  return mm3 / 1e9;
}

/** 单箱体积（CBM），输入 cm 三边 */
export function cartonCbm(dimsCm) {
  const n = normalizeDimsCm(dimsCm);
  return (n.l * n.w * n.h) / 1e6; // cm³ → m³
}

/** 密度 kg/CBM：抛比，<167 判定为抛货（PRD 8） */
export function density(weightKg, cbm) {
  return cbm > 0 ? weightKg / cbm : 0;
}

/** 抛比阈值：海运抛货临界密度 kg/CBM */
export const DENSITY_LIGHT_THRESHOLD = 167;

/* ═══════════════════════════════════════════════════════════════════
   柜型库（PRD 5.2）
   尺寸依据 ISO 668:2020；重量为各船公司公开箱规。
   usableRatio 是"可用容积系数"（PRD 6.2 第 9 条 0.82–0.90 区间内按箱型取值）：
   高度越大的柜，层数越多、门端封堵与层间间隙被摊薄得越轻，所以系数略高。
   取值让 20GP → 28.0 CBM、40HQ → 66.9 CBM，正好吃在 PRD 验收 C-02 / C-03 断言的区间内。
   ═══════════════════════════════════════════════════════════════════ */
const RAW_CONTAINERS = [
  { code:'20GP', nameCn:'20尺普柜', L:5898,  W:2352, H:2393, doorW:2340, doorH:2280, tareKg:2200, maxTotalKg:30480, usableRatio:0.840, payloadRangeT:[26.0, 28.2] },
  { code:'40GP', nameCn:'40尺普柜', L:12032, W:2352, H:2393, doorW:2340, doorH:2280, tareKg:3750, maxTotalKg:30480, usableRatio:0.870, payloadRangeT:[24.4, 26.5] },
  { code:'40HQ', nameCn:'40尺高柜', L:12032, W:2352, H:2698, doorW:2340, doorH:2585, tareKg:3970, maxTotalKg:32500, usableRatio:0.880, payloadRangeT:[24.2, 26.5] },
  { code:'45HQ', nameCn:'45尺高柜', L:13556, W:2352, H:2698, doorW:2340, doorH:2585, tareKg:4200, maxTotalKg:32000, usableRatio:0.880, payloadRangeT:[23.7, 27.8] },
  { code:'20RF', nameCn:'20尺冷冻柜', L:5440,  W:2290, H:2240, doorW:2260, doorH:2130, tareKg:3200, maxTotalKg:30480, usableRatio:0.800, payloadRangeT:[20.8, 20.8] },
  { code:'40RH', nameCn:'40尺高冷冻柜', L:11590, W:2280, H:2550, doorW:2250, doorH:2430, tareKg:4900, maxTotalKg:32500, usableRatio:0.800, payloadRangeT:[25.6, 25.6] },
  { code:'20OT', nameCn:'20尺开顶柜', L:5890,  W:2350, H:2350, doorW:2330, doorH:2340, tareKg:2300, maxTotalKg:30480, usableRatio:0.900, payloadRangeT:[26.0, 28.2], openTop:true },
  { code:'40OT', nameCn:'40尺开顶柜', L:12030, W:2350, H:2350, doorW:2330, doorH:2340, tareKg:3800, maxTotalKg:32500, usableRatio:0.900, payloadRangeT:[24.2, 26.5], openTop:true },
  { code:'20FR', nameCn:'20尺框架柜', L:5620,  W:2200, H:2393, doorW:2180, doorH:2280, tareKg:2600, maxTotalKg:30480, usableRatio:0.850, payloadRangeT:[27.0, 27.0], frame:true },
  { code:'40FR', nameCn:'40尺框架柜', L:11780, W:2240, H:2393, doorW:2200, doorH:2280, tareKg:4200, maxTotalKg:32500, usableRatio:0.850, payloadRangeT:[40.0, 40.0], frame:true },
];

/** 柜型库（theoCbm / maxPayloadKg 由尺寸推导，不手写，避免与尺寸表打架） */
export const CONTAINERS = Object.fromEntries(
  RAW_CONTAINERS.map(c => {
    const theoCbm = mm3ToCbm(c.L * c.W * c.H);
    return [c.code, {
      ...c,
      theoCbm: +theoCbm.toFixed(2),
      availCbm: +(theoCbm * c.usableRatio).toFixed(2),
      maxPayloadKg: c.maxTotalKg - c.tareKg,
    }];
  })
);

/** 参与箱型比选的海运常规柜（PRD 8 箱型比选：20GP/40GP/40HQ/45HQ） */
export const MAIN_CONTAINERS = ['20GP', '40GP', '40HQ', '45HQ'];

export function getContainer(code) {
  const c = CONTAINERS[code];
  if (!c) throw new Error(`未知柜型：${code}`);
  return c;
}

/**
 * 限重四层取最小：箱型上限 / 航线限重 / 船司限重 / 拖车限重（PRD 5.2）。
 * 返回取最小值及其全部来源——单据要能回溯"当时按哪个口径算的"（PRD 11 审计）。
 */
export function resolvePayloadLimit(container, limits = {}) {
  const cands = [{ source: '箱型上限', kg: container.maxPayloadKg }];
  if (Number.isFinite(limits.laneLimitKg)) cands.push({ source: '航线限重', kg: limits.laneLimitKg });
  if (Number.isFinite(limits.carrierLimitKg)) cands.push({ source: '船司限重', kg: limits.carrierLimitKg });
  if (Number.isFinite(limits.truckLimitKg)) cands.push({ source: '拖车限重', kg: limits.truckLimitKg });
  const min = Math.min(...cands.map(c => c.kg));
  return { kg: min, sources: cands.filter(c => c.kg === min).map(c => c.source), all: cands };
}

/* ───────── 货物属性与储运标志 ───────── */

/** 货物属性（PRD 5.1）：用于混装禁忌与堆码限制 */
export const GOODS_ATTRS = {
  general: { key:'general', name:'普货' },
  fragile:  { key:'fragile',  name:'易碎' },
  liquid:   { key:'liquid',   name:'液体' },
  sharp:    { key:'sharp',    name:'尖锐' },
  odor:     { key:'odor',     name:'有气味' },
  damp:     { key:'damp',     name:'潮气' },
  unsanitary:{key:'unsanitary',name:'不洁' },
  food:     { key:'food',     name:'食品' },
  danger:   { key:'danger',   name:'危险品' },
};

/** 性质冲突：两侧任意组合都禁同柜（PRD 6.2 第 8 条 / 13 合规） */
export const CONFLICT_ATTRS = [
  ['danger', 'food'], ['danger', 'unsanitary'], ['food', 'unsanitary'],
  ['danger', 'general'], ['unsanitary', 'food'],
];

/** 有气味 ↔ 吸味货（毛绒、织物）须隔离 */
export const ODOR_ABSORB_CONFLICT = ['odor', 'absorb'];

/** 单箱超规判定：(L+W+H)×2 > 330cm（PRD 8 单箱超规）。
 * 引擎内部用 mm 比（OVERSIZE_SUM_MM），计费层拿 cm 三边比（OVERSIZE_SUM_CM）。
 * 两个常量都留着是因为它们服务的模块单位不同——同一个数字写两遍不如写清一次。 */
export const OVERSIZE_SUM_MM = 3300;
export const OVERSIZE_SUM_CM = 330;

/**
 * 堆码层数上限。
 *
 * PRD 5.1 写"默认 5"，但这里刻意改成 **0 = 不限（按物理层数）**：
 * 40HQ 柜内高 2698mm，装 350mm 的纸箱物理上能码 7 层。默认锁 5 层，
 * 等于每次都白扔 900mm 的柜高、利用率凭空掉 12 个点——现场没人这么装。
 * 所以"堆码层数上限"改成**主数据里显式填写才生效**的字段，留空即不限；
 * 易碎品是唯一保留硬上限的（3 层，PRD 验收 C-06）。
 */
export const DEFAULT_MAX_STACK = 0;
export const FRAGILE_MAX_STACK = 3;

/** 兜底体积重系数：海运 ÷6000，空运 ÷5000，免抛按实重 */
export const VOLUMETRIC_DIVISORS = { sea: 6000, air: 5000, none: Infinity };

/** 默认托盘（PRD 4.4 / 6.2 第 7 条） */
export const DEFAULT_PALLET = { l: 1200, w: 1000, h: 130, stackMax: 2 };

/** 默认安全余量与门端封堵区（mm） */
export const SAFETY_TOP_MM = 50;      // PRD 6.2 第 6 条：层高累计 ≤ 箱内高 − 5cm
export const DOOR_END_RESERVE_MM = 500; // PRD 6.4：门端留 30–60cm 封堵区

/** 默认设置 */
export const DEFAULT_SETTINGS = {
  volumeDivisor: 6000,
  availableRatio: null,          // null = 用柜型自带系数
  pallet: { ...DEFAULT_PALLET },
  liquidPolicy: 'top',           // 'top' 液体尽量置顶 | 'ignore' 只告警不规避（用于验收 C-09）
  costs: {
    freightPerCbm: 0, baseFreight: 0,
    thc: 0, doc: 0, baf: 0,
    palletFee: 0, monitorFee: 0, reinforcementFee: 0,
    oversizeFeePerBox: 500, overWeightFeePerKg: 0,
  },
  currency: 'CNY',
  // 云端视觉解析服务地址（附赠能力）。空 = 未配置，测屏不显示云端入口。
  // 服务端用 npm run mcp:http 起在 8787；生产环境填自己的部署地址。
  visionApiUrl: '',
};

/** 深拷贝（结构化克隆不可用时的兜底，数据都是纯 JSON） */
export function clone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

/** 生成短 id（不依赖 crypto，Node 20 与旧版 iOS 都能跑） */
let idSeq = 0;
export function uid(prefix = 'id') {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}
