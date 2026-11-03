/**
 * 电子秤七段数码管 OCR 的单元测试。
 *
 * 这里没有用任何图片文件：测试自己实现了一个"合成七段数码管渲染器"，把
 * "12.35" 这样的字符串按标准七段几何画进 RGBA / 灰度缓冲区。这样做有两个好处：
 * 一是真值确定（期望串就是输入串），二是可以在同一张图上精确地制造恶劣条件——
 * 低对比度、整块高光干扰、被取景框切掉半个数字——这些恰恰是线上最容易出错、
 * 又最难用真实照片复现的场景。
 *
 * 断言口径统一为 PRD 的硬要求：**读不出可以，读错不行**。所以所有异常用例都要求
 * ok=false 且 reason 非空，而不是断言某个特定的错误码。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  SEG_MASK,
  binarize,
  readDigits,
  readScale,
  stabilize,
  parseScaleText,
} from '../h5/js/vision/ocr.js'

/* ───────────────────────── 合成七段数码管渲染器 ───────────────────────── */

const GEO = {
  digitW: 20,
  digitH: 34,
  thickness: 4,
  corner: 1,    // 段与段在拐角处的缝隙，真数码管都有，缺了会让 '1' 误判成 '7'
  charGap: 10,  // 字符间距
  dotSize: 4,
  margin: 12,
}

/** 位序 → 段名，与 SEG_MASK 的 bit0..bit6 一致。 */
const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

/**
 * 一个数字单元内七段的矩形 [x0, y0, x1, y1)（左上闭、右下开）。
 *
 * 两处几何细节不能省：
 *   1. 横向段（a/g/d）要向左盖过竖段所在列。真实数码管的段端头本来就是搭在竖段上的，
 *      若把横段整个缩进到竖段以内，列投影就会在该列断开，一个数字被切成两半。
 *   2. 横竖段之间要留 corner 缝隙。全亮不留缝时 '1' 与 '7'、'3' 与 '9' 的差别
 *      就只剩下肉眼难辨的一点点，分类器的容错窗口也失去意义。
 */
function segRects(x, y, { digitW: W, digitH: H, thickness: T, corner: G }) {
  const my0 = Math.round(H / 2 - T / 2)
  const my1 = my0 + T
  const inset = Math.floor(T / 2) + 1
  return {
    a: [x + inset, y, x + W - inset, y + T],
    g: [x + inset, y + my0, x + W - inset, y + my1],
    d: [x + inset, y + H - T, x + W - inset, y + H],
    f: [x, y + T + G, x + T, y + my0 - G],
    b: [x + W - T, y + T + G, x + W, y + my0 - G],
    e: [x, y + my1 + G, x + T, y + H - T - G],
    c: [x + W - T, y + my1 + G, x + W, y + H - T - G],
  }
}

