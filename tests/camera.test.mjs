/**
 * 采集管线的纯几何测试。
 *
 * 这里守的是 PRD 第 4 章的底线：**测不准可以，测错了绝对不行**。
 * 所以断言重心放在"该拒绝的时候有没有拒绝"上——
 * 低置信度、软塌、多箱同框、镜头位移，都要拦住并转人工补录。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calibrate, pxToCm, quadToDims, heightFromSideView,
  straightness, checkQuality, finalizeDims, detectBoxes, ScaleReader, liveVerdict,
} from '../h5/js/vision/camera.js'

/** 标定：画面里 1000px = 真实 100cm，即 10 px/cm */
const CAL = calibrate({ x: 0, y: 0 }, { x: 1000, y: 0 }, 100)
/** 同样的参照物只占 200px：2 px/cm，1px 就是 0.5cm */
const CAL_FAR = calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 100)   // 1 px/cm

describe('采集 · 标定与量距', () => {
  it('标定由参照物像素长度与真实长度得出比例', () => {
    assert.equal(CAL.ok, true)
    assert.ok(Math.abs(CAL.pxPerCm - 10) < 1e-9)
    assert.equal(+pxToCm(300, CAL).toFixed(2), 30)
    assert.equal(+pxToCm(300, CAL_FAR).toFixed(2), 300)   // 同一段像素，标定不同结果差 10 倍
  })

  it('标定点无效时明确报错，不返回 Infinity', () => {
    assert.equal(calibrate({ x: 5, y: 5 }, { x: 5, y: 5 }, 10).ok, false)
    assert.equal(calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 0).ok, false)
    assert.equal(pxToCm(100, { ok: false }), null)
  })

  it('四边形量出的长宽正确，并按长≥宽归一', () => {
    // 600×400mm 的箱顶，按 10px/cm → 600px × 400px
    const quad = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]
    const d = quadToDims(quad, CAL)
    assert.equal(d.ok, true)
    assert.equal(d.length, 60)
    assert.equal(d.width, 40)
  })

  it('透视导致对边不等长时给出警告（PRD：斜拍不可信）', () => {
    const skewed = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 700, y: 400 }, { x: 0, y: 400 }]
    const d = quadToDims(skewed, CAL)
    assert.equal(d.perspectiveWarning, true)
    assert.ok(d.skew > 0.12)
  })

  it('角点不足时明确失败', () => {
    assert.equal(quadToDims([{ x: 0, y: 0 }, { x: 10, y: 10 }], CAL).ok, false)
  })
})

describe('采集 · 双视角求高度', () => {
  it('俯视 600×400、侧视 600×500 时高度为 50cm', () => {
    const top = { length: 60, width: 40 }
    const side = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 0, y: 500 }]
    const h = heightFromSideView(side, CAL, top)
    assert.equal(h.ok, true)
    assert.equal(h.height, 50)
  })

  it('侧视里水平边对应箱宽时也能正确识别（不假设用户从哪一面拍）', () => {
    const top = { length: 60, width: 40 }
    const side = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 500 }, { x: 0, y: 500 }]
    const h = heightFromSideView(side, CAL, top)
    assert.equal(h.height, 50, '水平边 40cm 匹配箱宽，竖直边 50cm 才是高度')
  })
})

describe('采集 · 三边收敛（PRD 4.2.1 的诚实边界）', () => {
  it('只量到两维时明确要求补高度，不猜（PRD：绝不静默存错）', () => {
    const r = finalizeDims(60, 40, null, CAL)
    assert.equal(r.ok, false)
    assert.equal(r.measured, 2)
    assert.ok(r.reason.includes('高度'))
    assert.equal(r.dimsCm, null)
  })

  it('三边齐全时归一并给出误差估计', () => {
    const r = finalizeDims(60, 40, 35, CAL)
    assert.equal(r.ok, true)
    assert.deepEqual(r.dimsCm, { l: 60, w: 40, h: 35 })
    assert.ok(r.errorCm <= 1, '10px/cm 时误差应在 ±1cm 内')
    assert.equal(r.reliable, true)
  })

  it('参照物在画面里太小时，报出的误差要如实变差', () => {
    const r = finalizeDims(60, 40, 35, CAL_FAR)
    assert.equal(r.reliable, false, '像素密度不足时不该自称可靠')
    assert.ok(r.errorCm > 1)
  })
})

