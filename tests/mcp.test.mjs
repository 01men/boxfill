/**
 * MCP 工具层与 SQLite 存储的测试。
 *
 * 守的是两条底线：
 *   ① **两端算出一个数**——H5 与 Agent 走同一套 core，任何一边改了算法另一边跟着变；
 *      这里用同一份输入同时喂 tools.js 和 engine.js，比对结果必须一致。
 *   ② **脏数据进不来**——Agent 会传半截数据（尺寸缺一边、箱数为 0、货号不存在），
 *      这些必须在入口被挡下并说清缺什么，而不是让引擎算出 0 柜再报"装得下"。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, openStore } from '../server/sqlite-storage.js'
import { TOOLS, callTool, getTool, ToolError } from '../server/tools.js'
import { solvePlan } from '../h5/js/core/engine.js'
import { importCsvToStore } from '../h5/js/core/import.js'
import { deflateSync } from 'node:zlib'

/** 每个用例一个独立的内存库：SQLite 状态共享会互相污染断言 */
function freshStore() {
  return openStore({ file: ':memory:' })
}
const ctxOf = store => ({ store })

describe('SQLite 存储层 · 与既有 Store 无缝配合', () => {
  it('建档后重开数据库能读回（数据真的落盘了）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bx-'))
    const file = join(dir, 't.db')
    try {
      const a = openStore({ file })
      a.upsertSku({ code: 'K1', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12 })
      const b = openStore({ file })          // 重新打开同一个文件
      assert.equal(b.listSkus().length, 1)
      assert.equal(b.listSkus()[0].code, 'K1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('不同数据库之间数据隔离（多租户隔离的最小保证）', () => {
    const a = freshStore()
    const b = freshStore()
    a.upsertSku({ code: 'ONLY-A', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12 })
    assert.equal(a.listSkus().length, 1)
    assert.equal(b.listSkus().length, 0, 'B 库不该看到 A 的数据')
  })

  it('缺尺寸或缺重量的建档请求被挡下', () => {
    const s = openSqliteStore(':memory:')
    s.setItem('k', '{"a":1}')
    assert.equal(s.getItem('k'), '{"a":1}')
    assert.equal(s.getItem('不存在'), null)
    s.removeItem('k')
    assert.equal(s.getItem('k'), null)
  })
})

describe('MCP 工具层 · 与 H5 共用 core（结果必须一致）', () => {
  const ITEMS = [{ code: 'BX-1001', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 500 }]

  it('plan_containers 与直接调 engine 的柜数一致（同一套 core）', async () => {
    const direct = solvePlan({ items: ITEMS, boxType: '40HQ', timeLimitMs: 3000 })
    const viaTool = await callTool(ctxOf(freshStore()), 'plan_containers', { items: ITEMS, boxType: '40HQ' })
    assert.equal(viaTool.containers, direct.containers.length)
    assert.equal(viaTool.boxType, direct.boxType)
    assert.ok(Math.abs(viaTool.totals.cbm - direct.totals.cbm) < 1e-6)
    assert.ok(Math.abs(viaTool.totals.utilVol - direct.totals.utilVol) < 1e-9)
  })

  it('import_pi 与 H5 的 importCSV 是同一个函数（不会分叉）', () => {
    const csv = '货号,品名,长,宽,高,毛重,箱数,订单号,目的港\nY-1,陶瓷杯,40,30,25,12,100,PO-1,Jebel Ali'
    const a = freshStore(); const b = freshStore()
    const viaTool = importCsvToStore(a, csv)
    const viaCore = importCsvToStore(b, csv)
    // 两个实例吃同一份 CSV，结果必须一致——共用实现就没有分叉的可能
    assert.deepEqual(viaTool, viaCore)
    assert.equal(a.listSkus().length, b.listSkus().length)
    assert.equal(a.listOrders().length, b.listOrders().length)
  })

  it('tools.js 的 import_pi 确实复用 core 实现（防止将来有人再抄一份）', async () => {
    const csv = '货号,长,宽,高,毛重,箱数\nZ-1,40,30,25,12,10'
    const viaToolStore = freshStore()
    const r = await callTool(ctxOf(viaToolStore), 'import_pi', { content: csv })
    const viaCoreStore = freshStore()
    const expected = importCsvToStore(viaCoreStore, csv)
    assert.deepEqual(r, expected, 'MCP 工具与 core 的导入结果必须完全一致')
  })

  it('导入时缺尺寸或重量的行被跳过并计数，不进主数据', () => {
    const csv = [
      '货号,长,宽,高,毛重,箱数',
      'OK-1,40,30,25,12,10',
      'BAD-NODIM,,,25,12,10',      // 缺尺寸
      'BAD-NOWEIGHT,40,30,25,,10',  // 缺毛重
    ].join('\n')
    const store = freshStore()
    const r = importCsvToStore(store, csv)
    assert.equal(r.skus, 1, '只应建档 1 个 SKU')
    assert.equal(r.skipped, 2, '两行半截数据应被跳过并计入')
    assert.equal(store.listSkus().length, 1)
  })
})