/** 固定种子的伪随机噪声，保证用例可复现（真实拍摄不会每次都长一个样）。 */
function makeNoise(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * 渲染一段读数。
 *
 * opts:
 *   fg/bg    前景（亮段）与背景灰度
 *   noise    噪声幅度（灰度级）
 *   label    画一块"kg"字样的高光干扰块
 *   stray    在第 n 个数字与下一个数字之间塞一块高光（模拟漏读一位的陷阱）
 *   margin   四周边距；改大可让取景框与字形之间留出空隙
 * 返回 { data, width, height, cells }，cells 里带每个字符的位置，供构造截断用例。
 */
function renderReadout(text, opts = {}) {
  const fg = opts.fg ?? 235
  const bg = opts.bg ?? 18
  const noise = opts.noise ?? 5
  const margin = opts.margin ?? GEO.margin
  const geo = { ...GEO }
  const rnd = makeNoise(opts.seed ?? 20241017)

  const chars = [...text]
  const cells = []
  let penX = 0
  let pen = 0
  for (const ch of chars) {
    if (ch === '.') {
      pen += Math.round((geo.charGap - geo.dotSize) / 2)
      cells.push({ ch: '.', type: 'dot', x: pen, y: geo.digitH - geo.dotSize, w: geo.dotSize, h: geo.dotSize })
      pen += geo.dotSize + geo.charGap
    } else {
      cells.push({ ch, type: 'digit', x: pen, y: 0, w: geo.digitW, h: geo.digitH })
      pen += geo.digitW + geo.charGap
    }
  }
  const digitsEnd = pen

  const labelW = opts.label ? Math.round(geo.digitW * 1.1) : 0
  const width = pen - geo.charGap + margin + (labelW ? labelW + margin : 0) + margin
  const height = geo.digitH + margin * 2

  const shift = margin
  const buf = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const v = bg + Math.round((rnd() - 0.5) * 2 * noise)
    buf[i * 4] = v
    buf[i * 4 + 1] = v
    buf[i * 4 + 2] = v
    buf[i * 4 + 3] = 255
  }

  const rect = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) {
      if (y < 0 || y >= height) continue
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= width) continue
        const p = (y * width + x) * 4
        buf[p] = fg
        buf[p + 1] = fg
        buf[p + 2] = fg
      }
    }
  }

  for (const cell of cells) {
    const x = cell.x + shift
    const y = cell.y + margin
    cell.abs = { x, y, w: cell.w, h: cell.h }
    if (cell.type === 'dot') {
      rect(x, y, x + cell.w, y + cell.h)
      continue
    }
    const rects = segRects(x, y, geo)
    const mask = SEG_MASK[cell.ch]
    for (let s = 0; s < 7; s++) {
      if ((mask >> s) & 1) {
        const r = rects[SEG_NAMES[s]]
        rect(r[0], r[1], r[2], r[3])
      }
    }
  }

  if (opts.label) {
    // 秤面上的单位字样：矮、实心、不跟数字对齐，正是要被当成"噪音"忽略的东西
    const lh = Math.round(geo.digitH * 0.42)
    const lx = digitsEnd + margin
    const ly = margin + geo.digitH - lh
    rect(lx, ly, lx + Math.round(geo.digitW * 0.5), ly + lh)
    rect(lx + Math.round(geo.digitW * 0.6), ly, lx + labelW, ly + lh)
  }

  if (opts.stray !== undefined) {
    // 数字之间的高光块：若被静默忽略，读数就会凭空少一位
    const prev = cells.filter((c) => c.type === 'digit')[opts.stray]
    const sx = prev.x + shift + GEO.digitW + 1
    const sy = margin + 4
    rect(sx, sy, sx + 5, sy + 5)
  }

  return { data: buf, width, height, channels: 4, cells }
}

/** RGBA → 单通道灰度，用来验证两种输入格式走的是同一条识别路径。 */
function toGray(rgba) {
  const out = new Uint8Array(rgba.width * rgba.height)
  for (let i = 0; i < out.length; i++) out[i] = rgba.data[i * 4]
  return { data: out, width: rgba.width, height: rgba.height, channels: 1 }
}

/** 整幅图作为取景框。 */
const full = (img) => ({ x: 0, y: 0, w: img.width, h: img.height })

/* ───────────────────────────────── 断言助手 ───────────────────────────────── */

