/**
 * 装柜计算工具的装箱算法测试。
 *
 * 工具本体是 index.html（单文件、零依赖、要单独分发给装柜工人），但它里面的装箱
 * 内核是本项目里最容易出错、后果也最直接的算法——一旦装箱结果出现重叠或越界，
 * 单证员就会拿着一张装不下的方案去装柜。
 *
 * 所以这里把内核从 HTML 里抽出来，在 Node 下直接跑，并断言三条硬约束：
 *   1. 任意两个箱子在柜底投影上不重叠
 *   2. 所有箱子都在柜内尺寸内
 *   3. 层高累加不超过柜内高，且不超过最大堆码层数
 *
 * 抽取方式：从 <script> 里取到"渲染"分节之前的纯逻辑部分（无 DOM 依赖）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const HTML_PATH = join(HERE, '..', 'index.html')

/** 从 HTML 里抽出装箱内核（状态 + 几何 + 策略 + 统计，无 DOM）。 */
function loadKernel() {
  const html = readFileSync(HTML_PATH, 'utf8')
  const match = /<script>\n([\s\S]*)\n<\/script>/.exec(html)
  if (!match) throw new Error('index.html 里找不到 <script> 块')
  const kernel = match[1].split('/* ═══════════════════════════════════════════════════════\n   渲染')[0]
  if (!kernel.includes('function packLayer')) {
    throw new Error('装箱内核抽取失败：没找到 packLayer —— HTML 结构变了？')
  }
  return kernel
}

/**
 * 在隔离的 vm 上下文里求值内核。
 *
 * 不能直接 import：HTML 里是一整段 script，且末尾有 document/window 调用。
 * 这里只取纯逻辑部分求值，再注入一个驱动函数。
 */
function loadSolver() {
  const kernel = loadKernel()
  const context = createContext({})
  runInContext(
    `${kernel}
globalThis.__solve = solve;
globalThis.__setBox = function (t, a, b, c, g, m, q, r) {
  state.bL = a; state.bW = b; state.bH = c;
  state.gap = g; state.maxLayer = m; state.qty = q; state.allowRotate = r;
  state.dirs = DIRS.map(function () { return true; });
  var k = CONTAINERS[t];
  state.ctype = t; state.cL = k.L; state.cW = k.W; state.cH = k.H;
};`,
    context,
  )
  return (setup) => {
    runInContext(
      '__setBox(' +
        JSON.stringify(setup.ctype) + ',' +
        setup.bL + ',' + setup.bW + ',' + setup.bH + ',' +
        (setup.gap ?? 0) + ',' + (setup.maxLayer ?? 0) + ',' + (setup.qty ?? 0) + ',' +
        (setup.allowRotate !== false) + ');',
      context,
    )
    const result = runInContext('__solve()', context)
    return JSON.parse(JSON.stringify(result))
  }
}

const CONTAINER_SIZES = {
  '20GP': { L: 5898, W: 2352, H: 2393 },
  '40GP': { L: 12032, W: 2352, H: 2393 },
  '40HQ': { L: 12032, W: 2352, H: 2698 },
  '45HQ': { L: 13756, W: 2352, H: 2698 },
}

/** 纸箱第 di 个方向的三边（不含间隙）。 */
const DIR_KEYS = [
  ['L', 'W', 'H'], ['L', 'H', 'W'], ['W', 'L', 'H'],
  ['W', 'H', 'L'], ['H', 'L', 'W'], ['H', 'W', 'L'],
]

/** 体积（任意长度单位，只要两边一致即可）。 */
function volume(dims) {
  return dims.L * dims.W * dims.H
}

