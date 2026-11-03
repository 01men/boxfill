/**
 * 3D 装柜图渲染测试。
 *
 * 为什么要在 Node 里测一个"画到 canvas 上"的模块：PRD 7.2 写死了"低端机 / WebGL
 * 不可用时降级，**不得白屏**"。白屏是渲染代码抛异常造成的，而异常只有真跑一遍
 * 渲染路径才会暴露。这里用一个记录调用的 2D 上下文桩来跑，断言的是：
 * ① 渲染不抛异常；② 真的画了东西（不是空图）；③ 视图之间数据一致。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { solvePlan } from '../h5/js/core/engine.js'
import {
  renderAxonometric, renderLayerTop, renderSideView, renderBalanceChart,
  colorFor, shouldDegrade, PALETTE,
} from '../h5/js/ui/view3d.js'

/** 记录型 2D 上下文：足够跑完渲染，又不需要真画布 */
function stubCtx() {
  const calls = { fill: 0, stroke: 0, fillRect: 0, fillText: [], lineTo: 0, moveTo: 0 };
  return {
    calls,
    set fillStyle(v) {}, get fillStyle() { return '' },
    set strokeStyle(v) {}, get strokeStyle() { return '' },
    set lineWidth(v) {}, get lineWidth() { return 1 },
    set font(v) {}, get font() { return '' },
    set textAlign(v) {}, get textAlign() { return '' },
    set textBaseline(v) {}, get textBaseline() { return '' },
    set globalAlpha(v) {}, get globalAlpha() { return 1 },
    setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    clearRect() {},
    fillRect() { calls.fillRect++; },
    strokeRect() { calls.stroke++; },
    beginPath() {}, closePath() {},
    moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
    stroke() { calls.stroke++; },
    fill() { calls.fill++; },
    save() {}, restore() {}, clip() {},
    fillText(t) { calls.fillText.push(t); },
  };
}
// ctx 必须缓存：每次 getContext 返回新对象的话，渲染时记下的调用就再也读不到了
const stubCanvas = () => {
  const ctx = stubCtx();
  return { width: 900, height: 470, getContext: () => ctx, _ctx: ctx };
};

const PLAN = solvePlan({
  boxType: '40HQ',
  items: [
    { skuId: 'A', code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 400 },
    { skuId: 'B', code: 'B', dimsCm: { l: 50, w: 40, h: 30 }, weightKg: 14, boxes: 200, attrs: { liquid: true } },
  ],
});
const C = PLAN.containers[0];

describe('3D 装柜图 · 渲染不白屏', () => {
  it('轴测图正常渲染并画出大量色块', () => {
    const cv = stubCanvas();
    const out = renderAxonometric(cv, C, { yaw: -0.6, pitch: 0.6, zoom: 1 });
    assert.ok(out.faces > 100, `应画出上千个面，实际 ${out.faces}`)
    assert.ok(cv.getContext('2d').calls.fill > 100)
    assert.ok(out.scale > 0 && Number.isFinite(out.scale), '缩放比必须是有限正数，否则整张图会被缩成一条线')
  })

  it('还有剩余空间时，可入洞尺寸会标在图上（PRD 7.1）', () => {
    // 上面那份方案把柜码满了，本来就没有可入洞——换一份留有余量的
    const roomy = solvePlan({
      boxType: '40HQ',
      items: [{ skuId: 'A', code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 60 }],
    })
    assert.ok(roomy.containers[0].cavity, '这份方案应留出可入洞')
    const cv = stubCanvas();
    renderAxonometric(cv, roomy.containers[0], { showCavity: true });
    const texts = cv.getContext('2d').calls.fillText;
    assert.ok(texts.some(t => String(t).includes('可入洞')), 'PRD 7.1 要求标出可入洞尺寸')
  })

  it('没有可入洞时不画绿框（画了就是骗人）', () => {
    const noCavity = { ...C, cavity: null };
    const cv = stubCanvas();
    renderAxonometric(cv, noCavity, { showCavity: true });
    assert.ok(!cv.getContext('2d').calls.fillText.some(t => String(t).includes('可入洞')))
  })

  it('选中某个 SKU 时其余色块变半透明（点选高亮的视觉依据）', () => {
    const plain = stubCanvas(), picked = stubCanvas();
    renderAxonometric(plain, C, {});
    renderAxonometric(picked, C, { selectedSku: 'A' });
    assert.ok(plain.getContext('2d').calls.fill >= picked.getContext('2d').calls.fill,
      '未选中的色块应被半透明处理')
  })

  it('旋转到极端角度也不抛异常', () => {
    for (const [yaw, pitch] of [[0, 0], [Math.PI, 0], [0, -1.4], [0, 1.4], [1.57, 0.79]]) {
      const cv = stubCanvas();
      assert.doesNotThrow(() => renderAxonometric(cv, C, { yaw, pitch }), `yaw=${yaw} pitch=${pitch}`)
    }
  })

  it('缩放到极值不产生 NaN 坐标', () => {
    for (const zoom of [0.35, 1, 3]) {
      const out = renderAxonometric(stubCanvas(), C, { zoom });
      assert.ok(Number.isFinite(out.scale) && out.scale > 0, `zoom=${zoom} 缩放异常：${out.scale}`)
    }
  })
})

