/**
 * 摄像头采集管线（PRD 第 4 章）。
 *
 * ── 先说清楚一件 PRD 没写、但绕不过去的事 ──────────────────────────
 * PRD 4.2.1 方案 A 写「参照物法，±1.5cm，一次取景测出 L×W×H」。
 * 这在几何上做不到：一张俯视图只有箱体顶面的二维投影，**高度不在画面里**。
 * 顶面能测出长和宽；高度要么再拍一张（PRD 自己列为方案 B），要么靠已知值。
 *
 * 本模块的做法：
 *   · 一次俯视 → 长 × 宽（±1.5cm，可靠）
 *   · 高度 → 侧视补一张（±0.8cm），或用 SKU 主数据里已有的高度
 *   · 两者都没有 → 明确要求补录，**不猜**
 * 把猜出来的数写进主数据，后面一柜全错——这正是 PRD 4.3「绝不静默存错」的底线。
 *
 * 模块内的纯几何函数（标定、量距、直线度、位移判定）不碰 DOM，可在 Node 下测试。
 */

import { readScale, stabilize } from './ocr.js';

/* ═══════════════════════════════════════════════════════════════════
   纯几何：标定与量距
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 由参照物两点标定像素/厘米比。
 * @param {{x,y}} p1 参照物端点 1（画面像素）
 * @param {{x,y}} p2 参照物端点 2
 * @param {number} realCm 两点真实距离（cm）
 */
export function calibrate(p1, p2, realCm) {
  const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(px > 1) || !(realCm > 0)) return { ok: false, reason: '标定点无效' };
  return { ok: true, pxPerCm: px / realCm, refPx: px, realCm };
}

/** 已知标定下的像素距离 → cm */
export function pxToCm(px, cal) {
  if (!cal || !cal.ok) return null;
  return px / cal.pxPerCm;
}

/**
 * 由一个四边形的四条边推算长宽（cm）。
 *
 * 用对边平均而不是取最长边：拍摄总有轻微透视，只认最长边会让短边系统性偏小，
 * 而短边恰恰是"能不能塞进柜子"的决定性尺寸（PRD 6.2 第 1 条门框约束）。
 */
export function quadToDims(quad, cal) {
  if (!quad || quad.length !== 4) return { ok: false, reason: '需要 4 个角点' };
  const side = (a, b) => pxToCm(Math.hypot(b.x - a.x, b.y - a.y), cal);
  const sides = [side(quad[0], quad[1]), side(quad[1], quad[2]), side(quad[2], quad[3]), side(quad[3], quad[0])];
  if (sides.some(s => !Number.isFinite(s) || s <= 0)) return { ok: false, reason: '边长计算失败' };
  const longSide = (sides[0] + sides[2]) / 2;
  const shortSide = (sides[1] + sides[3]) / 2;
  // 顶面被斜拍时对边不等长，说明透视明显，此时结果不可信
  const skew = Math.abs(sides[0] - sides[2]) / Math.max(longSide, 1);
  return {
    ok: true,
    length: +Math.max(longSide, shortSide).toFixed(1),
    width: +Math.min(longSide, shortSide).toFixed(1),
    skew: +skew.toFixed(3),
    sides: sides.map(s => +s.toFixed(1)),
    perspectiveWarning: skew > 0.12,
  };
}

/**
 * 双视角求高度（PRD 4.2.1 方案 B）：侧面再拍一张，量箱体竖直边。
 * 两次拍摄之间纸箱与手机都不能动，所以 UI 要引导用户"把手机转到侧面，别动箱子"。
 */
export function heightFromSideView(sideQuad, cal, topDims) {
  const d = quadToDims(sideQuad, cal);
  if (!d.ok) return { ok: false, reason: d.reason };
  // 侧面看到的矩形里，水平方向对应箱子的长或宽，竖直方向才是高度。
  // 挑与俯视结果更接近的那条边作基准，剩下的那条即高度。
  const horizontal = d.length;
  const matchLong = topDims && Math.abs(horizontal - topDims.length) < Math.abs(horizontal - topDims.width);
  const height = matchLong ? d.width : d.length;
  return { ok: true, height: +height.toFixed(1), referenceSide: +horizontal.toFixed(1), perspectiveWarning: d.perspectiveWarning };
}

