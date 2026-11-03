/**
 * H5 应用主控。
 *
 * 主流程三屏：算 → 单 → 数；另有一屏「测」（摄像头识别）作为实验功能排在最后。
 * 业务逻辑全在 core/ 与 vision/ 里，这里只做「把数据搬到屏幕上、把用户操作变成参数」。
 * 这样分层的好处是：算法可以在 Node 下被测试穷举，UI 出问题也不会连累算法。
 *
 * 服务端（MCP）复用同一套 core —— 见 server/tools.js，两端不会算出两个答案。
 */

import { Store, parseCSV, toCSV, mapRow } from './core/store.js';
import { solvePlan, estimateContainers, boxFitsContainer } from './core/engine.js';
import { buildBilling, CHANNELS } from './core/billing.js';
import { suggestConsolidation } from './core/consolidate.js';
import { CONTAINERS, normalizeDimsCm, clone } from './core/units.js';
import {
  buildPackingList, buildLoadingPlan, buildVgm, buildBalanceReport, buildCostSummary,
  buildPrintBundle, buildLoadingPlanCsv, buildPackingListCsv, buildViolationList,
} from './core/docs.js';
import {
  startCamera, grabFrame, detectBoxes, liveVerdict,
  calibrate, ScaleReader, readScaleRegion, CameraError,
} from './vision/camera.js';
import { encodeToPng, analyzeRemote } from './vision/cloud.js';
import { renderAxonometric, renderLayerTop, renderSideView, renderBalanceChart, colorFor, shouldDegrade } from './ui/view3d.js';
import { applyHash, installDshApi } from './dsh.js';

const $ = id => document.getElementById(id);
const store = new Store();

const state = {
  // 默认落在「算」而不是「测」：摄像头识别是实验功能，主流程必须先能用。
  screen: 'calc',
  cam: null,
  scaleReader: new ScaleReader(),
  calibration: null,           // 标定：像素/厘米
  pending: null,               // 待入库的一箱
  plan: null,
  billing: null,
  picked: { orders: new Set(), skus: new Set() },
  lines: [],                   // 手工加的行
  view: '3d',
  layerIdx: 0,
  containerIdx: 0,
  yaw: -0.62, pitch: 0.6, zoom: 1,
  offlineEstimate: false,
};

/* ═══════════════════════════════════════════════════════════════════
   通用 UI 帮手
   ═══════════════════════════════════════════════════════════════════ */

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function modal(title, bodyHtml, footHtml = '') {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalFoot').innerHTML = footHtml;
  $('modal').hidden = false;
}
function closeModal() {
  // 确认测量的弹层被直接关掉（✕ / 遮罩）时恢复连续检测，别把画面冻死；
  // 云端流程的弹层被关掉则退出云端模式（照片还挂在取景台上，留着只会误导）
  const frozenUnconfirmed = state.frozen && !state.pending;
  const cloudUnconfirmed = state.cloud && !state.pending;
  $('modal').hidden = true;
  if (frozenUnconfirmed) retake();
  if (cloudUnconfirmed) { exitCloud(); setLight('idle', '云端识别已取消，可重新拍照'); }
}
$('modalClose').onclick = closeModal;
$('modal').onclick = e => { if (e.target === $('modal')) closeModal(); };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });

function go(screen) {
  state.screen = screen;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + screen));
  document.querySelectorAll('.tabs-bottom button').forEach(b => b.classList.toggle('on', b.dataset.go === screen));
  window.scrollTo(0, 0);
  if (screen === 'data') renderData();
  if (screen === 'docs') renderDocs();
}
document.querySelectorAll('.tabs-bottom button').forEach(b => { b.onclick = () => go(b.dataset.go); });

/* ═══════════════════════════════════════════════════════════════════
   画面 1「测」
   ═══════════════════════════════════════════════════════════════════ */

function setLight(kind, text) {
  const el = $('light');
  el.className = 'light ' + kind;
  $('lightText').textContent = text;
}

