/**
 * 单据输出层（h5/js/core/docs.js）的测试。
 *
 * 和装箱内核测试的思路一样：这一层不测"算得对不对"（那是引擎的事），
 * 而测「引擎给的数有没有原样落到纸上」——单据一旦和方案对不上，
 * 报关会被退、货代会对不上账、装柜工照着摆会摆错，三种后果都比算错更贵。
 *
 * 所以断言方式刻意避开"看起来有输出就算过"，而是把 HTML 里的表格单元格
 * 抠出来，跟输入逐个字段比对；CSV 则逐行、逐字段（含 BOM 和转义）比对。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPackingList,
  buildLoadingPlan,
  buildVgm,
  buildBalanceReport,
  buildCostSummary,
  buildSummaryCard,
  buildConsolidationCard,
  buildViolationList,
  buildPrintBundle,
  toCsv,
  buildLoadingPlanCsv,
  buildPackingListCsv,
  shipmentRows,
} from '../h5/js/core/docs.js'

/* ─────────────────────────── 假 ctx ─────────────────────────── */

const SKU_A = {
  id: 'A',
  code: 'SKU-A',
  nameCn: '陶瓷马克杯',
  nameEn: 'Ceramic Mug',
  dimsCm: { l: 60, w: 40, h: 35 },
  weightKg: 12.5,
  packQty: 12,
  pieces: 1680,
  netWeightKg: 11.8,
  noInvert: true,
  fragile: true,
  unitValue: 45,
  supplier: '义乌A厂',
}

// 体积 0.084 CBM/箱（60×40×35 cm）
const CBM_A = (60 * 40 * 35) / 1e6
// 体积 0.039375 CBM/箱（45×35×25 cm）
const CBM_B = (45 * 35 * 25) / 1e6

const SKU_B = {
  id: 'B',
  code: 'SKU-B',
  nameCn: '竹制餐垫',
  nameEn: 'Bamboo Placemat',
  dimsCm: { l: 45, w: 35, h: 25 },
  weightKg: 8.2,
  packQty: 20,
  pieces: 2200,
  netWeightKg: 7.9,
  noInvert: false,
  fragile: false,
  unitValue: 8,
  supplier: '义乌B厂',
}

const BOX_40HQ = {
  code: '40HQ',
  nameCn: '40高柜',
  L: 12032,
  W: 2352,
  H: 2698,
  doorW: 2340,
  doorH: 2585,
  theoCbm: 76.0,
  availCbm: 64.6,
  tareKg: 3970,
  maxPayloadKg: 26500,
  limitSources: ['箱型上限', '船司限重'],
}

/**
 * 在柜底平面里铺一个矩形阵列，用于造出真实坐标的分层数据。
 * 单据层不校验坐标合法性，但它要画图——图得画得出来，所以夹具得先站得住。
 */
function grid(skuId, code, x0, y0, fw, fh, cols, rows, take) {
  const out = []
  for (let r = 0; r < rows && out.length < take; r++) {
    for (let c = 0; c < cols && out.length < take; c++) {
      out.push({ x: x0 + c * fw, y: y0 + r * fh, w: fw, h: fh, skuId, code })
    }
  }
  return out
}

/** 沿柜长切 10 段的重量分布，段宽固定，重量凑到给定总和。 */
function distribution(L, weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  const step = L / weights.length
  return weights.map((kg, i) => ({
    from: Math.round(i * step),
    to: Math.round((i + 1) * step),
    kg,
    total,
  }))
}