/* ═══════════════════════════════════════════════════════════════════
   纯几何：画面质量判定（PRD 4.3 异常清单 / 验收 V-02、V-06）
   ═══════════════════════════════════════════════════════════════════ */

/** 直线性：把一条边按点数采样，算各点到首末连线（拟合直线）的最大偏离占比 */
export function straightness(points) {
  if (!points || points.length < 3) return { ok: false, value: 0, reason: '点数不足' };
  const n = points.length;
  const x0 = points[0].x, y0 = points[0].y;
  const x1 = points[n - 1].x, y1 = points[n - 1].y;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return { ok: false, value: 0, reason: '边太短' };
  let maxDev = 0;
  for (const p of points) {
    const dev = Math.abs((y1 - y0) * p.x - (x1 - x0) * p.y + x1 * y0 - y1 * x0) / len;
    maxDev = Math.max(maxDev, dev);
  }
  return { ok: true, value: +(maxDev / len).toFixed(4), straight: maxDev / len < 0.02 };
}

/**
 * 采集质量总检。任何一项不过就转人工补录——
 * 这是 PRD 反复强调的"错一个尺寸，后面一柜全错"的兜底。
 */
export function checkQuality(input) {
  const issues = [];
  const { edges = [], quads = 0, displacementCm = 0, confidence = 1, contrast = null, specular = null } = input;

  // 软塌 / 箱体变形：边不直
  for (const e of edges) {
    const s = straightness(e.points);
    if (s.ok && !s.straight) {
      issues.push({ code: 'Q-SOFT', level: 'reject', msg: '箱体边缘不直，可能软塌或变形，请放平重拍' });
    }
  }
  // 黑色覆膜 / 镜面彩盒：找不到可靠边缘（由检测层传入 confidence）
  if (confidence != null && confidence < 0.45) {
    issues.push({ code: 'Q-LOWCONF', level: 'reject', msg: '识别置信度过低，可能反光或贴了黑色覆膜，请翻个面' });
  }
  // 多箱同框：会让"这箱多大"变成薛定谔的箱子
  if (quads > 1) {
    issues.push({ code: 'Q-MULTI', level: 'reject', msg: `画面里有 ${quads} 个箱体，请一次只放一个箱子` });
  }
  // 低对比度：哑光深色背景 + 黑色纸箱是最常见的失败组合
  if (contrast != null && contrast < 0.15) {
    issues.push({ code: 'Q-CONTRAST', level: 'reject', msg: '箱体与背景太接近，请换个深色哑光垫板' });
  }
  // 手机位移 >2cm（PRD 4.3 / V-06）：位移后标定失效，尺寸会系统性偏
  if (displacementCm > 2) {
    issues.push({ code: 'Q-SHIFT', level: 'reject', msg: `镜头偏移了约 ${displacementCm.toFixed(1)}cm，请对准取景框`, displacement: true });
  }
  if (specular != null && specular > 0.3) {
    issues.push({ code: 'Q-GLARE', level: 'reject', msg: '纸箱反光严重，请关掉闪光灯换顶部漫射光' });
  }

  return {
    ok: issues.length === 0,
    issues,
    needRetry: issues.some(i => i.level === 'reject'),
    action: issues.length === 0 ? null : (issues[0].msg + (issues.length > 1 ? `（另有 ${issues.length - 1} 项待处理）` : '')),
  };
}

