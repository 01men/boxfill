/**
 * 体积重 / 运费测算与拼单规则的测试。
 *
 * 这两个模块的输出直接变成报价单给客户，错了是真金白银的亏损：
 *   · 口径算错 → 运费差几万（PRD 8 的真实案例：全抛 25337 vs 免抛 10854）
 *   · 拼单算错 → 多租一个柜，或者拼了根本装不进去
 * 所以断言重点放在**公式正确**与**单位不混用**，而不是某个具体金额。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { measure, freight, compareBoxTypes, buildBilling, cartonOptimization, CHANNELS } from '../h5/js/core/billing.js'
import { suggestConsolidation, checkHardRules, profileOrder, mergeItems, splitConsolCost } from '../h5/js/core/consolidate.js'

/** 抛货：60×40×35 / 8kg → 抛比 95 kg/CBM */
const LIGHT = { code: 'LIGHT', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 500 }
/** 重货：50×50×20 / 125kg → 抛比 2500 kg/CBM */
const HEAVY = { code: 'HEAVY', dimsCm: { l: 50, w: 50, h: 20 }, weightKg: 125, boxes: 100 }

describe('体积重 · 四个重量', () => {
  it('实重 / 体积重 / CBM / 抛比四个数都对', () => {
    const m = measure([LIGHT], { divisor: 6000 })
    assert.equal(m.boxes, 500)
    assert.equal(m.realKg, 4000, '实重 = 8kg × 500箱')
    assert.ok(Math.abs(m.cbm - 42) < 0.01, `CBM 应为 42，实际 ${m.cbm}`)      // 0.084 m³ × 500
    // 42 CBM × 167 kg/CBM = 7014 kg 体积重，这是海运抛货最典型的账
    assert.ok(Math.abs(m.volumetricKg - 7000) < 1, `体积重应为 7000（42,000,000cm³ ÷ 6000），实际 ${m.volumetricKg}`)
    assert.ok(Math.abs(m.densityKgPerCbm - 95.2) < 0.5, `抛比应约 95.2，实际 ${m.densityKgPerCbm}`)
    assert.equal(m.isLight, true, '抛比 <167 应判为抛货')
    assert.equal(m.chargeableKg, m.volumetricKg, '抛货按体积重计费')
  })

  it('重货按实重计费', () => {
    const m = measure([HEAVY])
    assert.ok(m.densityKgPerCbm > 167)
    assert.equal(m.isLight, false)
    assert.equal(m.chargeableKg, m.realKg, '重货应按实重计费')
  })

  it('÷6000 与 CBM×167 交叉验证一致（PRD C-13）', () => {
    for (const items of [[LIGHT], [HEAVY], [LIGHT, HEAVY]]) {
      const m = measure(items)
      const byCbm = (m.cbm * 1e6 / 6000)
      assert.ok(Math.abs(byCbm - m.volumetricKg) < 1, '两个口径必须一致')
      assert.equal(m.crossOk, true)
    }
  })

  it('空清单不崩', () => {
    const m = measure([])
    assert.equal(m.boxes, 0)
    assert.equal(m.realKg, 0)
    assert.equal(m.isLight, false)
  })

  it('件数按装箱数换算', () => {
    const m = measure([{ ...LIGHT, pieces: 6000 }])
    assert.equal(m.pieces, 6000)
  })
})

