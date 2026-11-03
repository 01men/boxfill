/**
 * 3D 装柜图渲染（PRD 第 7 章）。
 *
 * 为什么用 Canvas 2D 画投影，而不是 Three.js：
 *   ① 零依赖。仓库手机常常离线，连 CDN 上的 three.min.js 都拉不下来；
 *   ② 打印要 PNG / SVG，Canvas 出图直接 toDataURL，Three.js 还得额外配导出；
 *   ③ 装柜图的实际规模是"一柜几百到两千个长方体"，画家算法 + 背面剔除
 *      在移动端完全够用，而 WebGL 在低端安卓机上反而更容易掉帧。
 *
 * 代价是箱子上万时旋转会卡——所以做了「超量自动降级为俯视图」（PRD 7.2 降级要求）。
 */

/** SKU 固定色板：按货号哈希取色，保证同一 SKU 在所有图里颜色一致（PRD 7.2） */
const PALETTE = [
  '#2f6fb5', '#e8833a', '#3aa76f', '#c9414f', '#7b5ea7', '#0f9488',
  '#b8860b', '#4a6fa5', '#d2691e', '#556b2f', '#8b4513', '#2e8b57',
];

export function colorFor(skuId) {
  const key = String(skuId || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  // 黄金分割步长散列：相邻货号也分得开，不会连着几个 SKU 都是同一种蓝
  h = (h * 2654435761) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/**
 * 轴测图渲染。
 * @param {HTMLCanvasElement} canvas
 * @param {Container} container 引擎输出的单个柜
 * @param {object} opts {yaw, pitch, zoom, showCavity, selectedSku}
 */
export function renderAxonometric(canvas, container, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cL = container.L, cW = container.W, cH = container.H;
  const yaw = opts.yaw ?? -0.62;
  const pitch = opts.pitch ?? 0.6;
  const zoom = opts.zoom ?? 1;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#f2f5f9'); g.addColorStop(1, '#e3e9f0');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  const cx = cL / 2, cy = cW / 2, cz = cH / 2;
  const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // 投影：先绕 Z 轴 yaw（把柜长转到可视方向），再绕 X 轴 pitch 压出俯仰
  const project = (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const rx = dx * cy1 - dy * sy1;
    const ry = dx * sy1 + dy * cy1;
    return { sx: rx, sy: ry * cp - dz * sp, depth: ry * sp + dz * cp };
  };
  // 方向向量只旋转不平移：背面剔除必须用它，代入 project 会被 -cz*cp 主导而全判成背面
  const projectDir = (x, y, z) => (x * sy1 + y * cy1) * sp + z * cp;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [0, cL]) for (const y of [0, cW]) for (const z of [0, cH]) {
    const s = project(x, y, z);
    minX = Math.min(minX, s.sx); maxX = Math.max(maxX, s.sx);
    minY = Math.min(minY, s.sy); maxY = Math.max(maxY, s.sy);
  }
  const pad = 40;
  const scale = Math.min((W - pad * 2) / ((maxX - minX) || 1), (H - pad * 2) / ((maxY - minY) || 1)) * zoom;
  const offX = W / 2 - ((minX + maxX) / 2) * scale;
  const offY = H / 2 - ((minY + maxY) / 2) * scale;
  const P = (x, y, z) => { const s = project(x, y, z); return [s.sx * scale + offX, s.sy * scale + offY, s.depth]; };

  // 柜体线框
  ctx.strokeStyle = 'rgba(30,60,100,.5)'; ctx.lineWidth = 1.4;
  const E = [[0,0,0],[cL,0,0],[cL,cW,0],[0,cW,0],[0,0,cH],[cL,0,cH],[cL,cW,cH],[0,cW,cH]];
  ctx.beginPath();
  for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) {
    const pa = P(...E[a]), pb = P(...E[b]);
    ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
  }
  ctx.stroke();

  // 箱体六面 → 背面剔除 → 画家算法（远的先画）
  const faces = [];
  for (const layer of container.layers) {
    for (const b of layer.boxes) {
      const base = colorFor(b.skuId);
      const x0 = b.x, y0 = b.y, z0 = b.z;
      const V = [
        [x0,y0,z0], [x0+b.w,y0,z0], [x0+b.w,y0+b.h,z0], [x0,y0+b.h,z0],
        [x0,y0,z0+b.d], [x0+b.w,y0,z0+b.d], [x0+b.w,y0+b.h,z0+b.d], [x0,y0+b.h,z0+b.d],
      ];
      const F = [
        { idx:[4,5,6,7], n:[0,0,1],  k:1.08 },
        { idx:[0,3,2,1], n:[0,0,-1], k:0.5  },
        { idx:[0,1,5,4], n:[0,-1,0], k:0.94 },
        { idx:[2,3,7,6], n:[0,1,0],  k:0.7  },
        { idx:[1,2,6,5], n:[1,0,0],  k:0.84 },
        { idx:[3,0,4,7], n:[-1,0,0], k:0.64 },
      ];
      for (const f of F) {
        if (projectDir(f.n[0], f.n[1], f.n[2]) <= 0) continue;
        const pts = f.idx.map(i => P(...V[i]));
        faces.push({ pts, c: shade(base, f.k), depth: pts.reduce((s, q) => s + q[2], 0) / 4, skuId: b.skuId });
      }
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  ctx.lineWidth = 0.5;
  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.pts[0][0], f.pts[0][1]);
    for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = f.c;
    if (opts.selectedSku && f.skuId !== opts.selectedSku) ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(20,40,70,.22)'; ctx.stroke();
  }

  // 剩余可入洞：绿色虚线框（PRD 7.1 剩余空间视图）
  if (opts.showCavity !== false && container.cavity) {
    const cv = container.cavity;
    const z = container.H - cv.h;
    const pts = [[0,0,z],[cv.l,0,z],[cv.l,cv.w,z],[0,cv.w,z]]
      .map(([x,y,zz]) => P(x, y, zz))
      .map(p => [p[0], p[1]]);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#0f9d58'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(15,157,88,.12)';
    ctx.fill();
    ctx.fillStyle = '#0b7a45';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`可入洞 ${(cv.l / 10).toFixed(0)}×${(cv.w / 10).toFixed(0)}×${(cv.h / 10).toFixed(0)}cm`,
      (pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2);
  }

  // 顶部层高标注（PRD 7.3：每层高度）
  ctx.strokeStyle = 'rgba(180,60,60,.75)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  const a1 = P(0, 0, cH), a2 = P(0, 0, 0);
  ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]);
  ctx.stroke();

  return { scale, faces: faces.length };
}