function makeCtx(over = {}) {
  const c1Layers = [
    {
      index: 1,
      z: 0,
      h: 350,
      boxes: [
        ...grid('A', 'SKU-A', 0, 0, 600, 400, 16, 5, 80),
        ...grid('B', 'SKU-B', 9600, 0, 450, 350, 4, 5, 20),
      ],
    },
    {
      index: 2,
      z: 350,
      h: 350,
      boxes: [
        ...grid('A', 'SKU-A', 0, 0, 600, 400, 4, 5, 20),
        ...grid('B', 'SKU-B', 2400, 0, 450, 350, 15, 3, 40),
      ],
    },
  ]

  const c2Layers = [
    {
      index: 1,
      z: 0,
      h: 350,
      boxes: [
        ...grid('A', 'SKU-A', 0, 0, 600, 400, 8, 5, 40),
        ...grid('B', 'SKU-B', 4800, 0, 450, 350, 16, 4, 50),
      ],
    },
  ]

  const c1 = {
    index: 1,
    boxType: '40HQ',
    ...pick(BOX_40HQ),
    items: [
      { skuId: 'A', code: 'SKU-A', boxes: 100, weightKg: 1250, cbm: 100 * CBM_A, pieces: 1200, noInvert: true, stackTop: 3 },
      { skuId: 'B', code: 'SKU-B', boxes: 60, weightKg: 492, cbm: 60 * CBM_B, pieces: 1200, noInvert: false, stackTop: 2 },
    ],
    layers: c1Layers,
    freeRects: [{ x: 9600, y: 1750, w: 2400, h: 602 }],
    cavity: { l: 1200, w: 1000, h: 1300 },
    fragmentsRatio: 0.08,
    weightKg: 1742,
    cbm: 100 * CBM_A + 60 * CBM_B,
    utilVol: 0.83,
    utilWeight: 0.62,
    distribution: distribution(BOX_40HQ.L, [220, 210, 200, 190, 180, 170, 160, 150, 145, 117]),
    // 前后差 950kg：故意超过 800kg 告警线
    balance: { frontDiffKg: 950, sideDiffKg: 120, endMaxRatio: 0.58, passed: false },
  }

  const c2 = {
    index: 2,
    boxType: '40HQ',
    ...pick(BOX_40HQ),
    items: [
      { skuId: 'A', code: 'SKU-A', boxes: 40, weightKg: 500, cbm: 40 * CBM_A, pieces: 480, noInvert: true, stackTop: 3 },
      { skuId: 'B', code: 'SKU-B', boxes: 50, weightKg: 410, cbm: 50 * CBM_B, pieces: 1000, noInvert: false, stackTop: 2 },
    ],
    layers: c2Layers,
    freeRects: [{ x: 4800, y: 1400, w: 7232, h: 952 }],
    cavity: { l: 1200, w: 1000, h: 1300 },
    fragmentsRatio: 0.05,
    weightKg: 910,
    cbm: 40 * CBM_A + 50 * CBM_B,
    utilVol: 0.51,
    utilWeight: 0.32,
    distribution: distribution(BOX_40HQ.L, [120, 110, 100, 95, 90, 85, 80, 75, 80, 75]),
    // 偏重段占比 63%：故意超过 CTU 60% 上限
    balance: { frontDiffKg: 210, sideDiffKg: 90, endMaxRatio: 0.63, passed: false },
  }

  const cargoKg = c1.weightKg + c2.weightKg
  const cargoCbm = c1.cbm + c2.cbm
  const volumetricKg = cargoCbm * 1e6 / 6000

  const ctx = {
    plan: {
      id: 'PLAN-2026-001',
      createdAt: '2026-10-09T08:30:00Z',
      boxType: '40HQ',
      container: BOX_40HQ,
      containers: [c1, c2],
      totals: {
        boxes: 250,
        weightKg: cargoKg,
        cbm: cargoCbm,
        volumetricKg,
        densityKgPerCbm: cargoKg / cargoCbm,
        chargeableKg: Math.max(cargoKg, volumetricKg),
        utilVol: 0.885,
        utilWeight: 0.45,
        containerCount: 2,
      },
      violations: [
        { level: 'error', code: 'C-05', msg: '第 2 柜可入洞小于最小箱规，无法继续塞入' },
        { level: 'warn', code: 'C-02', msg: 'SKU-A 为不可倒置品，请核对第 2 柜第 1 层摆向' },
      ],
      billing: {
        channels: [
          { key: 'all-throw', name: '全抛(÷6000)', chargeableKg: volumetricKg, freight: 1820.5, diffVsBase: -120 },
          { key: 'half-throw', name: '半抛', chargeableKg: 2600, freight: 1940.0, diffVsBase: 0 },
        ],
        recommendedChannel: 'all-throw',
        boxTypeCompare: [
          { boxType: '40HQ', cbm: cargoCbm, weightKg: cargoKg, freight: 1820.5, costPerCbm: 113.15, containers: 2 },
          { boxType: '20GP', cbm: cargoCbm, weightKg: cargoKg, freight: 2360.0, costPerCbm: 146.67, containers: 4 },
        ],
        recommendedBoxType: '40HQ',
        surcharges: [
          { name: 'THC 码头操作费', amount: 680, note: '340/柜 × 2柜' },
          { name: 'DOC 单证费', amount: 150, note: '按票计收' },
          { name: 'BAF 燃油附加费', amount: 320, note: '160/柜 × 2柜' },
          { name: '加固材料', amount: 260, note: '含缠绕膜与护角' },
        ],
        totalCost: 3230.5,
      },
    },
    orders: [
      {
        id: 'SO-2026-1001',
        code: 'SO-2026-1001',
        customer: '义乌小陈贸易',
        customerAllowMixed: true,
        port: 'Ningbo',
        vessel: 'COSCO 泰安 V.034W',
        cutOff: '2026-10-20T17:00:00Z',
        dueDate: '2026-10-18',
        lines: [
          { skuId: 'A', boxes: 140, pieces: 1680 },
          { skuId: 'B', boxes: 110, pieces: 2200 },
        ],
        freightCurrency: 'USD',
      },
    ],
    skus: [SKU_A, SKU_B],
    customer: { id: 'C-1', name: '义乌小陈贸易', allowMixed: true, rejectMixedReason: '' },
    settings: {
      volumeDivisor: 6000,
      availableRatio: 0.85,
      pallet: { l: 1200, w: 1000, h: 130, stackMax: 2 },
      costs: {
        freightPerCbm: 113,
        baseFreight: 0,
        thc: 340,
        doc: 150,
        baf: 160,
        palletFee: 0,
        monitorFee: 0,
        oversizeFeePerBox: 500,
        overWeightFeePerKg: 0,
      },
    },
    generatedAt: '2026-10-09T09:00:00Z',
  }

  return applyOverride(ctx, over)
}