/** 校验一份方案的物理可行性；返回违规描述列表（空 = 可行）。 */
function violations(plan, box, container, gap) {
  const bad = []
  const boxSide = (key) => box[key]

  plan.layers.forEach((layer, li) => {
    const rects = []
    for (const it of layer.items) {
      const keys = DIR_KEYS[it.di]
      const bw = boxSide(keys[0]), bh = boxSide(keys[1]), bt = boxSide(keys[2])
      rects.push({ x: it.x, y: it.y, w: bw, h: bh })
      if (it.x < -1e-6 || it.y < -1e-6) bad.push(`L${li}: 箱子起点为负`)
      if (it.x + bw > container.L + 1e-6) bad.push(`L${li}: 超出柜长`)
      if (it.y + bh > container.W + 1e-6) bad.push(`L${li}: 超出柜宽`)
      if (layer.z + bt > container.H + 1e-6) bad.push(`L${li}: 超出柜高`)
    }
    // 两两重叠检查
    outer:
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        if (
          a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 &&
          a.y < b.y + b.h - 1e-6 && a.y + a.h > b.y + 1e-6
        ) {
          bad.push(`L${li}: 第 ${i} 与第 ${j} 箱重叠`)
          break outer
        }
      }
    }
    if (layer.z + layer.h > container.H + 1e-6) bad.push(`L${li}: 层高超出柜顶`)
    // 间隙约束：末列要留出装卸间隙
    if (gap > 0) {
      for (const it of layer.items) {
        const keys = DIR_KEYS[it.di]
        if (it.x + boxSide(keys[0]) + gap > container.L + 1e-6) bad.push(`L${li}: 末列未留装卸间隙`)
      }
    }
  })
  return bad
}

const CASES = [
  { name: '20GP 常规箱规', ctype: '20GP', bL: 600, bW: 400, bH: 350 },
  { name: '20GP 加大间隙', ctype: '20GP', bL: 600, bW: 400, bH: 350, gap: 50 },
  { name: '40GP 小箱规', ctype: '40GP', bL: 400, bW: 300, bH: 300 },
  { name: '40HQ 常规箱规', ctype: '40HQ', bL: 600, bW: 400, bH: 350 },
  { name: '45HQ 常规箱规', ctype: '45HQ', bL: 600, bW: 400, bH: 350 },
  { name: '大箱（1200×1000×900）', ctype: '20GP', bL: 1200, bW: 1000, bH: 900 },
  { name: '超大箱（2100×1200×1100）', ctype: '40HQ', bL: 2100, bW: 1200, bH: 1100 },
]

