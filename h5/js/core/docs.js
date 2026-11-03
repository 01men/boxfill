/**
 * 单据输出层 —— 把装箱引擎算出的方案渲染成可以直接用的纸质/电子单据。
 *
 * 为什么单独一层、并且强制「纯函数 + 只返回字符串」：
 *   1. 单据是全流程里最不该出错的一环。装柜工人照着装箱单装错一个箱位，
 *      海关扣货、船司甩柜，损失远大于省下的那点代码量。所以这一层只做「翻译」，
 *      不做任何业务判断——数字全部来自引擎，输入什么就印什么。
 *   2. 打印层（H5）关心的是 DOM，Node 测试关心的是字符串。如果单据函数自己
 *      建 DOM，就没法在 `node --test` 里验证。统一返回 HTML 片段后，浏览器里
 *      直接 innerHTML，Node 里直接 assert，两边跑的是同一份代码。
 *   3. 零第三方依赖：这套工具要能单文件发给装卸队/报关行，不能因为打印就
 *      拖进一整个图表库或 PDF 库。俯视图用 inline SVG 而不是 canvas，
 *      是因为 canvas 是位图，缩放和打印都会糊；SVG 是矢量，A4 出来是清晰的。
 *
 * 输入契约（只按这个结构读，不要臆造字段）：
 *   ctx = { plan, orders, skus, customer, settings, generatedAt }
 * 详见各导出函数上方的说明。所有来自数据的文本一律走 `esc()` 转义——
 * 单据是要 innerHTML 的，而品名是业务员自由输入的，不能默认它是干净的。
 */

/* ══════════════════════════════════════════════════════════════════
   一、格式化与转义

   金额/重量/体积的位数是报关行的硬要求，不是审美选择：
   金额 2 位小数（分），重量 1 位，CBM 3 位，毫米取整。
   千分位分隔是为了让装柜工人在纸质单据上不错读位数。
   ══════════════════════════════════════════════════════════════════ */

/** 所有"缺失"字段的统一占位符。单证员看到横杠就知道是没填，不至于当成 0 去算账。 */
const DASH = '—'

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** 判空要区分 0：箱数 0 是有效信息（这一柜没装这个 SKU），不能打成横杠。 */
function isBlank(v) {
  if (v === null || v === undefined || v === '') return true
  if (typeof v === 'number') return !Number.isFinite(v)
  return false
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 文本 + HTML 转义。缺失值落到统一占位符。 */
export function esc(v) {
  if (isBlank(v)) return DASH
  return String(v).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c])
}

/** 不转义的纯文本（用于 CSV 这种非 HTML 载体）。 */
export function text(v) {
  return isBlank(v) ? DASH : String(v)
}

/** 千分位。不用 toLocaleString：不同 Node / 浏览器 locale 的分隔符可能不一致，
 *  单据要和报关行的写法对齐，宁可自己写死规则。 */
function group(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmt(v, digits) {
  const n = num(v)
  if (n === null) return DASH
  const neg = n < 0
  const s = Math.abs(n).toFixed(digits)
  const i = s.slice(0, s.indexOf('.')) === '' ? s : s.split('.')[0]
  const f = s.indexOf('.') >= 0 ? s.slice(s.indexOf('.')) : ''
  return (neg ? '-' : '') + group(i) + f
}

const fmtInt = (v) => fmt(v, 0)
const fmtMm = (v) => fmt(v, 0)
const fmtWeight = (v) => fmt(v, 1)
const fmtCbm = (v) => fmt(v, 3)
const fmtPct = (v) => {
  const n = num(v)
  return n === null ? DASH : fmt(n * 100, 1) + '%'
}
/** 金额：2 位小数 + 千分位。币种可缺省（账单里以列名标注）。 */
const fmtMoney = (v, cur = '') => {
  const n = num(v)
  return n === null ? DASH : cur + fmt(n, 2)
}

/**
 * 日期直接切 ISO 字符串，不 new Date()。
 * 走 Date 会把 'Z' 当成 UTC 再转本地时区，同一份方案在不同时区打开
 * 截关日期会差一天——单证上差一天是要出事的。切字符串保证全球一致。
 */
function fmtDateTime(iso) {
  if (isBlank(iso)) return DASH
  const s = String(iso)
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s)
  if (m) return `${m[1]} ${m[2]}`
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return d ? d[1] : text(iso)
}

const fmtDate = (iso) => {
  if (isBlank(iso)) return DASH
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso))
  return m ? m[1] : text(iso)
}

/** 尺寸 cm：小数最多一位，且去掉无意义的 .0（60 而不是 60.0），
 *  免得同一份单据上有的尺寸带小数有的不带。 */
function fmtCm(v) {
  const n = num(v)
  if (n === null) return DASH
  return String(Math.round(n * 10) / 10)
}

function dimsText(d) {
  if (!d || typeof d !== 'object') return DASH
  const l = fmtCm(d.l)
  const w = fmtCm(d.w)
  const h = fmtCm(d.h)
  if (l === DASH && w === DASH && h === DASH) return DASH
  return `${l}×${w}×${h}`
}

/** 金额相加时统一按分取整，避免 0.1+0.2 那种浮点残渣出现在对账行里。 */
const round2 = (v) => Math.round(v * 100) / 100

/**
 * 把总额平均摊到 N 个柜。
 * 归集后各柜之和必须严格等于总额——单证员是按柜核对的，对不上 0.01 就得
 * 回头找单子。这里把余数全部压到最后一柜，保证求和恒等。
 */
function splitEvenly(total, n) {
  const t = num(total)
  const count = Math.max(1, Math.floor(num(n) || 0))
  if (t === null) return new Array(count).fill(null)
  const each = Math.floor((t / count) * 100) / 100
  const out = new Array(count).fill(each)
  out[count - 1] = round2(out[count - 1] + (t - each * count))
  return out
}

/* ══════════════════════════════════════════════════════════════════
   二、从 ctx 里取数

   所有读取都要容错：引擎的中间态（还没算完、只填了一半柜）也会走到单据层，
   这时候不能抛异常把整个页面炸掉，宁可印一份缺项的单据让人补。
   ══════════════════════════════════════════════════════════════════ */

const EMPTY = Object.freeze({})

function planOf(ctx) { return (ctx && ctx.plan) || EMPTY }
function settingsOf(ctx) { return (ctx && ctx.settings) || EMPTY }
function skusOf(ctx) { return Array.isArray(ctx.skus) ? ctx.skus.filter(Boolean) : [] }

/** 订单：单据只认第一个订单的抬头信息（一个 Plan 对应一个出货批次）。 */
function orderOf(ctx) {
  if (Array.isArray(ctx.orders) && ctx.orders.length) return ctx.orders.find(Boolean) || EMPTY
  return EMPTY
}

function customerOf(ctx) { return (ctx && ctx.customer) || EMPTY }

function skuMap(ctx) {
  const map = new Map()
  for (const s of skusOf(ctx)) {
    if (s.id !== undefined && s.id !== null) map.set(String(s.id), s)
    if (s.code) map.set(String(s.code), s)
  }
  return map
}

function lookupSku(ctx, idOrCode) {
  if (isBlank(idOrCode)) return null
  return skuMap(ctx).get(String(idOrCode)) || null
}

/** 实际柜列表。引擎没给 containers 但给了柜型时，合成一条用于展示，
 *  这样"只算了柜型还没展开"的中间态也能印出抬头。 */
function containersOf(ctx) {
  const p = planOf(ctx)
  const list = Array.isArray(p.containers) ? p.containers.filter(Boolean) : []
  if (list.length) return list
  const c = p.container
  if (c) {
    const n = Math.max(1, Math.floor(num(p.totals && p.totals.containerCount) || 1))
    const out = []
    for (let i = 1; i <= n; i++) out.push({ ...c, index: i, items: [], layers: [] })
    return out
  }
  return []
}

function totalsOf(ctx) { return planOf(ctx).totals || EMPTY }
function billingOf(ctx) { return planOf(ctx).billing || EMPTY }
function violationsOf(ctx) {
  const v = planOf(ctx).violations
  return Array.isArray(v) ? v.filter(Boolean) : []
}

function currency(ctx) {
  const o = orderOf(ctx)
  return isBlank(o.freightCurrency) ? '' : String(o.freightCurrency)
}

/**
 * 单件重量：容器 item 里的 weightKg 是该 item 在本柜的合计重，
 * 但引擎某些路径只填了箱数——那就按 SKU 单重算，两者对不上时以 item 为准
 * （item 是引擎当次算出来的，重算只是兜底）。
 */
function itemWeight(item, sku) {
  const w = num(item && item.weightKg)
  if (w !== null) return w
  const u = num(sku && sku.weightKg)
  const b = num(item && item.boxes)
  return u !== null && b !== null ? u * b : null
}

function itemCbm(item, sku) {
  const c = num(item && item.cbm)
  if (c !== null) return c
  const b = num(item && item.boxes)
  const dims = sku && sku.dimsCm
  if (b !== null && dims && dims.l && dims.w && dims.h) {
    return (b * dims.l * dims.w * dims.h) / 1000000
  }
  return null
}

function itemPieces(item, sku, boxes) {
  const p = num(item && item.pieces)
  if (p !== null) return p
  const per = num(sku && sku.packQty)
  const b = num(boxes)
  return per !== null && b !== null ? per * b : null
}