function pick(o) {
  const out = {}
  for (const k of Object.keys(o)) out[k] = o[k]
  return out
}

/** 深拷贝夹具并打补丁——直接改共享对象会让用例之间互相污染。 */
function applyOverride(ctx, over) {
  const base = JSON.parse(JSON.stringify(ctx))
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      Object.assign(base[k], v)
    } else {
      base[k] = v
    }
  }
  return base
}

/* ─────────────────────────── 断言工具 ─────────────────────────── */

/** 取出所有 <tr>...</tr>（表格里的行）。 */
function rowsOf(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
}

/** 一行的单元格文本；标签全部剥掉，单元格之间用 ｜ 分隔。 */
function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim())
}

/** 找到「某个 SKU 编码所在的那一行」——比对必须锁定到具体行，不能全文搜数字。 */
function rowFor(html, code) {
  const hit = rowsOf(html).map(cellsOf).find((cells) => cells.includes(code))
  assert.ok(hit, `HTML 里找不到 SKU ${code} 所在的数据行`)
  return hit
}

function csvRows(csv) {
  return csv.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '')
}

/** 把一行 CSV 拆成字段（含正确的引号还原），用于验证转义。 */
function csvFields(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

const ctx = makeCtx()

/* ─────────────────────────── 装箱单 ─────────────────────────── */

describe('单据层 · 装箱单', () => {
  const html = buildPackingList(ctx)

  it('抬头带出客户、订单、柜型、柜数、船期与截关', () => {
    for (const s of ['装箱单', 'PACKING LIST', '义乌小陈贸易', 'SO-2026-1001', '40HQ', 'Ningbo', 'COSCO 泰安 V.034W']) {
      assert.ok(html.includes(s), `装箱单缺少「${s}」`)
    }
    assert.ok(html.includes('2026-10-20 17:00'), '截关时间应印成 2026-10-20 17:00')
    assert.ok(html.includes('2026-10-18'), '交货日期应印出')
  })

  it('SKU-A 行的箱数/件数/毛重/净重/CBM 与输入逐格一致', () => {
    const c = rowFor(html, 'SKU-A')
    // 列序见 PL_COLS：#/唛头/品名/品名EN/箱数/件数/单箱毛重/毛重合计/单箱净重/净重合计/单箱CBM/CBM合计/箱规/目的港/船名/备注
    assert.equal(c[4], '140', 'SKU-A 箱数应为两柜合计 140')
    assert.equal(c[5], '1,680', 'SKU-A 件数应为 1680')
    assert.equal(c[6], '12.5', 'SKU-A 单箱毛重')
    assert.equal(c[7], '1,750.0', 'SKU-A 毛重合计 = 12.5 × 140')
    assert.equal(c[8], '11.8', 'SKU-A 单箱净重')
    assert.equal(c[9], '1,652.0', 'SKU-A 净重合计 = 11.8 × 140')
    assert.equal(c[10], '0.084', 'SKU-A 单箱 CBM')
    assert.equal(c[11], '11.760', 'SKU-A CBM 合计 = 0.084 × 140')
    assert.equal(c[12], '60×40×35', 'SKU-A 箱规')
    assert.equal(c[13], 'Ningbo', 'SKU-A 目的港')
    assert.equal(c[14], 'COSCO 泰安 V.034W', 'SKU-A 船名航次')
  })

  it('SKU-B 行的数字同样与输入一致（防止只对了一个 SKU）', () => {
    const c = rowFor(html, 'SKU-B')
    assert.equal(c[4], '110')
    assert.equal(c[5], '2,200')
    assert.equal(c[7], '902.0', 'SKU-B 毛重合计 = 8.2 × 110')
    assert.equal(c[9], '869.0', 'SKU-B 净重合计 = 7.9 × 110')
    assert.equal(c[11], '4.331', 'SKU-B CBM 合计 = 0.039375 × 110，进位到 3 位')
  })

  it('合计行等于各行之和，不重不漏', () => {
    const foot = rowsOf(html).map(cellsOf).find((c) => c[0] === '合计')
    assert.ok(foot, '缺少合计行')
    assert.equal(foot[4], '250', '总箱数')
    assert.equal(foot[5], '3,880', '总件数')
    assert.equal(foot[7], '2,652.0', '总毛重')
    assert.equal(foot[9], '2,521.0', '总净重')
    assert.equal(foot[11], '16.091', '总 CBM')

    const rows = shipmentRows(ctx)
    const sum = (f) => rows.reduce((a, r) => a + r[f], 0).toFixed(1)
    assert.equal(foot[7].replace(/,/g, ''), sum('grossKg'))
  })

  it('禁止倒置 / 易碎 / 堆码层写进备注列', () => {
    const c = rowFor(html, 'SKU-A')
    assert.ok(c[15].includes('不可倒置'), 'SKU-A 备注应含不可倒置')
    assert.ok(c[15].includes('易碎'), 'SKU-A 备注应含易碎')
    assert.ok(c[15].includes('可堆3层'), 'SKU-A 备注应含堆码层')
  })
})

/* ─────────────────────────── 装柜清单 ─────────────────────────── */

describe('单据层 · 装柜清单', () => {
  it('逐柜给出柜号、装载量、装载率与可入洞', () => {
    const html = buildLoadingPlan(ctx)
    for (const s of ['第 1 柜', '第 2 柜', '12,032×2,352×2,698', '1,742.0', '910.0', '83.0%', '51.0%', '1,200×1,000×1,300']) {
      assert.ok(html.includes(s), `装柜清单缺少「${s}」`)
    }
  })

  it('按柜按 SKU 分行，数字与该柜 items 一致', () => {
    const html = buildLoadingPlan(ctx)
    const row = rowsOf(html).map(cellsOf).find((c) => c.includes('SKU-A') && c[3] === '100')
    assert.ok(row, '第 1 柜 SKU-A 应有 100 箱')
    assert.equal(row[4], '1,200', '第 1 柜 SKU-A 件数')
    assert.equal(row[5], '1,250.0', '第 1 柜 SKU-A 重量')
    assert.equal(row[6], '8.400', '第 1 柜 SKU-A 体积')

    const row2 = rowsOf(html).map(cellsOf).find((c) => c.includes('SKU-A') && c[3] === '40')
    assert.ok(row2, '第 2 柜 SKU-A 应有 40 箱')
    assert.equal(row2[5], '500.0', '第 2 柜 SKU-A 重量')
  })

  it('byLayer=true 时逐层出俯视图，默认不出', () => {
    const withLayer = buildLoadingPlan(ctx, { byLayer: true })
    const without = buildLoadingPlan(ctx)
    assert.ok(withLayer.includes('dp-svg'), 'byLayer 应输出俯视图 SVG')
    assert.ok(withLayer.includes('dp-layer__hd'), 'byLayer 应给出每层的抬头')
    assert.ok(withLayer.includes('层高 350 mm'), 'byLayer 应标出层高')
    assert.ok(!without.includes('dp-svg'), '默认不应输出俯视图（页面会太长）')
  })
})

/* ─────────────────────────── VGM ─────────────────────────── */

describe('单据层 · VGM', () => {
  it('VGM = 货重 + 柜自重，总量与逐柜都能核对', () => {
    const { html, vgmKg, error } = buildVgm(ctx)
    assert.equal(error, null, '数据完整时不应报错')

    // 总重 = 2652 + 3970 × 2
    assert.equal(vgmKg, 10592)

    // 逐柜：货重 + 自重
    assert.ok(html.includes('5,712.0'), '第 1 柜 VGM 应为 1742 + 3970 = 5712')
    assert.ok(html.includes('4,880.0'), '第 2 柜 VGM 应为 910 + 3970 = 4880')
    assert.ok(html.includes('2,652.0'), '货物总重应印出')
    assert.ok(html.includes('7,940.0'), '柜自重合计应印出')
  })

  it('逐柜相加等于总量（申报单内部必须自洽）', () => {
    const { html, vgmKg } = buildVgm(ctx)
    // 列序：柜号/柜型/货重/自重/VGM/载货上限
    const perContainer = rowsOf(html)
      .map(cellsOf)
      .filter((c) => /^#\d+$/.test(c[0]))
      .map((c) => Number(c[4].replace(/,/g, '')))
    assert.equal(perContainer.length, 2, '应抓到两柜 VGM')
    assert.equal(perContainer[0], 5712)
    assert.equal(perContainer[1], 4880)
    assert.equal(perContainer[0] + perContainer[1], vgmKg)
  })

  it('totals 缺货重时退回逐柜合计，而不是直接放弃', () => {
    const partial = makeCtx()
    delete partial.plan.totals.weightKg
    const r = buildVgm(partial)
    assert.equal(r.error, null, '逐柜有货重时应能算出来')
    assert.equal(r.vgmKg, 2652 + 3970 * 2)
  })

  it('完全拿不到货重时给出明确错误，不编一个数出来', () => {
    const broken = makeCtx()
    delete broken.plan.totals.weightKg
    broken.plan.containers = []
    const r = buildVgm(broken)
    assert.ok(r.error, '缺货重应报错')
    assert.match(r.error, /重量/)
    assert.equal(r.vgmKg, null, '不能凭空给出 VGM')
  })
})

/* ─────────────────────────── 配重报告 ─────────────────────────── */

describe('单据层 · 配重报告', () => {
  it('前后差超过 800kg 时给出告警文案并带上具体数值', () => {
    const { html, violations, passed } = buildBalanceReport(ctx)
    assert.equal(passed, false, '有告警就不应判通过')
    const front = violations.find((v) => v.code === 'B-01')
    assert.ok(front, '应产生 B-01 前后配重差告警')
    assert.equal(front.level, 'warn')
    assert.ok(front.msg.includes('950.0'), `告警文案应写明实际差值，实际：${front.msg}`)
    assert.ok(front.msg.includes('800'), '告警文案应写明告警线')
    assert.ok(html.includes('前后配重差'), '报告正文应出现前后配重差')
  })

  it('CTU 偏重段占比超过 60% 时告警', () => {
    const { html, violations } = buildBalanceReport(ctx)
    const ctu = violations.find((v) => v.code === 'B-02')
    assert.ok(ctu, '应产生 B-02 CTU 告警')
    assert.ok(ctu.msg.includes('CTU 60/50'), `告警应点名 CTU 60/50，实际：${ctu.msg}`)
    assert.ok(ctu.msg.includes('63.0%'), `告警应写明占比，实际：${ctu.msg}`)
    assert.ok(html.includes('CTU 60/50'), '报告正文应出现 CTU 判定')
    assert.ok(html.includes('超限'), '超限柜应标红字')
  })

  it('合格方案不产生任何告警', () => {
    const ok = makeCtx()
    ok.plan.containers[0].balance = { frontDiffKg: 120, sideDiffKg: 60, endMaxRatio: 0.55, passed: true }
    ok.plan.containers[1].balance = { frontDiffKg: 90, sideDiffKg: 40, endMaxRatio: 0.52, passed: true }
    const { violations, passed, html } = buildBalanceReport(ok)
    assert.deepEqual(violations, [], `不应有告警，实际：${JSON.stringify(violations)}`)
    assert.equal(passed, true)
    assert.ok(html.includes('全部柜配重通过'))
  })

  it('沿柜长 10 段重量柱状图用纯 HTML 条形输出（不引图表库）', () => {
    const html = buildBalanceReport(ctx).html
    const bars = [...html.matchAll(/<i style="height:(\d+)%" title="([\d,]+)-([\d,]+)mm · ([\d,.]+)kg"><\/i>/g)]
    assert.equal(bars.length, 20, '两柜各 10 段 = 20 根柱子')
    assert.ok(html.includes('dp-bars'), '应使用 CSS 条形而非图表库')
    assert.ok(!html.includes('<canvas'), '不应出现 canvas')
    // 柱高必须和该段重量成正比：第 1 段最重，柱高应为 100%
    assert.equal(bars[0][1], '100')
    assert.equal(bars[0][4], '220.0', '第 1 段重量 220kg')
    assert.equal(bars[9][4], '117.0', '第 10 段重量 117kg')
    // 段边界应连续覆盖整个柜长（12,032mm / 10 段）
    assert.equal(bars[0][2], '0', '第 1 段起点')
    assert.equal(bars[9][3], '12,032', '第 10 段终点应到柜门')
  })

  it('缺配重数据时降级为告警而不是静默通过', () => {
    const partial = makeCtx()
    delete partial.plan.containers[0].balance
    delete partial.plan.containers[1].balance
    const { violations, passed } = buildBalanceReport(partial)
    assert.equal(passed, false)
    assert.ok(violations.some((v) => v.code === 'B-04'), '应提示缺少配重数据')
  })
})

/* ─────────────────────────── 费用汇总 ─────────────────────────── */

describe('单据层 · 费用汇总', () => {
  it('总额取自计费模块，附加费逐项列出并标出计收方式', () => {
    const { html, totalCost } = buildCostSummary(ctx)
    assert.equal(totalCost, 3230.5)
    for (const s of ['1,820.50', '680.00', '150.00', '320.00', '260.00', '3,230.50']) {
      assert.ok(html.includes(s), `费用汇总缺少「${s}」`)
    }
    assert.ok(html.includes('按柜'), '应标出按柜计收的项')
    assert.ok(html.includes('按票'), '应标出按票计收的项')
    assert.ok(html.includes('推荐'), '推荐渠道/柜型应标注')
  })

  it('按柜归集后各柜小计之和严格等于海运费 + 按柜附加费', () => {
    const { html } = buildCostSummary(ctx)
    // [^0-9]* 而不是 [\w]*：\w 会吃掉币种后的首位数字，把 1,410.25 读成 410.25
    const subtotals = [...html.matchAll(/dp-costbox__sum">小计 <b>[^0-9]*([\d,]+\.\d\d)<\/b>/g)].map((m) => Number(m[1].replace(/,/g, '')))
    assert.equal(subtotals.length, 2)
    // 910.25 平摊海运费 + 340 THC + 160 BAF
    assert.equal(subtotals[0], 1410.25)
    assert.equal(subtotals[1], 1410.25)
    assert.equal(subtotals[0] + subtotals[1], 1820.5 + 680 + 320)
  })

  it('没有计费结果时按本地费率兜底并标明是估算', () => {
    const noBilling = makeCtx()
    delete noBilling.plan.billing
    const { html, totalCost } = buildCostSummary(noBilling)
    assert.ok(html.includes('估算'), '兜底结果必须标明估算，不能当报价单用')
    // THC 340×2 + DOC 150 + BAF 160×2 = 1150
    assert.equal(totalCost, 1150)
  })
})

/* ─────────────────────────── 卡片 ─────────────────────────── */

describe('单据层 · 摘要 / 拼单 / 违规卡', () => {
  it('摘要卡三行回答「几个柜 / 多少钱 / 还能塞什么」', () => {
    const html = buildSummaryCard(ctx)
    assert.ok(html.includes('几个柜'), '缺第一行')
    assert.ok(html.includes('多少钱'), '缺第二行')
    assert.ok(html.includes('还能塞什么'), '缺第三行')
    assert.ok(html.includes('2</b> 柜'), '应写明 2 柜')
    assert.ok(html.includes('3,230.50'), '应写明总价')
    assert.ok(html.includes('还可再装约'), '应给出剩余可装量')
    assert.ok(html.includes('1,200×1,000×1,300'), '应给出最大可入洞')
  })

  it('拼单卡对缺字段的 suggestion 也不崩', () => {
    assert.ok(buildConsolidationCard(ctx, null).includes('拼单建议'))
    assert.ok(buildConsolidationCard(ctx, undefined).includes('拼单建议'))
    assert.ok(buildConsolidationCard(ctx, { }).includes('拼单建议'))

    const full = buildConsolidationCard(ctx, {
      headline: '把 SKU-B 的尾数拼进第 2 柜，可以少发一个柜',
      addableBoxes: 50,
      fillRate: 0.71,
      wastedCbm: 12.5,
      totalBoxes: 250,
      nextBoxType: '20GP',
      nextContainers: 1,
      reasons: ['SKU-B 单独发运费不划算'],
      perContainer: [{ index: 2, boxes: 90, addable: 50, fillRate: 0.71 }],
    })
    assert.ok(full.includes('少发一个柜'))
    assert.ok(full.includes('50'), '应显示可拼入箱数')
    assert.ok(full.includes('71.0%'), '应显示填充率')
    assert.ok(full.includes('SKU-B 单独发运费不划算'))
  })

  it('违规清单按 error/warn 分色，error 必须提示处理', () => {
    const html = buildViolationList(ctx)
    assert.ok(html.includes('dp-viol--err'), 'error 应走红色样式')
    assert.ok(html.includes('dp-viol--warn'), 'warn 应走琥珀色样式')
    assert.ok(html.includes('C-05'), '应带违规码')
    assert.ok(html.includes('其中 1 项必须处理'))

    const clean = buildViolationList(makeCtx({ plan: { ...makeCtx().plan, violations: [] } }))
    assert.ok(clean.includes('无违规项'))
  })
})

/* ─────────────────────────── 打印包 ─────────────────────────── */

describe('单据层 · A4 打印包', () => {
  const bundle = buildPrintBundle(ctx)

  it('一次打印包含全部单据标题', () => {
    for (const s of ['装箱单', '装柜清单', 'VGM 申报数据', '配重报告', '费用汇总', '装柜图']) {
      assert.ok(bundle.html.includes(s), `打印包缺少「${s}」`)
    }
    assert.ok(bundle.title.includes('SO-2026-1001'))
    assert.ok(bundle.title.includes('义乌小陈贸易'))
    assert.ok(bundle.title.includes('2柜'))
  })

  it('分层俯视图由 layers 坐标现场画成 inline SVG', () => {
    assert.ok(bundle.html.includes('<svg class="dp-svg"'), '应有内联 SVG')
    assert.ok(!bundle.html.includes('<canvas'), '不能用 canvas')
    // 3 层（2 柜 2 层 + 1 层）各画一次
    const svgs = bundle.html.match(/<svg class="dp-svg"/g) || []
    assert.equal(svgs.length, 3, '每个 container 的每个 layer 一张俯视图')
    // 柜内尺寸决定 viewBox，坐标原点在 mm 空间
    assert.ok(bundle.html.includes('viewBox="-300 -300 12632 2952"'), 'viewBox 应由柜内尺寸推出')
    // 250 个箱子全部画成 rect（外加每张图 1 个柜体轮廓 rect）
    const rects = (bundle.html.match(/<rect /g) || []).length
    assert.equal(rects, 250 + 3, '每个箱子一个 rect')
  })

  it('带利用率水印、二维码占位和 A4 横向分页', () => {
    assert.ok(bundle.html.includes('dp-wm'), '应有利用率水印')
    assert.ok(bundle.html.includes('利用率 88.5%'), '水印应带体积利用率')
    assert.ok(bundle.html.includes('dp-qr'), '应有二维码占位')
    assert.ok(bundle.html.includes('PLAN-2026-001'), '二维码占位应标单证号')
    assert.ok(bundle.css.includes('@page'), '应有打印分页规则')
    assert.ok(bundle.css.includes('A4 landscape'), '应为 A4 横向')
    assert.ok(bundle.html.includes('<style>'), 'html 自带样式，可直接 innerHTML 后 print')
  })

  it('可以关掉不想要的单据', () => {
    const slim = buildPrintBundle(ctx, { cost: false, vgm: false, qr: false, watermark: false, byLayer: false })
    assert.ok(!slim.html.includes('费用汇总'), '关掉后不应再出现费用汇总')
    assert.ok(!slim.html.includes('VGM 申报数据'), '关掉后不应再出现 VGM')
    // 注意要匹配 class="..." 而不是样式名——<style> 里本来就写着 .dp-qr/.dp-wm
    assert.ok(!slim.html.includes('class="dp-qr"'), '关掉后不应再出现二维码')
    assert.ok(!slim.html.includes('class="dp-wm"'), '关掉后不应再出现水印')
    assert.ok(!slim.html.includes('class="dp-svg"'), 'byLayer=false 后不应再印俯视图')
    assert.ok(slim.html.includes('装箱单'), '没关掉的单据照常输出')
  })
})

/* ─────────────────────────── CSV ─────────────────────────── */

describe('单据层 · CSV', () => {
  it('装箱单 CSV 行数正确，含 BOM，CRLF 换行', () => {
    const csv = buildPackingListCsv(ctx)
    assert.ok(csv.startsWith('﻿'), '必须带 UTF-8 BOM，否则 Excel 里中文乱码')
    assert.ok(csv.includes('\r\n'), '必须用 CRLF，Excel 才对得上行')
    assert.ok(csv.endsWith('\r\n'))

    const rows = csvRows(csv)
    assert.equal(rows.length, 4, '表头 + 2 个 SKU + 合计 = 4 行')
    assert.equal(csvFields(rows[0])[0], 'SKU编码')
    assert.equal(csvFields(rows[3])[0], '合计')
  })

  it('装箱单 CSV 字段数值与 HTML 装箱单一致', () => {
    const rows = csvRows(buildPackingListCsv(ctx))
    const head = csvFields(rows[0])
    const a = csvFields(rows[1])
    const iCode = head.indexOf('SKU编码')
    const rowA = rows.slice(1).map(csvFields).find((r) => r[iCode] === 'SKU-A')
    assert.ok(rowA)
    assert.equal(rowA[head.indexOf('箱数CTN')], '140')
    assert.equal(rowA[head.indexOf('毛重合计kg')], '1750')
    assert.equal(rowA[head.indexOf('净重合计kg')], '1652')
    assert.equal(rowA[head.indexOf('CBM合计')], '11.76')
    assert.equal(rowA[head.indexOf('目的港')], 'Ningbo')
    assert.ok(a, 'SKU-A 行应存在')
  })

  it('装柜清单 CSV 逐柜逐 SKU 行数正确', () => {
    const rows = csvRows(buildLoadingPlanCsv(ctx))
    assert.equal(rows.length, 6, '表头 + 2柜 × 2SKU + 合计 = 6 行')
    assert.equal(csvFields(rows[0])[0], '柜号')
    assert.equal(csvFields(rows[1])[0], '1', '第 1 柜')
    assert.equal(csvFields(rows[5])[0], '合计')
    const total = csvFields(rows[5])
    assert.equal(total[4], '250', '合计箱数')
    assert.equal(total[6], '2652', '合计重量')
  })

  it('含逗号和双引号的品名被正确转义', () => {
    const nasty = makeCtx()
    nasty.skus[0].nameCn = 'He said "hi", 大号马克杯'
    const csv = buildPackingListCsv(nasty)
    // 原样字符串必须被引号包住、内部双引号翻倍
    assert.ok(csv.includes('"He said ""hi"", 大号马克杯"'), `转义不正确：\n${csv}`)
    // 还原后必须严格等于原值
    const rows = csvRows(csv)
    const head = csvFields(rows[0])
    const rowA = rows.slice(1).map(csvFields).find((r) => r[head.indexOf('SKU编码')] === 'SKU-A')
    assert.equal(rowA[head.indexOf('品名')], 'He said "hi", 大号马克杯')
  })

  it('HTML 里同一个逗号/引号品名也照常显示（HTML 侧只需转义尖括号）', () => {
    const nasty = makeCtx()
    nasty.skus[0].nameCn = 'He said "hi", 大号马克杯'
    const html = buildPackingList(nasty)
    assert.ok(html.includes('He said &quot;hi&quot;, 大号马克杯'))
    assert.equal(html.split('大号马克杯').length - 1, 1, '只应出现一次（避免两套数据源打架）')
  })

  it('toCsv 支持二维数组与对象数组，空输入返回只含 BOM 的串', () => {
    assert.equal(toCsv([]), '﻿')
    assert.equal(toCsv([['a', 'b'], ['c', 'd']]), '﻿a,b\r\nc,d\r\n')
    const obj = toCsv([{ x: 1, y: 'a,b' }])
    assert.equal(obj, '﻿x,y\r\n1,"a,b"\r\n')
  })
})

/* ─────────────────────────── 健壮性 ─────────────────────────── */

describe('单据层 · 转义与空值', () => {
  it('品名里的 <script> 被转义，不会变成可执行标签', () => {
    const evil = makeCtx()
    evil.skus[0].nameCn = '<script>alert(1)</script>'
    evil.skus[0].nameEn = '<img src=x onerror=alert(2)>'
    const html = buildPackingList(evil)

    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '尖括号必须转义')
    assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), '尖括号必须转义')
    assert.ok(!html.includes('<script>'), '绝不能出现裸 <script>')
    // 转义后它是纯文本，不是标签：不存在可被浏览器识别的 <img ...> 开头
    assert.ok(!/<img[\s>]/.test(html), '不能漏出任何 <img 标签')

    // 装载清单与打印包同样要转义——它们渲染的是同一批数据
    assert.ok(!buildLoadingPlan(evil).includes('<script>'))
    assert.ok(!buildPrintBundle(evil).html.includes('<script>alert'))
  })

  it('转义覆盖到所有走数据的地方（客户名、目的地、船名）', () => {
    const evil = makeCtx({
      customer: { id: 'C-1', name: '<b>小陈</b>', allowMixed: true },
    })
    const evil2 = evil
    evil2.orders[0].port = 'Ningbo & <Ningbo>'
    evil2.orders[0].vessel = '<i>COSCO</i>'
    const html = buildPackingList(evil2)
    assert.ok(html.includes('&lt;b&gt;小陈&lt;/b&gt;'))
    assert.ok(html.includes('Ningbo &amp; &lt;Ningbo&gt;'))
    assert.ok(html.includes('&lt;i&gt;COSCO&lt;/i&gt;'))
    assert.ok(!html.includes('<b>小陈</b>'))
  })

  it('客户名为空、船期为空时不崩，输出「—」占位', () => {
    const empty = makeCtx()
    empty.customer = { id: 'C-1', name: '', allowMixed: true }
    empty.orders[0].vessel = ''
    empty.orders[0].cutOff = ''
    empty.orders[0].port = ''
    empty.orders[0].dueDate = ''

    const html = buildPackingList(empty)
    assert.ok(html.includes('—'), '缺字段应落到统一占位符')
    assert.ok(html.includes('陶瓷马克杯'), '有数据的部分照常打印')

    // 其余单据也不能因为抬头缺字段而挂掉
    assert.doesNotThrow(() => buildLoadingPlan(empty))
    assert.doesNotThrow(() => buildVgm(empty))
    assert.doesNotThrow(() => buildBalanceReport(empty))
    assert.doesNotThrow(() => buildCostSummary(empty))
    assert.doesNotThrow(() => buildSummaryCard(empty))
    assert.doesNotThrow(() => buildPrintBundle(empty))
  })

  it('方案为空（引擎还没算完）时所有单据都能出，只有占位', () => {
    const blank = { plan: {}, orders: [], skus: [], customer: {}, settings: {}, generatedAt: '' }
    assert.ok(buildPackingList(blank).includes('本方案暂无可装货物'))
    assert.ok(buildLoadingPlan(blank).includes('尚未生成装柜方案'))
    assert.ok(buildVgm(blank).error, '空方案应给出 VGM 错误')
    assert.doesNotThrow(() => buildBalanceReport(blank))
    assert.doesNotThrow(() => buildCostSummary(blank))
    assert.doesNotThrow(() => buildPrintBundle(blank))
    assert.equal(csvRows(buildLoadingPlanCsv(blank))[0], '柜号,柜型,SKU编码,品名,箱数,件数,重量kg,体积CBM,可堆层数,禁止倒置,易碎', 'CSV 至少要有完整表头')
  })

  it('数字 0 不会被当成「没填」而打成占位符', () => {
    const zero = makeCtx()
    zero.plan.containers[1].items = [
      { skuId: 'A', code: 'SKU-A', boxes: 0, weightKg: 0, cbm: 0, pieces: 0, noInvert: true, stackTop: 3 },
    ]
    const html = buildLoadingPlan(zero)
    assert.ok(html.includes('>0<'), '零箱数要印 0 而不是 —')
  })
})