describe('采集 · 质量拦截（PRD 4.3 / 验收 V-02、V-06）', () => {
  it('全部合格时通过', () => {
    const q = checkQuality({
      edges: [{ points: [{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 0 }] }],
      quads: 1, confidence: 0.9, contrast: 0.4, displacementCm: 0.5,
    })
    assert.equal(q.ok, true)
    assert.equal(q.action, null)
  })

  it('软塌/变形箱体被拦下', () => {
    const soft = [{ x: 0, y: 0 }, { x: 30, y: 25 }, { x: 60, y: 5 }, { x: 100, y: 0 }]
    const q = checkQuality({ edges: [{ points: soft }], quads: 1, confidence: 0.9, contrast: 0.4 })
    assert.equal(q.ok, false)
    assert.ok(q.issues.some(i => i.code === 'Q-SOFT'))
    assert.ok(q.action.includes('放平'))
  })

  it('黑色覆膜/镜面盒（置信度低）被拦下并提示翻面', () => {
    const q = checkQuality({ quads: 1, confidence: 0.2, contrast: 0.4 })
    assert.equal(q.ok, false)
    const issue = q.issues.find(i => i.code === 'Q-LOWCONF')
    assert.ok(issue && issue.msg.includes('翻'))
  })

  it('多箱同框被拦下', () => {
    const q = checkQuality({ quads: 3, confidence: 0.9, contrast: 0.4 })
    assert.ok(q.issues.some(i => i.code === 'Q-MULTI'))
    assert.ok(q.issues[0].msg.includes('一次只放一个'))
  })

  it('镜头位移超过 2cm 被拦下（PRD 4.3 / V-06）', () => {
    assert.equal(checkQuality({ quads: 1, confidence: 0.9, contrast: 0.4, displacementCm: 1.9 }).ok, true)
    const q = checkQuality({ quads: 1, confidence: 0.9, contrast: 0.4, displacementCm: 2.4 })
    assert.equal(q.ok, false)
    assert.ok(q.issues.some(i => i.code === 'Q-SHIFT'))
  })

  it('反光严重（高光占比高）被拦下并提示关闪光灯', () => {
    const q = checkQuality({ quads: 1, confidence: 0.9, contrast: 0.4, specular: 0.4 })
    assert.ok(q.issues.some(i => i.code === 'Q-GLARE'))
    assert.ok(q.issues[0].msg.includes('闪光灯'))
  })

  it('对比度过低（黑箱 + 深色背景）被拦下', () => {
    const q = checkQuality({ quads: 1, confidence: 0.9, contrast: 0.08 })
    assert.ok(q.issues.some(i => i.code === 'Q-CONTRAST'))
  })

  it('多项不合格时一次说清，不用让用户反复试', () => {
    const q = checkQuality({ quads: 2, confidence: 0.2, contrast: 0.05, displacementCm: 3 })
    assert.ok(q.issues.length >= 3)
    assert.ok(q.action.includes('另有'))
  })
})

