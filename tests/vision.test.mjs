/**
 * 云端视觉解析的测试（PNG 解码 + 现有算法）。
 *
 * 守的底线：**服务器算出来的数只是建议，绝不能是"自信的错答案"**。
 * 所以断言重心在"该拒绝的时候有没有拒绝"——
 * 没参照物就返回 null（不猜厘米）、角度斜就报 SKEW（不给尺寸）、
 * 多候选就告警（不默认第一个就是箱体）、非 PNG 直接拒。
 *
 * 所有测试图都是程序合成的（纯色矩形），不依赖任何真实照片。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePng, looksLikePng, PngError } from '../server/png.js'
import { analyzeImage, DISCLAIMER, MAX_IMAGE_BYTES } from '../server/vision.js'
import { detectBoxes } from '../h5/js/vision/camera.js'

/* ── 合成 PNG 的工具（与服务端解码器独立，避免"用被测代码造被测数据"） ── */

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const i of buf) c = CRC[(c ^ i) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, cr])
}
/** 按像素函数造一张 RGB8 PNG */
function makeRgbPng(W, H, fn) {
  const raw = Buffer.alloc((W * 3 + 1) * H)
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0                                  // filter = None
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y)
      raw[o++] = r; raw[o++] = g; raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2                        // bitDepth=8, colorType=RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 深色垫板 + 一个亮色矩形（模拟纸箱俯拍） */
function boxPhoto({ W = 1000, H = 800, box = { x: 200, y: 100, w: 600, h: 400 }, boxVal = 180, bgVal = 25 } = {}) {
  return makeRgbPng(W, H, (x, y) => {
    const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
    const v = inBox ? boxVal : bgVal
    return [v, v - 3, v - 8]
  })
}

describe('PNG 解码 · 纯 Node 零依赖', () => {
  it('解出正确的像素长度（RGB8）', () => {
    const img = decodePng(boxPhoto({ W: 40, H: 30 }))
    assert.equal(img.width, 40)
    assert.equal(img.height, 30)
    assert.equal(img.data.length, 40 * 30 * 4, '必须补齐成 RGBA 四通道')
  })

  it('输出能直接喂给 detectBoxes（下游零改造）', () => {
    const det = detectBoxes(decodePng(boxPhoto()))
    assert.equal(det.quads.length, 1, '箱体应被检出')
    assert.equal(det.quads[0].bounds.w, 600)
  })

  it('灰度 PNG 也能解（相机可能输出灰度）', () => {
    const W = 20, H = 20
    const raw = Buffer.alloc((W + 1) * H); let o = 0
    for (let y = 0; y < H; y++) { raw[o++] = 0; for (let x = 0; x < W; x++) raw[o++] = 150 }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
    const img = decodePng(png)
    assert.equal(img.data.length, W * H * 4)
    assert.equal(img.data[0], 150, '灰度值应被复制到 RGB 三通道')
    assert.equal(img.data[3], 255, '无 alpha 通道时补不透明')
  })

  it('非 PNG 输入被明确拒绝，而不是解出一堆垃圾', () => {
    assert.throws(() => decodePng(Buffer.from('this is not a png')), (e) => e instanceof PngError)
    assert.equal(looksLikePng(Buffer.from('nope')), false)
    assert.equal(looksLikePng(boxPhoto()), true)
  })

  it('图片被截断时报错，不返回半张图', () => {
    const png = boxPhoto({ W: 100, H: 100 })
    assert.throws(() => decodePng(png.subarray(0, png.length - 40)), (e) => e instanceof PngError)
  })
})

describe('云端视觉解析 · 尺寸换算', () => {
  it('有参照物时量出的尺寸与真值一致（±1cm 内）', () => {
    // 箱体 600×400px，标定 12px/cm → 真值 50×33.3cm
    const r = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 600 })
    assert.equal(r.ok, true)
    assert.ok(Math.abs(r.dimsCm.l - 50) < 1, `长 ${r.dimsCm.l} 应接近 50`)
    assert.ok(Math.abs(r.dimsCm.w - 33.3) < 1, `宽 ${r.dimsCm.w} 应接近 33.3`)
  })

  it('没有参照物 → 明确返回 null 并要求标定，绝不瞎猜厘米', () => {
    const r = analyzeImage(boxPhoto())
    assert.equal(r.ok, false)
    assert.equal(r.dimsCm, null, '没有比例尺时不能给出厘米数')
    assert.ok(r.warnings.some(w => w.code === 'NEED_CALIBRATION'))
    assert.ok(r.warnings.find(w => w.code === 'NEED_CALIBRATION').msg.includes('refRealCm'))
  })

  it('参照物参数不完整（只有 realCm 或只有 px）也拒绝出数', () => {
    assert.equal(analyzeImage(boxPhoto(), { refRealCm: 29.7 }).dimsCm, null)
    assert.equal(analyzeImage(boxPhoto(), { refPx: 600 }).dimsCm, null)
  })

  it('测量误差跟着参照物的像素长度走（参照物太小就是不准，如实报出来）', () => {
    const big = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 600 })   // 600px 参照物
    const small = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 60 })  // 只 60px
    assert.ok(big.errorCm < small.errorCm, '参照物像素越多，误差越小')
    assert.ok(big.errorCm <= 1, '大参照物应达到可靠精度')
  })

  it('斜拍（对边不等长）时不给"自信"的精确尺寸', () => {
    // 造一个梯形：上下边不等宽，模拟斜拍
    const W = 800, H = 600
    const png = makeRgbPng(W, H, (x, y) => {
      const cx = 400
      const hw = y < 300 ? 200 : 320
      const inShape = Math.abs(x - cx) < hw && y >= 100 && y < 500
      const v = inShape ? 180 : 25
      return [v, v, v]
    })
    const r = analyzeImage(png, { refRealCm: 40, refPx: 400 })
    // 梯形要么被质量校验拦下、要么被透视检查拦下、要么根本不是规整矩形——
    // 三种都算"没给不可信的尺寸"，但绝不能在无告警的情况下出精确厘米数
    if (r.ok && r.dimsCm) {
      assert.ok(
        r.warnings.some(w => ['SKEW', 'MULTI_CANDIDATE'].includes(w.code)),
        `斜拍却给出了 ${r.dimsCm.l}×${r.dimsCm.w}cm 且无告警，这是危险信号`,
      )
    }
  })

  it('画面里找不到箱体时如实报 NO_BOX', () => {
    const flat = makeRgbPng(400, 400, () => [120, 120, 120])   // 纯色无箱体
    const r = analyzeImage(flat)
    assert.equal(r.ok, false)
    assert.ok(r.warnings.some(w => w.code === 'NO_BOX'))
  })
})