describe('运费 · 渠道对照（PRD 8）', () => {
  const costs = { freightPerCbm: 280, freightPerTon: 0, baseFreight: 0, thc: 1800, doc: 300, baf: 0 }

  it('全抛比免抛贵，差额可直接算出', () => {
    const f = freight([LIGHT], { costs, divisor: 6000 })
    const all = f.channels.find(c => c.key === 'all-throw')
    const none = f.channels.find(c => c.key === 'no-throw')
    assert.ok(all.freight > none.freight, '全抛应比免抛贵')
    // 计费方数按计费重折算：全抛 42 方 vs 免抛 24 方，差价正是免抛协议值多少钱
    assert.ok(Math.abs(all.billedCbm - 42) < 0.5, `全抛计费方数应约 42，实际 ${all.billedCbm}`)
    assert.ok(Math.abs(none.billedCbm - 24) < 0.5, `免抛计费方数应约 24，实际 ${none.billedCbm}`)
    assert.ok(Math.abs(none.diffVsBase - (all.freight - none.freight)) < 0.01,
      `免抛差额应等于两口径运费之差 ${all.freight - none.freight}`)
    assert.equal(f.maxDiff, all.freight - none.freight, '最大渠道差额应等于最贵与最便宜之差')
  })

  it('四个渠道口径各自给出计费重', () => {
    const f = freight([LIGHT], { costs, divisor: 6000 })
    const get = k => f.channels.find(c => c.key === k).chargeableKg
    const m = measure([LIGHT])
    assert.ok(Math.abs(get('all-throw') - m.volumetricKg) < 1)
    assert.ok(Math.abs(get('no-throw') - m.realKg) < 1)
    assert.ok(Math.abs(get('half-throw') - (m.realKg + m.volumetricKg) / 2) < 1)
    assert.ok(get('air') > get('all-throw'), '空运 ÷5000 系数更小，体积重更大')
  })

  it('免抛协议下应推荐免抛', () => {
    const f = freight([LIGHT], { costs, divisor: 6000 })
    assert.equal(f.recommendedChannel, 'no-throw')
  })

  it('重货在四个口径下计费重相同（体积重根本压不过实重）', () => {
    const byTon = { freightPerCbm: 0, freightPerTon: 1500, baseFreight: 0 }
    const f = freight([HEAVY], { costs: byTon, divisor: 6000 })
    assert.equal(f.measure.isLight, false)
    const weights = f.channels.filter(c => c.key !== 'half-throw').map(c => c.chargeableKg)
    assert.ok(Math.abs(Math.max(...weights) - Math.min(...weights)) < 1,
      `重货在各口径下计费重应一致，实际 ${weights.join(',')}`)
    // 半抛取均值，计费重必然最低
    const half = f.channels.find(c => c.key === 'half-throw').chargeableKg
    assert.ok(half < weights[0], '半抛口径计费重应最低')
    assert.equal(f.recommendedChannel, 'half-throw')
  })

  it('没有任何单价配置时运费为 0 而不是 NaN', () => {
    const f = freight([LIGHT], { costs: {} })
    for (const c of f.channels) assert.equal(c.freight, 0, `${c.name} 运费应为 0`)
    assert.ok(Number.isFinite(f.maxDiff))
  })
})

describe('箱型比选（PRD 8 / C-23）', () => {
  const costs = { freightPerCbm: 100, thc: 1800, doc: 300 }

  it('抛货优先选 40HQ：40GP 与 40HQ 限重相近但 40HQ 多约 9 CBM（PRD 规则 A）', () => {
    const cmp = compareBoxTypes([{ ...LIGHT, boxes: 900 }], { costs })
    const gp = cmp.rows.find(r => r.boxType === '40GP')
    const hq = cmp.rows.find(r => r.boxType === '40HQ')
    assert.ok(hq.availCbm > gp.availCbm, '40HQ 可用容积应更大')
    assert.ok(Math.abs(gp.maxPayloadKg - hq.maxPayloadKg) < 3000, '40GP 与 40HQ 限重应接近')
    assert.ok(cmp.recommended.boxType === '40HQ' || cmp.recommended.boxType === '45HQ',
      `抛货应推荐 40HQ/45HQ，实际推荐 ${cmp.recommended.boxType}`)
  })

  it('按每 CBM 单价排序，并给出排名', () => {
    const cmp = compareBoxTypes([{ ...LIGHT, boxes: 600 }], { costs })
    const costsPerCbm = cmp.rows.map(r => r.costPerCbm)
    const sorted = costsPerCbm.slice().sort((a, b) => a - b)
    assert.deepEqual(costsPerCbm, sorted, '应按每 CBM 单价升序')
    assert.equal(cmp.rows[0].rank, 1)
    assert.ok(cmp.rows.every(r => r.containers >= 1))
  })

  it('重货不该推荐大柜', () => {
    const cmp = compareBoxTypes([{ ...HEAVY, boxes: 500 }], { costs })
    assert.ok(['20GP', '40GP'].includes(cmp.recommended.boxType), `重货应推荐小柜，实际 ${cmp.recommended.boxType}`)
  })
})

