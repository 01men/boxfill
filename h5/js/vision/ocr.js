/**
 * 电子秤七段数码管 OCR —— 纯函数内核（零依赖、不碰 DOM）。
 *
 * 采集链路：摄像头帧 → 二值化 → 切分字符 → 七段位掩码比对 → 单位换算 → 多帧稳定。
 *
 * 这个文件刻意不接受 ImageData、也不引用 window/navigator：像素以普通对象
 * {data, width, height} 传入，于是同一份代码既能跑在 canvas 前面（UI 层取出
 * ImageData 直接透传），也能在 Node 下用合成图做单测，不需要浏览器环境。
 *
 * 贯穿全文件的第一原则是**宁可读不出，也不能读错**。装箱场景里错读 0.1 kg 就是
 * 多装/少装一批货，且错值一旦入库极难追溯，所以每个不确定的中间量都配了显式的
 * 拒绝路径（ok=false + 中文原因），绝不"挑一个最像的"当有效读数。
 */

/**
 * 七段数码管位掩码。
 * bit0=a(上) bit1=b(右上) bit2=c(右下) bit3=d(下) bit4=e(左下) bit5=f(左上) bit6=g(中)
 */
export const SEG_MASK = {
  '0': 0x3f, '1': 0x06, '2': 0x5b, '3': 0x4f, '4': 0x66,
  '5': 0x6d, '6': 0x7d, '7': 0x07, '8': 0x7f, '9': 0x6f,
}

/**
 * 掩码 → 字符的反查表。
 * 只有恰好命中的掩码才认成数字：位掩码是离散的，"8 与 9 差一个段"这类近似匹配
 * 正是把半亮的段猜成数字的入口，宁可整位拒绝。
 */
const MASK_TO_CHAR = (() => {
  const m = new Map()
  for (const [ch, mask] of Object.entries(SEG_MASK)) m.set(mask, ch)
  return m
})()

/** 单位 → 千克。lb 用国际标准磅（0.45359237 kg），避免每处各写一个近似值。 */
const UNIT_TO_KG = { kg: 1, g: 0.001, lb: 0.45359237 }

/**
 * 七段分区比例。
 *
 * 判定不是"看亮像素落在哪"，而是把字符框切成 7 个互相不重叠的矩形分区，逐区
 * 算亮像素占比：占比过半即该段点亮。分区边界比真实段宽略宽（0.17/0.42/0.58/0.83、
 * 侧边 0.18），是为了把段与段之间的缝隙排除在所有分区之外——否则 g 段的像素会
 * 漏进左上/右上，'1' 就会被判成 '7'。
 */
const Z_TOP = 0.17
const Z_MID0 = 0.42
const Z_MID1 = 0.58
const Z_BOT = 1 - Z_TOP
const Z_SIDE = 0.18

/** 分区顺序与 SEG_MASK 的位序一致：[a, b, c, d, e, f, g]，值为 [r0, r1, c0, c1] 比例。 */
const ZONES = [
  [0, Z_TOP, Z_SIDE, 1 - Z_SIDE],      // a 上
  [Z_TOP, Z_MID0, 1 - Z_SIDE, 1],      // b 右上
  [Z_MID1, Z_BOT, 1 - Z_SIDE, 1],      // c 右下
  [Z_BOT, 1, Z_SIDE, 1 - Z_SIDE],      // d 下
  [Z_MID1, Z_BOT, 0, Z_SIDE],          // e 左下
  [Z_TOP, Z_MID0, 0, Z_SIDE],          // f 左上
  [Z_MID0, Z_MID1, Z_SIDE, 1 - Z_SIDE],// g 中
]

/** 分区亮像素占比达到该值才认为该段点亮。 */
const BIT_ON = 0.45

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0)
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * 抹掉浮点尾数（保留 6 位小数），避免 45.35900000000001 这类噪声把
 * "是否超过抖动阈值"这种边界判定顶到意外的一侧。位数不能更少——克级的读数换算成
 * 千克后本来就只有 3~4 位有效数字，round 到 3 位会把 12.5g 直接写成 0.013kg。
 */
function round6(v) {
  return Math.round(v * 1e6) / 1e6
}