/**
 * 持续检测的实时判定：摄像头打开后逐帧调用，回答「现在能不能按快门」。
 *
 * 识别"太快"和识别"太蠢"一样危险——画面刚扫到半只箱子就把结果弹出来，
 * 用户根本来不及核对，错了就进了主数据。所以取景阶段只做三件事：
 * 画边缘框、报状态、点亮快门；**尺寸换算与入库判定都推迟到用户点确认之后**。
 *
 * 返回 { code, msg, box, quality, dims, canMeasure }：
 *   NO_BOX    画面里没有可用箱体
 *   QUALITY   有画面但质量不过关（多箱 / 反光 / 边不直 / 低对比度 / 位移）
 *   NEED_CAL  箱体已锁定，但还没标定，量不出厘米
 *   SKEW      透视太斜，量出来的数不可信
 *   READY     可以测量（canMeasure = true，dims 已带出长×宽）
 */
export function liveVerdict(det, cal, opts = {}) {
  const q = det && det.quads ? det.quads[0] : null;
  // 空画面直接报"没找到箱子"：没检出四边形时置信度必然是 0，
  // 拿它去报"可能反光"是把没有的事说成了有
  if (!q) return { code: 'NO_BOX', msg: '没找到箱子，请放平、拍正', box: null, quality: null, dims: null, canMeasure: false };
  const quality = checkQuality({
    quads: det.quads.length,
    confidence: q.confidence,
    contrast: det.contrast,
    specular: det.specular,
    edges: q.edges,
    displacementCm: opts.displacementCm || 0,
  });
  if (!quality.ok) return { code: 'QUALITY', msg: quality.action, box: q, quality, dims: null, canMeasure: false };
  if (!cal || !cal.ok) return { code: 'NEED_CAL', msg: '已锁定箱体边缘，先放参照物点「标定」', box: q, quality, dims: null, canMeasure: false };
  const dims = quadToDims(q.corners, cal);
  if (!dims.ok) return { code: 'QUALITY', msg: '量不出尺寸，请对准后重试', box: q, quality, dims: null, canMeasure: false };
  if (dims.perspectiveWarning) return { code: 'SKEW', msg: '角度太斜，请垂直向下拍', box: q, quality, dims, canMeasure: false };
  return { code: 'READY', msg: '已锁定箱体', box: q, quality, dims, canMeasure: true };
}