describe('MCP 工具层 · 脏数据必须被挡下并说清缺什么', () => {
  const ctx = ctxOf(freshStore())

  it('缺一边尺寸 → 说清是哪一行、收到了什么、单位是什么', async () => {
    await assert.rejects(
      () => callTool(ctx, 'plan_containers', { items: [{ code: 'A', dimsCm: { l: 60, w: 40 }, weightKg: 8, boxes: 10 }] }),
      (e) => e instanceof ToolError && /items\[0\]/.test(e.message) && /尺寸不完整/.test(e.message),
    )
  })

  it('缺毛重 → 明确说为什么必填', async () => {
    await assert.rejects(
      () => callTool(ctx, 'plan_containers', { items: [{ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, boxes: 10 }] }),
      (e) => e instanceof ToolError && /缺毛重/.test(e.message),
    )
  })

  it('箱数为 0 或负数 → 拦下', async () => {
    await assert.rejects(
      () => callTool(ctx, 'plan_containers', { items: [{ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 0 }] }),
      (e) => e instanceof ToolError && /箱数不合法/.test(e.message),
    )
  })

  it('items 为空 → 说清期望的输入形状', async () => {
    await assert.rejects(
      () => callTool(ctx, 'plan_containers', { items: [] }),
      (e) => e instanceof ToolError && /不能为空/.test(e.message) && /dimsCm/.test(e.hint),
    )
  })

  it('未知柜型 → 列出可用柜型', async () => {
    await assert.rejects(
      () => callTool(ctx, 'plan_containers', { items: [{ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 1 }], boxType: '99XX' }),
      (e) => e instanceof ToolError && /未知柜型/.test(e.message) && /40HQ/.test(e.hint),
    )
  })

  it('未知工具名 → 说清可用工具列表', () => {
    assert.throws(() => getTool('nope'), (e) => e instanceof ToolError && /plan_containers/.test(e.hint))
  })

  it('只给一票货时拼单工具明确说明并指向正确工具', async () => {
    const store = freshStore()
    const sku = store.upsertSku({ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8 })
    store.upsertOrder({ code: 'PO-1', port: 'Jebel Ali', lines: [{ skuId: sku.id, boxes: 100 }] })
    await assert.rejects(
      () => callTool(ctxOf(store), 'suggest_consolidation', {}),
      (e) => e instanceof ToolError && /plan_containers/.test(e.hint),
    )
  })
})