function median(sorted) {
  const n = sorted.length
  if (!n) return 0
  const mid = n >> 1
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Otsu 自动阈值。
 *
 * 手机拍的电子秤照片没有固定曝光，用固定阈值会在暗柜台/强光下整体失效。
 * Otsu 对"亮段 + 暗底"这种双峰直方图最稳，且完全无参数。
 */
function otsuThreshold(hist, total) {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = wB * wF * ((sumB / wB) - ((sum - sumB) / wF)) ** 2
    if (between > best) {
      best = between
      thr = t
    }
  }
  return thr
}

/**
 * 把一段像素区域二值化，返回 {data:Uint8Array, width, height}（1 = 亮段，0 = 暗）。
 *
 * image 支持 RGBA（4 通道）与灰度（1 通道）两种常见来源；RGBA 走亮度加权而不是
 * 通道平均，因为电子秤红色 LED 段在亮度上与暗底仍有充足反差，平均值反而会把它
 * 压低。region 会被安全裁剪到图像内——UI 层画的是用户可拖的取景框，越界是常态。
 */
export function binarize(image, region, opts = {}) {
  const empty = { data: new Uint8Array(0), width: 0, height: 0 }
  if (!image || !image.data || !(image.width > 0) || !(image.height > 0)) return empty

  const W = image.width | 0
  const H = image.height | 0
  const px = W * H
  if (!px) return empty

  const src = image.data
  const ch = src.length >= px * 4 ? 4 : 1
  const r = region || { x: 0, y: 0, w: W, h: H }
  const rx = Math.round(Number(r.x) || 0)
  const ry = Math.round(Number(r.y) || 0)
  const x0 = clampInt(rx, 0, W)
  const y0 = clampInt(ry, 0, H)
  const x1 = clampInt(rx + (Number.isFinite(+r.w) ? +r.w : W), 0, W)
  const y1 = clampInt(ry + (Number.isFinite(+r.h) ? +r.h : H), 0, H)
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return empty

  const gray = new Uint8Array(w * h)
  const hist = new Uint32Array(256)
  let i = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, i++) {
      const p = (y * W + x) * ch
      let v
      if (ch === 4) {
        v = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      } else {
        v = src[p]
      }
      const b = v < 0 ? 0 : v > 255 ? 255 : v | 0
      gray[i] = b
      hist[b]++
    }
  }

  const total = w * h
  const thr = Number.isFinite(+opts.threshold) ? Math.round(+opts.threshold) : otsuThreshold(hist, total)
  const invert = opts.invert === true
  const out = new Uint8Array(total)
  for (let k = 0; k < total; k++) {
    const bright = gray[k] > thr
    out[k] = (invert ? !bright : bright) ? 1 : 0
  }
  return { data: out, width: w, height: h }
}

/**
 * 逐段统计字符框内的亮像素占比。
 *
 * 返回值同时带上分区面积：面积为 0 的分区（比如 '1' 的左侧两列宽度不足半像素）
 * 必须从置信度里剔除，否则它们会以"0 占比且期望熄灭"的形式把置信度刷高。
 */
function measureSegments(bin, x0, y0, w, h) {
  const ratios = new Float64Array(7)
  const areas = new Int32Array(7)
  for (let s = 0; s < 7; s++) {
    const z = ZONES[s]
    const ry0 = y0 + Math.round(z[0] * h)
    const ry1 = y0 + Math.round(z[1] * h)
    const rx0 = x0 + Math.round(z[2] * w)
    const rx1 = x0 + Math.round(z[3] * w)
    let on = 0
    let area = 0
    for (let y = ry0; y < ry1; y++) {
      if (y < 0 || y >= bin.height) continue
      const row = y * bin.width
      for (let x = rx0; x < rx1; x++) {
        if (x < 0 || x >= bin.width) continue
        area++
        if (bin.data[row + x]) on++
      }
    }
    areas[s] = area
    ratios[s] = area > 0 ? on / area : 0
  }
  return { ratios, areas }
}