/** 分层俯视图：仓管照着这张图码放（PRD 7.1） */
export function renderLayerTop(canvas, container, layerIndex) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f4f6f9'; ctx.fillRect(0, 0, W, H);
  // 层号要先钳到合法范围再往下传：查表和回报用的是同一个值。
  // 钳一处、报另一处的话，界面会画着第 5 层却写着"第 999 层"。
  const idx = Math.max(0, Math.min(layerIndex, container.layers.length - 1));
  const layer = container.layers[idx];
  if (!layer) return null;

  const pad = 34;
  const scale = Math.min((W - pad * 2) / container.L, (H - pad * 2) / container.W);
  const ox = (W - container.L * scale) / 2, oy = (H - container.W * scale) / 2;
  const X = x => ox + x * scale, Y = y => oy + y * scale;

  // 毫米网格：仓管要按刻度核对位置，没有网格的俯视图没有用
  const step = container.L > 8000 ? 1000 : 500;
  ctx.strokeStyle = '#eceff3'; ctx.lineWidth = 1;
  ctx.fillStyle = '#aab2bd'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  for (let g = 0; g <= container.L; g += step) {
    ctx.beginPath(); ctx.moveTo(X(g), Y(0)); ctx.lineTo(X(g), Y(container.W)); ctx.stroke();
    ctx.fillText(String(g / 10), X(g), oy - 5);
  }
  ctx.textAlign = 'right';
  for (let g = 0; g <= container.W; g += step) {
    ctx.beginPath(); ctx.moveTo(X(0), Y(g)); ctx.lineTo(X(container.L), Y(g)); ctx.stroke();
    ctx.fillText(String(g / 10), ox - 4, Y(g) + 3);
  }

  ctx.strokeStyle = '#2b4a6f'; ctx.lineWidth = 1.6;
  ctx.strokeRect(X(0), Y(0), container.L * scale, container.W * scale);

  // 按铺设顺序画，后画的盖住先画的：与实际码放一致
  for (const b of [...layer.boxes].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const w = b.w * scale, h = b.h * scale;
    ctx.fillStyle = colorFor(b.skuId) + 'cc';
    ctx.fillRect(X(b.x), Y(b.y), w, h);
    ctx.strokeStyle = 'rgba(20,40,70,.4)'; ctx.lineWidth = 0.7;
    ctx.strokeRect(X(b.x), Y(b.y), w, h);
    if (w > 34 && h > 18) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.code, X(b.x) + w / 2, Y(b.y) + h / 2);
    }
  }

  // 不可倒置货的竖向禁区：画成红色斜纹，提醒上方别压东西
  for (const r of (layer.noStackRects || [])) {
    ctx.save();
    ctx.beginPath(); ctx.rect(X(r.x), Y(r.y), r.w * scale, r.h * scale); ctx.clip();
    ctx.strokeStyle = 'rgba(200,60,60,.5)'; ctx.lineWidth = 1;
    for (let i = -container.H; i < container.L; i += 12) {
      ctx.beginPath(); ctx.moveTo(X(r.x + i), Y(r.y)); ctx.lineTo(X(r.x + i + r.h), Y(r.y + r.h)); ctx.stroke();
    }
    ctx.restore();
  }

  return {
    layerIndex: idx,
    count: layer.boxes.length,
    z: layer.z,
    h: layer.h,
    text: `第 ${layer.index} 层 · 底面 ${(layer.z / 10).toFixed(0)}–${((layer.z + layer.h) / 10).toFixed(0)} cm · ${layer.boxes.length} 箱`,
  };
}

