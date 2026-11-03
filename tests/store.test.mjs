/**
 * 主数据与离线存储测试。
 *
 * 重点在三条会直接导致"装错货 / 算错账 / 查无此人"的地方：
 *   1. 三段匹配认不认得对 SKU（认错比不认代价大得多）
 *   2. 尺寸改版有没有留痕（PRD 验收 C-26：改了要能回溯当时按哪个尺寸算的）
 *   3. 断网时能不能存住（PRD 验收 V-07）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Store, parseCSV, toCSV, mapRow } from '../h5/js/core/store.js'

function newStore() {
  let t = 1700000000000
  const mem = new Map()
  return new Store({
    storage: {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k),
    },
    now: () => { t += 1000; return t },
    online: true,
  })
}

const BOX = { code: 'YW-1001', nameCn: '陶瓷杯', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12, packQty: 6 }

describe('Store · SKU 主数据', () => {
  it('建档后尺寸按长≥宽≥高归一，且尺寸被转置视为同一箱', () => {
    const s = newStore()
    const sku = s.upsertSku({ ...BOX, dimsCm: { l: 25, w: 40, h: 30 } })
    assert.deepEqual(sku.dimsCm, { l: 40, w: 30, h: 25 })
    assert.equal(sku.version, 1)
    assert.equal(sku.dimsHistory.length, 1)
  })

  it('改尺寸会留版本，历史版本可回溯（PRD C-26）', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    s.upsertSku({ id: sku.id, ...BOX, dimsCm: { l: 45, w: 32, h: 26 }, changeReason: '改包装' })
    const after = s.getSku(sku.id)
    assert.equal(after.version, 2)
    assert.equal(after.dimsHistory.length, 2)
    assert.equal(after.dimsHistory[1].reason, '改包装')
    assert.deepEqual(after.dimsHistory[0].dimsCm, { l: 40, w: 30, h: 25 }, '旧尺寸版本必须保留')
    assert.deepEqual(after.dimsHistory[1].dimsCm, { l: 45, w: 32, h: 26 })
  })

  it('没改尺寸与重量就不产生新版本', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    s.upsertSku({ id: sku.id, ...BOX, nameCn: '陶瓷杯（改品名）' })
    assert.equal(s.getSku(sku.id).version, 1, '只改品名不该升版本')
    assert.equal(s.getSku(sku.id).dimsHistory.length, 1)
  })

  it('易碎标记会同时写进 attrs，供引擎的混装规则用', () => {
    const s = newStore()
    const sku = s.upsertSku({ ...BOX, code: 'F-1', fragile: true, attrs: { liquid: true } })
    assert.equal(sku.attrs.fragile, true)
    assert.equal(sku.attrs.liquid, true)
    assert.equal(sku.attrs.general, false, '有属性就不该再标普货')
  })
})

describe('Store · 三段匹配（PRD 4.4）', () => {
  it('条码精确匹配置信度为 1', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    const r = s.matchSku({ code: 'YW-1001', dimsCm: { l: 999, w: 999, h: 999 } })
    assert.equal(r.sku.id, sku.id)
    assert.equal(r.method, 'barcode')
    assert.equal(r.confidence, 1)
  })

  it('条码支持供应商别名', () => {
    const s = newStore()
    s.upsertSku({ ...BOX, aliases: ['SUP-A9'] })
    assert.ok(s.matchSku({ code: 'sup-a9' }).sku)
  })

  it('尺寸+重量模糊匹配能认出来，但置信度不给满', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    const r = s.matchSku({ dimsCm: { l: 41, w: 30, h: 25 }, weightKg: 12.2 })
    assert.equal(r.sku.id, sku.id)
    assert.equal(r.method, 'fuzzy')
    assert.ok(r.confidence > 0.6 && r.confidence < 1, `置信度 ${r.confidence} 不应给满`)
  })

  it('尺寸差太多时宁可不认（PRD：绝不静默存错）', () => {
    const s = newStore()
    s.upsertSku(BOX)
    const r = s.matchSku({ dimsCm: { l: 80, w: 60, h: 50 }, weightKg: 30 })
    assert.equal(r.sku, null)
    assert.equal(r.method, 'none', '认不出时 method=none，UI 应弹新 SKU 卡片')
  })

  it('认错 SKU 的代价高于多问一次：候选最多给 3 个让人选', () => {
    const s = newStore()
    for (let i = 0; i < 6; i++) s.upsertSku({ ...BOX, code: `C${i}`, dimsCm: { l: 40 + i * 0.4, w: 30, h: 25 }, weightKg: 12 })
    const r = s.matchSku({ dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12 })
    assert.ok(r.candidates.length <= 3)
  })
})

describe('Store · 合理性校验（PRD 4.2.2 / 验收 V-01、V-05）', () => {
  const seedHistory = (s, skuId, n, w) => {
    for (let i = 0; i < n; i++) s.recordMeasurement(skuId, { weightKg: w, dimsCm: BOX.dimsCm })
  }

  it('无历史时不做判定（首次采集不该被拦）', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    assert.equal(s.checkWeightDeviation(sku.id, 999).level, 'ok')
  })

  it('±30% 以内通过，±30% 标红，±80% 拒绝', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    seedHistory(s, sku.id, 5, 10)
    assert.equal(s.checkWeightDeviation(sku.id, 11).level, 'ok')
    assert.equal(s.checkWeightDeviation(sku.id, 12.9).level, 'ok')
    assert.equal(s.checkWeightDeviation(sku.id, 13.5).level, 'warn')
    assert.equal(s.checkWeightDeviation(sku.id, 6.5).level, 'warn')   // -35%
    assert.equal(s.checkWeightDeviation(sku.id, 19).level, 'reject')
    assert.equal(s.checkWeightDeviation(sku.id, 1).level, 'reject')
  })

  it('尺寸突变超过 15% 提示改包装（PRD 3）', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    assert.equal(s.checkDimensionJump(sku.id, { l: 42, w: 30, h: 25 }).level, 'ok')
    const jump = s.checkDimensionJump(sku.id, { l: 47, w: 30, h: 25 })
    assert.equal(jump.level, 'warn')
    assert.ok(jump.reason.includes('包装'))
    assert.ok(jump.pct > 0.15)
  })

  it('采集记录只留最近 20 条', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    for (let i = 0; i < 30; i++) s.recordMeasurement(sku.id, { weightKg: 10, dimsCm: BOX.dimsCm })
    assert.equal(s.getSku(sku.id).measurements.length, 20)
  })
})

describe('Store · 方案快照与审计（PRD 验收 C-26）', () => {
  it('历史方案回溯时能看到当时的尺寸，并与现在的主数据对比', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    const plan = {
      id: 'p1', boxType: '40HQ', createdAt: new Date().toISOString(),
      container: { code: '40HQ' }, totals: { boxes: 10 },
    }
    s.savePlan(plan, {
      items: [{ skuId: sku.id, code: sku.code, dimsCm: sku.dimsCm, weightKg: sku.weightKg, boxes: 10 }],
      settings: { volumeDivisor: 6000 },
    })

    // 三个月后客户改了包装
    s.upsertSku({ id: sku.id, ...BOX, dimsCm: { l: 45, w: 32, h: 26 }, changeReason: '改包装' })

    const diff = s.diffPlanAgainstCurrent('p1')
    assert.equal(diff.length, 1)
    assert.equal(diff[0].status, 'changed')
    assert.deepEqual(diff[0].then.dimsCm, { l: 40, w: 30, h: 25 }, '必须能读到当时的尺寸')
    assert.deepEqual(diff[0].now.dimsCm, { l: 45, w: 32, h: 26 })
    assert.equal(s.getPlan('p1').snapshot.skus[0].version, 1, '快照应记下当时的版本号')
  })

  it('主数据没变时回溯状态为 same', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    s.savePlan({ id: 'p2', totals: {} }, { items: [{ skuId: sku.id, code: sku.code, dimsCm: sku.dimsCm, weightKg: 12, boxes: 1 }] })
    assert.equal(s.diffPlanAgainstCurrent('p2')[0].status, 'same')
  })

  it('SKU 被删除后回溯标记 missing，而不是崩溃', () => {
    const s = newStore()
    const sku = s.upsertSku(BOX)
    s.savePlan({ id: 'p3', totals: {} }, { items: [{ skuId: sku.id, code: sku.code, dimsCm: sku.dimsCm, weightKg: 12, boxes: 1 }] })
    s.deleteSku(sku.id)
    assert.equal(s.diffPlanAgainstCurrent('p3')[0].status, 'missing')
  })

  it('方案历史最多留 50 份，避免撑爆 localStorage', () => {
    const s = newStore()
    for (let i = 0; i < 60; i++) s.savePlan({ id: `p${i}`, totals: {} }, { items: [] })
    assert.equal(s.listPlans().length, 50)
  })
})

describe('Store · 离线（PRD 4.5 / 验收 V-07）', () => {
  it('断网时写入照常成功，并进入待同步队列', () => {
    const s = newStore()
    s.setOnline(false)
    assert.equal(s.isOnline(), false)
    const sku = s.upsertSku(BOX)
    assert.ok(s.getSku(sku.id), '断网也必须能存住')
    assert.equal(s.enqueue({ type: 'sku.upsert', id: sku.id }), 1)
    assert.equal(s.pendingCount(), 1)
  })

  it('联网后 flush 清空队列，且能把操作发给后端', () => {
    const s = newStore()
    s.setOnline(false)
    s.upsertSku(BOX)
    s.enqueue({ type: 'sku.upsert' })
    const flushed = s.setOnline(true)
    assert.equal(flushed, 1, '恢复联网应同步掉 1 条')
    assert.equal(s.pendingCount(), 0)
  })

  it('flush 可把队列交给发送函数', async () => {
    const s = newStore()
    s.enqueue({ type: 'a' }); s.enqueue({ type: 'b' })
    const ops = s.db.pending.slice()
    const n = await s.flush(o => { ops.push(...o) })
    assert.equal(n, 2)
    assert.equal(s.pendingCount(), 0)
  })

  it('存储被禁时不崩，退回内存存储', () => {
    const s = new Store({ storage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() {} } })
    s.upsertSku(BOX)
    assert.equal(s.listSkus().length, 1)
  })

  it('数据版本不符时先备份再重置，不做破坏性迁移', () => {
    const mem = new Map()
    mem.set('ybx.store.v2', JSON.stringify({ schemaVersion: 1, skus: [{ id: 'old' }] }))
    const s = new Store({ storage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) } })
    assert.equal(s.listSkus().length, 0)
    assert.ok([...mem.keys()].some(k => k.includes('.bak.')), '旧数据应留档')
  })
})

describe('Store · CSV 导入（PRD 15：P0 先支持 Excel/CSV）', () => {
  it('解析带引号、逗号与换行的字段', () => {
    const rows = parseCSV('a,b,c\n1,"x,y","he said ""hi"""\n2,z,"multi\nline"')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].b, 'x,y')
    assert.equal(rows[0].c, 'he said "hi"')
    assert.equal(rows[1].c, 'multi\nline')
  })

  it('解析 Excel 导出的 BOM 与 CRLF', () => {
    const rows = parseCSV('﻿货号,箱数\r\nA1,10\r\nA2,20\r\n')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]['货号'], 'A1')
    assert.equal(rows[1]['箱数'], '20')
  })

  it('把中文列名映射成内部字段', () => {
    const rows = parseCSV('货号,品名,长,宽,高,毛重,箱数,装箱数(件/箱),目的港\nYW-1,陶瓷杯,40,30,25,12,100,6,Jebel Ali')
    const m = mapRow(rows[0])
    assert.equal(m.sku, 'YW-1')
    assert.equal(m.nameCn, '陶瓷杯')
    assert.deepEqual(m.dimsCm, { l: 40, w: 30, h: 25 })
    assert.equal(m.weightKg, 12)
    assert.equal(m.boxes, 100)
    assert.equal(m.port, 'Jebel Ali')
  })

  it('认不出的列原样保留在 raw 里，不丢信息', () => {
    const rows = parseCSV('货号,箱数,客户备注\nA,10,急单')
    assert.equal(mapRow(rows[0]).raw['客户备注'], '急单')
  })

  it('写出的 CSV 带 BOM，Excel 打开不乱码', () => {
    const csv = toCSV([{ 货号: 'YW-1', 品名: '杯' }])
    assert.ok(csv.startsWith('﻿'))
    assert.ok(csv.includes('\r\n'))
    assert.ok(parseCSV(csv)[0]['品名'] === '杯')
  })

  it('写出的 CSV 对含逗号与引号的字段做转义', () => {
    const csv = toCSV([{ a: 'x,y', b: 'he said "hi"' }])
    const back = parseCSV(csv)[0]
    assert.equal(back.a, 'x,y')
    assert.equal(back.b, 'he said "hi"')
  })

  it('导出再导入后数据不变（去重合并）', () => {
    const s = newStore()
    s.upsertSku(BOX)
    s.upsertSku({ ...BOX, code: 'YW-1002', dimsCm: { l: 50, w: 40, h: 30 } })
    const json = s.exportJSON()
    const s2 = newStore()
    const r = s2.importJSON(json)
    assert.equal(r.skus, 2)
    assert.equal(s2.listSkus().length, 2)
  })

  it('导入版本不符的数据被拒绝，不破坏现有主数据', () => {
    const s = newStore()
    s.upsertSku(BOX)
    assert.throws(() => s.importJSON(JSON.stringify({ schemaVersion: 999, skus: [] })))
    assert.equal(s.listSkus().length, 1, '拒绝导入后原有数据必须完好')
  })
})

describe('Store · 订单与客户', () => {
  it('订单行箱数为 0 的会被剔除', () => {
    const s = newStore()
    const o = s.upsertOrder({ code: 'PO1', lines: [{ skuId: 'a', boxes: 10 }, { skuId: 'b', boxes: 0 }] })
    assert.equal(o.lines.length, 1)
  })

  it('拒混装客户的原因能被拼单引擎读到', () => {
    const s = newStore()
    s.upsertCustomer({ name: 'BrandCo', allowMixed: false, rejectMixedReason: '品牌商要求独立货柜' })
    assert.deepEqual(s.rejectMixedReasons(), { BrandCo: '品牌商要求独立货柜' })
  })
})