/**
 * 汇总「本票货」的全部 SKU 行——装箱单和报关单共用的唯一数据源。
 *
 * 为什么从 containers 反推而不是直接打 orders.lines：
 * 装箱单必须反映「实际装了什么」，而 orders.lines 里可能有因为柜装不下
 * 被裁掉的尾数。印出来不一致，等于给报关埋雷。
 * 引擎还没展开柜时（containers 为空）才退回订单行，保证单据不为空。
 */
export function shipmentRows(ctx) {
  const map = new Map()
  const containers = containersOf(ctx)

  for (const c of containers) {
    const items = Array.isArray(c.items) ? c.items : []
    for (const it of items) {
      const key = String(it.skuId !== undefined && it.skuId !== null ? it.skuId : it.code)
      let row = map.get(key)
      if (!row) { row = { skuId: it.skuId, code: it.code, boxes: 0, weightKg: 0, cbm: 0, pieces: 0, noInvert: false, stackTop: 0 }; map.set(key, row) }
      const boxes = num(it.boxes) || 0
      const sku = lookupSku(ctx, key)
      row.boxes += boxes
      row.weightKg += itemWeight(it, sku) || 0
      row.cbm += itemCbm(it, sku) || 0
      const pieces = itemPieces(it, sku, boxes)
      row.pieces += pieces === null ? 0 : pieces
      if (it.noInvert) row.noInvert = true
      const st = num(it.stackTop)
      if (st !== null) row.stackTop = Math.max(row.stackTop, st)
    }
  }

  let list = [...map.values()]
  if (!list.length) {
    const order = orderOf(ctx)
    const lines = Array.isArray(order.lines) ? order.lines : []
    for (const ln of lines) {
      const sku = lookupSku(ctx, ln.skuId)
      const boxes = num(ln.boxes) || 0
      const dims = sku && sku.dimsCm
      list.push({
        skuId: ln.skuId,
        code: (sku && sku.code) || ln.skuId,
        boxes,
        weightKg: (num(sku && sku.weightKg) || 0) * boxes,
        cbm: dims ? (boxes * dims.l * dims.w * dims.h) / 1000000 : 0,
        pieces: itemPieces({ pieces: ln.pieces, boxes }, sku, boxes) || 0,
        noInvert: Boolean(sku && sku.noInvert),
        stackTop: 0,
        _sku: sku,
      })
    }
  }

  return list
    .map((r) => {
      const sku = r._sku || lookupSku(ctx, r.skuId) || lookupSku(ctx, r.code)
      const perBoxCbm = sku && sku.dimsCm ? (sku.dimsCm.l * sku.dimsCm.w * sku.dimsCm.h) / 1000000 : (r.boxes ? r.cbm / r.boxes : null)
      return {
        skuId: r.skuId,
        code: (sku && sku.code) || r.code,
        nameCn: (sku && sku.nameCn) || '',
        nameEn: (sku && sku.nameEn) || '',
        dimsCm: (sku && sku.dimsCm) || null,
        boxes: r.boxes,
        pieces: r.pieces,
        piecesPerBox: sku ? num(sku.packQty) : null,
        grossPerBoxKg: sku ? num(sku.weightKg) : null,
        netPerBoxKg: sku ? num(sku.netWeightKg) : null,
        grossKg: r.weightKg,
        // 净重没填就退到毛重：报关单上"净重"空着会被海关退单，
        // 宁可让单证员事后核，也不要印一个空格让人以为是 0。
        // 守卫必须落在**取值**上而不是条件上：SKU 查不到时 `sku && sku.netWeightKg`
        // 求值为 null，而 num(null) 是 0（不是 null），条件照样成立，
        // 紧接着的 sku.netWeightKg 就把整个单据生成打崩了。
        netKg: sku && num(sku.netWeightKg) !== null ? num(sku.netWeightKg) * r.boxes : r.weightKg,
        cbmPerBox: perBoxCbm,
        cbm: r.cbm,
        noInvert: Boolean(sku && sku.noInvert),
        fragile: Boolean(sku && sku.fragile),
        stackTop: r.stackTop,
        unitValue: num(sku && sku.unitValue),
        supplier: (sku && sku.supplier) || '',
      }
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en'))
}

function sumRows(rows, field) {
  return rows.reduce((a, r) => a + (num(r[field]) || 0), 0)
}

/* ══════════════════════════════════════════════════════════════════
   三、配色与公共片段

   SKU 配色必须稳定：同一个 SKU 在装柜图、俯视图、图例里必须是同一个颜色，
   否则装柜工人对不上"这块是哪个货"。用 SKU 在列表里的序号取色，不用哈希——
   哈希在排序变化时会变色。
   ══════════════════════════════════════════════════════════════════ */

const PALETTE = ['#2f6f9f', '#c1553b', '#3f8f5f', '#a8762c', '#6b4f9e', '#1f7a8c', '#8c3a52', '#5b6b7a']

function skuColor(ctx, idOrCode) {
  const list = shipmentRows(ctx)
  const key = String(idOrCode)
  let i = list.findIndex((r) => String(r.skuId) === key || String(r.code) === key)
  if (i < 0) {
    const all = skusOf(ctx)
    i = all.findIndex((s) => String(s.id) === key || String(s.code) === key)
  }
  if (i < 0) i = 0
  return PALETTE[i % PALETTE.length]
}

/** 元信息格：抬头/页脚那一片「字段名 + 值」。 */
function metaGrid(entries, cls = 'dp-meta') {
  const cells = entries
    .map(([k, v]) => `<div class="dp-meta__i"><span class="dp-meta__k">${esc(k)}</span><span class="dp-meta__v">${esc(v)}</span></div>`)
    .join('')
  return `<div class="${cls}">${cells}</div>`
}

/**
 * 通用表格。
 *   cols: [{head, align:'r', render(row, i)}] —— render 返回已渲染好的 HTML
 *   opts.footCells: 与列一一对应的合计行单元格数组（调用方自己拼，省掉一层间接）
 *
 * 表头用 thead 并在 CSS 里设 table-header-group，避免跨页时表头消失。
 * 合计行单独走 tfoot：打印时 tfoot 会在每页重复，正好当行内小计用。
 */
function table(cols, rows, opts = {}) {
  const cls = ['dp-tbl', opts.cls || ''].filter(Boolean).join(' ')
  const head = cols.map((c) => `<th class="${c.align === 'r' ? 'dp-num' : ''}">${esc(c.head)}</th>`).join('')
  const body = rows.length
    ? rows
        .map((r, i) => {
          const tds = cols
            .map((c) => `<td class="${c.align === 'r' ? 'dp-num' : ''}">${c.render(r, i)}</td>`)
            .join('')
          return `<tr>${tds}</tr>`
        })
        .join('')
    : `<tr><td class="dp-empty" colspan="${cols.length}">${esc(opts.emptyText || '无数据')}</td></tr>`
  const foot = Array.isArray(opts.footCells)
    ? `<tfoot><tr>${opts.footCells
        .map((v, i) => `<td class="${cols[i] && cols[i].align === 'r' ? 'dp-num' : ''}">${v === undefined || v === null ? '' : v}</td>`)
        .join('')}</tr></tfoot>`
    : ''
  return `<table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`
}

/* ══════════════════════════════════════════════════════════════════
   四、装箱单（Packing List）—— 报关用
   ══════════════════════════════════════════════════════════════════ */

const PL_COLS = [
  { head: '#', render: (r, i) => esc(i + 1) },
  { head: '唛头 / SKU', render: (r) => esc(r.code) },
  { head: '品名', render: (r) => esc(r.nameCn) },
  { head: '品名(EN)', render: (r) => esc(r.nameEn) },
  { head: '箱数 CTN', align: 'r', render: (r) => esc(fmtInt(r.boxes)) },
  { head: '件数 PCS', align: 'r', render: (r) => esc(fmtInt(r.pieces)) },
  { head: '单箱毛重kg', align: 'r', render: (r) => esc(fmtWeight(r.grossPerBoxKg)) },
  { head: '毛重合计kg', align: 'r', render: (r) => esc(fmtWeight(r.grossKg)) },
  { head: '单箱净重kg', align: 'r', render: (r) => esc(fmtWeight(r.netPerBoxKg)) },
  { head: '净重合计kg', align: 'r', render: (r) => esc(fmtWeight(r.netKg)) },
  { head: '单箱CBM', align: 'r', render: (r) => esc(fmtCbm(r.cbmPerBox)) },
  { head: 'CBM合计', align: 'r', render: (r) => esc(fmtCbm(r.cbm)) },
  { head: '箱规 cm', render: (r) => esc(dimsText(r.dimsCm)) },
  { head: '目的港', render: (r) => esc(r.port) },
  { head: '船名/航次', render: (r) => esc(r.vessel) },
  { head: '备注', render: (r) => esc(r.remark) },
]

function packingRows(ctx) {
  const order = orderOf(ctx)
  const port = text(order.port)
  const vessel = text(order.vessel)
  return shipmentRows(ctx).map((r) => {
    const notes = []
    if (r.noInvert) notes.push('不可倒置')
    if (r.fragile) notes.push('易碎')
    if (r.stackTop) notes.push(`可堆${fmtInt(r.stackTop)}层`)
    if (r.supplier) notes.push(r.supplier)
    return {
      ...r,
      port,
      vessel,
      remark: notes.join(' / '),
    }
  })
}

/**
 * 装箱单 HTML。
 *
 * 结构刻意做成「抬头 → 明细表 → 合计 → 签字栏」：这是报关行和报关行的模板
 * 看得懂的版式，不做美化——单证要的是能被机器/眼睛快速核对，不是好看。
 */
export function buildPackingList(ctx) {
  const plan = planOf(ctx)
  const order = orderOf(ctx)
  const cust = customerOf(ctx)
  const rows = packingRows(ctx)
  const totals = totalsOf(ctx)

  const gross = sumRows(rows, 'grossKg')
  const net = sumRows(rows, 'netKg')
  const cbm = sumRows(rows, 'cbm')
  const boxes = sumRows(rows, 'boxes')
  const pieces = sumRows(rows, 'pieces')

  const cols = PL_COLS

  const footCells = [
    esc('合计'),
    '',
    '',
    '',
    esc(fmtInt(boxes)),
    esc(fmtInt(pieces)),
    '',
    esc(fmtWeight(gross)),
    '',
    esc(fmtWeight(net)),
    '',
    esc(fmtCbm(cbm)),
    '',
    '',
    '',
    '',
  ]

  const body = rows.length
    ? rows.map((r, i) => `<tr>${cols.map((c, ci) => `<td class="${c.align === 'r' ? 'dp-num' : ''}">${c.render(r, i)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="dp-empty" colspan="${cols.length}">本方案暂无可装货物</td></tr>`

  const meta = metaGrid([
    ['客户', text(cust.name)],
    ['订单号', text(order.code || order.id)],
    ['提单/合同号', text(order.id)],
    ['目的港', text(order.port)],
    ['船名航次', text(order.vessel)],
    ['截关时间', fmtDateTime(order.cutOff)],
    ['交货日期', fmtDate(order.dueDate)],
    ['柜型', text(plan.boxType)],
    ['柜数', esc(fmtInt(totals.containerCount || containersOf(ctx).length))],
  ])

  const remarks = []
  if (isBlank(cust.allowMixed) === false && cust.allowMixed === false) {
    remarks.push(esc(cust.rejectMixedReason || '该客户不接受拼单，本单为整柜直发'))
  }
  if (plan.container && Array.isArray(plan.container.limitSources)) {
    remarks.push(esc(`限重口径：${plan.container.limitSources.join('、')}`))
  }

  return [
    `<section class="dp-doc dp-pl">`,
    `<h2 class="dp-doc__title">装箱单 <span class="dp-doc__en">PACKING LIST</span></h2>`,
    meta,
    `<table class="dp-tbl"><thead><tr>${cols.map((c) => `<th class="${c.align === 'r' ? 'dp-num' : ''}">${esc(c.head)}</th>`).join('')}</tr></thead><tbody>${body}</tbody><tfoot><tr>${footCells
      .map((v, i) => `<td class="${cols[i] && cols[i].align === 'r' ? 'dp-num' : ''}">${v}</td>`)
      .join('')}</tr></tfoot></table>`,
    remarks.length ? `<ul class="dp-notes">${remarks.map((r) => `<li>${r}</li>`).join('')}</ul>` : '',
    `<div class="dp-sign"><span>制单人</span><span>复核</span><span>报关行</span><span>船期</span></div>`,
    `<div class="dp-foot">制单 ${esc(fmtDateTime(ctx.generatedAt))} · 方案号 ${esc(plan.id)}</div>`,
    `</section>`,
  ].join('')
}

/* ══════════════════════════════════════════════════════════════════
   五、装柜清单（Loading Plan）—— 装柜工人照着摆
   ══════════════════════════════════════════════════════════════════ */

/**
 * 装柜清单：按柜 → 按 SKU 汇总（byLayer=true 时再展开到层）。
 * 与装箱单的区别是「视角」：装箱单给海关看（整票），装柜清单给装柜工看（逐柜），
 * 所以这里必须带柜号、装载率、禁倒/易碎标识，而不需要目的港。
 */
export function buildLoadingPlan(ctx, { byLayer = false } = {}) {
  const plan = planOf(ctx)
  const containers = containersOf(ctx)
  const cur = currency(ctx)

  // 空方案也要出一张说得清楚的空单，而不是半张表——半张表会被误当成"没货"。
  const blocks = containers.length
    ? containers.map((c) => {
    const items = Array.isArray(c.items) ? c.items : []
    const rows = items.map((it) => {
      const sku = lookupSku(ctx, it.skuId !== undefined ? it.skuId : it.code)
      return {
        code: (sku && sku.code) || it.code,
        nameCn: (sku && sku.nameCn) || text(it.nameCn),
        boxes: num(it.boxes) || 0,
        pieces: itemPieces(it, sku, num(it.boxes) || 0),
        weightKg: itemWeight(it, sku),
        cbm: itemCbm(it, sku),
        noInvert: Boolean(it.noInvert || (sku && sku.noInvert)),
        fragile: Boolean(sku && sku.fragile),
        stackTop: num(it.stackTop),
      }
    })

    const cols = [
      { head: '#', render: (r, i) => esc(i + 1) },
      { head: 'SKU', render: (r) => `<span class="dp-chip" style="background:${skuColor(ctx, r.code)}"></span>${esc(r.code)}` },
      { head: '品名', render: (r) => esc(r.nameCn) },
      { head: '箱数', align: 'r', render: (r) => esc(fmtInt(r.boxes)) },
      { head: '件数', align: 'r', render: (r) => esc(fmtInt(r.pieces)) },
      { head: '重量kg', align: 'r', render: (r) => esc(fmtWeight(r.weightKg)) },
      { head: '体积CBM', align: 'r', render: (r) => esc(fmtCbm(r.cbm)) },
      { head: '堆码层', align: 'r', render: (r) => esc(r.stackTop === null ? DASH : fmtInt(r.stackTop)) },
      { head: '禁倒', render: (r) => (r.noInvert ? '<b class="dp-warn-t">是</b>' : esc(DASH)) },
      { head: '易碎', render: (r) => (r.fragile ? '<b class="dp-warn-t">是</b>' : esc(DASH)) },
    ]

    const w = num(c.weightKg)
    const info = metaGrid([
      ['柜号', `#${fmtInt(c.index)}`],
      ['柜型', text(c.boxType)],
      ['柜内尺寸 mm', `${fmtMm(c.L)}×${fmtMm(c.W)}×${fmtMm(c.H)}`],
      ['门框 mm', `${fmtMm(c.doorW)}×${fmtMm(c.doorH)}`],
      ['装载体积 CBM', fmtCbm(c.cbm)],
      ['装载重量 kg', fmtWeight(w)],
      ['柜自重 kg', fmtMm(c.tareKg)],
      ['可装上限 kg', fmtMm(c.maxPayloadKg)],
      ['体积利用率', fmtPct(c.utilVol)],
      ['重量利用率', fmtPct(c.utilWeight)],
      ['碎片空间率', fmtPct(c.fragmentsRatio)],
      ['最大可入洞 mm', c.cavity ? `${fmtMm(c.cavity.l)}×${fmtMm(c.cavity.w)}×${fmtMm(c.cavity.h)}` : DASH],
    ], 'dp-meta dp-meta--box')

    const layers = Array.isArray(c.layers) ? c.layers : []
    const layerHtml = byLayer && layers.length
      ? `<div class="dp-layers">${layers
          .map((l) => {
            const boxes = Array.isArray(l.boxes) ? l.boxes : []
            const codes = [...new Set(boxes.map((b) => b.code))]
            return [
              `<div class="dp-layer">`,
              `<div class="dp-layer__hd">第 <b>${fmtInt(l.index)}</b> 层 · 起始高度 ${fmtMm(l.z)} mm · 层高 ${fmtMm(l.h)} mm · ${fmtInt(boxes.length)} 箱 · ${esc(codes.filter(Boolean).join(' + ') || DASH)}</div>`,
              layerTopView(ctx, c, l),
              `</div>`,
            ].join('')
          })
          .join('')}</div>`
      : ''

    return `<article class="dp-container"><h3 class="dp-container__t">第 ${esc(fmtInt(c.index))} 柜 · ${esc(text(c.boxType))}</h3>${info}${table(cols, rows, { emptyText: '该柜暂无货物' })}${layerHtml}</article>`
    })
    : ['<p class="dp-empty">尚未生成装柜方案。</p>']

  const t = totalsOf(ctx)
  const summary = metaGrid([
    ['总箱数', fmtInt(t.boxes)],
    ['总件数', fmtInt(sumRows(shipmentRows(ctx), 'pieces'))],
    ['总重量 kg', fmtWeight(t.weightKg)],
    ['总体积 CBM', fmtCbm(t.cbm)],
    ['体积重 kg', fmtWeight(t.volumetricKg)],
    ['计费重 kg', fmtWeight(t.chargeableKg)],
    ['抛比 kg/CBM', fmtWeight(t.densityKgPerCbm)],
    ['运费(推荐渠道)', fmtMoney(billingOf(ctx).totalCost, cur)],
  ], 'dp-meta dp-meta--sum')

  return [
    `<section class="dp-doc dp-lp">`,
    `<h2 class="dp-doc__title">装柜清单 <span class="dp-doc__en">LOADING PLAN</span></h2>`,
    blocks.join(''),
    `<h3 class="dp-sub">全量汇总</h3>`,
    summary,
    `<div class="dp-foot">共 ${esc(fmtInt(containers.length))} 柜 · 生成于 ${esc(fmtDateTime(ctx.generatedAt))}</div>`,
    `</section>`,
  ].join('')
}