/** 门端侧视图：判断还剩多少高度可塞（PRD 7.1） */
export function renderSideView(canvas, container) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f4f6f9'; ctx.fillRect(0, 0, W, H);
  const pad = 34;
  const scale = Math.min((W - pad * 2) / container.W, (H - pad * 2) / container.H);
  const ox = (W - container.W * scale) / 2, oy = (H - container.H * scale) / 2;
  const X = w => ox + w * scale, Y = h => oy + h * scale;

  // 门框限制：比门框宽的箱子在这一层是塞不进来的
  ctx.fillStyle = 'rgba(200,60,60,.08)';
  ctx.fillRect(X(0), Y(0), container.doorW * scale, container.H * scale);

  const maxLayerH = Math.max(...container.layers.map(l => l.h), 0);
  const used = container.layers.reduce((s, l) => s + l.h, 0);
  ctx.fillStyle = '#c9d4e2';
  ctx.fillRect(X(0), Y(0), container.W * scale, maxLayerH * scale);
  ctx.strokeStyle = '#2b4a6f'; ctx.lineWidth = 1.4;
  ctx.strokeRect(X(0), Y(0), container.W * scale, container.H * scale);

  // 实际码到多高
  ctx.fillStyle = 'rgba(47,111,181,.35)';
  ctx.fillRect(X(0), Y(0), container.W * scale, used * scale);
  ctx.strokeStyle = '#2f6fb5'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(0), Y(used)); ctx.lineTo(X(container.W), Y(used)); ctx.stroke();

  ctx.fillStyle = '#33405a'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`门宽 ${(container.doorW / 10).toFixed(0)}cm`, X(container.W / 2), Y(container.H) + 22);
  ctx.textAlign = 'left';
  ctx.fillText(`已码 ${(used / 10).toFixed(0)}cm`, X(container.W) + 6, Y(used));
  ctx.fillText(`柜高 ${(container.H / 10).toFixed(0)}cm`, X(container.W) + 6, Y(0));
  return { used, remain: container.H - used };
}

/** 配重剖面柱状图：一眼看出"头重"（PRD 7.1） */
export function renderBalanceChart(canvas, container) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const dist = container.distribution || [];
  const max = Math.max(...dist.map(d => d.kg), 1);
  const pad = { l: 40, r: 14, t: 16, b: 26 };
  const bw = (W - pad.l - pad.r) / (dist.length || 1);
  const bh = H - pad.t - pad.b;

  ctx.strokeStyle = '#e4e7ec'; ctx.lineWidth = 1;
  ctx.fillStyle = '#98a2b3'; ctx.font = '10px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + bh * i / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText((max * (1 - i / 4)).toFixed(0), pad.l - 5, y + 3);
  }

  dist.forEach((d, i) => {
    const h = (d.kg / max) * bh;
    // 超过 CTU 60/50 的段落标红：超限的段是最需要先动的
    const ratio = d.kg / (container.weightKg || 1);
    ctx.fillStyle = ratio > 0.3 ? '#c9414f' : '#2f6fb5';
    ctx.fillRect(pad.l + i * bw + 2, pad.t + bh - h, bw - 4, h);
  });

  ctx.fillStyle = '#667085'; ctx.textAlign = 'center';
  dist.forEach((d, i) => {
    if (i % 2 === 0) ctx.fillText(`${(d.from / 100).toFixed(0)}m`, pad.l + i * bw + bw / 2, H - 8);
  });
  ctx.textAlign = 'left';
  ctx.fillText('柜头', pad.l, H - 8 - 12);
  ctx.textAlign = 'right';
  ctx.fillText('柜尾', W - pad.r, H - 8 - 12);
  return { max };
}

/** 超量时降级：只画俯视图，宁可信息少也不要白屏卡死（PRD 7.2 降级） */
export function shouldDegrade(container) {
  const boxes = container.layers.reduce((s, l) => s + l.boxes.length, 0);
  return boxes > 1500;
}

export { PALETTE };