/** 列投影切出每一段笔画所在的连续列区间（小数点会自然成为独立的一小段列）。 */
function segmentRuns(bin) {
  const { width: W, height: H, data } = bin
  const prof = new Int32Array(W)
  // 阈值取行数的 4%：零星噪点不足一根笔画的高度，不该被当成一个字符切出来。
  const minCol = Math.max(1, Math.round(H * 0.04))
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      if (data[row + x]) prof[x]++
    }
  }
  const runs = []
  let x = 0
  while (x < W) {
    if (prof[x] < minCol) { x++; continue }
    const x0 = x
    while (x < W && prof[x] >= minCol) x++
    const x1 = x - 1
    let y0 = H
    let y1 = -1
    for (let yy = 0; yy < H; yy++) {
      const row = yy * W
      let any = false
      for (let xx = x0; xx <= x1; xx++) if (data[row + xx]) { any = true; break }
      if (any) { if (y0 === H) y0 = yy; y1 = yy }
    }
    if (y1 >= 0) runs.push({ x0, x1, w: x1 - x0 + 1, y0, y1, h: y1 - y0 + 1 })
  }
  return runs
}

/**
 * 判断一段列区间是不是小数点。
 *
 * 三个条件缺一不可：矮、贴底、明显窄。窄这条必须以整幅画面里最宽的字形为参照
 * （而不是以小数点自己为参照）——否则"kg"这类单位字样里的小方块会因为"相对自己
 * 不宽"而被当成小数点，把读数改写成 12.3.5 这种值。
 */
function isDotRun(run, hMed, yBotMax, wMax) {
  const cap = wMax * 0.4
  return (
    run.h <= Math.min(hMed * 0.5, cap) &&
    run.w <= cap &&
    run.y1 >= yBotMax - hMed * 0.25
  )
}

/**
 * 在"参考字框"里判字形，而不是在切出来的亮区里判。
 *
 * 切出来的亮区不等于字符框：'1' 只亮右侧两竖，框宽只有竖段那么窄、上下还各缺一截，
 * 直接拿自己的框按比例切分区，b/c 会被挤到分区之外判成全灭。所以先算出整串的参考
 * 字宽字高，再把窄字形按右边缘对齐到参考框上——七段管的 '1' 本来就是右对齐的。
 */
function classifyInCell(bin, cell) {
  const { ratios, areas } = measureSegments(bin, cell.x0, cell.y0, cell.w, cell.h)
  let mask = 0
  for (let s = 0; s < 7; s++) if (ratios[s] >= BIT_ON) mask |= 1 << s
  let sum = 0
  let n = 0
  for (let s = 0; s < 7; s++) {
    if (!areas[s]) continue
    sum += (mask >> s) & 1 ? ratios[s] : 1 - ratios[s]
    n++
  }
  // 整块实心（比如整块高光）七区全亮也会得到 0x7f（'8'）。用字框内的总亮像素占比
  // 把"实心方块"和"七段管"分开：真 '8' 的填充率约四成多，实心块接近 1。
  let lit = 0
  for (let y = cell.y0; y < cell.y0 + cell.h; y++) {
    if (y < 0 || y >= bin.height) continue
    const row = y * bin.width
    for (let x = cell.x0; x < cell.x0 + cell.w; x++) {
      if (x < 0 || x >= bin.width) continue
      if (bin.data[row + x]) lit++
    }
  }
  const fill = lit / (cell.w * cell.h)
  const char = MASK_TO_CHAR.get(mask) || null
  return { mask, char, quality: n ? sum / n : 0, fill }
}

/**
 * 识别一段已二值化的数码管区域（可含小数点）内的读数。
 *
 * 返回 { ok, text, value, digits, dotIndexes, confidence, reason }。
 * dotIndexes 记的是 digits 的下标 i，含义为"digits[i] 之后紧跟一个小数点"，
 * 与拼串顺序一致；text 不含单位，value = parseFloat(text) 或 null。
 */