/* ══════════════════════════════════════════════════════════════════
   六、分层俯视图（inline SVG）

   为什么是 SVG 而不是 canvas：canvas 是像素图，A4 出图会糊；
   SVG 是矢量，放大到任何尺寸都清晰，而且可以直接进 innerHTML 打印。
   坐标单位直接用 mm（viewBox），这样"箱子在柜里的绝对位置"和单据上的
   数字一致，不需要再乘一个缩放系数——少一次换算就少一处出错。
   ══════════════════════════════════════════════════════════════════ */

const VIEW_PAD = 300 // mm，画坐标标注和柜门标记的留白
const GRID_STEP = 1000 // mm

function layerTopView(ctx, container, layer) {
  const L = num(container.L) || 1
  const W = num(container.W) || 1
  const boxes = Array.isArray(layer.boxes) ? layer.boxes : []

  const vb = `${-VIEW_PAD} ${-VIEW_PAD} ${L + VIEW_PAD * 2} ${W + VIEW_PAD * 2}`
  const g = []

  // 毫米网格：让人能在图上量尺寸，而不是只看个大概
  for (let x = 0; x <= L; x += GRID_STEP) {
    g.push(`<line x1="${x}" y1="0" x2="${x}" y2="${W}" stroke="#d8dee6" stroke-width="8"/>`)
  }
  for (let y = 0; y <= W; y += GRID_STEP) {
    g.push(`<line x1="0" y1="${y}" x2="${L}" y2="${y}" stroke="#d8dee6" stroke-width="8"/>`)
  }

  // 柜体轮廓
  g.push(`<rect x="0" y="0" width="${L}" height="${W}" fill="none" stroke="#26313d" stroke-width="24"/>`)

  // 箱体
  for (const b of boxes) {
    const x = num(b.x) || 0
    const y = num(b.y) || 0
    const w = num(b.w) || 0
    const h = num(b.h) || 0
    const z = num(b.z) || 0
    const color = skuColor(ctx, b.skuId !== undefined ? b.skuId : b.code)
    g.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.72" stroke="#ffffff" stroke-width="6">` +
        `<title>${esc(text(b.code))} · ${fmtMm(w)}×${fmtMm(h)}mm @z=${fmtMm(z)}</title></rect>`
    )
    // 只在箱子够大时才写字，否则文字会糊成一团反而更看不懂
    const fs = Math.min(w, h) * 0.26
    if (fs > 150) {
      g.push(
        `<text x="${x + w / 2}" y="${y + h / 2}" font-size="${Math.round(fs)}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="monospace">${esc(text(b.code))}</text>`
      )
    }
  }

  // 柜门端标记：柜门在 x = L 侧（约定：x 从柜头内侧起量到柜门内侧）
  g.push(`<line x1="${L}" y1="-60" x2="${L}" y2="${W + 60}" stroke="#c1553b" stroke-width="30" stroke-dasharray="90 60"/>`)
  g.push(`<text x="${L}" y="${-140}" font-size="200" text-anchor="middle" fill="#c1553b" font-family="sans-serif">柜门</text>`)
  g.push(`<text x="0" y="${-140}" font-size="200" text-anchor="end" fill="#55606b" font-family="sans-serif">柜头</text>`)

  // 沿柜长的刻度
  for (let x = 0; x <= L; x += GRID_STEP) {
    g.push(`<text x="${x}" y="${W + 220}" font-size="150" text-anchor="middle" fill="#55606b" font-family="sans-serif">${fmtMm(x)}</text>`)
  }
  g.push(`<text x="${L / 2}" y="${W + 400}" font-size="170" text-anchor="middle" fill="#55606b" font-family="sans-serif">柜长 ${fmtMm(L)} mm</text>`)

  const counts = new Map()
  for (const b of boxes) {
    const k = String(b.code)
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  const legend = [...counts.entries()]
    .map(([code, n]) => {
      const color = skuColor(ctx, code)
      return `<span class="dp-legend__i"><i style="background:${color}"></i>${esc(code)} × ${esc(fmtInt(n))}</span>`
    })
    .join('')

  return [
    `<div class="dp-view">`,
    `<svg class="dp-svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="分层俯视图">`,
    g.join(''),
    `</svg>`,
    `<div class="dp-legend">${legend}</div>`,
    `</div>`,
  ].join('')
}

