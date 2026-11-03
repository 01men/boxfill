/**
 * 介绍页演示：把真实的装箱引擎跑在介绍页上。
 *
 * 为什么不用录屏 GIF 或手写动画：
 *   介绍页最怕的是"图里演的和真跑的不一样"。这个仓库的立身之本是 H5 与 MCP
 *   共用一份实现（h5/js/core/），演示页再画一套假的，恰好把这个承诺作废。
 *   所以这里 import 的是 solvePlan 和 renderAxonometric 本体——
 *   页面上转起来的每一个箱子，都是真排出来的；它也顺带证明了"网页端零依赖
 *   但能用上完整引擎"这件事，因为引擎本来就是纯 ES 模块，浏览器直接跑。
 *
 * 三屏演示对应产品真正在解决的三件事：
 *   · 箱体计算 → 轴测图逐层搭建，柜数/体积/利用率实时滚动
 *   · 货物分布 → 分层俯视图（仓管真正照着摆的那张图）+ 层高标注
 *   · 预览     → 门端侧视，箱高对不对门框一眼看出来
 *
 * 性能约束（决定了这页为什么这样写）：
 *   renderAxonometric 每帧要为每个箱子生成 6 个面、排序、绘制。演示场景
 *   刻意控制在每柜 1500 箱以内（shouldDegrade 的同一道门槛），并把动画
 *   限制在可视区内才跑 —— 介绍页不该在后台烧用户的电。
 */
import { solvePlan } from './core/engine.js';
import {
  renderAxonometric, renderLayerTop, renderSideView, colorFor,
} from './ui/view3d.js';

/* ── 三个演示场景 ──────────────────────────────────────────────────
   都是小商品外贸真实会遇到的组合。箱数刻意选在"能看清单个箱子"的量级：
   再多就糊成一片色块，再少就撑不出多层的码放过程。 */
const SCENARIOS = [
  {
    key: 'light',
    label: '抛货专场',
    hint: '轻泡大件，柜子是被体积撑满的——重量线还剩一大半没用上',
    items: [
      { code: 'BX-2101', nameCn: '亚克力收纳箱', dimsCm: { l: 60, w: 40, h: 40 }, weightKg: 8.0, boxes: 180 },
      { code: 'BX-2102', nameCn: '厨房挂件大箱', dimsCm: { l: 55, w: 45, h: 35 }, weightKg: 7.2, boxes: 150 },
      { code: 'BX-2103', nameCn: '化妆镜礼盒', dimsCm: { l: 50, w: 50, h: 30 }, weightKg: 6.0, boxes: 120 },
      { code: 'BX-2104', nameCn: '手机支架彩盒', dimsCm: { l: 45, w: 35, h: 28 }, weightKg: 5.0, boxes: 160 },
    ],
  },
  {
    key: 'mixed',
    label: '抛重互补',
    hint: '抛货单 + 重货单拼一柜，体积线和承重线同时往上走——这才是拼单最值钱的地方',
    items: [
      { code: 'WT-3301', nameCn: '工艺挂件（大）', dimsCm: { l: 60, w: 40, h: 40 }, weightKg: 8.0, boxes: 120 },
      { code: 'WT-3302', nameCn: '家居装饰摆件', dimsCm: { l: 50, w: 40, h: 35 }, weightKg: 6.5, boxes: 130 },
      { code: 'HT-4401', nameCn: '陶瓷花盆', dimsCm: { l: 60, w: 45, h: 40 }, weightKg: 30, boxes: 55 },
      { code: 'HT-4402', nameCn: '铸铁厨具', dimsCm: { l: 55, w: 50, h: 45 }, weightKg: 45, boxes: 40 },
    ],
  },
  {
    key: 'heavy',
    label: '重货专场',
    hint: '密度 393 kg/CBM 的货，柜子是被重量顶住的——排得再满也过不去这堵墙',
    items: [
      { code: 'MT-5501', nameCn: '电饭煲纸箱', dimsCm: { l: 60, w: 40, h: 40 }, weightKg: 38, boxes: 200 },
      { code: 'MT-5502', nameCn: '电水壶礼盒', dimsCm: { l: 55, w: 50, h: 45 }, weightKg: 45, boxes: 150 },
      { code: 'MT-5503', nameCn: '搅拌机包装', dimsCm: { l: 50, w: 40, h: 35 }, weightKg: 30, boxes: 200 },
    ],
  },
];