describe('云端视觉解析 · 契约（可改 + 免责 + 边界）', () => {
  it('结果标注为可编辑，并固定带免责声明', () => {
    const r = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 600 })
    assert.equal(r.editable, true, '结果必须声明客户端可修改')
    assert.equal(r.disclaimer, DISCLAIMER)
    assert.match(DISCLAIMER, /仅供参考/)
    assert.match(DISCLAIMER, /不作为结算或出货依据/)
  })

  it('高度恒为 null 并要求补录（单张俯视图几何上拍不出高度）', () => {
    const r = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 600 })
    assert.equal(r.dimsCm.h, null)
    assert.ok(r.warnings.some(w => w.code === 'NEED_HEIGHT'))
  })

  it('不带 scaleRegion 就不出重量（不给 0 冒充读数）', () => {
    const r = analyzeImage(boxPhoto(), { refRealCm: 50, refPx: 600 })
    assert.equal(r.weightKg, null)
    assert.equal(r.scaleRead, null)
  })

  it('非 PNG 上传被挡下并给出可执行提示', () => {
    assert.throws(
      () => analyzeImage(Buffer.from('<?php ?>')),
      (e) => /只接受 PNG/.test(e.message) && /toBlob/.test(e.hint),
    )
  })

  it('空图片与超限图片都被挡下', () => {
    assert.throws(() => analyzeImage(Buffer.alloc(0)), (e) => /没有收到图片/.test(e.message))
    // 用真实的 PNG 头 + 超限体积：验证拦它的是"太大"而不是"格式不对"
    const realPng = boxPhoto()
    const oversized = Buffer.concat([realPng, Buffer.alloc(MAX_IMAGE_BYTES)])
    assert.throws(() => analyzeImage(oversized), (e) => /超过 8MB/.test(e.message))
  })

  it('超大请求先报"太大"而非"格式不对"（顺序：安全检查优先）', () => {
    const junk = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x41)   // 既超限又不是 PNG
    assert.throws(() => analyzeImage(junk), (e) => /超过 8MB/.test(e.message),
      '体积检查必须排在格式检查之前，否则 8MB 的坏请求要先被验格式')
  })

  it('roi 指定后只在指定区域内选目标（多候选不默认取最大）', () => {
    // 造两个都够亮的矩形：左边箱体、右边另一个物件
    const W = 1200, H = 700
    const png = makeRgbPng(W, H, (x, y) => {
      const inA = x >= 100 && x < 500 && y >= 150 && y < 450
      const inB = x >= 700 && x < 1000 && y >= 150 && y < 450
      const v = inA || inB ? 190 : 25
      return [v, v, v]
    })
    const r = analyzeImage(png, { roi: { x: 700 / W, y: 150 / H, w: 300 / W, h: 300 / H }, refRealCm: 30, refPx: 300 })
    assert.equal(r.roiUsed, true)
    if (r.ok) {
      // 选了右侧那块，宽度应接近 300px 对应的 30cm，而不是左边 400px 的
      assert.ok(Math.abs(r.dimsCm.l - 30) < 2, `应量到 roi 内的 30cm，实际 ${r.dimsCm.l}`)
    }
  })

  it('多候选且未指定 roi 时告警（不静默替用户选一个）', () => {
    const W = 1200, H = 700
    const png = makeRgbPng(W, H, (x, y) => {
      const inA = x >= 100 && x < 500 && y >= 150 && y < 450
      const inB = x >= 700 && x < 1000 && y >= 150 && y < 450
      const v = inA || inB ? 190 : 25
      return [v, v, v]
    })
    const r = analyzeImage(png, { refRealCm: 30, refPx: 400 })
    if (r.detection.candidateCount > 1) {
      assert.ok(r.warnings.some(w => w.code === 'MULTI_CANDIDATE'), '多候选必须提醒用户指定 roi')
    }
  })
})