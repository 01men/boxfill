/**
 * 云端视觉解析：PNG 字节 → 尺寸与重量。
 *
 * ── 定位 ────────────────────────────────────────────────────────────
 * 这是**附赠能力**，不是产品主体：它替用户省下"敲 200 个 SKU 建档"的工时，
 * 但省不了运费——真正值钱的是 engine / consolidate / docs。
 * 所以接口设计刻意不追求全自动：**解析结果一律可改，且默认就带着"仅供参考"的标注**。
 * 尺寸错一点点，后面一整柜全错；这里宁可让用户多看一眼，也不给"自信的错答案"。
 *
 * ── 与端侧的关键差异：目标区域要显式指定 ───────────────────────────
 * 端侧取景时，用户把参照物取走、对准取景框，画面里就一个矩形，按面积取最大准没错。
 * 但一张上传的照片里往往同时有：纸箱、A4 参照物、垫板边、甚至别的箱子——
 * 白纸比牛皮纸箱更亮也更大，"取最大块"会选中参照物，量出一张纸的尺寸。
 * 所以云端强制要求调用方说明"箱体在哪"（roi），算法只在这一块里找。
 *
 * ── 复用而非重写 ────────────────────────────────────────────────────
 * 解码之后的每一步都直接调 h5/js/vision/ 里的现有函数，端侧与云端因此
 * 对同一张照片给出同一个答案；算法改进只需改一处。
 */

import { decodePng, looksLikePng, PngError } from './png.js';
import { detectBoxes, quadToDims, checkQuality, finalizeDims, readScaleRegion, ScaleReader } from '../h5/js/vision/camera.js';

/** 单次上传大小上限：一张手机照 ~2MB，留足余量又不至于被人当图床 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 解析结果固定带这句提示。放在服务端是刻意的：
 * 只要结果是服务端算出来的，就一定是机器估的，客户端即使忘了展示也有这一层兜底。
 */
export const DISCLAIMER = '解析结果由图像自动估算，仅供参考，不作为结算或出货依据；请核对后再入库。';

export class VisionError extends Error {
  constructor(msg, hint) {
    super(msg);
    this.name = 'VisionError';
    this.hint = hint || null;
  }
}

/**
 * 主入口。
 *
 * @param {Buffer} imagePng  PNG 字节（客户端须先经 canvas 重编码）
 * @param {object} opts
 *   - roi: {x,y,w,h} 0~1 相对坐标，箱体所在区域；不给则用整幅图并接受"可能选错块"
 *   - refRealCm: 参照物在画面里的真实长度（cm）；给了才可能量出厘米
 *   - refPx:   参照物在画面里的像素长度（与 refRealCm 配对）
 *   - refInRoi: 参照物是否也在 roi 内（同框标定用；分开标定时给 false）
 *   - scaleRegion: {x,y,w,h} 电子秤显示屏在画面中的位置（0~1 相对）
 *   - scaleUnit: 'kg' | 'lb' | 'g'
 *   - tareKg: 皮重
 * @returns {{ok, ...}} 见文件末尾的返回结构
 */