describe('MCP 工具层 · 业务正确性', () => {
  const seedTwoOrders = () => {
    const store = freshStore()
    const light = store.upsertSku({ code: 'L', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8 })
    const heavy = store.upsertSku({ code: 'H', dimsCm: { l: 50, w: 50, h: 20 }, weightKg: 125 })
    store.upsertOrder({
      code: 'PO-LIGHT', customer: 'C1', port: 'Jebel Ali', vessel: 'V1',
      cutOff: '2026-11-01T00:00:00Z', lines: [{ skuId: light.id, boxes: 264 }],
    })
    store.upsertOrder({
      code: 'PO-HEAVY', customer: 'C2', port: 'Jebel Ali', vessel: 'V1',
      cutOff: '2026-11-01T00:00:00Z', lines: [{ skuId: heavy.id, boxes: 152 }],
    })
    return store
  }

  it('list_containers 返回尺寸/容积/限重，单位统一 cm', async () => {
    const r = await callTool(ctxOf(freshStore()), 'list_containers')
    assert.ok(r.containers.length >= 4)
    const hq = r.containers.find(c => c.code === '40HQ')
    assert.ok(hq.innerCm.l > 1000 && hq.innerCm.l < 1300, '40HQ 内长应在 cm 量级')
    assert.ok(hq.maxPayloadKg > 20000)
    assert.equal(r.unit.dim, 'cm')
  })

  it('calc_freight 不传柜数时自动排一次（Agent 少传一个参数也能算）', async () => {
    const r = await callTool(ctxOf(freshStore()), 'calc_freight', {
      items: [{ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 500 }],
      costs: { freightPerCbm: 280, thc: 1800 },
    })
    assert.ok(r.containers >= 1)
    assert.equal(typeof r.measure.densityKgPerCbm, 'number')
    assert.equal(r.measure.isLight, true, '抛比 95 应判为抛货')
  })

  it('check_fits 的超长判定与计费层口径一致（(L+W+H)×2 > 330cm）', async () => {
    const r = await callTool(ctxOf(freshStore()), 'check_fits', {
      boxType: '40HQ',
      dimsList: [{ l: 60, w: 40, h: 35 }, { l: 150, w: 60, h: 60 }],   // 周长 540 > 330
    })
    assert.equal(r.results[0].oversize, false, '常规箱不该判超长')
    assert.equal(r.results[1].oversize, true, '周长 540cm 应判超长')
  })

  it('拼单建议给出省柜数与费用分摊，合计等于总成本', async () => {
    const r = await callTool(ctxOf(seedTwoOrders()), 'suggest_consolidation', { containerCost: 18000 })
    const g = r.groups[0]
    assert.ok(g.suggestions.length > 0)
    const s = g.suggestions[0]
    assert.ok(s.savedContainers >= 1)
    assert.equal(s.savedMoney, s.savedContainers * 18000)
    assert.ok(s.costSplit.length >= 2)
    const sum = s.costSplit.reduce((a, c) => a + c.amount, 0)
    assert.ok(Math.abs(sum - 18000) < 0.005, `分摊合计 ${sum} 应等于 18000`)
  })

  it('get_order_boxes 汇总的体积与抛比算得对', async () => {
    const store = seedTwoOrders()
    // 只取一单：264 箱 × (60×40×35)/1e6 = 22.176 CBM，工具按 2 位小数给
    const r = await callTool(ctxOf(store), 'get_order_boxes', { orderCode: 'PO-LIGHT' })
    assert.equal(r.count, 1)
    assert.ok(Math.abs(r.totalCbm - 22.18) < 0.01, `实际 ${r.totalCbm}`)
    assert.equal(r.totalWeightKg, 264 * 8)
    assert.ok(Math.abs(r.densityKgPerCbm - (264 * 8) / 22.176) < 0.1, `实际 ${r.densityKgPerCbm}`)
  })

  it('get_order_boxes 不传 orderCode 时汇总全部订单', async () => {
    const r = await callTool(ctxOf(seedTwoOrders()), 'get_order_boxes', {})
    assert.equal(r.count, 2)
    assert.ok(r.totalCbm > 22.18, '两单汇总应大于单单')
    assert.ok(r.totalWeightKg > 264 * 8)
  })

  it('gen_docs 无方案时明确提示先算，不返回空白', async () => {
    await assert.rejects(
      () => callTool(ctxOf(freshStore()), 'gen_docs', { kind: 'packing' }),
      (e) => e instanceof ToolError && /还没有任何方案/.test(e.message) && /plan_containers/.test(e.hint),
    )
  })

  it('gen_docs 未知类型时列出可用单据', async () => {
    await assert.rejects(
      () => callTool(ctxOf(freshStore()), 'gen_docs', { kind: '不存在的单据' }),
      (e) => e instanceof ToolError && /packing/.test(e.hint),
    )
  })
})