export function readDigits(binary, opts = {}) {
  const fail = (reason) => ({
    ok: false, text: '', value: null, digits: [], dotIndexes: [],
    confidence: 0, reason,
  })

  const bin = binary
  if (!bin || !bin.data || !(bin.width > 0) || !(bin.height > 0)) {
    return fail('未找到数码管区域')
  }
  const total = bin.width * bin.height
  if (bin.data.length < total) return fail('未找到数码管区域')

  let lit = 0
  for (let i = 0; i < total; i++) if (bin.data[i]) lit++
  const litRatio = lit / total
  // 全亮/全暗都意味着这一帧根本没法分割（取景框盖住整块高光、过曝，或全黑），
  // 继续往下走只会稳定地产出一个漂亮的错误答案。
  if (litRatio > 0.9) return fail('画面过曝，明暗对比不足')
  if (litRatio < 0.005) return fail('画面过暗，未找到数码管区域')

  const runs = segmentRuns(bin)
  if (!runs.length) return fail('未找到数码管区域')

  const hMed = median(runs.map((r) => r.h).sort((a, b) => a - b))
  const yBotMax = runs.reduce((m, r) => Math.max(m, r.y1), 0)
  const wMax = runs.reduce((m, r) => Math.max(m, r.w), 0)

  const dots = []
  const glyphRuns = []
  for (const run of runs) {
    if (isDotRun(run, hMed, yBotMax, wMax)) dots.push(run)
    else glyphRuns.push(run)
  }
  if (!glyphRuns.length) return fail('未找到数码管区域')
  glyphRuns.sort((a, b) => a.x0 - b.x0)

// 字格上下边界取"够高的字形"的极值，不能取中位数/分位数：'1'、'4'、'7' 天生缺
  // 上下横段（只有 25/34 高），一旦按分位数取边界，边界会缩到这些矮字形上，横向段
  // 分区随之错位，整串读不出来。先滤掉明显矮的东西（单位字样、噪点块），剩下的
  // 取上下极值即为真实字格。
  const maxH = glyphRuns.reduce((m, r) => Math.max(m, r.h), 0)
  const tall = glyphRuns.filter((r) => r.h >= maxH * 0.7)
  const inkTop = Math.min(...tall.map((r) => r.y0))
  // 小数点永远贴着字格底边，是唯一能钉死底边的锚点。
  const inkBot = Math.max(...tall.map((r) => r.y1), ...dots.map((d) => d.y1))
  const inkH = inkBot - inkTop + 1

  // 参考字宽取"宽字形"的最大值：'1' 只点亮右侧两竖，天然比其它数字窄，
  // 若把它算进参考值，所有被截断的数字都会被误判为合格。
  const wide = glyphRuns.filter((r) => r.w >= inkH * 0.45)
  const refW = wide.length ? Math.max(...wide.map((r) => r.w)) : Math.max(4, Math.round(inkH * 0.55))

  // 笔画厚度 = 最细的那根竖段的宽度（'1' 就是一整根竖）。字格真实边界最坏只比墨迹
  // 边界各差一个笔画厚度：整串都是 1/4（谁都没有上横段）或 1/4/7（谁都没有下横段）
  // 时，那一侧的墨迹边界就落在笔画中段。所以最多再放宽 maxK 个像素重试。
  const maxK = Math.max(1, Math.round(refW * 0.35))
  const classify = (top, bot) => {
    const h = bot - top + 1
    const digits = []
    const rejects = []
    for (const run of glyphRuns) {
      // 纵向只要求与整串的亮区带重叠，并留 35% 的余量：'1' 和 '4' 天生没有上下横段
      // （只有 25/34 高），差一截是正常的，但整体抬高/压低（被上下裁掉）说明字没拍全。
      const bandOk = run.y0 >= top - h * 0.35 && run.y1 <= bot + h * 0.35
      // 十个数字里只有 '1' 会缺左侧两竖，且没有任何数字缺右侧两竖，所以每个字形的
      // 亮区右边缘必然就是它所在字符格的右边缘——统一按右边缘对齐即可把字形放回
      // 完整字符格，不必分别处理左对齐/右对齐。
      const cls = classifyInCell(bin, { x0: run.x1 - refW + 1, y0: top, w: refW, h })

      const isNarrowOne = cls.mask === SEG_MASK['1'] && cls.quality >= 0.6 && run.w < refW * 0.55
      if (isNarrowOne) {
        if (bandOk) digits.push({ char: '1', mask: SEG_MASK['1'], confidence: round6(cls.quality), x: run.x0, w: run.w })
        else rejects.push(run)
        continue
      }
      if (!bandOk || run.h < h * 0.68 || cls.fill > 0.85 ||
          cls.char === null || run.w < refW * 0.8 || cls.quality < 0.5) {
        rejects.push(run)
        continue
      }
      digits.push({
        char: cls.char, mask: cls.mask, confidence: round6(cls.quality), x: run.x0, w: run.w,
      })
    }
    return { digits, rejects, top, bot, h }
  }
  // 够高也够宽却没认出来的字形，一定是一个没读出来的数字；矮块（单位字样、反光）
  // 不算。参照的是墨迹字高而不是当前字格高度——字格高度正是这一轮在调的变量，
  // 拿它当尺子会在字格被放宽时把真正丢掉的那个数字判成"小噪声"，从而悄悄少读一位。
  const lostDigits = (a) => a.rejects.filter((r) => r.h >= inkH * 0.6 && r.w >= refW * 0.4).length

  let best = null
  for (let k = 0; k <= maxK; k++) {
    const a = classify(inkTop - k, dots.length ? inkBot : inkBot + k)
    if (!best || lostDigits(a) < lostDigits(best)) best = a
    if (a.digits.length && !lostDigits(a)) break
  }
  const { digits, rejects, top: refTop, bot: refBot, h: refH } = best

  if (!digits.length) return fail('未找到数码管区域')

  // 数字之间出现没认出来的东西，说明中间漏了一位。宁可报错让人重新取景，也不能报出
  // 少一位的重量——那是另一个完全合法的数值，一旦入库就再也查不出来了。
  const lo = digits[0].x
  const hi = digits[digits.length - 1].x
  for (const run of rejects) {
    const c = run.x0 + run.w / 2
    if (c > lo && c < hi) return fail('字形不完整：数字之间存在无法识别的字形')
  }

  // 与数字同量级（够高也够宽）却没被认成数字的，一定是一个没读出来的数字。它可能在
  // 取景框边缘（被切掉一半），也可能在首位/末位（少读一位）。两种都必须报错。
  // 明显更矮更小的块（秤面单位字样、反光斑）才允许当噪声忽略。
  for (const run of rejects) {
    if (run.h < inkH * 0.6 || run.w < refW * 0.4) continue
    const touches = run.x0 === 0 || run.x1 === bin.width - 1 || run.y0 === 0 || run.y1 === bin.height - 1
    return fail(touches ? '字形不完整：字符被取景框截断' : '字形不完整：存在无法识别的数字')
  }

  // 小数点归到它左边那个数字上，落到该数字的下标里
  const dotSet = new Set()
  for (const d of dots) {
    // 取"右边缘落在小数点左边"的最靠右的那个数字。若改成按绝对距离取最近，取景框
    // 稍微偏一点，点就会挂到右邻数字头上，读数凭空多出一位小数——这比读不出更糟。
    let best = -1
    for (let i = 0; i < digits.length; i++) {
      if (digits[i].x + digits[i].w <= d.x0) best = i
    }
    if (best < 0) return fail('小数点位置异常')
    // 点还必须落在紧邻的那个字符格里：离左邻数字超过一个字宽，说明它是别处的噪声
    if (d.x0 - (digits[best].x + digits[best].w) > refW) return fail('小数点位置异常')
    dotSet.add(best)
  }
  const dotIndexes = [...dotSet].sort((a, b) => a - b)
  if (dotIndexes.length > 1) return fail('存在多个小数点')
  if (dotIndexes.length === 1 && dotIndexes[0] === digits.length - 1) return fail('小数点位置异常')

  let text = ''
  for (let i = 0; i < digits.length; i++) {
    text += digits[i].char
    if (dotSet.has(i)) text += '.'
  }
  const value = parseFloat(text)
  if (!Number.isFinite(value)) return fail('字形不完整：读数无法解析')

  const confidence = round6(digits.reduce((a, d) => a + d.confidence, 0) / digits.length)
  const minConfidence = Number.isFinite(+opts.minConfidence) ? +opts.minConfidence : 0
  if (confidence < minConfidence) return fail(`识别置信度不足（${confidence.toFixed(2)}）`)

  return { ok: true, text, value, digits, dotIndexes, confidence, reason: '' }
}