describe('装柜计算 · 装箱内核', () => {
  it('六类常用柜型 + 各种箱规下，Top3 方案全部物理可行', () => {
    const solve = loadSolver()

    for (const c of CASES) {
      const gap = c.gap ?? 0
      const out = solve({ ...c, gap })

      assert.equal(out.error, undefined, `${c.name} 不应有错误，实际：${out.error}`)
      assert.ok(out.plans.length > 0, `${c.name} 应至少产出一个方案`)

      const container = CONTAINER_SIZES[c.ctype]
      // violations 按 {L,W,H} 取纸箱三边，用例里是 {bL,bW,bH}——不转手的话
      // 三边全成 undefined，所有越界/重叠比较都变成 NaN>… 的 false，断言全绿。
      const box = { L: c.bL, W: c.bW, H: c.bH }
      for (const plan of out.plans) {
        const bad = violations(plan, box, container, gap)
        assert.equal(
          bad.length, 0,
          `${c.name} · ${plan.boxes} 箱方案违规：${bad.slice(0, 3).join('; ')}`,
        )
      }
    }
  })

  it('箱数落在物理容量区间内（不多不少）', () => {
    const solve = loadSolver()
    const c = CASES[3] // 40HQ 600×400×350
    const out = solve(c)

    const container = CONTAINER_SIZES[c.ctype]
    const box = { L: c.bL, W: c.bW, H: c.bH }
    // 上限取"体积装满"这个硬边界，而不是 floor(L/bL)*floor(W/bW)*floor(H/bH)：
    // 内核会混方向码放（600 立起来每层能放 180 箱，高于同一方向的 100 箱），
    // 整齐码法的乘积不是它的上界，拿来断言只会把更优的方案误判成超载。
    const volumeCeiling = Math.floor(volume(container) / volume(box))
    // 每层至少要有纸箱最短边那么高，层数因此有硬上限。
    const layersMax = Math.floor(container.H / Math.min(box.L, box.W, box.H))

    for (const plan of out.plans) {
      assert.ok(plan.boxes > 0, '总箱数应为正')
      assert.ok(plan.boxes <= volumeCeiling, `装 ${plan.boxes} 箱超过体积上限 ${volumeCeiling}`)
      assert.ok(plan.layers.length > 0, '至少应有一层')
      assert.ok(plan.layers.length <= layersMax, `层数 ${plan.layers.length} 超过硬上限 ${layersMax}`)
    }
  })

  it('利用率的取值范围合法，且总箱数随柜型递增', () => {
    const solve = loadSolver()
    const results = []

    for (const ctype of ['20GP', '40GP', '40HQ', '45HQ']) {
      const out = solve({ ctype, bL: 600, bW: 400, bH: 350 })
      const best = out.plans[0]
      assert.ok(best.util > 0, `${ctype} 利用率应为正`)
      assert.ok(best.util <= 1, `${ctype} 利用率不应超过 100%`)
      results.push(best.boxes)
    }

    // 柜子越大装得越多
    assert.ok(results[0] < results[1], '40GP 应比 20GP 装得多')
    assert.ok(results[2] >= results[1], '40HQ 不应比 40GP 装得少')
  })

  it('单一方向基线不劣于同方向的整齐码法', () => {
    const solve = loadSolver()
    const c = CASES[0]
    const container = CONTAINER_SIZES[c.ctype]
    const out = solve(c)

    // 基线至少能放下整齐网格的箱数
    const gridPerLayer = Math.floor(container.L / c.bL) * Math.floor(container.W / c.bW)
    const gridLayers = Math.floor(container.H / c.bH)
    assert.ok(
      out.single.boxes >= gridPerLayer * gridLayers,
      `基线 ${out.single.boxes} 箱低于整齐码法 ${gridPerLayer * gridLayers} 箱`,
    )
  })

  it('混合方向不会比单一方向少装（Top1 必须 ≥ 基线）', () => {
    const solve = loadSolver()
    for (const c of CASES) {
      const out = solve({ ...c, gap: c.gap ?? 0 })
      assert.ok(
        out.plans[0].boxes >= out.single.boxes,
        `${c.name}：混合 ${out.plans[0].boxes} 箱 < 基线 ${out.single.boxes} 箱`,
      )
    }
  })

  it('限制最大堆码层数时，实际层数不超过上限', () => {
    const solve = loadSolver()
    for (const cap of [1, 2, 3]) {
      const out = solve({ ctype: '40HQ', bL: 600, bW: 400, bH: 350, maxLayer: cap })
      for (const plan of out.plans) {
        assert.ok(plan.layers.length <= cap, `上限 ${cap} 层，实际 ${plan.layers.length} 层`)
      }
    }
  })

  it('指定待装数量时不超过该数量', () => {
    const solve = loadSolver()
    for (const qty of [1, 100, 500]) {
      const out = solve({ ctype: '40HQ', bL: 600, bW: 400, bH: 350, qty })
      for (const plan of out.plans) {
        assert.ok(plan.boxes <= qty, `指定 ${qty} 箱，实际装 ${plan.boxes} 箱`)
      }
    }
  })

  it('禁止旋转时只用不倒置的方向', () => {
    const solve = loadSolver()
    const out = solve({ ctype: '20GP', bL: 600, bW: 400, bH: 350, allowRotate: false })
    for (const plan of out.plans) {
      // 允许的方向是 d[2] === 'H' 的三个：索引 0、2、5
      for (const di of Object.keys(plan.byDir).map(Number)) {
        assert.ok([0, 2, 5].includes(di), `出现了不该用的方向索引 ${di}`)
      }
    }
  })

  it('纸箱比柜子还大时给出明确错误，不产出荒谬数字', () => {
    const solve = loadSolver()
    const out = solve({ ctype: '20GP', bL: 6000, bW: 400, bH: 350 })
    assert.ok(out.error, '应给出错误提示')
    assert.ok(out.error.includes('没有可用方向'), `错误信息不明确：${out.error}`)
  })

  it('各方向用量之和等于总箱数', () => {
    const solve = loadSolver()
    const out = solve({ ctype: '40HQ', bL: 600, bW: 400, bH: 350, gap: 20 })
    for (const plan of out.plans) {
      const sum = Object.values(plan.byDir).reduce((a, b) => a + b, 0)
      assert.equal(sum, plan.boxes)
    }
  })

  it('箱数超过柜内容量上限时给出错误（防止装出 20 万箱）', () => {
    // 这条守住 capacityUpperBound 兜底：即使算法有 bug 也不会产出离谱数字
    const solve = loadSolver()
    const out = solve({ ctype: '20GP', bL: 600, bW: 400, bH: 350 })
    const container = CONTAINER_SIZES['20GP']
    const ceiling = Math.floor(volume(container) / volume({ L: 600, W: 400, H: 350 }))
    for (const plan of out.plans) {
      assert.ok(plan.boxes <= ceiling, `装 ${plan.boxes} 箱超过 20GP 内容量上限 ${ceiling}`)
    }
  })
})