/* ══════════════════════════════════════════════════════════════════
   七、VGM 申报

   VGM（Verified Gross Mass，核实总重）= 货重 + 柜自重。
   船司只认这一个数，报错了轻则改单重则甩柜。逐柜给出，方便和提单、
   舱单互相核对；总重同时作为返回值供程序提交。
   ══════════════════════════════════════════════════════════════════ */

export function buildVgm(ctx) {
  const plan = planOf(ctx)
  const totals = totalsOf(ctx)
  // 只认引擎真正展开的柜：containersOf() 会为了展示兜底合成柜，
  // 那些合成柜没有重量，拿来算 VGM 就是凭空编数。
  const real = Array.isArray(plan.containers) ? plan.containers.filter(Boolean) : []

  let error = null
  let cargoKg = num(totals.weightKg)

  if (cargoKg === null && real.length) {
    // totals 没收敛就退回逐柜合计——这是同一个数的两种来源，取哪个都比留空强。
    const known = real.filter((c) => num(c.weightKg) !== null)
    if (known.length === real.length) {
      cargoKg = known.reduce((a, c) => a + num(c.weightKg), 0)
    } else if (known.length) {
      // 一半柜有重量：报出来，但不给一个残缺的申报数
      error = `只有 ${fmtInt(known.length)}/${fmtInt(real.length)} 柜有重量数据，无法生成完整 VGM`
    }
  }
  if (cargoKg === null) error = error || '缺少货物重量，无法生成 VGM'

  const rows = real.map((c) => {
    const tare = num(c.tareKg)
    const cargo = num(c.weightKg)
    const vgm = cargo === null || tare === null ? null : cargo + tare
    return { index: c.index, boxType: c.boxType, cargoKg: cargo, tareKg: tare, vgmKg: vgm, maxPayloadKg: num(c.maxPayloadKg) }
  })

  const tareTotal = rows.reduce((a, r) => a + (num(r.tareKg) || 0), 0)
  const vgmTotal = cargoKg === null ? null : cargoKg + tareTotal

  const t = table(
    [
      { head: '柜号', render: (r) => esc(`#${fmtInt(r.index)}`) },
      { head: '柜型', render: (r) => esc(r.boxType) },
      { head: '货物重量 kg', align: 'r', render: (r) => esc(fmtWeight(r.cargoKg)) },
      { head: '柜自重 kg', align: 'r', render: (r) => esc(fmtWeight(r.tareKg)) },
      { head: 'VGM 总重 kg', align: 'r', render: (r) => esc(fmtWeight(r.vgmKg)) },
      { head: '载货上限 kg', align: 'r', render: (r) => esc(fmtWeight(r.maxPayloadKg)) },
    ],
    rows,
    { emptyText: '尚未生成装柜方案' }
  )

  const html = [
    `<section class="dp-doc dp-vgm">`,
    `<h2 class="dp-doc__title">VGM 申报数据 <span class="dp-doc__en">VERIFIED GROSS MASS</span></h2>`,
    metaGrid([
      ['申报方式', '自重法（Method 1：货重 + 柜自重）'],
      ['托盘/木箱自重', '已含在货物毛重内'],
      ['申报柜数', fmtInt(rows.length)],
      ['货物总重 kg', fmtWeight(cargoKg)],
      ['柜自重合计 kg', fmtWeight(tareTotal)],
      ['申报总重 kg', fmtWeight(vgmTotal)],
      ['船名航次', text(orderOf(ctx).vessel)],
      ['截关时间', fmtDateTime(orderOf(ctx).cutOff)],
    ]),
    t,
    error ? `<p class="dp-alert dp-alert--err">${esc(error)}</p>` : `<p class="dp-alert dp-alert--ok">本数据为自重法计算结果，申报前请与实际过磅记录核对。</p>`,
    `</section>`,
  ].join('')

  return { html, vgmKg: vgmTotal, error }
}

/* ══════════════════════════════════════════════════════════════════
   八、配重报告

   为什么要单独出报告：配重是海运事故里最常见的诱因，而它是个「看起来对、
   实际偏」的问题——箱子没出界、重心也没算错，但前后偏 900kg 照样会让
   吊装和驾驶环节出事。所以必须把前后差、左右差、CTU 分布做成可核对的数字。
   ══════════════════════════════════════════════════════════════════ */

/** 前后重量差的告警线（kg）。CTU 对 40 尺柜的前后均衡要求实践中放宽到这个量级。 */
const BALANCE_FRONT_WARN = 800
/** 侧向差告警线（kg）。左右偏太多会让柜体在船上"扭"，装载桥也要调。 */
const BALANCE_SIDE_WARN = 400
/** CTU 前半/前半段载重占比上限（60/50 判定）。超过就是不合规。 */
const CTU_RATIO_LIMIT = 0.6