describe('附加费与纸箱优化（PRD 8 / 9.3 / C-10 / C-24）', () => {
  it('周长超 330cm 的箱子收超长附加费', () => {
    const b = buildBilling([{ code: 'LONG', dimsCm: { l: 200, w: 120, h: 120 }, weightKg: 80, boxes: 10 }],
      { costs: { oversizeFeePerBox: 500 } })
    const s = b.surcharges.find(x => x.name === '超长附加费')
    assert.ok(s, '应有超长附加费')
    assert.equal(s.amount, 5000, '10 箱 × ¥500')
    assert.ok(s.note.includes('LONG'))
  })

  it('纸箱改小给出可执行的省运费建议（C-24）', () => {
    const out = cartonOptimization([LIGHT], { freightPerKg: 1.5, divisor: 6000, minSaving: 1 })
    assert.ok(out.length > 0, '应给出改箱建议')
    const o = out[0]
    assert.ok(o.to.l < o.from.l && o.to.w < o.from.w && o.to.h < o.from.h)
    assert.ok(o.volumetricTo < o.volumetricFrom, '改小后体积重应下降')
    assert.ok(o.savedMoney > 0, '应算出省多少钱')
    assert.ok(o.savedKg > 0)
  })

  it('免抛（按实重计费）时改箱省不了运费，不该给出建议', () => {
    // 体积重不参与计费 → 省体积重 = 省 0 块。给这种建议是在浪费老板时间
    const heavyOnly = cartonOptimization([HEAVY], { freightPerKg: 1.5, divisor: 6000, minSaving: 1 })
    const saved = heavyOnly.reduce((s, x) => s + x.savedMoney, 0)
    assert.equal(saved, 0, '按实重计费时纸箱优化不应产生节省')
  })
})