const VIEWS = [
  { key: 'iso', label: '箱体计算' },
  { key: 'top', label: '货物分布' },
  { key: 'side', label: '门端预览' },
];

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = t => 1 - Math.pow(1 - t, 3);

/** 平面上的所有箱子，按"层 → 层内顺序"摊平：搭建动画就是按这个序往前放 */
function flattenLayers(container) {
  const flat = [];
  for (const layer of container.layers) for (const b of layer.boxes) flat.push({ layer, box: b });
  return flat;
}

/**
 * 按进度截出一个"码到一半"的容器视图。
 *
 * 直接改 container.layers 会污染真实方案（同一份数据还要喂给俯视和侧视），
 * 所以这里返回浅拷贝。层内按顺序逐个放出来，看起来就是码放过程，
 * 而不是整层突然出现——后者演示不出"一层铺满再往上堆"这个核心约束。
 */
function sliceAt(container, flat, t) {
  const n = Math.round(clamp01(t) * flat.length);
  const perLayer = new Map();
  for (let i = 0; i < n; i++) {
    const li = flat[i].layer;
    if (!perLayer.has(li)) perLayer.set(li, []);
    perLayer.get(li).push(flat[i].box);
  }
  return {
    placed: n,
    view: {
      ...container,
      layers: container.layers.map(l => ({ ...l, boxes: perLayer.get(l) || [] })),
    },
  };
}

/** 数字滚动：让"柜数/体积/利用率"跟着一层层长出来，而不是一开始就是终值 */
function tween(node, from, to, fmt, t) {
  node.textContent = fmt(from + (to - from) * easeOut(t));
}

const fmtInt = v => Math.round(v).toLocaleString('zh-CN');
const fmt1 = v => v.toFixed(1);
const fmtPct = v => (v * 100).toFixed(1) + '%';

/**
 * 把演示挂到 root 上。返回 destroy，便于测试或单页复用时拆掉。
 * @param {HTMLElement} root 挂载点
 * @param {(index:number)=>void} [onScenario] 切场景时的回调，用来更新页面上的说明文字
 */