describe('采集 · 箱体自动检测', () => {
  /** 造一张图：深色背景 + 中间一个亮色矩形（模拟牛皮纸箱放在深蓝垫板上） */
  function synthImage(W = 200, H = 200, box = { x: 40, y: 50, w: 120, h: 80 }, boxVal = 200, bgVal = 40) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        const v = inside ? boxVal : bgVal;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    return { data, width: W, height: H };
  }

  it('能找出画面里的箱体并给出四角', () => {
    const r = detectBoxes(synthImage());
    assert.equal(r.quads.length, 1, '应只找到一个箱体')
    const q = r.quads[0]
    assert.ok(q.area > 0)
    assert.equal(q.corners.length, 4)
    // 四角应大致落在矩形边界上
    const xs = q.corners.map(c => c.x), ys = q.corners.map(c => c.y)
    const box = { x: 40, y: 50, w: 120, h: 80 }
    assert.ok(Math.min(...xs) >= box.x - 2 && Math.min(...xs) <= box.x + 2, `左边界应贴近 ${box.x}，实际 ${Math.min(...xs)}`)
    assert.ok(Math.max(...xs) >= box.x + box.w - 2 && Math.max(...xs) <= box.x + box.w, `右边界应贴近 ${box.x + box.w}，实际 ${Math.max(...xs)}`)
    assert.ok(Math.min(...ys) >= box.y - 2 && Math.max(...ys) <= box.y + box.h, `上下边界应贴近 ${box.y}–${box.y + box.h}`)
    // 四角必须构成不自交的顺时针四边形：横平竖直，各边长度对应箱体实际边长
    assert.deepEqual(q.corners.map(c => [c.x, c.y]),
      [[box.x, box.y], [box.x + box.w - 1, box.y], [box.x + box.w - 1, box.y + box.h - 1], [box.x, box.y + box.h - 1]])
  })

  it('两个箱子同框时都被检出（交给上层判定 Q-MULTI）', () => {
    const W = 300, H = 200;
    const data = new Uint8ClampedArray(W * H * 4);
    const rects = [{ x: 20, y: 30, w: 90, h: 80 }, { x: 170, y: 30, w: 90, h: 80 }];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      const v = inside ? 210 : 40;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    const r = detectBoxes({ data, width: W, height: H });
    assert.equal(r.quads.length, 2)
    assert.equal(checkQuality({ quads: r.quads.length, confidence: 0.9, contrast: 0.4 }).ok, false)
  })

  it('纯色空画面不产生误检', () => {
    const W = 120, H = 120;
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const r = detectBoxes({ data, width: W, height: H });
    assert.equal(r.quads.length, 0, '空画面不该凭空认出箱子')
  })

  it('检出结果可直接量出尺寸（端到端：图 → cm）', () => {
    const W = 200, H = 200;
    // 箱顶 120px × 80px，配 10px/cm 的标定 → 12cm × 8cm
    const img = synthImage(W, H, { x: 40, y: 50, w: 120, h: 80 });
    const r = detectBoxes(img);
    const d = quadToDims(r.quads[0].corners, CAL)
    assert.ok(Math.abs(d.length - 12) < 0.6, `量得 ${d.length}cm，应约 12cm`)
    assert.ok(Math.abs(d.width - 8) < 0.6, `量得 ${d.width}cm，应约 8cm`)
  })
})