function normalizeUnit(unit) {
  const u = String(unit || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(UNIT_TO_KG, u) ? u : null
}

/**
 * 从原始像素一步到位：二值化 → 读数 → 换算 → 扣皮。
 *
 * 在 readDigits 结果上追加 { unit, unitSource, valueKg, tareApplied }。
 * 单位识别不出来时按 kg 处理——国内档口的电子秤几乎全是 kg，猜错单位会直接
 * 差一个 1000 倍，所以 unitSource 会如实标成 'auto'，让 UI 有机会提示用户确认。
 */
export function readScale(image, region, opts = {}) {
  const bin = binarize(image, region, opts)
  const out = readDigits(bin, { minConfidence: opts.minConfidence })
  const given = normalizeUnit(opts.unit)
  const unit = given || 'kg'
  const unitSource = given ? 'manual' : 'auto'
  const tare = Number.isFinite(+opts.tare) ? +opts.tare : 0

  let valueKg = null
  if (out.ok && Number.isFinite(out.value)) {
    const net = out.value * UNIT_TO_KG[unit] - tare
    // 扣成 0 或负数几乎总是皮重大于货重（或读数本身就错了），当成 0 装箱会直接
    // 产出一份"空车"的合法方案，所以这里只能失败；同时把 value 也抹掉，免得调用
    // 方绕过 ok 直接拿去用。
    if (net > 0) valueKg = round6(net)
    else { out.ok = false; out.value = null; out.reason = '扣皮后重量为零或负数，请重新称重' }
  }

  return { ...out, unit, unitSource, valueKg, tareApplied: tare }
}

/**
 * 多帧取值稳定化：readings 为 [{valueKg, ts}] 数组。
 *
 * 电子秤在货放稳前会一直跳动，取单帧等于取一个随机数。这里要求至少 minFrames
 * 帧有效且最大最小之差不超过 jitter，否则判"秤未稳定"，让上层继续采。
 * 取中位数而非均值：中位数对"某一帧突然跳成别的重量"这种异常值免疫。
 */
export function stabilize(readings, opts = {}) {
  const minFrames = Number.isFinite(+opts.minFrames) ? +opts.minFrames : 3
  const jitter = Number.isFinite(+opts.jitter) ? +opts.jitter : 0.05

  const vals = []
  const list = Array.isArray(readings) ? readings : []
  for (const item of list) {
    const v = item && typeof item === 'object' ? item.valueKg : item
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) vals.push(v)
  }
  const frames = vals.length
  if (frames < minFrames) {
    return { value: null, stable: false, frames, spread: null, reason: `有效帧不足（${frames}/${minFrames}）` }
  }

  const sorted = vals.slice().sort((a, b) => a - b)
  const spread = round6(sorted[sorted.length - 1] - sorted[0])
  const value = round6(median(sorted))
  if (spread > jitter + 1e-9) {
    return { value, stable: false, frames, spread, reason: `秤未稳定（波动 ${spread.toFixed(3)} kg）` }
  }
  return { value, stable: true, frames, spread, reason: '' }
}