/** 磅换算的小数位很长，断言用容差而不是全等，否则会把精度问题误报成逻辑问题。 */
function close(actual, expected, eps = 1e-6, hint = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${hint}期望 ≈ ${expected}，实际 ${actual}`,
  )
}

function assertRejected(out, hint) {
  assert.equal(out.ok, false, `${hint}：期望识别失败，实际读出 ${JSON.stringify(out.text)}`)
  assert.ok(out.reason && out.reason.length > 0, `${hint}：失败时必须给出中文原因`)
  assert.equal(out.value ?? null, null, `${hint}：识别失败时不得给出数值`)
  assert.equal(out.valueKg ?? null, null, `${hint}：识别失败时不得给出千克值`)
}

/* ───────────────────────────────── 测试主体 ───────────────────────────────── */

describe('电子秤七段数码管 OCR · 渲染与识别', () => {
  it('10 个数字逐个渲染都能读回来（掩码定义与几何必须自洽）', () => {
    // 这里用 readDigits 而不是 readScale：读数 "0" 经换算后是 0 kg，按 PRD 属于
    // "扣皮后无有效重量"，会被 readScale 拒绝——那是正确的行为，不该在这里断言它成功。
    for (let d = 0; d <= 9; d++) {
      const ch = String(d)
      const img = renderReadout(ch)
      const out = readDigits(binarize(img, full(img)))
      assert.equal(out.ok, true, `数字 ${ch} 应能识别：${out.reason}`)
      assert.equal(out.text, ch)
      assert.equal(out.value, d)
      assert.equal(out.digits.length, 1)
      assert.equal(out.digits[0].mask, SEG_MASK[ch], `数字 ${ch} 的掩码对不上`)
      if (d > 0) {
        const scaled = readScale(img, full(img))
        assert.equal(scaled.ok, true, `数字 ${ch} 应能换算出千克：${scaled.reason}`)
        assert.equal(scaled.valueKg, d)
      } else {
        // 秤读数为 0 时不能当成"有效重量 0"放行，否则会存出一份空车的方案
        assertRejected(readScale(img, full(img)), '秤面读数为 0')
      }
    }
  })

  it('带小数点的读数位置正确：12.35 / 0.5 / 123.45', () => {
    const cases = [
      ['12.35', '12.35', 12.35, [1]],
      ['0.5', '0.5', 0.5, [0]],
      ['123.45', '123.45', 123.45, [2]],
      ['00.50', '00.50', 0.5, [1]],
    ]
    for (const [input, text, value, dots] of cases) {
      const img = renderReadout(input)
      const out = readScale(img, full(img))
      assert.equal(out.ok, true, `${input} 应能识别：${out.reason}`)
      assert.equal(out.text, text)
      assert.equal(out.value, value)
      assert.deepEqual(out.dotIndexes, dots, `${input} 的小数点下标不对`)
      assert.equal(out.valueKg, value, `${input} 换算后千克值不对`)
      assert.ok(out.confidence > 0.8, `${input} 的置信度偏低：${out.confidence}`)
    }
  })

  it('灰度输入与 RGBA 输入识别结果一致', () => {
    const rgba = renderReadout('12.35')
    const gray = toGray(rgba)
    const a = readScale(rgba, full(rgba))
    const b = readScale(gray, full(gray))
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(b.text, a.text)
    assert.equal(b.valueKg, a.valueKg)
  })

  it('反色显示（深字亮底）加 invert 后同样能识别', () => {
    // 反色屏是液晶秤的常态：不传 invert 会把背景当笔画，读出一串乱码
    const img = renderReadout('45.6', { fg: 20, bg: 210 })
    const normal = readScale(img, full(img))
    const inverted = readScale(img, full(img), { invert: true })
    assert.equal(inverted.ok, true, `反色读取失败：${inverted.reason}`)
    assert.equal(inverted.text, '45.6')
    assert.equal(inverted.valueKg, 45.6)
    assert.notEqual(normal.ok, true, '未开 invert 时不该侥幸读对（否则这条用例没意义）')
  })

  it('画面里的单位字样（kg 高光块）被忽略，不会被误读成 8', () => {
    const img = renderReadout('12.35', { label: true })
    const out = readScale(img, full(img))
    assert.equal(out.ok, true, `带单位字样时应仍能读出数字：${out.reason}`)
    assert.equal(out.text, '12.35', '单位字样被当成了数字')
    assert.equal(out.digits.length, 4)
  })

  it('数字中间的高光块不会被静默忽略（少读一位比读不出更危险）', () => {
    const img = renderReadout('12.35', { stray: 0 })
    const out = readScale(img, full(img))
    assertRejected(out, '数字之间存在无法识别的字形')
  })

  it('取景框越界不崩溃，按裁剪后的区域照常识别', () => {
    const img = renderReadout('12.35')
    const wild = [
      { x: -80, y: -60, w: img.width + 400, h: img.height + 300 },
      { x: img.width - 4, y: img.height - 4, w: 9999, h: 9999 },
      { x: 5, y: 5, w: 0, h: 0 },
    ]
    for (const region of wild) {
      const bin = binarize(img, region)
      assert.ok(bin.width >= 0 && bin.height >= 0)
      assert.equal(bin.data.length, bin.width * bin.height)
    }
    // 越界但仍盖住整串数字
    const loose = readScale(img, { x: -20, y: -20, w: img.width + 40, h: img.height + 40 })
    assert.equal(loose.ok, true, `越界取景框应照常识别：${loose.reason}`)
    assert.equal(loose.text, '12.35')
  })

  it('数字被取景框切掉一半时必须报错，绝不静默存错值', () => {
    const img = renderReadout('12.35')
    const last = img.cells.filter((c) => c.type === 'digit').pop().abs
    // 只框到最后一个数字的一半
    const cut = { x: 0, y: 0, w: last.x + Math.round(last.w / 2), h: img.height }
    const out = readScale(img, cut)
    assertRejected(out, '右侧数字被截断')

    // 上下切掉一截（g 段以下全没了）
    const vertCut = { x: 0, y: 0, w: img.width, h: Math.round(GEO.digitH * 0.72) }
    assertRejected(readScale(img, vertCut), '纵向被截断')

    // 只框住前两个数字是可以的——那是用户自己选的区域，不是错误
    const ok = readScale(img, { x: 0, y: 0, w: img.cells[1].abs.x + img.cells[1].w + 2, h: img.height })
    assert.equal(ok.ok, true, `完整框住前两位应能读：${ok.reason}`)
    assert.equal(ok.text, '12')
  })

  it('全黑 / 全白 / 空图 一律识别失败并给出原因', () => {
    const blank = (v, w = 60, h = 40) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = v
        data[i * 4 + 1] = v
        data[i * 4 + 2] = v
        data[i * 4 + 3] = 255
      }
      return { data, width: w, height: h }
    }
    assertRejected(readScale(blank(0), { x: 0, y: 0, w: 60, h: 40 }), '全黑画面')
    assertRejected(readScale(blank(255), { x: 0, y: 0, w: 60, h: 40 }), '全白画面')
    assertRejected(readDigits({ data: new Uint8Array(0), width: 0, height: 0 }), '空二值图')
    assertRejected(readDigits(null), '缺图')
  })

  it('低对比度读数仍能识别（手机在暗柜台拍秤面）', () => {
    const img = renderReadout('8.75', { fg: 92, bg: 58, noise: 4 })
    const out = readScale(img, full(img))
    assert.equal(out.ok, true, `低对比度应能识别：${out.reason}`)
    assert.equal(out.text, '8.75')
  })

  it('低对比度低到无法分割时失败，而不是给出随机数', () => {
    const img = renderReadout('12.35', { fg: 104, bg: 100, noise: 3 })
    assertRejected(readScale(img, full(img)), '对比度不足')
  })

  it('minConfidence 门槛生效', () => {
    const img = renderReadout('12.35')
    assertRejected(readScale(img, full(img), { minConfidence: 1.01 }), '置信度门槛')
  })
})

describe('电子秤七段数码管 OCR · 单位换算与皮重', () => {
  it('lb / g / kg 三种单位换算到千克', () => {
    const img = renderReadout('12.50')
    const kg = readScale(img, full(img), { unit: 'kg' })
    assert.equal(kg.unit, 'kg')
    assert.equal(kg.unitSource, 'manual', '显式传入的单位应标为人工指定')
    assert.equal(kg.valueKg, 12.5)

    const lb = readScale(img, full(img), { unit: 'lb' })
    assert.equal(lb.unit, 'lb')
    close(lb.valueKg, 12.5 * 0.45359237, 1e-6, '12.5 lb 换算：')

    const g = readScale(img, full(img), { unit: 'g' })
    assert.equal(g.valueKg, 0.0125)
  })

  it('不指定单位时按 kg 处理并标为 auto', () => {
    const img = renderReadout('20.00')
    const out = readScale(img, full(img))
    assert.equal(out.unit, 'kg')
    assert.equal(out.unitSource, 'auto')
  })

  it('皮重扣减；扣到 <=0 时拒绝出数', () => {
    const img = renderReadout('12.35')
    const tared = readScale(img, full(img), { tare: 2 })
    assert.equal(tared.ok, true)
    assert.equal(tared.valueKg, 10.35)
    assert.equal(tared.tareApplied, 2)

    assertRejected(readScale(img, full(img), { tare: 12.35 }), '皮重等于毛重')
    assertRejected(readScale(img, full(img), { tare: 20 }), '皮重大于毛重')
  })

  it('识别失败时不产出千克值', () => {
    const img = renderReadout('12.35')
    const out = readScale(img, { x: 0, y: 0, w: img.width, h: Math.round(GEO.digitH * 0.5) }, { tare: 0 })
    assertRejected(out, '纵向截断的读数')
  })
})

describe('电子秤七段数码管 OCR · 多帧稳定', () => {
  const frames = (vs) => vs.map((v, i) => ({ valueKg: v, ts: i * 120 }))

  it('三帧一致 → stable:true', () => {
    const out = stabilize(frames([12.3, 12.31, 12.3]))
    assert.equal(out.stable, true, out.reason)
    assert.equal(out.value, 12.3)
    assert.equal(out.frames, 3)
    assert.equal(out.spread, 0.01)
  })

  it('含跳变帧（极差 > 0.05kg）→ stable:false', () => {
    const out = stabilize(frames([12.3, 15.8, 12.31]))
    assert.equal(out.stable, false)
    assert.ok(out.spread > 0.05)
    assert.match(out.reason, /未稳定/)
  })

  it('帧数不足 → stable:false', () => {
    const out = stabilize(frames([12.3, 12.31]))
    assert.equal(out.stable, false)
    assert.equal(out.frames, 2)
    assert.equal(out.value, null)
    assert.ok(out.reason.length > 0)
  })

  it('读不出数的帧不计入有效帧', () => {
    const out = stabilize([{ valueKg: null }, { valueKg: 12.3 }, { valueKg: 12.3 }, { valueKg: 12.3 }])
    assert.equal(out.ok, undefined)
    assert.equal(out.frames, 3)
    assert.equal(out.stable, true)
  })

  it('允许范围内的正常抖动仍算稳定', () => {
    const out = stabilize(frames([12.3, 12.33, 12.31]))
    assert.equal(out.stable, true, out.reason)
    assert.equal(out.value, 12.31)
  })

  it('自定义帧数与抖动阈值', () => {
    const readings = frames([5, 5.02, 5.01, 5.03])
    assert.equal(stabilize(readings, { minFrames: 2 }).stable, true)
    assert.equal(stabilize(readings, { jitter: 0.005 }).stable, false)
    assert.equal(stabilize([], { minFrames: 1 }).stable, false)
  })
})

describe('电子秤七段数码管 OCR · 字符串校验入口', () => {
  it('合法读数', () => {
    assert.equal(parseScaleText('12.35').valueKg, 12.35)
    assert.equal(parseScaleText('  1.2  ').valueKg, 1.2)
    assert.equal(parseScaleText('0.5').valueKg, 0.5)
    assert.equal(parseScaleText('12345').valueKg, 12345)
    assert.equal(parseScaleText('１２．３５').valueKg, 12.35, '全角数字应折半角后识别')
    assert.equal(parseScaleText('1.20').ok, true)
  })

  it('非法读数一律拒绝（字母、乱码、多点、超长、空串）', () => {
    for (const bad of ['12a', '..', '1.2.3', '', '   ', 'abc', 'kg', '-5', '1.234', '123456', '1..2', '0x10', '12,35']) {
      const out = parseScaleText(bad)
      assert.equal(out.ok, false, `"${bad}" 不该通过校验`)
      assert.equal(out.valueKg, null, `"${bad}" 不该产出千克值`)
      assert.ok(out.reason.length > 0, `"${bad}" 缺少失败原因`)
    }
    assert.equal(parseScaleText(null).ok, false)
    assert.equal(parseScaleText(undefined).ok, false)
  })

  it('从字符串里识别单位：lb → kg 换算', () => {
    const out = parseScaleText('100 lb')
    assert.equal(out.ok, true, out.reason)
    assert.equal(out.unit, 'lb')
    assert.equal(out.unitSource, 'auto')
    close(out.valueKg, 45.359237, 1e-6, '100 lb ≈ 45.359 kg：')

    close(parseScaleText('100LB').valueKg, 45.359237, 1e-6, '大写单位：')
    assert.equal(parseScaleText('5 kg').valueKg, 5)
    assert.equal(parseScaleText('5 kgf').valueKg, 5)
    assert.equal(parseScaleText('2500 g').valueKg, 2.5)
    assert.equal(parseScaleText('2500g').valueKg, 2.5)
    // 没有单位词时按 opts.unit，再退到默认 kg
    close(parseScaleText('7', { unit: 'lb' }).valueKg, 7 * 0.45359237, 1e-6, '7 lb：')
    assert.equal(parseScaleText('7').unit, 'kg')
  })

  it('皮重扣减，扣到 <=0 时 ok=false', () => {
    assert.equal(parseScaleText('12.35', { tare: 2.35 }).valueKg, 10)
    const dead = parseScaleText('12.35', { tare: 12.35 })
    assert.equal(dead.ok, false)
    assert.equal(dead.valueKg, null)
    assert.ok(dead.reason.length > 0)

    const over = parseScaleText('100 lb', { tare: 50 })
    assert.equal(over.ok, false)
    assert.equal(over.valueKg, null)
  })

  it('失败结果也带上原始串，便于 UI 回显让人工核对', () => {
    const out = parseScaleText('12a')
    assert.equal(out.raw, '12a')
    assert.equal(out.ok, false)
  })
})