/** 纸箱三边归一 + 与已知值比对，给出 ±cm 误差估计 */
export function finalizeDims(lengthCm, widthCm, heightCm, cal) {
  const arr = [lengthCm, widthCm, heightCm].filter(v => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
  if (arr.length < 3) {
    return { ok: false, reason: '只量到部分尺寸，请补拍侧面或手工输入高度', dimsCm: null, measured: arr.length };
  }
  // 误差跟着参照物在画面里的像素长度走：参照物只占 50px 时，1px 就是 0.2cm，
  // 这时候报 ±1cm 是自欺欺人，不如把真实误差带出去让人判断
  const pxPerCm = cal && cal.ok ? cal.pxPerCm : 0;
  const errorCm = pxPerCm > 0 ? +(2 / pxPerCm).toFixed(1) : null;
  return {
    ok: true,
    dimsCm: { l: +arr[0].toFixed(1), w: +arr[1].toFixed(1), h: +arr[2].toFixed(1) },
    errorCm,
    reliable: errorCm != null && errorCm <= 1,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   DOM：相机与取景
   ═══════════════════════════════════════════════════════════════════ */

export class CameraError extends Error {
  constructor(code, msg, hint) {
    super(msg);
    this.code = code;
    this.hint = hint || null;
  }
}

/**
 * 打开摄像头。
 * PRD 验收 H-01：HTTPS 下成功，HTTP 下明确提示"请使用 HTTPS 或微信打开"。
 */
export async function startCamera(video, opts = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new CameraError('NO_API', '当前浏览器不支持调起摄像头', '请用微信打开，或改用手持枪补录');
  }
  const isSecure = typeof location !== 'undefined'
    ? (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))
    : true;
  if (!isSecure) {
    throw new CameraError('INSECURE', '当前不是 HTTPS，无法调起摄像头', '请使用 HTTPS 访问，或在微信里打开');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: opts.facingMode || 'environment',
        width: { ideal: 1280 }, height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('DENIED', '摄像头权限被拒绝', '可在浏览器设置里允许后重试，或用手持枪补录');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('NO_DEVICE', '没有找到可用的摄像头', '请检查设备连接，或改用手持枪补录');
    }
    throw new CameraError('CAMERA', `摄像头启动失败：${err && err.message || err}`, '请重试或改用手持枪补录');
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS Safari 不加会强制全屏播放
  video.muted = true;
  try { await video.play(); } catch { /* 部分浏览器 play() 需用户手势，静默失败即可 */ }
  return {
    stream,
    stop() {
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    },
  };
}

/** 把当前帧拷到 canvas（只取一次，供识别用）。返回 ImageData：detectBoxes/readScale 都要吃像素。 */
export function grabFrame(video, canvas) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new CameraError('NOT_READY', '画面还没准备好', '请稍候再拍');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * 从画面里找箱体四边形。
 *
 * 这里用的是「边缘密度 + 连通域 + 四角拟合」，而不是一个训练好的检测模型。
 * 原因很实际：卷积模型要几百 MB 权重，仓库手机在弱网下下不动；而标定板 + 规则
 * 的组合在**受控工位**（哑光垫板、顶部漫射光、垂直俯拍）里足够稳，且失败时能
 * 明确说"看不清，请翻面"，而不是给一个自信的错答案。
 *
 * 返回 {quads:[{corners, area, confidence}], contrast, specular}；quads 为空即识别失败。
 */
export function detectBoxes(imageData) {
  const { width: W, height: H, data } = imageData;
  const gray = new Uint8ClampedArray(W * H);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[p] = g; sum += g;
  }
  const mean = sum / (W * H);

  // 亮度直方图 → Otsu 阈值
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sigma = 0, threshold = 128, acc = 0, sumB = 0, mB = 0, mF = 0;
  for (let t = 0; t < 256; t++) {
    acc += hist[t];
    if (!acc) continue;
    const rest = total - acc;
    if (!rest) break;
    sumB += t * hist[t];
    mB = sumB / acc; mF = (total - sumB) / rest;
    const between = acc * rest * (mB - mF) * (mB - mF);
    if (between > sigma) { sigma = between; threshold = t; }
  }

  // 亮区连通域（箱体通常比垫板亮；若整体偏暗则取暗区，交给调用方判断）
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > threshold ? 1 : 0;

  const quads = [];
  const minArea = (W * H) * 0.02;
  const visited = new Uint8Array(W * H);
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let area = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    const borderPts = [];
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 只保留边界像素，角点从边界里取
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1
        || !mask[p - 1] || !mask[p + 1] || !mask[p - W] || !mask[p + W]) borderPts.push({ x, y });
      if (x > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - W] && !visited[p - W]) { visited[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] && !visited[p + W]) { visited[p + W] = 1; stack.push(p + W); }
    }
    if (area < minArea) continue;

    const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
    const bboxArea = bboxW * bboxH;
    // 铺满整幅画面 = 没拍到独立的箱子（整屏都是同一个连通域）
    if (bboxArea > (W * H) * 0.9) continue;
    // 填充率太低 = 散碎亮斑（反光、背景杂物），不是实心箱体。
    // 注意**不能**因为填充率高就排除：一个规规矩矩的矩形箱顶，填充率正好是 1
    const fill = bboxArea > 0 ? area / bboxArea : 0;
    if (fill < 0.55) continue;

    const corners = quadCorners(borderPts, { x: minX, y: minY, w: bboxW, h: bboxH });
    quads.push({
      corners,
      area,
      bounds: { x: minX, y: minY, w: bboxW, h: bboxH },
      // 填充率越低说明形状越不规整，角点越不可信
      confidence: +Math.min(1, 0.55 + (fill - 0.55) * 1.5).toFixed(3),
      edges: borderEdges(borderPts, corners),
    });
  }

  quads.sort((a, b) => b.area - a.area);
  // 对比度用「前景均值 − 背景均值」的归一化差值，比类间方差直观：
  // 0.15 对应黑白分明，低于它基本是深色箱配深色垫板
  const contrast = Math.min(1, Math.abs(mB - mF) / 255);
  let bright = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > 240) bright++;
  const specular = bright / gray.length;

  return { quads, contrast: +contrast.toFixed(3), specular: +specular.toFixed(4), threshold, mean: +mean.toFixed(1) };
}