/**
 * 校验与单位换算（纯字符串入口，便于外部直接传入 OCR 原始串或手输读数）。
 *
 * 只接受 ^\d{1,5}(\.\d{1,2})?$：磅/千克换算后再除以 10 会让小数位膨胀，
 * 而超过 5 位整数只可能是乱码或误读，一个都不放行。字符串里允许出现单位词，
 * 但只剥离已知单位（kgf/kg/lb/g…），其它字母一律判非法——"12a"若被宽容地
 * 过滤掉字母就会变成合法的 12。
 */
export function parseScaleText(raw, opts = {}) {
  const text = typeof raw === 'string' ? raw : ''
  const pickUnit = (u) => normalizeUnit(u)
  const manual = pickUnit(opts.unit)
  const unitSource = manual ? 'manual' : 'auto'
  const out = { ok: false, valueKg: null, raw: text, unit: manual || 'kg', unitSource }

  // 全角数字/小数点是手机输入法与 OCR 常见输出，统一折半角再校验
  const norm = text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[。．]/g, '.')
    .trim()

  const lower = norm.toLowerCase()
  let unit = manual
  if (/lbs?\b|lb/.test(lower)) unit = 'lb'
  else if (/kgf|kg/.test(lower)) unit = 'kg'
  else if (/g/.test(lower)) unit = 'g'
  unit = unit || 'kg'
  out.unit = unit

  const num = lower
    .replace(/kgs|kgf|lbs|lb|kg|g/g, '')
    .trim()
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(num)) {
    return { ...out, reason: '读数格式非法（只允许数字与一位小数点）' }
  }

  const tare = Number.isFinite(+opts.tare) ? +opts.tare : 0
  const net = parseFloat(num) * UNIT_TO_KG[unit] - tare
  if (!(net > 0)) {
    return { ...out, reason: '扣皮后重量为零或负数，请重新称重' }
  }
  return { ...out, ok: true, valueKg: round6(net), reason: '' }
}