describe('采集 · 确认制连续检测判定（liveVerdict）', () => {
  /** 造一个 det 结构：一个干净的 60×40cm 箱顶（10px/cm 标定下） */
  const det1 = (over = {}) => ({
    quads: [{
      corners: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }],
      confidence: 0.9, edges: [], area: 240000,
      bounds: { x: 0, y: 0, w: 600, h: 400 },
    }],
    contrast: 0.5, specular: 0, ...over,
  })

  it('画面干净 + 已标定 → READY，dims 带出长×宽', () => {
    const v = liveVerdict(det1(), CAL)
    assert.equal(v.code, 'READY')
    assert.equal(v.canMeasure, true)
    assert.equal(v.dims.length, 60)
    assert.equal(v.dims.width, 40)
  })

  it('画面里没箱子 → NO_BOX，不给测', () => {
    const v = liveVerdict({ quads: [], contrast: 0.5, specular: 0 }, CAL)
    assert.equal(v.code, 'NO_BOX')
    assert.equal(v.canMeasure, false)
  })

  it('箱体已锁定但没标定 → NEED_CAL：先标定才能量出厘米', () => {
    const v = liveVerdict(det1(), null)
    assert.equal(v.code, 'NEED_CAL')
    assert.equal(v.canMeasure, false)
    assert.ok(v.box, '箱体框还是要给出来，供画面上画边缘')
    assert.ok(v.msg.includes('标定'))
  })

  it('多箱同框 → QUALITY 拦截，且优先级高于缺标定', () => {
    const two = det1({ quads: [det1().quads[0], { ...det1().quads[0], confidence: 0.8 }] })
    assert.equal(liveVerdict(two, null).code, 'QUALITY', '质量不过关时先说质量问题')
    const v = liveVerdict(two, CAL)
    assert.equal(v.code, 'QUALITY')
    assert.ok(v.msg.includes('2 个箱体'))
  })

  it('置信度过低（反光/覆膜）→ QUALITY 拦下', () => {
    const v = liveVerdict(det1({ quads: [{ ...det1().quads[0], confidence: 0.2 }] }), CAL)
    assert.equal(v.code, 'QUALITY')
    assert.ok(v.msg.includes('翻个面') || v.msg.includes('置信度'))
  })

  it('透视太斜 → SKEW，量出来的数不可信就不给测', () => {
    const skew = {
      quads: [{
        corners: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 700, y: 400 }, { x: 0, y: 400 }],
        confidence: 0.9, edges: [], area: 1, bounds: { x: 0, y: 0, w: 700, h: 400 },
      }],
      contrast: 0.5, specular: 0,
    }
    const v = liveVerdict(skew, CAL)
    assert.equal(v.code, 'SKEW')
    assert.equal(v.canMeasure, false)
  })

  it('det 为 null/空对象也不崩（摄像头刚打开的极端帧）', () => {
    assert.equal(liveVerdict(null, CAL).code, 'NO_BOX')
    assert.equal(liveVerdict({}, CAL).code, 'NO_BOX')
  })
})

describe('采集 · 秤屏稳定取数（PRD V-04）', () => {
  it('连续三帧一致才给值', () => {
    const r = new ScaleReader({ minFrames: 3, jitter: 0.05 })
    assert.equal(r.push({ ok: true, valueKg: 12.0 }), null, '不足 3 帧不返回')
    assert.equal(r.push({ ok: true, valueKg: 12.0 }), null)
    const out = r.push({ ok: true, valueKg: 12.0 })
    assert.ok(out && out.stable === true)
    assert.ok(Math.abs(out.value - 12) < 1e-6)
  })

  it('数值跳动超阈值时判为未稳定（提示"等秤稳"）', () => {
    const r = new ScaleReader({ minFrames: 3, jitter: 0.05 })
    r.push({ ok: true, valueKg: 12.0 })
    r.push({ ok: true, valueKg: 12.9 })
    const out = r.push({ ok: true, valueKg: 12.1 })
    assert.ok(out, '帧数够了要返回结果')
    assert.equal(out.stable, false)
    assert.ok(out.spread > 0.05)
  })

  it('识别失败的帧也计入窗口（读不出就是读不出）', () => {
    const r = new ScaleReader({ minFrames: 3 })
    r.push({ ok: true, valueKg: 12 })
    r.push({ ok: false })
    const out = r.push({ ok: false })
    assert.ok(out)
    assert.equal(out.stable, false)
  })

  it('皮重被扣除，且改动皮重会清空历史窗口', () => {
    const r = new ScaleReader({ minFrames: 3, tare: 2 })
    r.push({ ok: true, valueKg: 14 }); r.push({ ok: true, valueKg: 14 })
    const out = r.push({ ok: true, valueKg: 14 })
    assert.ok(Math.abs(out.value - 12) < 1e-6, '总重 14 − 皮重 2 = 净重 12')
    r.setTare(0)
    assert.equal(r.readings.length, 0, '改皮重后必须重新读数，不能拿旧窗口的数当净重')
  })
})