/** 连通域边界 → 四个角点：取 x+y 与 x−y 的四个极值点。
 *  注意 x+y 最大的是**右下**角不是右上——写反了会让排出的四边形自交，
 *  量出来的长宽变成对角线。 */
function quadCorners(pts, box) {
  const fallback = [
    { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
  ];
  if (!pts || pts.length < 4) return fallback;
  let tl = null, tr = null, bl = null, br = null;
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of pts) {
    const a = p.x + p.y, b = p.x - p.y;
    if (a < minA) { minA = a; tl = p; }     // 左上
    if (a > maxA) { maxA = a; br = p; }     // 右下
    if (b > maxB) { maxB = b; tr = p; }     // 右上
    if (b < minB) { minB = b; bl = p; }     // 左下
  }
  return [tl, tr, br, bl].map(p => p || fallback[0]);
}

/** 把边界点按"离哪条边近"归拢到四条边，供直线度检测用 */
function borderEdges(pts, corners) {
  const edges = [[], [], [], []];
  const segs = corners.map((a, i) => [a, corners[(i + 1) % 4]]);
  for (const p of pts) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = pointSegDist(p, segs[i][0], segs[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    edges[best].push(p);
  }
  return edges.filter(e => e.length >= 3).map(points => ({ points }));
}

function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ═══════════════════════════════════════════════════════════════════
   秤屏读数（把 OCR 包成"连续读、稳了才算数"）
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 连续多帧读秤，稳定后返回一次结果。
 * PRD 4.2.2 第 6 条 / 验收 V-04：3 帧跳动 >0.05kg 就不取值，提示"等秤稳"。
 */
export class ScaleReader {
  constructor(opts = {}) {
    this.unit = opts.unit || 'kg';
    this.tare = Number(opts.tare) || 0;
    this.minFrames = opts.minFrames ?? 3;
    this.jitter = opts.jitter ?? 0.05;
    this.readings = [];
  }
  setTare(kg) { this.tare = Number(kg) || 0; this.readings = []; }
  /** 喂一帧识别结果；内部维持 readings 窗口 */
  push(frameResult) {
    const at = Date.now();
    if (frameResult && frameResult.ok && Number.isFinite(frameResult.valueKg)) {
      this.readings.push({ valueKg: frameResult.valueKg - this.tare, ts: at });
    } else {
      // 识别失败也要计入：连着三帧读不出来，同样是"不能取值"
      this.readings.push({ valueKg: null, ts: at });
    }
    if (this.readings.length > 12) this.readings.shift();
    return this.readings.length >= this.minFrames ? stabilize(this.readings, { minFrames: this.minFrames, jitter: this.jitter }) : null;
  }
  reset() { this.readings = []; }
}

/** 从整帧图像的指定区域读秤（region 为 0~1 的相对坐标，方便适配不同分辨率） */
export function readScaleRegion(imageData, region, opts = {}) {
  const x = Math.round(region.x * imageData.width);
  const y = Math.round(region.y * imageData.height);
  const w = Math.round(region.w * imageData.width);
  const h = Math.round(region.h * imageData.height);
  return readScale(imageData, { x, y, w, h }, opts);
}

/** 语音输入（PRD 1.3「语音 > 键盘」），浏览器不支持时返回空串而不是抛错 */
export function startVoice(onText, onError) {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) {
    if (onError) onError(new CameraError('NO_SPEECH', '当前浏览器不支持语音输入', '请直接打字'));
    return null;
  }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = false;
  rec.onresult = e => onText(e.results[0][0].transcript);
  rec.onerror = e => onError && onError(e);
  rec.start();
  return { stop: () => rec.stop() };
}