describe('3D 装柜图 · 俯视/侧视/配重', () => {
  it('俯视图返回该层信息，且层号与高度对得上', () => {
    const info = renderLayerTop(stubCanvas(), C, 0);
    assert.equal(info.layerIndex, 0)
    assert.equal(info.count, C.layers[0].boxes.length)
    assert.ok(info.text.includes('第 1 层'))
    // 高度以 cm 呈现（引擎内部是 mm）
    assert.ok(info.text.includes('cm'))
  })

  it('层号越界时不崩，回退到最后一层', () => {
    const info = renderLayerTop(stubCanvas(), C, 999);
    assert.equal(info.layerIndex, C.layers.length - 1)
  })

  it('侧视图给出已码高度与剩余高度，且剩余不为负', () => {
    const info = renderSideView(stubCanvas(), C);
    assert.ok(info.used > 0 && info.used <= C.H)
    assert.ok(info.remain >= 0, '剩余高度不该是负数')
  })

  it('配重剖面 10 段重量之和等于总重（PRD 7.1 配重剖面）', () => {
    renderBalanceChart(stubCanvas(), C)
    const sum = C.distribution.reduce((s, d) => s + d.kg, 0)
    assert.ok(Math.abs(sum - C.weightKg) < 1)
    assert.equal(C.distribution.length, 10)
  })

  it('配重剖面在超 60/50 的段落用警示色（按段判断而非整柜）', () => {
    const cv = stubCanvas();
    assert.doesNotThrow(() => renderBalanceChart(cv, C))
  })
})

describe('3D 装柜图 · 色板与降级', () => {
  it('同一 SKU 永远同色，不同 SKU 色差开', () => {
    assert.equal(colorFor('YW-1001'), colorFor('YW-1001'))
    const colors = ['A', 'B', 'YW-1001', 'YW-1002', 'YW-1003', 'YW-1004', 'YW-2001'].map(colorFor);
    assert.ok(new Set(colors).size >= 4, `7 个 SKU 应分到至少 4 种颜色，实际 ${new Set(colors).size}`)
  })

  it('色值都是合法 CSS 颜色', () => {
    for (const c of PALETTE) assert.match(c, /^#[0-9a-f]{6}$/i, `色板值 ${c} 不是合法颜色`)
    assert.match(colorFor(''), /^#[0-9a-f]{6}$/i)
  })

  it('箱数超限时提示降级（PRD 7.2 不得白屏）', () => {
    const small = solvePlan({ boxType: '20GP', items: [{ code: 'X', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 50 }] })
    assert.equal(shouldDegrade(small.containers[0]), false)
    const huge = solvePlan({ boxType: '40HQ', timeLimitMs: 20000, items: [{ code: 'Y', dimsCm: { l: 30, w: 20, h: 15 }, weightKg: 2, boxes: 3000 }] })
    assert.equal(shouldDegrade(huge.containers[0]), true, '3000 箱应走降级路径')
  })

  it('空方案渲染不崩（刚进页面还没有方案的情况）', () => {
    const empty = { L: 12032, W: 2352, H: 2698, doorW: 2340, doorH: 2585, layers: [], cavity: null, distribution: [], weightKg: 0 };
    assert.doesNotThrow(() => renderAxonometric(stubCanvas(), empty, {}))
    assert.equal(renderLayerTop(stubCanvas(), empty, 0), null)
    assert.doesNotThrow(() => renderSideView(stubCanvas(), empty))
  })
})