export function analyzeImage(imagePng, opts = {}) {
  if (!imagePng || !imagePng.length) {
    throw new VisionError('没有收到图片', '请以二进制 body 或 base64 传入 PNG');
  }
  // 体积检查必须在格式检查之前：8MB 的垃圾请求先要被"太大"挡住，
  // 而不是先花时间验格式再拒——顺序反了既慢又让报错指向错误的原因
  if (imagePng.length > MAX_IMAGE_BYTES) {
    throw new VisionError(
      `图片 ${(imagePng.length / 1024 / 1024).toFixed(1)}MB 超过 8MB 上限`,
      '上传前等比缩到 1600px 以内即可，识别精度不受影响',
    );
  }
  if (!looksLikePng(imagePng)) {
    throw new VisionError(
      '只接受 PNG 图片',
      '浏览器端请用 canvas.toBlob(blob, "image/png") 重新编码后再上传',
    );
  }

  let image;
  try {
    image = decodePng(imagePng);
  } catch (err) {
    if (err instanceof PngError) throw new VisionError(err.message, err.hint);
    throw new VisionError(`图片解码失败：${err.message}`);
  }

  const det = detectBoxes(image);
  const warnings = [];
  if (!det.quads.length) {
    warnings.push({
      code: 'NO_BOX',
      msg: '画面里没找到箱体。请把纸箱放平、拍正，避免反光与黑色覆膜；必要时补拍一张。',
    });
  }

  // ── 选目标四边形：优先取 roi 内最大的那个，而不是全图最大的 ──────────
  const roi = opts.roi && opts.roi.w > 0 && opts.roi.h > 0
    ? toPixelRoi(opts.roi, image)
    : { x: 0, y: 0, w: image.width, h: image.height, used: false };
  const inRoi = det.quads.filter(q => overlaps(q.bounds, roi));
  const candidates = inRoi.length ? inRoi : det.quads;
  if (!roi.used && det.quads.length > 1) {
    warnings.push({
      code: 'MULTI_CANDIDATE',
      msg: `画面里有 ${det.quads.length} 个矩形且未指定箱体区域，可能量到了别的物件。请传入 roi 明确箱体位置。`,
    });
  }
  const q = candidates[0] || null;

  // ── 质量校验：不合格就如实报出来，不给"自信的错答案" ──────────────
  const quality = checkQuality({
    quads: inRoi.length || det.quads.length,
    confidence: q ? q.confidence : 0,
    contrast: det.contrast,
    specular: det.specular,
    edges: q ? q.edges : [],
    displacementCm: 0,   // 单张照片不存在跨帧位移
  });

  const result = {
    ok: false,
    disclaimer: DISCLAIMER,
    editable: true,      // 客户端必须能改：字段就是建议值，不是最终值
    image: { width: image.width, height: image.height },
    roiUsed: roi.used,
    detection: {
      found: !!q,
      candidateCount: det.quads.length,
      candidateInRoiCount: inRoi.length,
      cornersPx: q ? q.corners.map(p => ({ x: p.x, y: p.y })) : null,
      boundsPx: q ? q.bounds : null,
      confidence: q ? q.confidence : 0,
    },
    quality: { ok: quality.ok, issues: quality.issues, action: quality.action },
    dimsCm: null,
    errorCm: null,
    weightKg: null,
    scaleRead: null,
    warnings,
  };

  if (!q || !quality.ok) return result;

  // ── 尺寸：没有参照物就量不出厘米，如实返回 null ────────────────────
  const cal = buildCalibration(opts);
  if (!cal) {
    warnings.push({
      code: 'NEED_CALIBRATION',
      msg: '缺少比例参照，无法换算出厘米尺寸。请在同一张照片里放入 A4 纸或标定板，并传 refRealCm / refPx。',
    });
    result.detection.cornersPx = q.corners.map(p => ({ x: p.x, y: p.y }));
    return result;
  }

  const dims = quadToDims(q.corners, cal);
  if (!dims.ok) {
    warnings.push({ code: 'BAD_QUAD', msg: `量不出尺寸：${dims.reason}` });
    return result;
  }
  if (dims.perspectiveWarning) {
    warnings.push({
      code: 'SKEW',
      msg: `拍摄角度偏斜（对边不等长 ${(dims.skew * 100).toFixed(0)}%），结果不可信。请垂直向下重拍。`,
    });
    return result;
  }

  result.dimsCm = { l: dims.length, w: dims.width, h: null };  // 高度：单张俯视图拍不出
  result.errorCm = cal.pxPerCm > 0 ? +(2 / cal.pxPerCm).toFixed(1) : null;
  warnings.push({
    code: 'NEED_HEIGHT',
    msg: '单张俯视图在几何上测不出高度（照平了就没有纵深信息）。请补一个高度值，或侧拍一张。',
  });

  // ── 重量：读秤屏。读不稳就返回 null，不猜 ──────────────────────────
  if (opts.scaleRegion) {
    const region = toPixelRoi(opts.scaleRegion, image);
    const read = readScaleRegion(image, region, {
      unit: opts.scaleUnit || 'kg',
      tare: Number(opts.tareKg) || 0,
    });
    result.scaleRead = {
      ok: !!read.ok,
      text: read.text || null,
      valueKg: read.ok ? +Number(read.value).toFixed(2) : null,
      confidence: read.ok ? read.confidence : 0,
      reason: read.ok ? null : (read.reason || '秤屏没读出来'),
    };
    if (read.ok) {
      result.weightKg = result.scaleRead.valueKg;
    } else {
      warnings.push({ code: 'SCALE_FAIL', msg: `秤屏没读出来：${read.reason || '未知原因'}。请手工填写重量。` });
    }
  }

  result.ok = true;
  return result;
}

/** 相对坐标 → 像素坐标，并夹紧到画面内 */
function toPixelRoi(r, image) {
  const x = Math.max(0, Math.round((Number(r.x) || 0) * image.width));
  const y = Math.max(0, Math.round((Number(r.y) || 0) * image.height));
  const w = Math.max(1, Math.min(image.width - x, Math.round((Number(r.w) || 0) * image.width)));
  const h = Math.max(1, Math.min(image.height - y, Math.round((Number(r.h) || 0) * image.height)));
  return { x, y, w, h, used: true };
}

/**
 * 由 refRealCm / refPx 组装标定。
 *
 * 两种传法：
 *   ① 参照物就在同一张照片里 → 直接给 refPx（它的像素长度）
 *   ② 参照物在另一张图里标定 → 给 refPx 与 refRealCm，同时告诉调用方
 *      "这个 refPx 来自另一张图"——此时两个图的拍摄距离必须一致，
 *      所以接口保留 refInRoi 标记，让上层能决定要不要提示用户
 */
function buildCalibration(opts) {
  const real = Number(opts.refRealCm);
  const px = Number(opts.refPx);
  if (!(real > 0) || !(px > 1)) return null;
  return { ok: true, pxPerCm: px / real, refPx: px, realCm: real };
}

/** 两个矩形是否相交（交集面积 > 0） */
function overlaps(bounds, roi) {
  if (!bounds) return false;
  const x1 = Math.max(bounds.x, roi.x);
  const y1 = Math.max(bounds.y, roi.y);
  const x2 = Math.min(bounds.x + bounds.w, roi.x + roi.w);
  const y2 = Math.min(bounds.y + bounds.h, roi.y + roi.h);
  return x2 > x1 && y2 > y1;
}