describe('拼单规则（PRD 9）', () => {
  const skuMap = new Map([
    ['sku-l', { id: 'sku-l', code: 'L', nameCn: '抛货', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, packQty: 10, attrs: {} }],
    ['sku-h', { id: 'sku-h', code: 'H', nameCn: '重货', dimsCm: { l: 50, w: 50, h: 20 }, weightKg: 125, packQty: 4, attrs: {} }],
    ['sku-f', { id: 'sku-f', code: 'F', nameCn: '食品', dimsCm: { l: 40, w: 30, h: 30 }, weightKg: 12, packQty: 6, attrs: { food: true } }],
    ['sku-d', { id: 'sku-d', code: 'D', nameCn: '危险品', dimsCm: { l: 40, w: 30, h: 30 }, weightKg: 15, packQty: 6, attrs: { danger: true } }],
  ])

  const order = (o) => ({
    id: o.id, code: o.code, customer: o.customer || 'C1',
    port: o.port || 'Jebel Ali', vessel: o.vessel || 'V1',
    cutOff: o.cutOff || '2026-11-01T00:00:00Z',
    customerAllowMixed: o.allowMixed !== false,
    dueDate: o.dueDate || '2026-10-20',
    lines: o.lines,
  })

  it('目的港不同直接不推荐（C-18）', () => {
    const A = profileOrder(order({ id: 'o1', code: 'A1', port: 'Jebel Ali', lines: [{ skuId: 'sku-l', boxes: 100 }] }), skuMap)
    const B = profileOrder(order({ id: 'o2', code: 'B1', port: 'Hamburg', lines: [{ skuId: 'sku-h', boxes: 50 }] }), skuMap)
    const r = checkHardRules(A, B)
    assert.equal(r.ok, false)
    assert.ok(r.reasons.some(x => x.code === '①' && x.msg.includes('目的港')))
  })

  it('客户拒绝混装时不推荐并说明原因（C-19）', () => {
    const A = profileOrder(order({ id: 'o1', code: 'A1', lines: [{ skuId: 'sku-l', boxes: 100 }] }), skuMap)
    const B = profileOrder(order({ id: 'o2', code: 'B1', customer: 'BrandCo', allowMixed: false, lines: [{ skuId: 'sku-h', boxes: 50 }] }), skuMap)
    const r = checkHardRules(A, B, { rejectReasons: { BrandCo: '品牌商要求独立货柜' } })
    assert.equal(r.ok, false)
    const reason = r.reasons.find(x => x.code === '③')
    assert.ok(reason && reason.msg.includes('BrandCo') && reason.msg.includes('独立货柜'))
  })

  it('危险品与食品禁同柜（C-08 的硬约束版本）', () => {
    const A = profileOrder(order({ id: 'o1', code: 'A1', lines: [{ skuId: 'sku-d', boxes: 20 }] }), skuMap)
    const B = profileOrder(order({ id: 'o2', code: 'B1', lines: [{ skuId: 'sku-f', boxes: 20 }] }), skuMap)
    const r = checkHardRules(A, B)
    assert.equal(r.ok, false)
    assert.ok(r.reasons.some(x => x.code === '④' && x.msg.includes('危险品')))
  })

  it('截关相差超过缓冲天数不推荐（C-21 的硬约束版本）', () => {
    const A = profileOrder(order({ id: 'o1', code: 'A1', cutOff: '2026-11-01T00:00:00Z', lines: [{ skuId: 'sku-l', boxes: 50 }] }), skuMap)
    const B = profileOrder(order({ id: 'o2', code: 'B1', cutOff: '2026-11-10T00:00:00Z', lines: [{ skuId: 'sku-h', boxes: 50 }] }), skuMap)
    assert.equal(checkHardRules(A, B, { bufferDays: 1 }).ok, false)
    assert.equal(checkHardRules(A, B, { bufferDays: 15 }).ok, true, '缓冲期放宽后应可拼')
  })

  it('抛货单 + 重货单推荐同柜，并明确写出省几个柜（C-20）', () => {
    const orders = [
      order({ id: 'o1', code: 'A1', lines: [{ skuId: 'sku-l', boxes: 264 }] }),   // 22.2 CBM / 2.1t
      order({ id: 'o2', code: 'B1', lines: [{ skuId: 'sku-h', boxes: 152 }] }),   // 7.6 CBM / 19t
    ]
    const res = suggestConsolidation(orders, skuMap, { containerCost: 18000, boxType: '40HQ', timeLimitMs: 3000 })
    assert.equal(res.groups.length, 1)
    const g = res.groups[0]
    assert.ok(g.suggestions.length > 0, '应给出拼单建议')
    const s = g.suggestions[0]
    assert.equal(s.orders.length, 2)
    assert.ok(s.savedContainers >= 1, `应至少省 1 个柜，实际省 ${s.savedContainers}`)
    assert.ok(s.savedMoney >= 18000, `应算出省 ¥18000，实际 ${s.savedMoney}`)
    assert.ok(s.notes.some(n => n.code === '⑤'), '应标注密度互补')
    // 合并后 1 个柜同时装下体积与重量：看的是"柜内占用率"，不是相对理论容积的利用率
    assert.equal(s.mergedContainers, 1, '两单合并后应只占 1 个柜')
    assert.ok(s.volumeFillPct > 0.3, `容积占用率 ${(s.volumeFillPct * 100).toFixed(0)}% 偏低`)
    assert.ok(s.weightFillPct > 0.6, `承重占用率 ${(s.weightFillPct * 100).toFixed(0)}% 偏低——重货没吃进来就没意义`)
  })

  it('交期冲突时给出延误提示（C-21）', () => {
    const orders = [
      order({ id: 'o1', code: 'A1', dueDate: '2026-10-12', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
      order({ id: 'o2', code: 'B1', dueDate: '2026-10-20', lines: [{ skuId: 'sku-h', boxes: 152 }] }),
    ]
    const res = suggestConsolidation(orders, skuMap, { containerCost: 18000, boxType: '40HQ' })
    const s = res.groups[0].suggestions[0]
    const note = s.notes.find(n => n.code === '⑥')
    assert.ok(note, '应有交期提示')
    assert.ok(note.msg.includes('延误'), '应写明延误天数')
  })

  it('拼不上的订单给出"差多少 CBM"与三选一（C-22）', () => {
    const orders = [
      order({ id: 'o1', code: 'A1', port: 'Hamburg', lines: [{ skuId: 'sku-l', boxes: 100 }] }),
    ]
    const res = suggestConsolidation(orders, skuMap, { boxType: '40HQ' })
    const solo = res.groups[0].solo[0]
    assert.ok(solo.hint.length > 0)
    assert.ok(solo.hint.includes('CBM') || solo.hint.includes('装不下'))
    assert.equal(solo.options.length, 3, '应给换柜/等下一水/压缩包装三选一')
    assert.ok(solo.remainCbm >= 0 && solo.remainKg >= 0)
  })

  it('同 SKU 在两个订单里合并后箱数累加，属性取并集', () => {
    const A = profileOrder(order({ id: 'o1', code: 'A', lines: [{ skuId: 'sku-l', boxes: 100 }] }), skuMap)
    const B = profileOrder(order({ id: 'o2', code: 'B', lines: [{ skuId: 'sku-l', boxes: 50 }] }), skuMap)
    const merged = mergeItems([A, B])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].boxes, 150)
  })

  it('体积画像（抛比）算对', () => {
    const p = profileOrder(order({ id: 'o', code: 'X', lines: [{ skuId: 'sku-l', boxes: 100 }] }), skuMap)
    assert.ok(Math.abs(p.cbm - 8.4) < 0.01)
    assert.equal(p.weightKg, 800)
    assert.ok(Math.abs(p.density - 95.2) < 0.5)
    assert.equal(p.pieces, 1000, '件数 = 箱数 × 装箱数')
  })

  it('找不到 SKU 的订单行被跳过而不是崩溃', () => {
    const p = profileOrder(order({ id: 'o', code: 'X', lines: [{ skuId: '不存在', boxes: 10 }] }), skuMap)
    assert.equal(p.items.length, 0)
    assert.equal(p.cbm, 0)
  })

  it('单个订单时不该给出拼单建议', () => {
    const res = suggestConsolidation([order({ id: 'o1', code: 'A1', lines: [{ skuId: 'sku-l', boxes: 100 }] })], skuMap, {})
    assert.equal(res.groups[0].suggestions.length, 0)
    assert.equal(res.groups[0].solo.length, 1)
  })
})