export function buildBalanceReport(ctx) {
  const plan = planOf(ctx)
  const containers = containersOf(ctx)
  const violations = []

  const rows = containers.map((c) => {
    const b = c.balance || EMPTY
    const dist = Array.isArray(c.distribution) ? c.distribution.filter(Boolean) : []
    let endMaxRatio = num(b.endMaxRatio)
    if (endMaxRatio === null && dist.length) {
      // 没有现成比例就用分段重量自己算一次，取前半/后半中更偏的那一侧。
      const total = dist.reduce((a, d) => a + (num(d.kg) || 0), 0)
      if (total > 0) {
        const half = num(c.L) ? num(c.L) / 2 : null
        let front = 0
        if (half !== null) {
          for (const d of dist) {
            const to = num(d.to) === null ? Infinity : num(d.to)
            if ((num(d.from) || 0) < half) front += (num(d.kg) || 0) * (half - (num(d.from) || 0)) / Math.max(1, to - (num(d.from) || 0))
          }
        }
        const f = front / total
        endMaxRatio = Math.max(f, 1 - f)
      }
    }

    const frontDiff = num(b.frontDiffKg)
    const sideDiff = num(b.sideDiffKg)

    const tag = c.index
    if (frontDiff === null) {
      violations.push({ level: 'warn', code: 'B-04', msg: `第 ${fmtInt(tag)} 柜缺少前后配重数据` })
    } else if (Math.abs(frontDiff) > BALANCE_FRONT_WARN) {
      violations.push({
        level: 'warn',
        code: 'B-01',
        msg: `第 ${fmtInt(tag)} 柜前后配重差 ${fmtWeight(Math.abs(frontDiff))} kg，超过 ${fmtInt(BALANCE_FRONT_WARN)} kg 告警线（柜${frontDiff > 0 ? '头' : '门'}侧偏重）`,
      })
    }
    if (sideDiff === null) {
      violations.push({ level: 'warn', code: 'B-04', msg: `第 ${fmtInt(tag)} 柜缺少左右配重数据` })
    } else if (Math.abs(sideDiff) > BALANCE_SIDE_WARN) {
      violations.push({
        level: 'warn',
        code: 'B-03',
        msg: `第 ${fmtInt(tag)} 柜左右配重差 ${fmtWeight(Math.abs(sideDiff))} kg，超过 ${fmtInt(BALANCE_SIDE_WARN)} kg 告警线`,
      })
    }
    if (endMaxRatio === null) {
      violations.push({ level: 'warn', code: 'B-04', msg: `第 ${fmtInt(tag)} 柜缺少沿柜长重量分布，无法做 CTU 判定` })
    } else if (endMaxRatio > CTU_RATIO_LIMIT) {
      violations.push({
        level: 'warn',
        code: 'B-02',
        msg: `第 ${fmtInt(tag)} 柜 CTU 60/50 判定不通过：偏重段占载重 ${fmtPct(endMaxRatio)}，超过 ${fmtPct(CTU_RATIO_LIMIT)} 上限`,
      })
    }

    return { c, frontDiff, sideDiff, endMaxRatio, dist }
  })

  const passed = violations.length === 0

  const t = table(
    [
      { head: '柜号', render: (r) => esc(`#${fmtInt(r.c.index)}`) },
      { head: '柜型', render: (r) => esc(r.c.boxType) },
      { head: '总重 kg', align: 'r', render: (r) => esc(fmtWeight(r.c.weightKg)) },
      { head: '前后差 kg', align: 'r', render: (r) => esc(fmtWeight(r.frontDiff)) },
      { head: '左右差 kg', align: 'r', render: (r) => esc(fmtWeight(r.sideDiff)) },
      { head: '偏重段占比', align: 'r', render: (r) => esc(fmtPct(r.endMaxRatio)) },
      { head: 'CTU 60/50', render: (r) => (r.endMaxRatio === null ? DASH : r.endMaxRatio > CTU_RATIO_LIMIT ? '<b class="dp-bad">超限</b>' : '<b class="dp-ok">通过</b>') },
      { head: '结论', render: (r) => (r.c.balance && r.c.balance.passed ? '<b class="dp-ok">通过</b>' : '<b class="dp-warn-t">需调整</b>') },
    ],
    rows,
    { emptyText: '尚未生成装柜方案' }
  )

  const charts = rows
    .map((r) => {
      const dist = r.dist
      if (!dist.length) return ''
      const maxKg = Math.max(...dist.map((d) => num(d.kg) || 0), 1)
      const bars = dist
        .map((d) => {
          const kg = num(d.kg) || 0
          const pctH = Math.max(1, Math.round((kg / maxKg) * 100))
          const from = num(d.from)
          const to = num(d.to)
          return `<i style="height:${pctH}%" title="${esc(fmtMm(from))}-${esc(fmtMm(to))}mm · ${esc(fmtWeight(kg))}kg"></i>`
        })
        .join('')
      const labels = dist
        .map((d) => `<span>${esc(fmtInt(num(d.from)))}</span>`)
        .join('')
      return [
        `<div class="dp-dist">`,
        `<div class="dp-dist__t">第 ${esc(fmtInt(r.c.index))} 柜 · 沿柜长 ${esc(fmtInt(dist.length))} 段重量分布（kg）</div>`,
        `<div class="dp-bars">${bars}</div>`,
        `<div class="dp-bars__x">${labels}<span>${esc(fmtMm(num(dist[dist.length - 1].to)))}</span></div>`,
        `</div>`,
      ].join('')
    })
    .join('')

  const html = [
    `<section class="dp-doc dp-bal">`,
    `<h2 class="dp-doc__title">配重报告 <span class="dp-doc__en">WEIGHT DISTRIBUTION</span></h2>`,
    `<p class="dp-note">判定口径：前后配重差 ≤ ${fmtInt(BALANCE_FRONT_WARN)} kg、左右配重差 ≤ ${fmtInt(BALANCE_SIDE_WARN)} kg、偏重段载重占比 ≤ ${fmtPct(CTU_RATIO_LIMIT)}（CTU 60/50 规则）。</p>`,
    t,
    charts,
    passed
      ? `<p class="dp-alert dp-alert--ok">全部柜配重通过，可以安排装柜。</p>`
      : `<div class="dp-vlist">${violations.map((v) => `<p class="dp-alert dp-alert--warn">${esc(`[${v.code}] ${v.msg}`)}</p>`).join('')}</div>`,
    `<div class="dp-foot">方案号 ${esc(plan.id)} · 生成于 ${esc(fmtDateTime(ctx.generatedAt))}</div>`,
    `</section>`,
  ].join('')

  return { html, violations, passed }
}

/* ══════════════════════════════════════════════════════════════════
   九、费用汇总

   费用必须"按柜归集"：一票发好几柜时，客户和货代是按柜对账的，
   只给一个总数对不上钱。所以海运费、THC/BAF 这类按柜发生的费用要摊到柜上。
   ══════════════════════════════════════════════════════════════════ */

/**
 * 附加费是否「按柜计收」。
 *
 * 计费模块只给了总额和备注，没给归集口径，但客户和货代是按柜核账的。
 * 这里按费用名里是否出现「柜 / 码头 / THC / BAF」这类行业固定说法来推断；
 * 推断不出来就留在票级——**宁可少摊也不要摊错**，摊错会让人以为某柜便宜而
 * 改变配货，比不分摊更难发现。
 */
const PER_CONTAINER_HINT = /THC|BAF|码头|港口|滞港|滞箱|柜/

/**
 * 取附加费清单。
 *
 * 优先用计费模块算好的 billing.surcharges——它是唯一做过运费谈判口径的来源。
 * 只有在完全没有计费结果时，才按 settings.costs 现场兜底推一个粗账，
 * 并在单据上标明"估算"，避免被当成正式报价单用。
 */
function surchargeList(ctx) {
  const b = billingOf(ctx)
  if (Array.isArray(b.surcharges) && b.surcharges.length) {
    return {
      estimated: false,
      items: b.surcharges.filter(Boolean).map((s) => ({
        name: text(s.name),
        amount: num(s.amount),
        note: text(s.note),
        perContainer: PER_CONTAINER_HINT.test(text(s.name)),
      })),
    }
  }

  const costs = settingsOf(ctx).costs || EMPTY
  const count = Math.max(1, containersOf(ctx).length)
  const items = []
  const thc = num(costs.thc)
  if (thc !== null && thc !== 0) items.push({ name: 'THC 码头操作费', amount: thc * count, note: `￥${fmt(thc, 0)}/柜 × ${fmtInt(count)}柜`, perContainer: true })
  const doc = num(costs.doc)
  if (doc !== null && doc !== 0) items.push({ name: 'DOC 单证费', amount: doc, note: '按票计收', perContainer: false })
  const baf = num(costs.baf)
  if (baf !== null && baf !== 0) items.push({ name: 'BAF 燃油附加费', amount: baf * count, note: `￥${fmt(baf, 0)}/柜 × ${fmtInt(count)}柜`, perContainer: true })
  return { estimated: true, items }
}