export function mountDemo(root, onScenario) {
  if (!root) return () => {};
  root.innerHTML = '';

  /* ── 骨架 ── */
  const shell = el('div', 'demo');
  const stage = el('div', 'demo-stage');
  const canvas = el('canvas');
  const badge = el('div', 'demo-badge');
  stage.append(canvas, badge);

  const side = el('div', 'demo-side');
  const viewBar = el('div', 'demo-views');
  const statBox = el('div', 'demo-stats');
  const layerBar = el('div', 'demo-layer');
  side.append(viewBar, statBox, layerBar);

  const dots = el('div', 'demo-dots');
  shell.append(stage, side, dots);
  root.append(shell);

  /* ── 状态 ── */
  const state = {
    plans: [],
    layerCounts: [],      // 每个场景首柜的层数（层滑杆的上限跟着场景走）
    idx: 0,
    view: 'iso',
    layerIdx: 0,
    layerIdxMax: 1,
    progress: 1,
    armed: false,         // 是否已经"首次入场"过；没入场时展示完整方案而不是空柜
    running: false,
    raf: 0,
    timer: 0,
  };

  /** 当前场景首柜的层数，层滑杆与文案都以它为准 */
  const layerCount = () => state.layerCounts[state.idx] || 1;

  const plan = () => state.plans[state.idx];
  // 演示只看第一个柜：多柜方案在介绍页上没法一句话说清，
  // 而"柜内码得对不对"这件事看一个柜就够了。
  const container = () => {
    const p = plan();
    return p && p.containers && p.containers.length ? p.containers[0] : null;
  };

  /* ── 视图切换按钮 ── */
  const viewBtns = VIEWS.map(v => {
    const b = el('button', 'demo-view', v.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.view = v.key;
      viewBtns.forEach((x, i) => x.classList.toggle('on', VIEWS[i].key === v.key));
      fitCanvas();       // 不同视图画布高度不同（俯视是长条，侧视接近方形）
      replay();          // 换个看法重放一次搭建过程
    });
    viewBar.append(b);
    return b;
  });
  viewBtns[0].classList.add('on');

  /* ── 场景切换点 ── */
  const dotBtns = SCENARIOS.map((s, i) => {
    const b = el('button', 'demo-dot');
    b.type = 'button';
    b.title = s.label;
    b.setAttribute('aria-label', s.label);
    b.addEventListener('click', () => select(i));
    dots.append(b);
    return b;
  });

  function select(i) {
    state.idx = i;
    state.layerIdx = 0;
    state.layerIdxMax = layerCount();
    state.progress = 1;      // 先把完整方案摆出来：演示区在视口外时不该是个空柜
    state.armed = false;     // 等它第一次进视口，再重放搭建过程
    dotBtns.forEach((x, j) => x.classList.toggle('on', i === j));
    if (typeof onScenario === 'function') onScenario(i);
    paint(0);
  }

  /* ── 层滑杆（只在俯视 / 侧视下有意义） ── */
  const layerLabel = el('span', 'demo-layer-label');
  const layerPrev = el('button', 'demo-layer-btn', '‹');
  const layerNext = el('button', 'demo-layer-btn', '›');
  layerBar.append(layerPrev, layerLabel, layerNext);
  layerPrev.addEventListener('click', () => stepLayer(-1));
  layerNext.addEventListener('click', () => stepLayer(1));

  function stepLayer(d) {
    state.layerIdx = Math.max(0, Math.min(state.layerIdxMax, state.layerIdx + d));
    paint(0);
  }

  /* ── 统计卡片（随搭建进度滚动） ── */
  const statDefs = [
    { label: '柜数', fmt: v => fmtInt(v) + ' 柜' },
    { label: '箱数', fmt: fmtInt },
    { label: '体积', fmt: v => fmt1(v) + ' CBM' },
    { label: '柜内占用', fmt: fmtPct },
  ];
  const statNodes = statDefs.map(d => {
    const row = el('div', 'demo-stat');
    const k = el('span', 'demo-stat-k', d.label);
    const v = el('b', 'demo-stat-v', '—');
    row.append(k, v);
    statBox.append(row);
    return { node: v, fmt: d.fmt };
  });

  /* ── canvas 尺寸：跟设备像素对齐，否则高分屏上发虚 ──
   高度按视图定死，绝不读 stage.clientHeight：stage 的高度是被 canvas 撑出来的，
   读了再写回去就是正反馈，画布会一轮轮长高下去。 */
  const VIEW_H = { iso: 460, top: 250, side: 380 };
  const STAGE_PAD = 40;   // 对应 css 里 .demo-stage 的 20px × 2

  function fitCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(320, (stage.clientWidth || 640) - STAGE_PAD);
    const h = VIEW_H[state.view] || 420;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  /* ── 画一帧 ── */
  function paint(t) {
    const p = plan();
    if (!p || p.error) { badge.textContent = p && p.error ? p.error : '—'; return; }
    const c = container();
    if (!c) return;
    const flat = flattenLayers(c);
    const { view: shown, placed } = sliceAt(c, flat, state.progress);
    const boxCount = flat.length;
    const building = state.progress < 1;

    if (state.view === 'iso') {
      const yaw = REDUCED ? -0.62 : -0.62 + Math.sin(t * 0.00042) * 0.2;
      renderAxonometric(canvas, shown, { yaw, pitch: 0.6, zoom: 1 });
      const total = layerCount();
      // 徽标说的是画布上真正看得见的东西：码到第几层、已经摆了几个箱子。
      // 写总数会让人以为 610 箱已经全在画上了。
      const live = Math.max(1, shown.layers.filter(l => l.boxes.length).length);
      badge.textContent = building
        ? `逐层码放中 · 第 ${live} 层 / 共 ${total} 层 · 已码 ${placed} 箱`
        : `码放完成 · ${p.boxType} × ${p.containers.length} · ${total} 层 · ${boxCount} 箱`;
    } else if (state.view === 'top') {
      renderLayerTop(canvas, shown, Math.min(state.layerIdx, Math.max(0, shown.layers.length - 1)));
      badge.textContent = building
        ? `第 ${Math.min(state.layerIdx + 1, layerCount())} 层铺货中 · 已铺 ${placed} / ${boxCount} 箱`
        : `第 ${Math.min(state.layerIdx + 1, Math.max(1, shown.layers.length))} 层俯视 · 仓管照这张图摆`;
      layerLabel.textContent = `第 ${state.layerIdx + 1} / ${layerCount()} 层`;
    } else {
      renderSideView(canvas, shown);
      badge.textContent = '门端侧视 · 箱高过不过门框一眼看出来';
      layerLabel.textContent = `层高 ${(c.layers.reduce((s, l) => s + l.h, 0) / 10).toFixed(0)}cm`;
    }

    // 统计跟着搭建进度走
    const k = state.view === 'iso' ? state.progress : 1;
    const full = p.totals;
    const boxes = full.boxes * k;
    const cbm = full.cbm * k;
    const target = [
      p.containers.length,
      boxes,
      cbm,
      // 可用容积在 plan.container 上（柜型基准），不在单个柜上——
      // 报"已装方 / 理论方"会把箱型不整除的损耗算成排布差，那是误导。
      p.container && p.container.availCbm ? cbm / p.container.availCbm : 0,
    ];
    statNodes.forEach((s, i) => {
      const from = Number(s.node.dataset.v || 0);
      s.node.dataset.v = target[i];
      tween(s.node, from, target[i], s.fmt, Math.min(1, k));
    });
  }

  /* ── 动画循环 ─────────────────────────────────────────────
   rAF 不是哪儿都会回调的：无头浏览器、被内嵌的 webview、后台标签页都可能
   干脆不合成帧。碰上这种环境，演示会永远停在第一层——看起来就是"卡住了"。
   所以每帧挂一个看门狗：150ms 内rAF 没动静，就认定它不可用，退回定时器驱动。 */
  const BUILD_MS = 2600;   // 逐层搭建的时长，太快看不清"一层一层往上堆"
  const FALLBACK_MS = 16;  // 定时器兜底的帧间隔
  let last = 0;
  let rafOk = true;
  let watchdog = 0;

  function stopLoop() {
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
    state.running = false;
  }

  function schedule() {
    if (rafOk) {
      state.raf = requestAnimationFrame(onFrame);
      watchdog = setTimeout(() => {
        watchdog = 0;
        if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
        rafOk = false;
        onFrame(performance.now());
      }, 150);
    } else {
      state.timer = setTimeout(() => onFrame(performance.now()), FALLBACK_MS);
    }
  }

  function onFrame(now) {
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
    state.raf = 0;
    if (!state.running) return;
    // last 在 kick 里重置成本帧起点，而不是"起点减去已走时长"——
    // 那样第一帧的 delta 等于整个时长，进度直接跳到 1，搭建动画等于没演。
    state.progress = Math.min(1, state.progress + (now - last) / BUILD_MS);
    last = now;
    paint(now);
    if (state.progress < 1) schedule();
    else state.running = false;
  }

  function kick() {
    if (REDUCED) { state.progress = 1; paint(0); return; }
    if (state.running) return;
    state.running = true;
    last = performance.now();
    schedule();
  }

  /** 从零重放一次搭建过程 */
  function replay() {
    stopLoop();
    state.progress = 0;
    state.armed = true;
    paint(0);
    kick();
  }

  /* ── 算三份方案（真跑引擎） ── */
  for (const s of SCENARIOS) {
    const r = solvePlan({ items: s.items, boxType: 'AUTO', timeLimitMs: 2500 });
    if (r && !r.error && r.containers.length) {
      state.plans.push(r);
      state.layerCounts.push(r.containers[0].layers.length);
    } else {
      state.plans.push({ error: (r && r.error) || '无法生成方案' });
      state.layerCounts.push(1);
    }
  }

  /* ── 挂载观察：离开视口就停，别让介绍页在后台空转 ── */
  let firstEntry = true;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        fitCanvas();
        // 第一次进视口才重放搭建过程；之后保持完整状态，切视图时才重放。
        if (firstEntry || !state.armed) { firstEntry = false; replay(); }
        else paint(0);
      } else if (state.raf || state.timer) {
        stopLoop();
      }
    }
  }, { threshold: 0.18 });
  io.observe(shell);

  const ro = new ResizeObserver(() => { fitCanvas(); paint(0); });
  ro.observe(stage);

  fitCanvas();
  select(0);

  return () => {
    io.disconnect();
    ro.disconnect();
    stopLoop();
  };
}

/**
 * 供介绍页展示货号图例用的小工具：按色板给一个货号取色，
 * 保证图例颜色和 3D 图里的箱子颜色对得上。
 */
export const legendColor = colorFor;

/** 场景标签给导航用 */
export const demoScenarios = SCENARIOS.map(s => ({ key: s.key, label: s.label, hint: s.hint }));