$('btnCam').onclick = async () => {
  try {
    state.cam = await startCamera($('video'));
    $('stage').classList.add('live');
    $('stageEmpty').hidden = true;
    $('shotBar').hidden = false;
    setLight('idle', '连续检测中：把纸箱和秤屏放进取景框');
    loopFrame();
  } catch (err) {
    const code = err instanceof CameraError ? err : new CameraError('X', String(err && err.message || err));
    setLight('no', code.message);
    modal('打不开摄像头', `<p>${esc(code.message)}</p>${code.hint ? `<p style="margin-top:8px;color:#55647a">${esc(code.hint)}</p>` : ''}`,
      '<button class="btn ghost" id="mmClose">知道了</button><button class="btn primary" id="mmManual">手工补录</button>');
    $('mmClose').onclick = closeModal;
    $('mmManual').onclick = () => { closeModal(); showManual(); };
  }
};
$('btnManual').onclick = showManual;
function showManual() {
  $('manualBox').hidden = false;
  $('measureResult').hidden = true;
  setLight('idle', '手工补录');
  $('manualBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('btnManualSave').onclick = () => {
  const code = $('mCode').value.trim() || 'NEW-' + Date.now().toString(36);
  const dimsCm = normalizeDimsCm({ l: +$('mL').value, w: +$('mW').value, h: +$('mH').value });
  const weightKg = +$('mWt').value;
  if (!(dimsCm.l > 0 && weightKg > 0)) return toast('尺寸和毛重必须填');
  const sku = store.upsertSku({ code, nameCn: $('mName').value.trim(), dimsCm, weightKg, changeReason: '手工补录' });
  toast(`已建档 ${sku.code}，下次自动认`);
  $('manualBox').hidden = true;
  renderData();
};

/* ── 云端拍照识别（附赠能力，实验） ─────────────────────────────────
 * 流程：拍照/选图 → 编码 PNG 上传（无标定）→ 服务端框出箱体候选 →
 * 用户在照片上点参照物两端（refPx）→ 带参重新解析 → 核对表单（可改）→ 入库。
 * 服务端返回固定带免责声明；重量不在本流程读（秤屏可后续框选），表单里手填。
 * state.cloud 非空即处于云端模式，stage 的点击与渲染都被它接管。 */
let cloudBusy = false;
$('btnCloud').onclick = () => {
  const api = store.getSettings().visionApiUrl;
  if (!api) {
    return modal('先配置服务地址', `<p>云端识别还没配置服务地址。到 <b>数 → 设置 → 云端识别 API</b> 填入服务地址（本机演示用 <code>http://localhost:8787</code>，服务端用 <code>npm run mcp:http</code> 启动）。</p>
      <p style="margin-top:8px;color:#55647a">没有服务也可以直接用手工补录，结果完全等价。</p>`,
      '<button class="btn primary" id="cvOk">知道了</button>');
  }
  $('cloudFile').click();
};

$('cloudFile').onchange = async () => {
  const f = $('cloudFile').files && $('cloudFile').files[0];
  $('cloudFile').value = '';
  if (!f || cloudBusy) return;
  cloudBusy = true;
  try {
    const png = await encodeToPng(f);
    stopCameraIfAny();
    state.cloud = { png, taps: [], mode: 'ref', refRealCm: 29.7, refPx: null };
    await showCloudPhoto(png);
    setLight('idle', '已上传，正在识别…');
    const r = await analyzeRemote(store.getSettings().visionApiUrl, png, {});
    state.cloud.last = r;
    drawCloudOverlay();
    if (!r.detection.found) {
      setLight('no', '照片里没找到箱体。请平放、拍正、避免反光后再试一次');
      return;
    }
    setLight('idle', '已框出箱体（黄框）。点参照物两端（如 A4 长边）完成标定');
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    state.cloud = null;
    drawGuides(null, { quads: [] });
    setLight('no', String(err && err.message || err));
  } finally {
    cloudBusy = false;
  }
};

/** 把照片画进取景台（画到 overlay 上，点按坐标按 cover 裁切映射回图像坐标） */
async function showCloudPhoto(pngBlob) {
  const bmp = await createImageBitmap(pngBlob);
  const cv = $('overlay');
  cv.width = bmp.width; cv.height = bmp.height;
  cv.getContext('2d').drawImage(bmp, 0, 0);
  $('stage').classList.add('live');
  $('stageEmpty').hidden = true;
  $('shotBar').hidden = true;
}

/** 在照片上画箱体候选框与已点的标定点 */
function drawCloudOverlay() {
  const c = state.cloud;
  if (!c) return;
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const r = c.last;
  if (r && r.detection.found && r.detection.cornersPx) {
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = Math.max(3, cv.width / 300);
    ctx.beginPath();
    r.detection.cornersPx.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.stroke();
  }
  ctx.fillStyle = '#ff5252';
  for (const t of c.taps) {
    ctx.beginPath(); ctx.arc(t.x, t.y, Math.max(6, cv.width / 160), 0, Math.PI * 2); ctx.fill();
  }
  if (c.taps.length >= 2) {
    ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(c.taps[0].x, c.taps[0].y); ctx.lineTo(c.taps[1].x, c.taps[1].y); ctx.stroke();
  }
}

/** 云端模式的两点采集：mode='ref' → 标定并重解析；两点坐标按 cover 裁切映射回图像像素 */
function handleCloudTap(e) {
  const c = state.cloud;
  if (!c || cloudBusy) return;
  const cv = $('overlay');
  const rect = cv.getBoundingClientRect();
  // canvas 的 CSS 是 object-fit:cover，先还原出"图像被缩放/裁切"的映射
  const scale = Math.max(rect.width / cv.width, rect.height / cv.height);
  const offsetX = (rect.width - cv.width * scale) / 2;
  const offsetY = (rect.height - cv.height * scale) / 2;
  const p = {
    x: (e.clientX - rect.left + offsetX) / scale,
    y: (e.clientY - rect.top + offsetY) / scale,
  };
  c.taps.push(p);
  if (c.taps.length < 2) { drawCloudOverlay(); setLight('idle', '再点参照物的另一端'); return; }

  if (c.mode === 'ref') {
    c.refPx = Math.hypot(c.taps[1].x - c.taps[0].x, c.taps[1].y - c.taps[0].y);
    reanalyzeCloud();
  }
}

/** 带标定参数重新请求解析，把结果送进核对表单 */
async function reanalyzeCloud() {
  const c = state.cloud;
  if (!c || !(c.refPx > 0)) return;
  cloudBusy = true;
  try {
    setLight('idle', '正在按参照物换算尺寸…');
    const r = await analyzeRemote(store.getSettings().visionApiUrl, c.png, {
      refRealCm: c.refRealCm, refPx: c.refPx,
    });
    c.last = r;
    drawCloudOverlay();
    if (r.ok && r.dimsCm) {
      finishCloud(r);
    } else {
      const why = (r.warnings && r.warnings[0] && r.warnings[0].msg) || '识别不出来，请重拍';
      setLight('no', why);
      c.taps = [];
      drawCloudOverlay();
    }
  } catch (err) {
    setLight('no', String(err && err.message || err));
  } finally {
    cloudBusy = false;
  }
}

/** 云端解析完成 → 核对表单。所有字段都可改；免责声明必须展示。 */
function finishCloud(r) {
  const known = (() => {
    const code = $('scanCode').value.trim();
    return code ? store.getSkuByCode(code) : null;
  })();
  const heightKnown = known ? known.dimsCm.h : null;
  showPartialForm(
    { length: r.dimsCm.l, width: r.dimsCm.w },
    r.weightKg,
    heightKnown,
    r.errorCm,
    '云端解析·仅供参考',
  );
  setLight('ok', '解析完成，请核对修改后入库');
}

/** 相机/云端互斥：开云端流程前把可能开着的摄像头停掉 */
function stopCameraIfAny() {
  if (state.cam) {
    try { state.cam.stop(); } catch { /* 已停过也无妨 */ }
    state.cam = null;
  }
  state.frozen = false;
  state.scaleReader.reset();
  state.scaleStable = null;
  $('shotBar').hidden = true;
}

/** 离开云端模式：清状态、擦掉照片 */
function exitCloud() {
  state.cloud = null;
  const cv = $('overlay');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

/**
 * 连续检测循环：摄像头开着就一直跑。
 * 只做三件事——画边缘框、报状态、持续读秤攒稳定读数；
 * 尺寸换算与入库判定全部推迟到用户点「确认测量」之后。
 * state.frozen 时暂停识别（保留最后一帧的锁定框），等入库或重拍再恢复。
 */
let frameBusy = false;
async function loopFrame() {
  if (!state.cam) return;
  requestAnimationFrame(loopFrame);
  if (frameBusy || state.frozen) return;
  frameBusy = true;
  try {
    const canvas = $('overlay');
    const img = grabFrame($('video'), canvas);
    const det = detectBoxes(img);
    const v = liveVerdict(det, state.calibration, { displacementCm: state.displacementCm || 0 });
    state.live = v;
    drawGuides(v.box, det);

    if (v.code === 'READY') {
      $('btnShot').disabled = false;
      // 趁用户对准取景框的工夫持续读秤：等按下快门时多半已经稳了
      const region = { x: 0.2, y: 0.7, w: 0.6, h: 0.2 };
      const frame = readScaleRegion(img, region, { unit: $('scaleUnit').value, tare: +$('tareKg').value || 0 });
      state.scaleStable = state.scaleReader.push(frame);
      setLight('ok', state.scaleStable && state.scaleStable.stable
        ? `✓ 已锁定箱体边缘，秤已稳（${state.scaleStable.value}kg）——核对取景后点「确认测量」`
        : '✓ 已锁定箱体边缘，正在读秤…');
    } else {
      $('btnShot').disabled = v.code !== 'NEED_CAL';
      setLight(v.code === 'NEED_CAL' ? 'idle' : 'no', v.msg);
    }
  } catch (err) {
    setLight('no', '识别出错：' + String(err && err.message || err));
  } finally {
    frameBusy = false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 「确认测量」：从连续检测切到一次性测量。等秤稳（最多 ~2s）后弹核对表单。 */
$('btnShot').onclick = async () => {
  const v = state.live;
  if (!v) return toast('画面还没准备好');
  if (v.code === 'NEED_CAL') return doCalibrate();
  if (!v.canMeasure) return toast(v.msg, 2600);

  setLight('idle', '正在锁定读数…');
  let st = state.scaleStable;
  for (let i = 0; (!st || !st.stable) && i < 14; i++) {
    await sleep(140);
    st = state.scaleStable;
  }
  const weightKg = st && st.stable ? +st.value.toFixed(2) : null;
  if (!st || !st.stable) setLight('no', '秤没读稳，重量请在下一步核对填写');

  state.frozen = true;   // 冻结识别，锁定框留在画面上供核对

  // 测量精度跟参照物像素长度走（见 camera.js finalizeDims 的口径）
  const errorCm = state.calibration && state.calibration.ok
    ? +(2 / state.calibration.pxPerCm).toFixed(1) : null;

  // 俯视图拍不出高度（几何硬伤，见 camera.js 顶部说明）。
  // 已扫到货号且主数据里有高度时直接带出来，不用再侧拍一张。
  const known = (() => {
    const code = $('scanCode').value.trim();
    return code ? store.getSkuByCode(code) : null;
  })();
  showPartialForm(v.dims, weightKg, known ? known.dimsCm.h : null, errorCm);
  beep();
};

/** 重拍：保留标定，清掉待入库结果，恢复连续检测 */
function retake() {
  state.pending = null;
  state.frozen = false;
  state.scaleReader.reset();
  state.scaleStable = null;
  $('measureResult').hidden = true;
  setLight('idle', '对准下一箱');
}
$('btnRetake').onclick = retake;

function drawGuides(q, det) {
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!q) return;
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
  ctx.beginPath();
  q.corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath(); ctx.stroke();
  // 画剩下的框，数量 >1 时上层会拦（Q-MULTI）
  if (det.quads.length > 1) {
    ctx.strokeStyle = 'rgba(192,57,43,.9)';
    for (const other of det.quads.slice(1)) {
      ctx.beginPath();
      other.corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath(); ctx.stroke();
    }
  }
}

/** 只量到两维时的核对表单：宁可多问一次，也不猜高度。
 *  note 非空时在顶部展示来源与免责（云端解析的"仅供参考"就是从这里出去的）。 */
function showPartialForm(dims, weightKg, knownHeight, errorCm, note) {
  const noteHtml = note
    ? `<div class="issue warn" style="margin-bottom:10px"><b>${esc(note)}</b>：解析结果由图像自动估算，仅供参考，请逐项核对后再入库。</div>`
    : '';
  modal('核对这箱数据',
    `${noteHtml}<p style="margin-bottom:10px">已测得长×宽${note ? '' : '（俯视图在几何上拍不出高度）'}。高度${knownHeight ? '已从主数据带出' : '请侧拍一张量高度，或直接手工填'}，重量${weightKg != null ? '已读稳自动填入' : '没读稳，请看秤屏手工填'}。</p>
     <div class="grid3">
       <div class="field"><label>长 cm</label><input type="number" id="pL" value="${dims.length}" step="0.1"></div>
       <div class="field"><label>宽 cm</label><input type="number" id="pW" value="${dims.width}" step="0.1"></div>
       <div class="field"><label>高 cm</label><input type="number" id="pH" placeholder="必填" step="0.1" value="${knownHeight || ''}"></div>
     </div>
     <div class="field"><label>单箱毛重 kg</label><input type="number" id="pWt" value="${weightKg ?? ''}" placeholder="${weightKg == null ? '必填' : ''}" step="0.01"></div>`,
    '<button class="btn ghost" id="pCancel">重拍</button><button class="btn primary" id="pOk">确认，待入库</button>');
  $('pCancel').onclick = () => { closeModal(); retake(); };
  $('pOk').onclick = () => {
    const h = +$('pH').value;
    if (!(h > 0)) return toast('高度必填，否则这箱没法算体积');
    const weight = +$('pWt').value;
    if (!(weight > 0)) return toast('毛重必填，秤没读稳时请看秤屏手工填');
    const dimsCm = normalizeDimsCm({ l: +$('pL').value, w: +$('pW').value, h });
    const match = store.matchSku({ code: $('scanCode').value.trim(), dimsCm, weightKg: weight });
    state.pending = { dimsCm, weightKg: weight, confidence: 1, manual: false, match, errorCm };
    // 记录来源：云端识别入主数据时留痕（changeReason 用），并退出云端模式
    state.pendingSource = note === '云端解析·仅供参考' ? '云端识别' : '视觉采集';
    if (note) exitCloud();
    closeModal();
    renderPending();
    setLight('ok', '✓ 已测量，核对后点「入库」');
  };
}

function renderPending() {
  const p = state.pending;
  if (!p) { $('measureResult').hidden = true; return; }
  $('measureResult').hidden = false;
  $('rDims').textContent = `${p.dimsCm.l}×${p.dimsCm.w}×${p.dimsCm.h}`;
  $('rWeight').textContent = p.weightKg ? `${p.weightKg}` : '—';
  const m = p.match || {};
  $('rSku').textContent = m.sku ? m.sku.code : '新 SKU';

  const box = $('mIssues');
  box.innerHTML = '';
  const add = (cls, msg) => {
    const d = document.createElement('div');
    d.className = 'issue ' + cls;
    d.textContent = msg;
    box.appendChild(d);
  };
  if (m.sku) {
    add('ok', `认到 ${m.sku.code} ${m.sku.nameCn || ''}（${m.method === 'barcode' ? '条码精确匹配' : '尺寸重量匹配 ' + m.confidence}）`);
    const dev = store.checkWeightDeviation(m.sku.id, p.weightKg);
    if (dev.level === 'warn') add('warn', dev.reason);
    if (dev.level === 'reject') add('error', dev.reason);
    const jump = store.checkDimensionJump(m.sku.id, p.dimsCm);
    if (jump.level === 'warn') add('warn', jump.reason);
    if (m.method === 'fuzzy' && m.candidates && m.candidates.length > 1) {
      add('info', '认得不太准，若是别的货请点「重测」后改货号');
    }
  } else {
    add('warn', '没见过这个箱：入库时会按新 SKU 建档，下次自动认');
  }
  if (p.errorCm != null && p.errorCm > 1) {
    add('warn', `测量精度约 ±${p.errorCm}cm（参照物在画面里太小），建议靠近一点或换大张标定板`);
  }
}

$('btnCal').onclick = () => doCalibrate();
$('btnSaveSku').onclick = () => {
  const p = state.pending;
  if (!p) return;
  const m = p.match || {};
  const dev = m.sku ? store.checkWeightDeviation(m.sku.id, p.weightKg) : { level: 'ok' };
  if (dev.level === 'reject') return toast('毛重异常太多，请重新称重', 3200);

  const code = $('scanCode').value.trim() || (m.sku ? m.sku.code : 'NEW-' + Date.now().toString(36));
  const sku = store.upsertSku({
    id: m.sku ? m.sku.id : undefined,
    code,
    nameCn: m.sku ? m.sku.nameCn : '',
    dimsCm: p.dimsCm, weightKg: p.weightKg,
    changeReason: p.manual ? '手工补录' : (state.pendingSource || '视觉采集'),
  });
  store.recordMeasurement(sku.id, { dimsCm: p.dimsCm, weightKg: p.weightKg, source: p.manual ? 'manual' : 'vision' });

  // 装柜清单按 SKU 累加箱数（PRD 4.4：一次录入即进入待装清单）
  const line = state.lines.find(l => l.skuId === sku.id);
  if (line) line.boxes += 1;
  else state.lines.push({ skuId: sku.id, code: sku.code, boxes: 1 });

  toast(`已入库 ${sku.code}，本轮待装 ${state.lines.reduce((s, l) => s + l.boxes, 0)} 箱`);
  $('scanCode').value = '';
  state.scaleReader.reset();
  state.scaleStable = null;
  state.pending = null;
  state.frozen = false;
  $('measureResult').hidden = true;
  setLight('ok', '✓ 继续下一箱');
  renderSkuPick();
};

/** 标定：用当前帧里最大的四边形（参照物板）量出像素/厘米 */
async function doCalibrate() {
  if (!state.cam) return toast('先打开摄像头');
  const canvas = document.createElement('canvas');
  const img = grabFrame($('video'), canvas);
  const det = detectBoxes(img);
  const q = det.quads[0];
  if (!q) return setLight('no', '没找到标定板，请把 A4 纸放平在画面里');
  const type = $('refType').value;
  const realCm = type === 'custom' ? +$('refCustom').value : ({ 'a4-long': 29.7, 'a4-short': 21.0, grid10: 10 }[type]);
  if (!(realCm > 0)) return toast('请填参照物真实长度');

  const c = q.corners;
  // A4 长边对应画面里的长边；先量长边再量短边，取像素更多的那条以降低误差
  const b = q.bounds;
  const longPx = Math.max(b.w, b.h), shortPx = Math.min(b.w, b.h);
  const cal = type === 'grid10'
    ? calibrate({ x: 0, y: 0 }, { x: longPx, y: 0 }, 10)
    : (type === 'a4-long' ? calibrate({ x: 0, y: 0 }, { x: longPx, y: 0 }, 29.7)
      : calibrate({ x: 0, y: 0 }, { x: shortPx, y: 0 }, 21.0));
  state.calibration = cal;
  state.calibrationQuad = { corners: c, bounds: b };
  setLight('idle', `已标定 ${cal.pxPerCm.toFixed(2)} 像素/厘米，请把纸箱放进来`);
  toast('标定好了，放箱子进来');
}

/** 取景框点击：云端模式下是"点参照物两端"；摄像头模式下是"点两下量距离"兜底标定 */
$('stage').addEventListener('click', e => {
  if (e.target.closest('button')) return;   // 按钮点击不算标定点
  if (state.cloud) return handleCloudTap(e);
  if (!state.cam) return;
  const cv = $('overlay');
  const rect = cv.getBoundingClientRect();
  const p = {
    x: (e.clientX - rect.left) / rect.width * cv.width,
    y: (e.clientY - rect.top) / rect.height * cv.height,
  };
  state.tapPoints = state.tapPoints || [];
  state.tapPoints.push(p);
  if (state.tapPoints.length === 2) {
    const type = $('refType').value;
    const realCm = type === 'custom' ? +$('refCustom').value : ({ 'a4-long': 29.7, 'a4-short': 21.0, grid10: 10 }[type]);
    const cal = calibrate(state.tapPoints[0], state.tapPoints[1], realCm);
    state.calibration = cal.ok ? cal : null;
    setLight(cal.ok ? 'idle' : 'no', cal.ok ? `已标定 ${cal.pxPerCm.toFixed(2)} 像素/厘米` : '标定点太近，请拉开一点');
    state.tapPoints = [];
  }
});

$('refType').onchange = e => { $('refCustom').hidden = e.target.value !== 'custom'; };
$('btnMatch').onclick = () => {
  const code = $('scanCode').value.trim();
  if (!code) return toast('先扫或输入货号');
  const m = store.matchSku({ code });
  if (!m.sku) return toast('没见过这个货号，入库时会新建', 2600);
  toast(`认到 ${m.sku.code} ${m.sku.nameCn || ''}（${m.sku.dimsCm.l}×${m.sku.dimsCm.w}×${m.sku.dimsCm.h}）`, 2800);
};
$('tareKg').onchange = () => { state.scaleReader.setTare(+$('tareKg').value || 0); toast('皮重已更新'); };

function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.value = 0.06;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch { /* 静音失败无所谓 */ }
}

/* ═══════════════════════════════════════════════════════════════════
   画面 2「算」
   ═══════════════════════════════════════════════════════════════════ */

$('calcSource').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#calcSource button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('orderPick').hidden = b.dataset.src !== 'orders';
  $('skuPick').hidden = b.dataset.src !== 'sku';
  renderPicks();
};

$('btnAddLine').onclick = () => {
  modal('手工加一行', `
    <div class="field"><label>选 SKU</label><select id="hlSku"></select></div>
    <div class="field"><label>箱数</label><input type="number" id="hlBoxes" value="100" min="1"></div>`,
    '<button class="btn ghost" id="hlCancel">取消</button><button class="btn primary" id="hlOk">加入</button>');
  $('hlSku').innerHTML = store.listSkus().map(s =>
    `<option value="${esc(s.id)}">${esc(s.code)} ${esc(s.nameCn || '')} · ${s.dimsCm.l}×${s.dimsCm.w}×${s.dimsCm.h}</option>`).join('')
    || '<option value="">（还没有 SKU，先去建档）</option>';
  $('hlCancel').onclick = closeModal;
  $('hlOk').onclick = () => {
    const skuId = $('hlSku').value;
    const boxes = Math.floor(+$('hlBoxes').value || 0);
    if (!skuId || boxes <= 0) return toast('选 SKU 并填箱数');
    const sku = store.getSku(skuId);
    const exist = state.lines.find(l => l.skuId === skuId);
    if (exist) exist.boxes += boxes;
    else state.lines.push({ skuId, code: sku.code, boxes });
    closeModal();
    toast('已加入待装清单');
    renderSkuPick();
  };
};

/** 清空本轮待装清单（测量屏逐箱攒的 + 手工加的），不动主数据 */
$('btnClearLines').onclick = () => {
  if (!state.lines.length) return toast('待装清单已经是空的');
  if (!confirm(`清空待装清单（共 ${state.lines.reduce((s, l) => s + l.boxes, 0)} 箱）？`)) return;
  state.lines = [];
  renderSkuPick();
  toast('待装清单已清空');
};

function renderPicks() {
  renderOrderPick();
  renderSkuPick();
}

function renderOrderPick() {
  const box = $('orderPick');
  const orders = store.listOrders();
  box.innerHTML = orders.length ? '' : '<p style="font-size:12.5px;color:#8a97a8">还没有订单，去「数 → 订单」导入 CSV 或新建。</p>';
  for (const o of orders) {
    const on = state.picked.orders.has(o.id);
    const el = document.createElement('div');
    el.className = 'item' + (on ? ' on' : '');
    el.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>
      <div class="t"><b>${esc(o.code)} ${esc(o.customer || '')}</b>
      <span>${esc(o.port || '未填目的港')} · ${o.lines.length} 个 SKU · ${o.lines.reduce((s, l) => s + l.boxes, 0)} 箱</span></div>`;
    el.querySelector('input').onchange = ev => {
      if (ev.target.checked) state.picked.orders.add(o.id); else state.picked.orders.delete(o.id);
      el.classList.toggle('on', ev.target.checked);
    };
    box.appendChild(el);
  }
}

function renderSkuPick() {
  const box = $('skuPick');
  const skus = store.listSkus();
  const pendingById = new Map();
  for (const l of state.lines) pendingById.set(l.skuId, (pendingById.get(l.skuId) || 0) + l.boxes);
  const totalPending = [...pendingById.values()].reduce((s, n) => s + n, 0);
  $('pendingTotal').textContent = totalPending ? `待装清单共 ${totalPending} 箱` : '';

  box.innerHTML = skus.length ? '' : '<p style="font-size:12.5px;color:#8a97a8">还没有 SKU，去「数 → SKU」建档。</p>';
  for (const s of skus) {
    const on = state.picked.skus.has(s.id) || pendingById.has(s.id);
    const el = document.createElement('div');
    el.className = 'item' + (on ? ' on' : '');
    el.innerHTML = `<span class="dot" style="background:${colorFor(s.id)}"></span>
      <div class="t"><b>${esc(s.code)} ${esc(s.nameCn || '')}</b>
      <span>${s.dimsCm.l}×${s.dimsCm.w}×${s.dimsCm.h}cm · ${s.weightKg}kg${pendingById.has(s.id) ? ` · <b style="color:#0e6b52">待装 ${pendingById.get(s.id)} 箱</b>` : ''}</span></div>`;
    el.querySelector('.t').onclick = () => {
      if (state.picked.skus.has(s.id)) state.picked.skus.delete(s.id);
      else state.picked.skus.add(s.id);
      renderSkuPick();
    };
    box.appendChild(el);
  }
}

/** 把勾选的订单 / SKU / 手工行汇总成引擎要的 items */
function collectItems() {
  const items = [];
  for (const id of state.picked.skus) {
    const s = store.getSku(id);
    if (!s) continue;
    const line = state.lines.find(l => l.skuId === id);
    const boxes = line ? line.boxes : 100;
    items.push(toEngineItem(s, boxes));
  }
  for (const l of state.lines) {
    if (state.picked.skus.has(l.skuId)) continue;
    const s = store.getSku(l.skuId);
    if (s) items.push(toEngineItem(s, l.boxes));
  }
  const orders = store.listOrders().filter(o => state.picked.orders.has(o.id));
  for (const o of orders) {
    for (const line of o.lines) {
      const s = store.getSku(line.skuId);
      if (!s) continue;
      items.push(toEngineItem(s, line.boxes));
    }
  }
  // 同 SKU 合并：分开算会让同一箱货占两个位置，柜数虚高
  const map = new Map();
  for (const it of items) {
    const k = it.skuId;
    if (map.has(k)) map.get(k).boxes += it.boxes;
    else map.set(k, it);
  }
  return { items: [...map.values()], orders };
}

function toEngineItem(s, boxes) {
  return {
    skuId: s.id, code: s.code, nameCn: s.nameCn, nameEn: s.nameEn,
    dimsCm: s.dimsCm, weightKg: s.weightKg, boxes: Math.floor(boxes) || 0,
    packQty: s.packQty, netWeightKg: s.netWeightKg, maxStack: s.maxStack,
    noInvert: s.noInvert, noInvertDimsCm: s.noInvertDimsCm, fragile: s.fragile,
    attrs: s.attrs, unitValue: s.unitValue,
  };
}

function doCalc() {
  const { items, orders } = collectItems();
  if (!items.length) return toast('先勾订单或勾 SKU', 2600);

  const limits = {};
  if (+$('cLane').value > 0) limits.laneLimitKg = +$('cLane').value;
  if (+$('cTruck').value > 0) limits.truckLimitKg = +$('cTruck').value;
  const pallet = $('cPallet').checked ? store.getSettings().pallet : false;
  const settings = store.getSettings();

  const plan = solvePlan({
    items, boxType: $('cBoxType').value, limits, pallet,
    timeLimitMs: 8000,
    settings,
  });
  if (plan.error) return toast(plan.error, 4000);

  const costs = readCosts();
  const billing = buildBilling(items, {
    costs, divisor: settings.volumeDivisor,
    containers: plan.containers.length,
    limits, boxType: plan.boxType,
    palletCount: $('cPallet').checked ? Math.round(plan.totals.cbm / 1.2) : 0,
  });

  state.plan = plan;
  state.billing = billing;
  state.selectedOrders = orders;
  store.savePlan(plan, { items, orders, settings, limits, skuMap: new Map(store.listSkus().map(s => [s.id, s])) });
  renderResult();
  toast(`方案已生成，用时 ${plan.elapsedMs}ms`);
}
$('btnCalc').onclick = doCalc;

function readCosts() {
  const perBox = +$('cPerBox').value || 0;
  return {
    freightPerCbm: +$('cPerCbm').value || 0,
    freightPerTon: +$('cPerTon').value || 0,
    baseFreight: 0,
    thc: +$('cThc').value || 0,
    doc: +$('cDoc').value || 0,
    baf: +$('cBaf').value || 0,
    monitorFee: 0, palletFee: 0, reinforcementFee: 0,
    oversizeFeePerBox: +$('setOversize').value || 500,
  };
}

function renderResult() {
  const plan = state.plan, b = state.billing;
  $('calcOut').hidden = false;

  // 三行摘要：几个柜 / 多少钱 / 还能塞什么（PRD 画面 2）
  $('sContainers').textContent = `${plan.containers.length} × ${plan.boxType}`;
  const money = b.channels.find(c => c.key === b.recommendedChannel);
  $('sMoney').textContent = money && money.freight > 0
    ? `约 ¥${fmt(money.freight)}`
    : `${fmt(plan.totals.cbm, 1)} 方 / ${fmt(plan.totals.weightKg / 1000, 1)} 吨`;
  const cav = plan.containers[plan.containers.length - 1].cavity;
  $('sMore').textContent = cav
    ? `还能塞 ${(cav.l / 10).toFixed(0)}×${(cav.w / 10).toFixed(0)}×${(cav.h / 10).toFixed(0)}cm 的货`
    : '这一柜满了';
  $('sSub').textContent =
    `${plan.strategyName || ''} · 体积利用率 ${(plan.totals.utilVol * 100).toFixed(0)}% · `
    + `重量利用率 ${(plan.totals.utilWeight * 100).toFixed(0)}% · `
    + `${plan.totals.boxes} 箱 · 抛比 ${plan.totals.densityKgPerCbm} kg/CBM`
    + (b.measure.isLight ? '（抛货，按体积计费）' : '（重货，按重量计费）');

  // 违规清单
  const vlist = $('violList');
  vlist.innerHTML = plan.violations.length
    ? plan.violations.map(v => `<div class="issue ${v.level}">${esc(v.msg)}</div>`).join('')
    : '<div class="issue ok">没有发现问题，可以照这个方案装</div>';
  $('violCard').hidden = false;

  // 甩单
  const sc = $('spillCard');
  if (plan.spill.length) {
    sc.hidden = false;
    const lastC = plan.containers[plan.containers.length - 1];
    const gap = (plan.spill.reduce((s, x) => s + x.cbm, 0) - (lastC.cavity ? (lastC.cavity.l * lastC.cavity.w * lastC.cavity.h) / 1e9 : 0));
    $('spillBox').innerHTML =
      `<table class="t"><thead><tr><th>SKU</th><th class="num">箱数</th><th class="num">体积 CBM</th></tr></thead><tbody>`
      + plan.spill.map(s => `<tr><td>${esc(s.code)}</td><td class="num">${fmt(s.boxes)}</td><td class="num">${fmt(s.cbm, 2)}</td></tr>`).join('')
      + `</tbody></table>
      <p style="margin-top:8px;font-size:12.5px;color:#55647a">三选一：换 45HQ（多 ${(CONTAINERS['45HQ'].availCbm - CONTAINERS[plan.boxType].availCbm).toFixed(1)} CBM）／等下一水拼柜／压缩包装看下面的纸箱优化建议。</p>`;
  } else sc.hidden = true;

  // 剩余空间
  const rem = [];
  plan.containers.forEach(c => {
    rem.push(`<div class="issue info">第 ${c.index} 柜：剩 ${fmt(c.cbm, 2)} CBM · 剩 ${fmt(c.maxPayloadKg - c.weightKg)} kg 承重`
      + (c.cavity ? ` · 最大可入洞 ${(c.cavity.l / 10).toFixed(0)}×${(c.cavity.w / 10).toFixed(0)}×${(c.cavity.h / 10).toFixed(0)}cm` : ' · 已码满')
      + ` · 碎片率 ${(c.fragmentsRatio * 100).toFixed(0)}%</div>`);
  });
  // 能塞进"可入洞"的 SKU Top5（PRD 6.4）
  const lastC = plan.containers[plan.containers.length - 1];
  if (lastC.cavity) {
    const fits = store.listSkus().filter(s => boxFitsContainer(s.dimsCm, plan.boxType).fits).map(s => ({
      s, vol: s.dimsCm.l * s.dimsCm.w * s.dimsCm.h,
      fit: s.dimsCm.l <= lastC.cavity.l && s.dimsCm.w <= lastC.cavity.w && s.dimsCm.h <= lastC.cavity.h,
    })).sort((a, b2) => b2.vol - a.vol);
    const top = fits.filter(x => x.fit).slice(0, 5);
    if (top.length) {
      rem.push('<div class="issue ok">能塞进最后这个洞的货（体积大的优先）：'
        + top.map(x => `${esc(x.s.code)}`).join('、') + '</div>');
    }
  }
  $('remainBox').innerHTML = rem.join('');

  // 箱型比选
  const cmp = b.boxTypeCompare;
  $('cmpCard').hidden = !(cmp && cmp.length);
  if (cmp && cmp.length) {
    $('cmpBox').innerHTML = `<table class="t"><thead><tr><th>柜型</th><th class="num">柜数</th><th class="num">可用方</th><th class="num">限重</th><th class="num">每方单价</th></tr></thead><tbody>`
      + cmp.map(r => `<tr${r.boxType === b.recommendedBoxType ? ' style="background:#e7f4f0;font-weight:700"' : ''}>
          <td>${esc(r.boxType)}${r.boxType === b.recommendedBoxType ? ' ★' : ''}</td>
          <td class="num">${r.containers}</td><td class="num">${r.availCbm}</td>
          <td class="num">${fmt(r.maxPayloadKg / 1000, 1)}t</td>
          <td class="num">${r.costPerCbm ? '¥' + fmt(r.costPerCbm) : '—'}</td></tr>`).join('')
      + '</tbody></table>';
  }

  // 渠道比价
  const hasMoney = b.channels.some(c => c.freight > 0);
  $('chanCard').hidden = !hasMoney;
  if (hasMoney) {
    $('chanBox').innerHTML = `<table class="t"><thead><tr><th>渠道</th><th class="num">计费重</th><th class="num">运费</th><th class="num">比全抛省</th></tr></thead><tbody>`
      + b.channels.map(c => `<tr${c.key === b.recommendedChannel ? ' style="background:#e7f4f0;font-weight:700"' : ''}>
          <td>${esc(c.name)}${c.key === b.recommendedChannel ? ' ★' : ''}</td>
          <td class="num">${fmt(c.chargeableKg)}kg</td><td class="num">¥${fmt(c.freight)}</td>
          <td class="num">${c.diffVsBase > 0 ? '¥' + fmt(c.diffVsBase) : '—'}</td></tr>`).join('')
      + '</tbody></table>';
  }

  // 纸箱优化
  $('cartonCard').hidden = !(b.cartonOptimization && b.cartonOptimization.length);
  if (b.cartonOptimization && b.cartonOptimization.length) {
    $('cartonBox').innerHTML = b.cartonOptimization.map(c =>
      `<div class="issue info"><b>${esc(c.code)}</b>：${c.from.l}×${c.from.w}×${c.from.h} 改成 ${c.to.l}×${c.to.w}×${c.to.h} cm，`
      + `单箱体积重 ${c.volumetricFrom}→${c.volumetricTo} kg，`
      + `全部 ${fmt(c.savedKg)} kg 体积重${b.measure.isLight ? `，按 ${fmt(b.channels.find(x => x.key === b.recommendedChannel)?.freightPerKg || 0, 2)} 元/kg 计约省 ¥${fmt(c.savedMoney)}` : ''}</div>`
    ).join('');
  }

  state.layerIdx = 0;
  renderView();
  renderLayerBar();
  renderDocs();
}

/* ── 视图切换 ── */
$('viewTabs').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#viewTabs button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  state.view = b.dataset.view;
  renderView();
};

function currentContainer() {
  const plan = state.plan;
  if (!plan || !plan.containers.length) return null;
  return plan.containers[Math.min(state.containerIdx, plan.containers.length - 1)];
}

function renderView() {
  const c = currentContainer();
  const cv = $('cv3d');
  const legend = $('legend');
  if (!c) return;

  // 多柜时加一排切换（超过 2 柜才有必要，否则手机上挤不下）
  if (state.plan.containers.length > 1 && state.view === '3d' && !$('layerBar').dataset.multi) {
    const bar = $('layerBar');
    bar.dataset.multi = '1';
    bar.innerHTML = state.plan.containers.map((x, i) =>
      `<button data-ci="${i}" class="${i === state.containerIdx ? 'on' : ''}">第 ${x.index} 柜</button>`).join('');
    bar.hidden = false;
    bar.querySelectorAll('button').forEach(b => b.onclick = () => {
      state.containerIdx = +b.dataset.ci;
      renderLayerBar();
      renderView();
    });
  }

  if (shouldDegrade(c)) {
    // PRD 7.2 降级：低端机/超量时不白屏，改画俯视图
    const info = renderLayerTop(cv, c, state.layerIdx);
    legend.innerHTML = `<div>箱数过多，已降级为俯视图</div><div>${esc(info.text)}</div>`;
    return;
  }

  if (state.view === '3d') {
    renderAxonometric(cv, c, { yaw: state.yaw, pitch: state.pitch, zoom: state.zoom });
    legend.innerHTML = c.items.map(it =>
      `<div><span class="dot" style="display:inline-block;background:${colorFor(it.skuId)}"></span>${esc(it.code)} · ${it.boxes} 箱 · ${fmt(it.weightKg)}kg</div>`).join('');
  } else if (state.view === 'layer') {
    const info = renderLayerTop(cv, c, state.layerIdx);
    legend.innerHTML = `<div>${esc(info.text)}</div><div>斜纹区=不可倒置货上方禁区</div>`;
  } else if (state.view === 'side') {
    const info = renderSideView(cv, c);
    legend.innerHTML = `<div>已码 ${(info.used / 10).toFixed(0)}cm / 柜高 ${(c.H / 10).toFixed(0)}cm</div>`
      + `<div>还能往上码 ${(info.remain / 10).toFixed(0)}cm</div>`;
  } else {
    renderBalanceChart(cv, c);
    legend.innerHTML = `<div>前后差 ${fmt(c.balance.frontDiffKg)}kg（限 800）</div>`
      + `<div>左右差 ${fmt(c.balance.sideDiffKg)}kg（限 500）</div>`
      + `<div>CTU 60/50：${c.balance.endMaxRatio <= 0.6 ? '✓ 合规' : '✗ 违规'}</div>`;
  }
}

function renderLayerBar() {
  const c = currentContainer();
  const bar = $('layerBar');
  if (!c) return;
  if (state.plan.containers.length > 1) { bar.hidden = false; return; }
  bar.hidden = state.view !== 'layer';
  bar.innerHTML = c.layers.map((l, i) =>
    `<button data-li="${i}" class="${i === state.layerIdx ? 'on' : ''}">第 ${l.index} 层 · ${l.boxes.length} 箱</button>`).join('');
  bar.querySelectorAll('button').forEach(b => b.onclick = () => { state.layerIdx = +b.dataset.li; renderView(); renderLayerBar(); });
}

function initCanvasDrag() {
  const cv = $('cv3d');
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    state.yaw += (e.clientX - drag.x) * 0.012;
    state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
    if (state.view === '3d') renderView();
  });
  const stop = () => { drag = null; };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    state.zoom = Math.max(0.35, Math.min(3, state.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    if (state.view === '3d') renderView();
  }, { passive: false });
}

$('btnPng').onclick = () => {
  const cv = $('cv3d');
  cv.toBlob(blob => {
    if (!blob) return toast('导出失败');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `装柜图-${state.plan.boxType}-${state.plan.id}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
  toast('已导出当前视角 PNG');
};
$('btnGoDocs').onclick = () => go('docs');

/* ═══════════════════════════════════════════════════════════════════
   画面 3「单」
   ═══════════════════════════════════════════════════════════════════ */

function docCtx() {
  return {
    plan: state.plan,
    billing: state.billing,
    orders: state.selectedOrders || [],
    skus: store.listSkus(),
    settings: store.getSettings(),
    generatedAt: new Date().toISOString(),
  };
}

function renderDocs() {
  const p = state.plan;
  $('docPlan').innerHTML = p
    ? `<b>${p.boxType} × ${p.containers.length}</b> · ${fmt(p.totals.boxes)} 箱 · ${fmt(p.totals.cbm, 2)} CBM · `
      + `${fmt(p.totals.weightKg / 1000, 2)} 吨 · ${p.id}`
    : '还没有方案，先去「算」跑一次。';
  $('docList').querySelectorAll('.doc').forEach(b => { b.disabled = !p; b.style.opacity = p ? 1 : .5; });
  renderPlanHistory();
}

$('docList').onclick = e => {
  const b = e.target.closest('.doc');
  if (!b || !state.plan) return;
  const ctx = docCtx();
  const kind = b.dataset.doc;

  if (kind === 'csv') {
    const csv = toCSV(parseCSV(buildLoadingPlanCsv(ctx)), Object.keys(parseCSV(buildLoadingPlanCsv(ctx))[0] || {}));
    download(csv, `装柜清单-${state.plan.id}.csv`, true);
    download(buildPackingListCsv(ctx), `装箱单-${state.plan.id}.csv`, true);
    toast('两个 CSV 已导出');
    return;
  }

  let html = '', title = '';
  if (kind === 'packing') { html = buildPackingList(ctx); title = '装箱单 Packing List'; }
  else if (kind === 'loading') { html = buildLoadingPlan(ctx, { byLayer: true }); title = '装柜清单 Loading Plan'; }
  else if (kind === 'vgm') { const r = buildVgm(ctx); html = r.html; title = 'VGM 申报数据'; }
  else if (kind === 'balance') { const r = buildBalanceReport(ctx); html = r.html; title = '配重报告'; }
  else if (kind === 'cost') { const r = buildCostSummary(ctx); html = r.html; title = '费用汇总'; }
  else if (kind === 'print') {
    const bundle = buildPrintBundle(ctx);
    $('printArea').innerHTML = `<style>${bundle.css}</style>${bundle.html}`;
    state.printTitle = bundle.title;
    setTimeout(() => window.print(), 60);
    toast('正在打开打印，可选「存为 PDF」');
    return;
  }
  modal(title, html, '<button class="btn primary" id="dClose">关闭</button>');
  $('dClose').onclick = closeModal;
};

$('btnPrint').onclick = () => {
  if (!state.plan) return toast('还没有方案');
  const bundle = buildPrintBundle(docCtx());
  $('printArea').innerHTML = `<style>${bundle.css}</style>${bundle.html}`;
  state.printTitle = bundle.title;
  window.print();
};

$('btnShare').onclick = async () => {
  if (!state.plan) return toast('还没有方案');
  const ctx = docCtx();
  const text = `${state.plan.boxType} × ${state.plan.containers.length} 柜，${fmt(state.plan.totals.boxes)} 箱，`
    + `${fmt(state.plan.totals.cbm, 2)} CBM，${fmt(state.plan.totals.weightKg / 1000, 2)} 吨，`
    + `体积利用率 ${(state.plan.totals.utilVol * 100).toFixed(0)}%。`;
  const bundle = buildPrintBundle(ctx);
  try {
    const blob = new Blob([bundle.html], { type: 'text/html' });
    const file = new File([blob], `装柜方案-${state.plan.boxType}.html`, { type: 'text/html' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ title: '装柜方案', text, files: [file] });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('已复制方案摘要，发给货代吧', 2800);
  } catch {
    try { await navigator.clipboard.writeText(text); toast('已复制方案摘要'); }
    catch { modal('方案摘要', `<p>${esc(text)}</p>`, '<button class="btn primary" id="sc">关闭</button>'); $('sc').onclick = closeModal; }
  }
};

function download(text, filename, isCSV) {
  const blob = new Blob([isCSV ? text : text], { type: isCSV ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function renderPlanHistory() {
  const box = $('planHistory');
  const plans = store.listPlans().slice(0, 8);
  box.innerHTML = plans.length ? '' : '<p style="font-size:12.5px;color:#8a97a8">还没有历史方案。</p>';
  for (const p of plans) {
    const el = document.createElement('div');
    el.className = 'row-i';
    el.innerHTML = `<div class="t"><b>${esc(p.boxType)} × ${p.containers.length} · ${fmt(p.totals.boxes)} 箱</b>
      <span>${new Date(p.savedAt).toLocaleString('zh-CN')} · ${esc(p.port || '')}${esc(p.customer || '')}</span></div>
      <button class="btn ghost sm">查看</button>`;
    el.querySelector('button').onclick = () => {
      const diff = store.diffPlanAgainstCurrent(p.id);
      const changed = (diff || []).filter(d => d.status === 'changed');
      modal('历史方案回溯',
        `<p><b>${esc(p.boxType)} × ${p.containers.length}</b>，${fmt(p.totals.boxes)} 箱，${fmt(p.totals.cbm, 2)} CBM</p>
         <p style="margin-top:8px;font-size:13px">当时用的主数据：</p>
         <table class="t"><thead><tr><th>SKU</th><th>当时尺寸</th><th>现在尺寸</th></tr></thead><tbody>`
        + (diff || []).map(d => `<tr><td>${esc(d.code)}</td><td>${d.then ? `${d.then.dimsCm.l}×${d.then.dimsCm.w}×${d.then.dimsCm.h}` : '—'}</td>
           <td>${d.now ? `${d.now.dimsCm.l}×${d.now.dimsCm.w}×${d.now.dimsCm.h}` : '已删除'}</td></tr>`).join('')
        + '</tbody></table>'
        + (changed.length ? `<p class="issue warn" style="margin-top:10px">${changed.length} 个 SKU 的主数据在这之后被改过。历史结果按当时的尺寸保留，不会被新尺寸覆盖。</p>`
          : '<p class="issue ok" style="margin-top:10px">主数据没变过，结果仍然有效。</p>'));
    };
    box.appendChild(el);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   数据页
   ═══════════════════════════════════════════════════════════════════ */

$('dataTabs').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#dataTabs button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  for (const t of ['sku', 'order', 'consol', 'setting']) $('pane-' + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === 'sku') renderSkuList();
  if (b.dataset.tab === 'order') renderOrderList();
};

function renderData() {
  renderSkuList();
  renderOrderList();
  const s = store.getSettings();
  $('setDivisor').value = s.volumeDivisor;
  $('setOversize').value = s.costs.oversizeFeePerBox;
  $('setMonitor').value = s.costs.monitorFee;
  $('setVisionApi').value = s.visionApiUrl || '';
}

function renderSkuList() {
  const skus = store.listSkus();
  $('skuCount').textContent = skus.length ? `${skus.length} 个` : '';
  const box = $('skuList');
  box.innerHTML = skus.length ? '' : '<p style="font-size:12.5px;color:#8a97a8">还没有 SKU。可以手工建，也可以导入 CSV。</p>';
  for (const s of skus) {
    const el = document.createElement('div');
    el.className = 'row-i';
    const fit = boxFitsContainer(s.dimsCm, '40HQ');
    el.innerHTML = `<span class="dot" style="background:${colorFor(s.id)}"></span>
      <div class="t"><b>${esc(s.code)} ${esc(s.nameCn || '')}</b>
      <span>${s.dimsCm.l}×${s.dimsCm.w}×${s.dimsCm.h}cm · ${s.weightKg}kg · ${s.packQty}件/箱 · v${s.version}</span>
      <span style="color:${fit.fits && fit.doorOk ? '#0f7b3d' : '#c0392b'}">${fit.fits ? (fit.doorOk ? '40HQ 可装' : '过不了门框') : '装不进 40HQ'}</span></div>
      <button class="btn ghost sm">改</button><button class="x">删</button>`;
    el.querySelector('.btn').onclick = () => skuForm(s);
    el.querySelector('.x').onclick = () => {
      if (!confirm(`删除 ${s.code}？`)) return;
      store.deleteSku(s.id); renderSkuList();
    };
    box.appendChild(el);
  }
}

const ATTRS = [
  ['fragile', '易碎'], ['liquid', '液体'], ['odor', '有气味'], ['absorb', '吸味'],
  ['sharp', '尖锐'], ['damp', '潮气'], ['food', '食品'], ['danger', '危险品'], ['unsanitary', '不洁'],
];

function skuForm(sku) {
  const s = sku || { attrs: {} };
  modal(sku ? `改 ${sku.code}` : '新建 SKU',
    `<div class="grid3">
      <div class="field"><label>货号 *</label><input id="fCode" value="${esc(s.code || '')}"></div>
      <div class="field"><label>品名</label><input id="fName" value="${esc(s.nameCn || '')}"></div>
      <div class="field"><label>英文品名</label><input id="fNameEn" value="${esc(s.nameEn || '')}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>长 cm *</label><input type="number" step="0.1" id="fL" value="${s.dimsCm ? s.dimsCm.l : ''}"></div>
      <div class="field"><label>宽 cm *</label><input type="number" step="0.1" id="fW" value="${s.dimsCm ? s.dimsCm.w : ''}"></div>
      <div class="field"><label>高 cm *</label><input type="number" step="0.1" id="fH" value="${s.dimsCm ? s.dimsCm.h : ''}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>单箱毛重 kg *</label><input type="number" step="0.01" id="fWt" value="${s.weightKg || ''}"></div>
      <div class="field"><label>装箱数（件/箱）</label><input type="number" id="fPack" value="${s.packQty || 1}"></div>
      <div class="field"><label>堆码层数上限<br><small>留空 = 不限</small></label><input type="number" id="fStack" value="${s.maxStack || ''}" placeholder="不限"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>单箱货值 ¥</label><input type="number" id="fVal" value="${s.unitValue || ''}"></div>
      <div class="field"><label>供应商</label><input id="fSup" value="${esc(s.supplier || '')}"></div>
      <div class="field"><label>仓位</label><input id="fLoc" value="${esc(s.location || '')}"></div>
    </div>
    <div class="field inline"><input type="checkbox" id="fInv" ${s.noInvert ? 'checked' : ''}><label for="fInv">不可倒置（必须放柜底，上方留空）</label></div>
    <div class="sec" style="margin-top:10px">货物属性<span class="hint">决定混装禁忌与堆码限制</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px">
      ${ATTRS.map(([k, n]) => `<label class="inline"><input type="checkbox" data-attr="${k}" ${(s.attrs && s.attrs[k]) ? 'checked' : ''}><label>${n}</label></label>`).join('')}
    </div>`,
    '<button class="btn ghost" id="fCancel">取消</button><button class="btn primary" id="fOk">保存</button>');
  $('fCancel').onclick = closeModal;
  $('fOk').onclick = () => {
    const attrs = {};
    $('modalBody').querySelectorAll('[data-attr]').forEach(el => { attrs[el.dataset.attr] = el.checked; });
    const code = $('fCode').value.trim();
    if (!code) return toast('货号必填');
    const dimsCm = normalizeDimsCm({ l: +$('fL').value, w: +$('fW').value, h: +$('fH').value });
    const weightKg = +$('fWt').value;
    if (!(dimsCm.l > 0 && weightKg > 0)) return toast('尺寸和毛重必填');
    store.upsertSku({
      id: sku ? sku.id : undefined, code,
      nameCn: $('fName').value.trim(), nameEn: $('fNameEn').value.trim(),
      dimsCm, weightKg,
      packQty: +$('fPack').value || 1,
      maxStack: +$('fStack').value || 0,
      unitValue: +$('fVal').value || 0,
      supplier: $('fSup').value.trim(), location: $('fLoc').value.trim(),
      noInvert: $('fInv').checked,
      attrs, changeReason: '手工编辑',
    });
    closeModal();
    renderSkuList();
    renderPicks();
    toast('已保存');
  };
}

$('btnSkuAdd').onclick = () => skuForm(null);
$('btnSkuExport').onclick = () => {
  const rows = store.listSkus().map(s => ({
    货号: s.code, 品名: s.nameCn, 英文品名: s.nameEn,
    长: s.dimsCm.l, 宽: s.dimsCm.w, 高: s.dimsCm.h,
    毛重: s.weightKg, 装箱数: s.packQty, 堆码层数: s.maxStack || '',
    单箱货值: s.unitValue || '', 供应商: s.supplier, 仓位: s.location,
  }));
  download(toCSV(rows), 'SKU主数据.csv', true);
  toast('已导出 CSV');
};
$('btnSkuCsv').onclick = () => pickFile(text => {
  const rows = parseCSV(text).map(mapRow);
  let ok = 0;
  for (const r of rows) {
    if (!r.dimsCm || !(r.weightKg > 0)) continue;
    store.upsertSku({ code: r.sku || r.code, nameCn: r.nameCn, dimsCm: r.dimsCm, weightKg: r.weightKg, packQty: r.packQty, unitValue: r.unitValue, changeReason: 'CSV 导入' });
    ok++;
  }
  renderSkuList();
  toast(`导入 ${ok} 个 SKU${rows.length - ok ? `，${rows.length - ok} 行缺尺寸或重量被跳过` : ''}`, 3200);
});

$('btnOrdAdd').onclick = () => {
  const skus = store.listSkus();
  if (!skus.length) return toast('先建 SKU', 2600);
  modal('新建订单',
    `<div class="grid3">
      <div class="field"><label>订单号</label><input id="oCode"></div>
      <div class="field"><label>客户</label><input id="oCus"></div>
      <div class="field"><label>目的港</label><input id="oPort" placeholder="Jebel Ali"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>船期航次</label><input id="oVes"></div>
      <div class="field"><label>截关时间</label><input type="datetime-local" id="oCut"></div>
      <div class="field"><label>交期</label><input type="date" id="oDue"></div>
    </div>
    <div class="field inline"><input type="checkbox" id="oMix" checked><label for="oMix">允许拼柜</label></div>
    <div class="sec" style="margin-top:10px">货品</div>
    ${skus.map(s => `<div class="grid3" style="margin-bottom:6px">
      <div class="field"><label>${esc(s.code)} ${esc(s.nameCn || '')}</label></div>
      <div class="field"><label>箱数</label><input type="number" id="ob_${s.id}" value="0" min="0"></div>
      <div class="field"><label>备注</label><input id="on_${s.id}"></div>
    </div>`).join('')}`,
    '<button class="btn ghost" id="oCancel">取消</button><button class="btn primary" id="oOk">保存</button>');
  $('oCancel').onclick = closeModal;
  $('oOk').onclick = () => {
    const lines = [];
    for (const s of skus) {
      const boxes = Math.floor(+$('ob_' + s.id).value || 0);
      if (boxes > 0) lines.push({ skuId: s.id, boxes });
    }
    if (!lines.length) return toast('至少填一个箱数');
    store.upsertOrder({
      code: $('oCode').value.trim() || undefined, customer: $('oCus').value.trim(),
      port: $('oPort').value.trim(), vessel: $('oVes').value.trim(),
      cutOff: $('oCut').value ? new Date($('oCut').value).toISOString() : '',
      dueDate: $('oDue').value,
      customerAllowMixed: $('oMix').checked, lines,
    });
    closeModal(); renderOrderList(); renderPicks(); toast('订单已保存');
  };
};

function renderOrderList() {
  const orders = store.listOrders();
  $('orderCount').textContent = orders.length ? `${orders.length} 单` : '';
  const box = $('orderList');
  box.innerHTML = orders.length ? '' : '<p style="font-size:12.5px;color:#8a97a8">还没有订单。可以手工建，或导入 CSV / PI。</p>';
  for (const o of orders) {
    const el = document.createElement('div');
    el.className = 'row-i';
    el.innerHTML = `<div class="t"><b>${esc(o.code)} ${esc(o.customer || '')}</b>
      <span>${esc(o.port || '未填目的港')} · ${esc(o.vessel || '')} · ${o.lines.length} SKU · ${o.lines.reduce((s, l) => s + l.boxes, 0)} 箱</span>
      ${o.customerAllowMixed === false ? '<span style="color:#c0392b">客户拒绝混装</span>' : ''}</div>
      <button class="x">删</button>`;
    el.querySelector('.x').onclick = () => {
      if (!confirm(`删除订单 ${o.code}？`)) return;
      store.deleteOrder(o.id); renderOrderList();
    };
    box.appendChild(el);
  }
}

$('btnOrdCsv').onclick = () => pickFile(text => {
  const rows = parseCSV(text).map(mapRow);
  // 按订单号 + 客户 + 目的港分组：PI 表本来就是一单一片段
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.raw['订单号'] || r.raw['PO'] || r.raw['order'] || 'IMPORT'}|${r.customer || ''}|${r.port || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let made = 0, madeSku = 0;
  for (const [key, list] of groups) {
    const [code, customer, port] = key.split('|');
    const lines = [];
    for (const r of list) {
      if (!r.dimsCm || !(r.weightKg > 0)) continue;
      let sku = r.sku ? store.getSkuByCode(r.sku) : null;
      if (!sku) {
        sku = store.upsertSku({ code: r.sku || `IMP-${Date.now().toString(36)}`, nameCn: r.nameCn, dimsCm: r.dimsCm, weightKg: r.weightKg, packQty: r.packQty, changeReason: 'PI 导入' });
        madeSku++;
      }
      if (r.boxes > 0) lines.push({ skuId: sku.id, boxes: r.boxes });
    }
    if (lines.length) {
      store.upsertOrder({ code, customer, port, vessel: list[0].vessel || '', cutOff: list[0].cutOff || '', lines });
      made++;
    }
  }
  renderOrderList(); renderSkuList(); renderPicks();
  toast(`导入 ${made} 个订单${madeSku ? `，新建 ${madeSku} 个 SKU` : ''}`, 3400);
});

function pickFile(cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv,text/plain';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => cb(String(reader.result || ''));
    reader.readAsText(f, 'utf-8');
  };
  input.click();
}

/* ── 拼单 ── */
$('btnConsol').onclick = () => {
  const orders = store.listOrders();
  if (orders.length < 2) return toast('至少要有两票货才能拼', 2600);
  const skuMap = new Map(store.listSkus().map(s => [s.id, s]));
  const res = suggestConsolidation(orders, skuMap, {
    containerCost: +$('consolCost').value || 0,
    rejectReasons: store.rejectMixedReasons(),
    boxType: $('cBoxType').value === 'AUTO' ? '40HQ' : $('cBoxType').value,
  });
  const out = $('consolOut');
  state.consol = res;
  if (!res.groups.some(g => g.suggestions.length)) {
    out.innerHTML = '<div class="issue warn">没找到值得拼的组合。目的港不同、客户拒混装、或货物性质冲突都会直接拦下。</div>';
    return;
  }
  out.innerHTML = res.groups.filter(g => g.suggestions.length || g.solo.length).map(g => `
    <div class="sec" style="margin-top:12px">${esc(g.port || '未填目的港')} · ${g.orderCount} 单</div>
    ${g.suggestions.map(s => `<div class="issue ok">
      <b>${s.orders.map(o => esc(o.code)).join(' + ')}</b> 拼一柜 ${esc(s.boxType)}（${s.orders.length} 单）<br>
      ${s.orders.map(o => `${esc(o.code)}: ${fmt(o.cbm, 1)} CBM / ${fmt(o.weightKg / 1000, 1)} 吨`).join('；')}<br>
      单独发要 ${s.aloneContainers} 柜，拼完 ${s.mergedContainers} 柜 → <b>省 ${s.savedContainers} 个柜 ≈ ¥${fmt(s.savedMoney)}</b><br>
      柜内占用：容积 ${(s.volumeFillPct * 100).toFixed(0)}% · 承重 ${(s.weightFillPct * 100).toFixed(0)}%
      ${s.costSplit.length ? `<br>费用分摊（${s.mergedContainers} 柜 × ¥${fmt(s.containerCost)}）：`
        + s.costSplit.map(c => `${esc(c.code)} ¥${fmt(c.amount)}（${c.basis === 'volume' ? '按体积' : '按重量'} ${(c.share * 100).toFixed(0)}%）`).join(' / ') : ''}
      ${s.notes.map(n => `<div style="margin-top:4px;color:${n.level === 'warn' ? '#7a4708' : '#0b5c2f'}">${esc(n.msg)}</div>`).join('')}
      <div style="margin-top:8px"><button class="btn primary sm" data-consol-apply="${s.orderIds.join(',')}">按此拼单去测算 →</button></div>
    </div>`).join('')}
    ${g.solo.map(s => `<div class="issue info"><b>${esc(s.profile.order.code)}</b> 单独 ${s.containers} 柜 · ${esc(s.hint)}</div>`).join('')}
  `).join('');
};

/** 拼单建议一键落地：只勾这几个订单，跳到「算」直接跑真实排布 */
$('consolOut').addEventListener('click', e => {
  const b = e.target.closest('[data-consol-apply]');
  if (!b) return;
  const ids = b.dataset.consolApply.split(',').filter(Boolean);
  state.picked.orders = new Set(ids);
  state.picked.skus.clear();
  state.lines = [];
  renderPicks();
  go('calc');
  doCalc();
});

/* ── 设置 ── */
$('btnShop').onclick = () => {
  go('data');
  document.querySelector('#dataTabs button[data-tab="setting"]').click();
};

$('btnSaveSet').onclick = () => {
  store.setSettings({
    volumeDivisor: +$('setDivisor').value || 6000,
    visionApiUrl: $('setVisionApi').value.trim(),
    costs: {
      oversizeFeePerBox: +$('setOversize').value || 500,
      monitorFee: +$('setMonitor').value || 0,
    },
  });
  toast('已保存');
};
$('btnExportAll').onclick = () => download(store.exportJSON(), '装箱工具备份.json');
$('btnImportAll').onclick = () => pickFile(text => {
  try {
    const r = store.importJSON(text);
    renderData();
    toast(`导入完成：${r.skus} 个 SKU / ${r.orders} 单 / ${r.plans} 份方案`, 3000);
  } catch (e) {
    toast('导入失败：' + e.message, 3600);
  }
});
$('btnSeed').onclick = () => { seedDemo(); renderData(); renderPicks(); toast('示例数据已载入'); };

/** 示例数据：第一次打开时让人 30 秒看到全流程，而不是面对空表单 */
function seedDemo() {
  const demo = [
    { code: 'BX-1001', nameCn: '陶瓷马克杯', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12, packQty: 6, unitValue: 180, supplier: '华东一号仓' },
    { code: 'BX-1002', nameCn: '竹制餐垫', dimsCm: { l: 45, w: 35, h: 12 }, weightKg: 3.5, packQty: 20, unitValue: 45 },
    { code: 'BX-1003', nameCn: '毛绒玩具', dimsCm: { l: 50, w: 40, h: 35 }, weightKg: 6, packQty: 8 },
    // 易碎+气味可与其他货同柜；示例刻意避开「液体」属性——液体策略会触发分柜，
    // 两单永远拼不进一柜，演示不了拼单建议（第一次试验就栽在这）
    { code: 'BX-1004', nameCn: '玻璃香水瓶', dimsCm: { l: 30, w: 25, h: 28 }, weightKg: 15, packQty: 4, attrs: { fragile: true, odor: true }, unitValue: 620 },
    { code: 'BX-2001', nameCn: '瓷砖 600×600', dimsCm: { l: 62, w: 62, h: 12 }, weightKg: 28, packQty: 2, unitValue: 260 },
  ];
  for (const d of demo) store.upsertSku(d);
  const ids = store.listSkus();
  const byCode = c => ids.find(s => s.code === c);
  store.upsertOrder({
    code: 'PO-A-1024', customer: 'Al Noor Trading', port: 'Jebel Ali', vessel: 'MAERSK V.2418',
    cutOff: '2026-11-05T08:00:00Z', dueDate: '2026-10-20',
    lines: [{ skuId: byCode('BX-1001').id, boxes: 260 }, { skuId: byCode('BX-1002').id, boxes: 180 }, { skuId: byCode('BX-1003').id, boxes: 120 }],
  });
  store.upsertOrder({
    code: 'PO-A-1031', customer: 'Gulf Housewares', port: 'Jebel Ali', vessel: 'MAERSK V.2418',
    cutOff: '2026-11-05T08:00:00Z', dueDate: '2026-10-22',
    lines: [{ skuId: byCode('BX-2001').id, boxes: 150 }, { skuId: byCode('BX-1004').id, boxes: 90 }],
  });
  store.upsertOrder({
    code: 'PO-H-2088', customer: 'Hamburg Import GmbH', port: 'Hamburg', vessel: 'MSC V.33',
    cutOff: '2026-11-20T08:00:00Z', dueDate: '2026-11-01',
    lines: [{ skuId: byCode('BX-1001').id, boxes: 200 }],
  });
}

/* ═══════════════════════════════════════════════════════════════════
   启动
   ═══════════════════════════════════════════════════════════════════ */

function paintNet() {
  const el = $('netState');
  const on = store.isOnline();
  el.textContent = on ? '在线' : '离线可用';
  el.classList.toggle('off', !on);
}

function boot() {
  initCanvasDrag();
  renderPicks();
  paintNet();
  store.on('change', paintNet);

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { store.setOnline(true); toast('已联网，本地数据已同步'); });
    window.addEventListener('offline', () => { store.setOnline(false); toast('已断网，采集与测算照常可用', 3000); });
  }

  // URL hash 预填（DSH 端 / 上游系统跳转用），见 dsh.js
  const preset = applyHash(store);
  if (preset && preset.items && preset.items.length) {
    state.lines = preset.items.map(i => ({ skuId: i.skuId, code: i.code, boxes: i.boxes }));
    toast('已按链接参数带入待装清单', 2600);
  }
  renderSkuPick();

  installDshApi({ store, state, go, toast, modal, closeModal, getPlan: () => state.plan, solve: () => collectItems() });

  if (!store.listSkus().length) {
    modal('第一次用？', `<p>这是<b>物流箱体测算工具</b>：<b>算</b>要几个柜多少钱 → <b>单</b>一键发货代 → <b>数</b>管主数据与拼单。</p>
      <p style="margin-top:10px">「测」是摄像头自动量尺寸重量的实验功能，最后一个键，不影响主流程。现在还没有任何数据，要不要先载入一份示例订单？</p>`,
      '<button class="btn ghost" id="sdNo">我自己建</button><button class="btn primary" id="sdYes">载入示例</button>');
    $('sdYes').onclick = () => { closeModal(); seedDemo(); renderData(); renderPicks(); go('calc'); toast('示例已载入，点「开始测算」跑一次'); };
    $('sdNo').onclick = () => { closeModal(); go('data'); };
  }
}

boot();