describe('拼单 · 分组与多单吸收', () => {
  const skuMap = new Map([
    ['sku-l', { id: 'sku-l', code: 'L', nameCn: '抛货', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, packQty: 10, attrs: {} }],
  ])

  const order = (o) => ({
    id: o.id, code: o.code, customer: o.customer || 'C1',
    port: o.port || 'Jebel Ali', vessel: o.vessel || 'V1',
    cutOff: o.cutOff || '2026-11-01T00:00:00Z',
    customerAllowMixed: o.allowMixed !== false,
    dueDate: o.dueDate || '2026-10-20',
    lines: o.lines,
  })

  it('同港不同船、截关在缓冲期内 → 仍应分到一组给建议', () => {
    // 以前按「港+船」分组，同港换船的两单被永远隔开；船期兼容本该由硬约束②判断
    const orders = [
      order({ id: 'o1', code: 'A1', vessel: 'MAERSK V.1', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
      order({ id: 'o2', code: 'B1', vessel: 'MSC V.2', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
    ]
    const res = suggestConsolidation(orders, skuMap, { boxType: '40HQ', timeLimitMs: 3000 })
    assert.equal(res.groups.length, 1, '同港应只有一组')
    assert.ok(res.groups[0].suggestions.length > 0, '截关相同、仅船名不同，应给出拼单建议')
  })

  it('三张半满的抛货单应吸收进同一个建议（多成员）', () => {
    // 每单 160 箱（13.4 CBM）各自 1 柜，合并 480 箱（40.3 CBM）仍装得下 1 柜 → 省 2 柜
    const orders = [
      order({ id: 'o1', code: 'A1', customer: 'C1', lines: [{ skuId: 'sku-l', boxes: 160 }] }),
      order({ id: 'o2', code: 'B1', customer: 'C2', lines: [{ skuId: 'sku-l', boxes: 160 }] }),
      order({ id: 'o3', code: 'C1b', customer: 'C3', lines: [{ skuId: 'sku-l', boxes: 160 }] }),
    ]
    const res = suggestConsolidation(orders, skuMap, { containerCost: 18000, boxType: '40HQ', timeLimitMs: 5000 })
    const sug = res.groups[0].suggestions[0]
    assert.ok(sug, '应存在拼单建议')
    assert.equal(sug.orders.length, 3, '三单应被吸收进同一个建议')
    assert.ok(sug.savedContainers >= 2, `三单合一柜应省 ≥2 柜，实际 ${sug.savedContainers}`)
    assert.equal(sug.mergedContainers, 1)
    assert.ok(sug.orderIds.length === 3, '建议要带 orderIds 供一键落地')
  })

  it('吸收第三单若不省柜（合并要 2 柜）则不吸收', () => {
    // 每单 264 箱（22.2 CBM）：两单 44.3 CBM 一柜；三单 66.5 CBM > 可用 67 的排布上限多半要 2 柜
    const orders = [
      order({ id: 'o1', code: 'A1', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
      order({ id: 'o2', code: 'B1', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
      order({ id: 'o3', code: 'C1', lines: [{ skuId: 'sku-l', boxes: 264 }] }),
    ]
    const res = suggestConsolidation(orders, skuMap, { boxType: '40HQ', timeLimitMs: 5000 })
    for (const sug of res.groups[0].suggestions) {
      // 若真被吸收成三单，那必须仍然省柜；否则成员应保持 ≤2
      if (sug.orders.length === 3) {
        assert.ok(sug.savedContainers >= 2, '吸收成三单还得多省一个柜，否则不该吸收')
      }
    }
  })
})

describe('拼单 · 费用分摊（splitConsolCost）', () => {
  const m = (code, cbm, t) => ({ order: { id: 'o-' + code, code, customer: code }, cbm, weightKg: t * 1000, items: [] })

  it('抛货按体积分、重货按重量分，金额合计严格等于总成本', () => {
    const rows = splitConsolCost([m('A', 30, 5), m('B', 10, 20)], 18000, { boxType: '40HQ' })
    assert.equal(rows.length, 2)
    const sum = rows.reduce((s, r) => s + r.amount, 0)
    assert.ok(Math.abs(sum - 18000) < 0.005, `分摊合计 ${sum} 应等于 18000`)
    const A = rows.find(r => r.code === 'A'), B = rows.find(r => r.code === 'B')
    assert.equal(A.basis, 'volume', 'A 体积线占用高，按体积分')
    assert.equal(B.basis, 'weight', 'B 承重线占用高，按重量分')
    assert.ok(B.amount > A.amount, '压重量线的成员应付更多')
    assert.ok(A.share > 0 && B.share > 0 && A.share + B.share <= 1.0001)
  })

  it('单边占绝对主导时，主导方承担绝大部分费用', () => {
    const rows = splitConsolCost([m('BIG', 60, 25), m('tiny', 0.5, 0.2)], 20000, { boxType: '40HQ' })
    const big = rows.find(r => r.code === 'BIG')
    assert.ok(big.amount > 19000, `主导方应承担绝大部分，实际 ${big.amount}`)
  })

  it('总成本为 0 时不产生金额（只出装载建议不出钱的口径一致）', () => {
    const rows = splitConsolCost([m('A', 30, 5), m('B', 10, 20)], 0, { boxType: '40HQ' })
    assert.ok(rows.every(r => r.amount === 0))
  })

  it('空成员列表不崩', () => {
    assert.deepEqual(splitConsolCost([], 1000, {}), [])
  })
})