export function buildCostSummary(ctx) {
  const b = billingOf(ctx)
  const cur = currency(ctx)
  const containers = containersOf(ctx)
  const count = Math.max(1, containers.length)
  const costs = settingsOf(ctx).costs || EMPTY

  // 海运费取推荐渠道的报价；没有渠道结果才退回 totalCost 减去附加费。
  const channels = Array.isArray(b.channels) ? b.channels.filter(Boolean) : []
  const recKey = text(b.recommendedChannel)
  const rec = channels.find((c) => String(c.key) === recKey) || channels[0] || null
  let freight = rec ? num(rec.freight) : null
  const sur = surchargeList(ctx)
  const surTotal = sur.items.reduce((a, s) => a + (num(s.amount) || 0), 0)
  if (freight === null) {
    const total = num(b.totalCost)
    freight = total === null ? null : round2(total - surTotal)
  }

  const totalCost = num(b.totalCost) !== null ? num(b.totalCost) : round2((freight || 0) + surTotal)

  const perFreight = splitEvenly(freight, count)

  const itemCols = [
    { head: '费用项', render: (s) => esc(s.name) },
    { head: '金额', align: 'r', render: (s) => esc(fmtMoney(s.amount, cur)) },
    { head: '计收方式', render: (s) => esc(s.perContainer ? '按柜' : '按票') },
    { head: '说明', render: (s) => esc(s.note) },
  ]

  const surTbl = table(itemCols, sur.items, {
    emptyText: '无附加费用',
    footCells: [esc('附加费小计'), esc(fmtMoney(surTotal, cur)), '', ''],
  })

  // 按柜归集：海运费平摊，按柜发生的附加费（THC/BAF）原样落到各柜。
  const perContainerRows = containers.map((c, i) => {
    const items = []
    items.push({ name: '海运费（平摊）', amount: perFreight[i] })
    for (const s of sur.items) {
      if (!s.perContainer) continue
      items.push({ name: s.name, amount: s.amount / Math.max(1, count) })
    }
    const sub = items.reduce((a, s) => a + (num(s.amount) || 0), 0)
    return { index: c.index, boxType: c.boxType, items, sub }
  })

  const perContainerHtml = perContainerRows.length
    ? perContainerRows
        .map((r) =>
          [
            `<div class="dp-costbox">`,
            `<div class="dp-costbox__t">第 ${esc(fmtInt(r.index))} 柜 · ${esc(text(r.boxType))}</div>`,
            table(
              [
                { head: '费用项', render: (s) => esc(s.name) },
                { head: '金额', align: 'r', render: (s) => esc(fmtMoney(s.amount, cur)) },
              ],
              r.items,
              { emptyText: '无分摊费用' }
            ),
            `<div class="dp-costbox__sum">小计 <b>${esc(fmtMoney(r.sub, cur))}</b></div>`,
            `</div>`,
          ].join('')
        )
        .join('')
    : `<p class="dp-empty">尚未生成装柜方案，无法按柜归集费用。</p>`

  const cmpCols = [
    { head: '柜型', render: (r) => esc(r.boxType) },
    { head: '柜数', align: 'r', render: (r) => esc(fmtInt(r.containers)) },
    { head: '装入 CBM', align: 'r', render: (r) => esc(fmtCbm(r.cbm)) },
    { head: '货重 kg', align: 'r', render: (r) => esc(fmtWeight(r.weightKg)) },
    { head: '海运费', align: 'r', render: (r) => esc(fmtMoney(r.freight, cur)) },
    { head: '单方成本', align: 'r', render: (r) => esc(fmtMoney(r.costPerCbm, cur)) },
    { head: '', render: (r) => (String(r.boxType) === String(b.recommendedBoxType) ? '<b class="dp-ok">推荐</b>' : '') },
  ]
  const cmpRows = (Array.isArray(b.boxTypeCompare) ? b.boxTypeCompare.filter(Boolean) : []).map((r) => ({
    boxType: text(r.boxType),
    containers: num(r.containers),
    cbm: num(r.cbm),
    weightKg: num(r.weightKg),
    freight: num(r.freight),
    costPerCbm: num(r.costPerCbm),
  }))

  const chanCols = [
    { head: '计费方式', render: (c) => esc(text(c.name)) },
    { head: '计费重 kg', align: 'r', render: (c) => esc(fmtWeight(c.chargeableKg)) },
    { head: '运费', align: 'r', render: (c) => esc(fmtMoney(c.freight, cur)) },
    { head: '较基准', align: 'r', render: (c) => esc(fmtMoney(c.diffVsBase, cur)) },
    { head: '', render: (c) => (String(c.key) === String(b.recommendedChannel) ? '<b class="dp-ok">推荐</b>' : '') },
  ]

  const html = [
    `<section class="dp-doc dp-cost">`,
    `<h2 class="dp-doc__title">费用汇总 <span class="dp-doc__en">COST SUMMARY</span></h2>`,
    metaGrid([
      ['币种', cur || DASH],
      ['推荐柜型', text(b.recommendedBoxType || planOf(ctx).boxType)],
      ['柜数', fmtInt(count)],
      ['计费重 kg', fmtWeight(billingOf(ctx).channels && rec ? rec.chargeableKg : totalsOf(ctx).chargeableKg)],
      ['海运费', fmtMoney(freight, cur)],
      ['附加费小计', fmtMoney(surTotal, cur)],
      ['总计', fmtMoney(totalCost, cur)],
    ]),
    `<h3 class="dp-sub">计费渠道对比</h3>`,
    table(chanCols, channels.filter(Boolean).map((c) => ({ ...c, key: c.key, name: c.name })), { emptyText: '暂无计费渠道数据' }),
    `<h3 class="dp-sub">附加费${sur.estimated ? '（估算，费率取自本地设置）' : ''}</h3>`,
    surTbl,
    `<h3 class="dp-sub">按柜归集</h3>`,
    perContainerHtml,
    `<h3 class="dp-sub">柜型成本对比</h3>`,
    table(cmpCols, cmpRows, { emptyText: '暂无柜型对比数据' }),
    `<div class="dp-foot">本地费率参考：运费 ${esc(fmtMoney(costs.freightPerCbm, cur))}/CBM、基础运费 ${esc(fmtMoney(costs.baseFreight, cur))}、超长费 ${esc(fmtMoney(costs.oversizeFeePerBox, cur))}/箱</div>`,
    `</section>`,
  ].join('')

  return { html, totalCost }
}

/* ══════════════════════════════════════════════════════════════════
   十、摘要卡 / 拼单建议 / 违规清单 —— 卡片类输出
   ══════════════════════════════════════════════════════════════════ */

/**
 * 方案摘要卡：只回答老板关心的三件事——几个柜、多少钱、还能塞什么。
 * 刻意做得很短：这一段是要放进手机首屏的，信息多一行就没人看了。
 */
export function buildSummaryCard(ctx) {
  const plan = planOf(ctx)
  const totals = totalsOf(ctx)
  const b = billingOf(ctx)
  const cur = currency(ctx)
  const containers = containersOf(ctx)
  const c = plan.container || {}
  const count = Math.max(1, num(totals.containerCount) || containers.length)

  // 「还能塞什么」按已选柜型算剩余：可用容积/可用重量减去已用部分。
  const availCbm = num(c.availCbm) !== null ? num(c.availCbm) : (num(c.theoCbm) || 0) * (num(settingsOf(ctx).availableRatio) || 0.85)
  const leftCbm = availCbm * count - (num(totals.cbm) || 0)
  const leftKg = (num(c.maxPayloadKg) || 0) * count - (num(totals.weightKg) || 0)

  // 可入洞取各柜里体积最大的那个——装柜工关心的是"这一块洞能塞什么"
  let cavity = null
  for (const ct of containers) {
    const cv = ct.cavity
    if (!cv) continue
    const vol = (num(cv.l) || 0) * (num(cv.w) || 0) * (num(cv.h) || 0)
    if (!cavity || vol > cavity.vol) cavity = { cv, vol }
  }
  const util = num(totals.utilVol)
  const nearlyFull = util !== null && util > 0.95
  const remaining = nearlyFull
    ? '本柜型已接近装满，剩余货建议拼入新柜或改走快递/空运'
    : `还可再装约 ${fmtCbm(Math.max(0, leftCbm))} CBM / ${fmtWeight(Math.max(0, leftKg))} kg`

  const html = [
    `<section class="dp-card dp-sum">`,
    `<div class="dp-sum__row"><span class="dp-sum__k">几个柜</span><span class="dp-sum__v"><b>${esc(fmtInt(count))}</b> 柜 · ${esc(text(plan.boxType))} · 装载 ${esc(fmtInt(totals.boxes))} 箱 / ${esc(fmtCbm(totals.cbm))} CBM</span></div>`,
    `<div class="dp-sum__row"><span class="dp-sum__k">多少钱</span><span class="dp-sum__v"><b>${esc(fmtMoney(b.totalCost, cur))}</b> ${esc(cur)} · 计费重 ${esc(fmtWeight(totals.chargeableKg))} kg</span></div>`,
    `<div class="dp-sum__row"><span class="dp-sum__k">还能塞什么</span><span class="dp-sum__v">${esc(remaining)}${cavity ? ` · 最大可入洞 ${esc(fmtMm(cavity.cv.l))}×${esc(fmtMm(cavity.cv.w))}×${esc(fmtMm(cavity.cv.h))} mm` : ''}</span></div>`,
    `<div class="dp-sum__bar" title="体积利用率 ${esc(fmtPct(util))}"><i style="width:${esc(Math.min(100, Math.max(0, (num(util) || 0) * 100)).toFixed(1))}%"></i></div>`,
    `</section>`,
  ].join('')

  return html
}

/**
 * 拼单建议卡。
 *
 * suggestion 的形状由调用方（拼单算法）决定，这里只做防御式渲染：
 * 任何一个字段缺失都只影响那一行的显示，不影响整张卡——
 * 因为拼单算法还在演进，单据层不应该跟着它一起改。
 * 约定支持的字段：
 *   { headline, totalBoxes, addableBoxes, wastedCbm, fillRate,
 *     reasons: [string], nextBoxType, nextContainers,
 *     perContainer: [{ index, boxes, addable, fillRate }] }
 */
