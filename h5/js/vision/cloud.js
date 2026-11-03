/**
 * 云端视觉解析的浏览器端（H5 → 服务端）。
 *
 * 流程对应一次"拍照 → 上传 → 标定 → 再解析"的闭环：
 *   ① 拍照/选图 → encodeToPng：等比缩到 1600px 内并强制编码成 PNG
 *      （服务端解码器只吃 PNG，换取服务端零依赖，见 server/png.js）
 *   ② analyze 无标定参数上传 → 服务端返回箱体候选框 + NEED_CALIBRATION
 *   ③ 用户在照片上点参照物两端 → 前端算出 refPx → 带参再解析
 *   ④ 服务端返回 dimsCm（weightKg 若给了 scaleRegion）→ 客户端展示、**可改**、确认入库
 *
 * 服务端返回的结果固定带 disclaimer（免责声明）与 editable（可修改）标记，
 * 这里的职责是把它们如实透传给 UI——不允许悄悄抹掉。
 */

/** 把 File/Blob 压进 1600px 内并编码为 PNG */
export function encodeToPng(fileOrBlob, maxPx = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('图片编码失败，请重试'));
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不出来，换一张试试')); };
    img.src = url;
  });
}

/**
 * 调服务端解析。
 * @param {string} apiBase 如 http://localhost:8787（不带尾斜杠）
 * @param {Blob} pngBlob PNG 图片
 * @param {object} params {roi, refRealCm, refPx, scaleRegion, scaleUnit, tareKg}
 * @returns {Promise<object>} 服务端的 JSON（含 disclaimer / editable / warnings）
 */
export async function analyzeRemote(apiBase, pngBlob, params = {}) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('还没有配置云端识别服务地址（设置 → 云端识别 API）');
  const q = new URLSearchParams();
  if (params.roi) q.set('roi', [params.roi.x, params.roi.y, params.roi.w, params.roi.h].join(','));
  if (params.scaleRegion) q.set('scaleRegion', [params.scaleRegion.x, params.scaleRegion.y, params.scaleRegion.w, params.scaleRegion.h].join(','));
  if (params.refRealCm > 0) q.set('refRealCm', params.refRealCm);
  if (params.refPx > 0) q.set('refPx', params.refPx);
  if (params.scaleUnit) q.set('scaleUnit', params.scaleUnit);
  if (params.tareKg > 0) q.set('tareKg', params.tareKg);

  let res;
  try {
    res = await fetch(`${base}/api/vision/analyze${q.toString() ? '?' + q : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: pngBlob,
    });
  } catch {
    // fetch 只在网络层失败时抛：DNS/端口/断网。业务失败走的是 200/4xx + JSON
    throw new Error('连不上云端识别服务，请检查「设置 → 云端识别 API」，或改用手工补录');
  }
  let body;
  try { body = await res.json(); }
  catch { throw new Error(`服务返回异常（HTTP ${res.status}），请稍后再试`); }
  if (!res.ok) {
    const msg = body && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(body && body.hint ? `${msg}（${body.hint}）` : msg);
  }
  return body;
}