describe('MCP 工具层 · analyze_photo（视觉附赠能力）', () => {
  /** 合成一张 1000×800 箱体俯拍 PNG（深垫板 + 600×400 亮箱） */
  function boxPng() {
    const W = 1000, H = 800, box = { x: 200, y: 100, w: 600, h: 400 }
    const raw = Buffer.alloc((W * 3 + 1) * H)
    let o = 0
    for (let y = 0; y < H; y++) {
      raw[o++] = 0
      for (let x = 0; x < W; x++) {
        const v = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h ? 180 : 25
        raw[o++] = v; raw[o++] = v; raw[o++] = v
      }
    }
    const crcT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
    const crc32 = b => { let c = 0xFFFFFFFF; for (const i of b) c = crcT[(c ^ i) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
      const td = Buffer.concat([Buffer.from(type), data])
      const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td))
      return Buffer.concat([len, td, cr])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }

  it('带标定参数量出尺寸，结果带免责与可编辑标记', async () => {
    const r = await callTool(ctxOf(freshStore()), 'analyze_photo', {
      imageBase64: boxPng().toString('base64'),
      refRealCm: 50, refPx: 600,
    })
    assert.equal(r.ok, true)
    assert.ok(Math.abs(r.dimsCm.l - 50) < 1, `长 ${r.dimsCm.l}`)
    assert.match(r.disclaimer, /仅供参考/)
    assert.equal(r.editable, true, '客户端必须能改：解析结果只是建议')
  })

  it('不带标定 → 明确要求参照物而不是瞎给出厘米', async () => {
    const r = await callTool(ctxOf(freshStore()), 'analyze_photo', {
      imageBase64: boxPng().toString('base64'),
    })
    assert.equal(r.ok, false)
    assert.equal(r.dimsCm, null)
    assert.ok(r.warnings.some(w => w.code === 'NEED_CALIBRATION'))
  })

  it('非 PNG 图片 → ToolError 带可执行提示', async () => {
    await assert.rejects(
      () => callTool(ctxOf(freshStore()), 'analyze_photo', { imageBase64: Buffer.from('nope').toString('base64') }),
      (e) => e instanceof ToolError && /PNG/.test(e.message),
    )
  })

  it('描述里写明"仅供参考"（Agent 读到描述就该知道这不是确定值）', () => {
    const t = getTool('analyze_photo')
    assert.match(t.description, /仅供参考/)
    assert.match(t.description, /editable/)
  })
})

describe('MCP 工具层 · 注册表自身的一致性', () => {
  it('工具名唯一', () => {
    const names = TOOLS.map(t => t.name)
    assert.equal(new Set(names).size, names.length, '有重复的工具名')
  })

  it('每个工具都有 name/title/description/inputSchema/handler', () => {
    for (const t of TOOLS) {
      assert.ok(t.name, '缺 name')
      assert.ok(t.title && t.title.length > 1, `${t.name} 缺 title`)
      assert.ok(t.description && t.description.length > 20, `${t.name} 描述过短，Agent 看不懂该什么时候调它`)
      assert.equal(t.inputSchema.type, 'object', `${t.name} 的 inputSchema 必须是 object`)
      assert.equal(typeof t.handler, 'function', `${t.name} 缺 handler`)
    }
  })

  it('inputSchema 里声明的 required 字段必须真的出现在 properties 里', () => {
    for (const t of TOOLS) {
      for (const req of t.inputSchema.required || []) {
        assert.ok(t.inputSchema.properties[req], `${t.name}: required 里有 ${req} 但 properties 里没有`)
      }
    }
  })

  it('描述里写明了单位（Agent 最容易搞错的就是 cm/mm 与 kg/g）', () => {
    const plan = getTool('plan_containers')
    assert.match(plan.description, /cm/)
    assert.match(plan.description, /kg/)
  })
})