export function buildConsolidationCard(ctx, suggestion) {
  const s = suggestion && typeof suggestion === 'object' ? suggestion : EMPTY
  const reasons = Array.isArray(s.reasons) ? s.reasons.filter(Boolean) : []

  const stats = [
    ['可拼入箱数', fmtInt(s.addableBoxes)],
    ['合并后填充率', fmtPct(s.fillRate)],
    ['可省空余体积 CBM', fmtCbm(s.wastedCbm)],
    ['涉及总箱数', fmtInt(s.totalBoxes)],
    ['建议改用柜型', text(s.nextBoxType)],
    ['建议柜数', fmtInt(s.nextContainers)],
  ].filter(([, v]) => v !== DASH)

  const per = Array.isArray(s.perContainer) ? s.perContainer.filter(Boolean) : []
  const perHtml = per.length
    ? table(
        [
          { head: '柜号', render: (r) => esc(`#${fmtInt(r.index)}`) },
          { head: '现有箱数', align: 'r', render: (r) => esc(fmtInt(r.boxes)) },
          { head: '可再拼入', align: 'r', render: (r) => esc(fmtInt(r.addable)) },
          { head: '填充率', align: 'r', render: (r) => esc(fmtPct(r.fillRate)) },
        ],
        per,
        { emptyText: '无分柜数据' }
      )
    : ''

  return [
    `<section class="dp-card dp-cons">`,
    `<h3 class="dp-card__t">拼单建议</h3>`,
    isBlank(s.headline) ? '' : `<p class="dp-card__lead">${esc(s.headline)}</p>`,
    stats.length ? `<div class="dp-chiprow">${stats.map(([k, v]) => `<span class="dp-chipbox"><i>${esc(k)}</i><b>${esc(v)}</b></span>`).join('')}</div>` : '',
    perHtml,
    reasons.length ? `<ul class="dp-notes">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '',
    `</section>`,
  ].join('')
}

/** 违规清单：error 红（挡住出货），warn 琥珀（要人确认）。 */
export function buildViolationList(ctx) {
  const list = violationsOf(ctx)
  const body = list.length
    ? list
        .map(
          (v) =>
            `<li class="dp-viol ${v.level === 'error' ? 'dp-viol--err' : 'dp-viol--warn'}"><span class="dp-viol__code">${esc(text(v.code))}</span><span class="dp-viol__msg">${esc(text(v.msg))}</span></li>`
        )
        .join('')
    : `<li class="dp-viol dp-viol--ok">无违规项，方案可执行。</li>`

  const errs = list.filter((v) => v.level === 'error').length
  return [
    `<section class="dp-card dp-vl">`,
    `<h3 class="dp-card__t">违规清单 <span class="dp-card__n">${esc(fmtInt(list.length))}</span>${errs ? `<span class="dp-viol--err">其中 ${esc(fmtInt(errs))} 项必须处理</span>` : ''}</h3>`,
    `<ul class="dp-viols">${body}</ul>`,
    `</section>`,
  ].join('')
}

/* ══════════════════════════════════════════════════════════════════
   十一、打印包

   一次 window.print() 打出全部单据：A4 横向、每个 section 一个分页、
   固定水印（在浏览器里 position:fixed 打印时会重复到每一页）。
   html 里直接内联 <style>，是为了让调用方"只做 innerHTML"就能打印，
   少一次样式注入顺序的坑；css 同时单独返回，方便页面自己已经有样式表
   的场景复用/覆盖。
   ══════════════════════════════════════════════════════════════════ */

const PRINT_CSS = `
.dp-doc,.dp-card{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2733}
.dp-doc{padding:6mm 0 10mm;page-break-after:always;break-after:page;position:relative}
.dp-doc:last-child{page-break-after:auto;break-after:auto}
.dp-doc__title{margin:0 0 3mm;font-size:19pt;letter-spacing:1px;border-bottom:2px solid #1d2733;padding-bottom:2mm}
.dp-doc__en{font-size:10pt;color:#6b7684;font-weight:400;margin-left:2mm}
.dp-doc__title+.dp-meta{margin-top:3mm}
.dp-sub{margin:5mm 0 2mm;font-size:12pt;border-left:4px solid #2f6f9f;padding-left:2mm}
.dp-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5mm 4mm;margin:2mm 0;font-size:9pt}
.dp-meta--box{grid-template-columns:repeat(4,1fr);background:#f6f8fa;padding:2mm;border-radius:2mm}
.dp-meta--sum{background:#f6f8fa;padding:2mm;border-radius:2mm}
.dp-meta__i{display:flex;gap:2mm;min-width:0}
.dp-meta__k{color:#6b7684;white-space:nowrap}
.dp-meta__v{font-weight:600;overflow-wrap:anywhere}
.dp-tbl{width:100%;border-collapse:collapse;font-size:8.5pt;margin:2mm 0}
.dp-tbl th,.dp-tbl td{border:1px solid #b9c2cc;padding:1.4mm 1.6mm;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.dp-tbl thead{display:table-header-group}
.dp-tbl th{background:#eef2f6;font-weight:700}
.dp-tbl tfoot td{background:#f6f8fa;font-weight:700}
.dp-num{text-align:right;font-variant-numeric:tabular-nums}
.dp-empty{text-align:center;color:#8a94a0;padding:4mm}
.dp-chip{display:inline-block;width:3mm;height:3mm;border-radius:1mm;margin-right:1.2mm;vertical-align:middle}
.dp-ok{color:#1f7a4d}
.dp-warn-t{color:#a8620a}
.dp-bad{color:#b3261e}
.dp-alert{padding:2mm 3mm;border-radius:2mm;font-size:9pt;margin:2mm 0;border:1px solid}
.dp-alert--ok{background:#eef7f1;border-color:#b7dcc5;color:#1f5c38}
.dp-alert--warn{background:#fdf5e6;border-color:#f0d5a0;color:#8a5a06}
.dp-alert--err{background:#fdeeed;border-color:#f2c2be;color:#98251d}
.dp-vlist{margin:2mm 0}
.dp-notes{margin:2mm 0;padding-left:5mm;font-size:8.5pt;color:#4a5560}
.dp-sign{display:flex;justify-content:space-between;gap:8mm;margin-top:8mm;font-size:9pt;color:#4a5560}
.dp-sign span{flex:1;border-top:1px solid #b9c2cc;padding-top:1.5mm}
.dp-foot{margin-top:4mm;font-size:8pt;color:#8a94a0;border-top:1px dashed #cfd6dd;padding-top:1.5mm}
.dp-container{page-break-inside:avoid;break-inside:avoid;margin:4mm 0}
.dp-container__t{margin:3mm 0 1.5mm;font-size:12pt;color:#2f6f9f}
.dp-layers{display:flex;flex-direction:column;gap:4mm;margin-top:3mm}
.dp-layer{page-break-inside:avoid;break-inside:avoid}
.dp-layer__hd{font-size:9pt;margin-bottom:1mm;color:#2b3641}
.dp-view{page-break-inside:avoid;break-inside:avoid}
.dp-svg{width:100%;height:auto;background:#fff;border:1px solid #b9c2cc;border-radius:2mm}
.dp-legend{display:flex;flex-wrap:wrap;gap:3mm;font-size:8.5pt;margin-top:1.5mm;color:#3c4753}
.dp-legend__i{display:inline-flex;align-items:center;gap:1.2mm}
.dp-legend__i i{width:3.4mm;height:3.4mm;border-radius:1mm;display:inline-block}
.dp-dist{margin:4mm 0}
.dp-dist__t{font-size:9pt;color:#3c4753;margin-bottom:1.5mm}
.dp-bars{display:flex;align-items:flex-end;gap:1.5mm;height:34mm;border-bottom:1px solid #6b7684}
.dp-bars i{flex:1;min-height:0.6mm;background:#2f6f9f;display:block}
.dp-bars__x{display:flex;gap:1.5mm;font-size:7pt;color:#8a94a0;margin-top:1mm;font-variant-numeric:tabular-nums}
.dp-costbox{page-break-inside:avoid;break-inside:avoid;margin:3mm 0}
.dp-costbox__t{font-weight:700;margin-bottom:1.5mm}
.dp-costbox__sum{text-align:right;font-size:9pt;padding:1.5mm 2mm;background:#f6f8fa;border:1px solid #b9c2cc;border-top:none}
.dp-sum__row{display:flex;gap:3mm;padding:2mm 0;border-bottom:1px dashed #cfd6dd;font-size:10pt}
.dp-sum__k{flex:0 0 22mm;color:#6b7684}
.dp-sum__v{flex:1}
.dp-sum__bar{height:3mm;background:#e6ebf0;border-radius:2mm;margin-top:2.5mm;overflow:hidden}
.dp-sum__bar i{display:block;height:100%;background:#2f6f9f}
.dp-card__t{margin:0 0 2mm;font-size:12pt}
.dp-card__n{font-size:9pt;color:#6b7684;margin-left:2mm}
.dp-card__lead{margin:0 0 2mm;font-size:10pt}
.dp-chiprow{display:flex;flex-wrap:wrap;gap:2mm}
.dp-chipbox{background:#f0f4f8;border-radius:2mm;padding:1.5mm 2.5mm;font-size:9pt}
.dp-chipbox i{color:#6b7684;font-style:normal;margin-right:1.5mm}
.dp-viols{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1.5mm}
.dp-viol{display:flex;gap:2.5mm;padding:1.6mm 2.5mm;border-radius:2mm;font-size:9pt;border:1px solid}
.dp-viol--err{background:#fdeeed;border-color:#f2c2be;color:#98251d}
.dp-viol--warn{background:#fdf5e6;border-color:#f0d5a0;color:#8a5a06}
.dp-viol--ok{background:#eef7f1;border-color:#b7dcc5;color:#1f5c38}
.dp-viol__code{font-weight:700;flex:0 0 16mm}
.dp-wm{position:fixed;top:44%;left:0;right:0;text-align:center;transform:rotate(-24deg);
  font-size:52pt;color:rgba(47,111,159,.10);letter-spacing:6px;pointer-events:none;z-index:0;font-weight:700}
.dp-qr{width:24mm;height:24mm;border:1px dashed #6b7684;border-radius:1mm;display:flex;align-items:center;
  justify-content:center;font-size:7pt;color:#6b7684;text-align:center;padding:1mm}
.dp-phead{display:flex;justify-content:space-between;align-items:flex-end;gap:6mm;border-bottom:2px solid #1d2733;padding-bottom:2mm;margin-bottom:3mm}
.dp-phead__l{font-size:8.5pt;color:#4a5560}
.dp-phead__t{font-size:16pt;font-weight:700}
@media print{
  @page{size:A4 landscape;margin:10mm}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .dp-doc,.dp-card{page-break-after:always;break-after:page}
  .dp-doc:last-child,.dp-card:last-child{page-break-after:auto;break-after:auto}
}
`

export function buildPrintBundle(ctx, opts = {}) {
  const {
    packingList = true,
    loadingPlan = true,
    byLayer = true,
    vgm = true,
    balance = true,
    cost = true,
    qr = true,
    watermark = true,
  } = opts || {}

  const plan = planOf(ctx)
  const order = orderOf(ctx)
  const cust = customerOf(ctx)
  const totals = totalsOf(ctx)
  const cur = currency(ctx)

  const title = [
    text(order.code || order.id),
    text(cust.name),
    text(plan.boxType),
    `${fmtInt(totals.containerCount || containersOf(ctx).length)}柜`,
  ]
    .filter((s) => s && s !== DASH)
    .join(' · ')

  const wm = watermark
    ? `<div class="dp-wm">利用率 ${esc(fmtPct(totals.utilVol))} · ${esc(fmtPct(totals.utilWeight))}</div>`
    : ''

  const qrBox = qr
    ? `<div class="dp-qr" title="单证二维码占位">二维码<br>${esc(text(plan.id))}</div>`
    : ''

  const head = [
    `<div class="dp-phead">`,
    `<div><div class="dp-phead__t">${esc(title || '装柜单据')}</div>`,
    `<div class="dp-phead__l">客户 ${esc(text(cust.name))} · 订单 ${esc(text(order.code || order.id))} · 目的港 ${esc(text(order.port))} · 船名航次 ${esc(text(order.vessel))} · 截关 ${esc(fmtDateTime(order.cutOff))}</div></div>`,
    qrBox,
    `</div>`,
  ].join('')

  // 每柜分层俯视图：装柜工人靠这个对着摆，缺了等于没打印。
  const views = containersOf(ctx)
    .map((c) => {
      const layers = Array.isArray(c.layers) ? c.layers.filter(Boolean) : []
      if (!layers.length) return ''
      return [
        `<section class="dp-doc dp-views">`,
        `<h2 class="dp-doc__title">装柜图 <span class="dp-doc__en">STOWAGE PLAN</span></h2>`,
        `<h3 class="dp-container__t">第 ${esc(fmtInt(c.index))} 柜 · ${esc(text(c.boxType))} · ${esc(fmtMm(c.L))}×${esc(fmtMm(c.W))}×${esc(fmtMm(c.H))} mm · ${esc(fmtWeight(c.weightKg))} kg · ${esc(fmtCbm(c.cbm))} CBM</h3>`,
        `<div class="dp-layers">${layers.map((l) => `<div class="dp-layer"><div class="dp-layer__hd">第 ${esc(fmtInt(l.index))} 层 · z=${esc(fmtMm(l.z))} mm · 层高 ${esc(fmtMm(l.h))} mm</div>${layerTopView(ctx, c, l)}</div>`).join('')}</div>`,
        `</section>`,
      ].join('')
    })
    .join('')

  // 装柜清单在打印包里一律不带分层图：同一批俯视图后面已经由「装柜图」整节
  // 印一遍了，重复印只是让 A4 多出三页纸，不增加任何信息。
  const sections = []
  if (packingList) sections.push(buildPackingList(ctx))
  if (loadingPlan) sections.push(buildLoadingPlan(ctx, { byLayer: false }))
  if (vgm) sections.push(buildVgm(ctx).html)
  if (balance) sections.push(buildBalanceReport(ctx).html)
  if (cost) sections.push(buildCostSummary(ctx).html)
  if (byLayer) sections.push(views)

  const html = [
    `<style>${PRINT_CSS}</style>`,
    `<div class="dp-print">`,
    wm,
    head,
    sections.join(''),
    `</div>`,
  ].join('')

  return { title: title || '装柜单据', html, css: PRINT_CSS }
}

/* ══════════════════════════════════════════════════════════════════
   十二、CSV

   Excel 友好是硬要求：国内报关行的电脑多半是 Windows + Excel，
   不加 BOM 中文全是乱码；不转义含逗号/引号的字段，整张表会串列。
   ══════════════════════════════════════════════════════════════════ */

const BOM = '\uFEFF'

/** 单个字段转义：含逗号/引号/换行时整体加引号，内部引号翻倍（CSV 双写规则）。 */
function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? String(v) : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * 行 → CSV 文本。
 * 支持二维数组，也支持对象数组（自动用首个对象的键当表头），
 * 因为两种调用姿势在不同模块里都常见，强行只收一种反而更容易出错。
 */
export function toCsv(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r !== undefined && r !== null) : []
  if (!list.length) return BOM
  const isObject = typeof list[0] === 'object' && !Array.isArray(list[0])
  let header = null
  if (isObject) {
    header = Object.keys(list[0])
  }
  const lines = []
  if (header) lines.push(header.map(csvCell).join(','))
  for (const r of list) {
    if (Array.isArray(r)) lines.push(r.map(csvCell).join(','))
    else if (r && typeof r === 'object') lines.push(header.map((k) => csvCell(r[k])).join(','))
    else lines.push(csvCell(r))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/** 装柜清单 CSV：逐柜逐 SKU，正是装柜工在平板上导入的那张表。 */
export function buildLoadingPlanCsv(ctx) {
  const rows = []
  for (const c of containersOf(ctx)) {
    const items = Array.isArray(c.items) ? c.items : []
    if (!items.length) {
      rows.push([c.index, c.boxType, '', '', 0, 0, '', '', '', '', ''])
      continue
    }
    for (const it of items) {
      const sku = lookupSku(ctx, it.skuId !== undefined ? it.skuId : it.code)
      rows.push([
        c.index,
        text(c.boxType),
        text((sku && sku.code) || it.code),
        text((sku && sku.nameCn) || it.nameCn),
        num(it.boxes) || 0,
        itemPieces(it, sku, num(it.boxes) || 0) || 0,
        round2(itemWeight(it, sku) || 0),
        itemCbm(it, sku) === null ? '' : itemCbm(it, sku),
        num(it.stackTop) === null ? '' : num(it.stackTop),
        it.noInvert || (sku && sku.noInvert) ? 'Y' : '',
        sku && sku.fragile ? 'Y' : '',
      ])
    }
  }
  rows.unshift([
    '柜号', '柜型', 'SKU编码', '品名', '箱数', '件数', '重量kg', '体积CBM', '可堆层数', '禁止倒置', '易碎',
  ])
  const totals = totalsOf(ctx)
  rows.push(['合计', '', '', '', num(totals.boxes) || 0, sumRows(shipmentRows(ctx), 'pieces'), round2(num(totals.weightKg) || 0), round3(num(totals.cbm) || 0), '', '', ''])
  return toCsv(rows)
}

const round3 = (v) => Math.round(v * 1000) / 1000

/** 装箱单 CSV：与 HTML 装箱单同源同数据，报关行拿去就能转 EXCEL。 */
export function buildPackingListCsv(ctx) {
  const rows = packingRows(ctx)
  const data = rows.map((r) => [
    r.code,
    text(r.nameCn),
    text(r.nameEn),
    dimsText(r.dimsCm).replace(/×/g, 'x'),
    r.boxes,
    r.pieces,
    r.grossPerBoxKg === null ? '' : round2(r.grossPerBoxKg),
    round2(r.grossKg),
    r.netPerBoxKg === null ? '' : round2(r.netPerBoxKg),
    round2(r.netKg),
    r.cbmPerBox === null ? '' : round3(r.cbmPerBox),
    round3(r.cbm),
    text(r.port),
    text(r.vessel),
    text(r.remark),
  ])
  data.unshift([
    'SKU编码', '品名', '品名(EN)', '箱规cm', '箱数CTN', '件数PCS',
    '单箱毛重kg', '毛重合计kg', '单箱净重kg', '净重合计kg',
    '单箱CBM', 'CBM合计', '目的港', '船名航次', '备注',
  ])
  data.push([
    '合计', '', '', '',
    sumRows(rows, 'boxes'),
    sumRows(rows, 'pieces'),
    '',
    round2(sumRows(rows, 'grossKg')),
    '',
    round2(sumRows(rows, 'netKg')),
    '',
    round3(sumRows(rows, 'cbm')),
    '', '', '',
  ])
  return toCsv(data)
}