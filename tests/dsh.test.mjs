/**
 * DSH 端集成层测试。
 *
 * 这一层是给外部插件（dsh-lc-parser 之类）用的，一旦破坏，坏的是别人家的流程，
 * 而且往往在我们自己这边测不出来。所以重点断言两条兼容性承诺：
 *   ① 不认识的参数只忽略、不报错（插件可以先升级自己再升级这边）
 *   ② 单位与口径锁死（cm / kg），插件传错单位要被挡住而不是被默默接受
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseHash, applyHash, installDshApi, buildShareLink } from '../h5/js/dsh.js'
import { Store } from '../h5/js/core/store.js'

function newStore() {
  const mem = new Map()
  return new Store({
    storage: {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k),
    },
    online: true,
  })
}

/** dsh.js 内部会读 location.hash；测试里塞一个假的 */
function withHash(hash, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location')
  const saved = globalThis.location
  globalThis.location = { hash, protocol: 'https:', hostname: 'localhost' }
  try { return fn(); } finally {
    if (had) globalThis.location = saved; else delete globalThis.location
  }
}

describe('DSH 集成 · URL hash 预填', () => {
  it('解析标准参数：货号 + 三边 + 重量 + 箱数', () => {
    const h = withHash('#sku=YW-1001&l=40&w=30&h=25&wt=12&qty=260', () => parseHash());
    assert.equal(h.items.length, 1);
    const it = h.items[0];
    assert.equal(it.code, 'YW-1001');
    assert.deepEqual(it.dimsCm, { l: 40, w: 30, h: 25 });
    assert.equal(it.weightKg, 12);
    assert.equal(it.boxes, 260);
  });

  it('尺寸归一（长≥宽≥高），传反顺序也认得', () => {
    const h = withHash('#sku=A&l=25&w=40&h=30&wt=12&qty=10', () => parseHash());
    assert.deepEqual(h.items[0].dimsCm, { l: 40, w: 30, h: 25 });
  });

  it('柜型容错：40hq / 40-HQ 都认得', () => {
    for (const v of ['40HQ', '40hq', '40-HQ', '40 hq']) {
      const h = withHash(`#type=${encodeURIComponent(v)}&sku=A&l=40&w=30&h=25&wt=1&qty=1`, () => parseHash());
      assert.equal(h.boxType, '40HQ', `${v} 应解析为 40HQ`);
    }
  });

  it('只给总体积不给箱数时反推件数', () => {
    const h = withHash('#sku=A&l=50&w=40&h=30&wt=8&cbm=6', () => parseHash());
    assert.equal(h.items.length, 1);
    assert.ok(h.items[0].boxes > 0, '应反推出箱数');
  });

  it('不认识的参数被忽略，不报错（插件可以先升级自己）', () => {
    const h = withHash('#sku=A&l=40&w=30&h=25&wt=12&qty=10&futureField=999&anotherOne=xyz', () => parseHash());
    assert.equal(h.items.length, 1);
    assert.equal(h.items[0].boxes, 10);
  });

  it('缺重量或缺尺寸时不产出半截数据', () => {
    const noWt = withHash('#sku=A&l=40&w=30&h=25&qty=10', () => parseHash());
    assert.equal(noWt.items.length, 0, '缺毛重不能入库——没重量算不了运费也算不了限重');
    const noDim = withHash('#sku=A&wt=12&qty=10', () => parseHash());
    assert.equal(noDim.items.length, 0, '缺尺寸不能入库——装柜靠尺寸');
  });

  it('没有 hash 时返回 null，不抛错', () => {
    assert.equal(withHash('', () => parseHash()), null);
  });

  it('带订单信息时一并解析出目的港与订单', () => {
    const h = withHash('#order=PO-1&customer=Al%20Noor&port=Jebel%20Ali&vessel=MAERSK&sku=A&l=40&w=30&h=25&wt=12&qty=50', () => parseHash());
    assert.equal(h.order.code, 'PO-1');
    assert.equal(h.order.customer, 'Al Noor');
    assert.equal(h.order.port, 'Jebel Ali');
    assert.equal(h.port, 'Jebel Ali');
  })

  it('applyHash 把数据落进 store，坏数据被挡在门外', () => {
    const store = newStore();
    withHash('#sku=YW-9&l=40&w=30&h=25&wt=12&qty=100&port=Hamburg', () => applyHash(store));
    assert.equal(store.listSkus().length, 1);
    assert.equal(store.listSkus()[0].code, 'YW-9');
    assert.equal(store.listOrders().length, 1);
    assert.equal(store.listOrders()[0].port, 'Hamburg');

    const store2 = newStore();
    withHash('#sku=BAD&l=40&w=30&h=25&qty=100', () => applyHash(store2));
    assert.equal(store2.listSkus().length, 0, '缺毛重的行不应进主数据');
  })

  it('buildShareLink 生成可跳转的链接，空值不带进去', () => {
    const link = buildShareLink('https://x.cn/h5/', { type: '40HQ', sku: 'A1', port: '' });
    assert.ok(link.startsWith('https://x.cn/h5/#'));
    assert.ok(link.includes('type=40HQ'));
    assert.ok(!link.includes('port='), '空值不该出现在链接里');
    assert.equal(buildShareLink('https://x.cn/h5/', {}), 'https://x.cn/h5/');
  })
})

describe('DSH 集成 · JS API', () => {
  function setup() {
    const store = newStore()
    const state = { lines: [], screen: 'measure' }
    const calls = { toast: [], screens: [], modals: [] }
    const api = installDshApi({
      store, state,
      go: s => calls.screens.push(s),
      toast: m => calls.toast.push(m),
      modal: (t) => calls.modals.push(t),
      closeModal: () => {},
      getPlan: () => state.plan || null,
      solve: () => ({ items: [] }),
    })
    return { store, state, api, calls }
  }

  it('solve 返回可直接用的摘要，插件不用解析方案结构', () => {
    const { api } = setup()
    const r = api.solve({
      items: [{ code: 'A', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 500 }],
      boxType: 'AUTO',
      costs: { freightPerCbm: 280, thc: 1800 },
    })
    assert.equal(r.ok, true)
    assert.ok(r.summary.containers >= 1)
    assert.ok(r.summary.cbm > 0)
    assert.equal(r.summary.isLight, true, '抛比 95 应判为抛货')
    assert.equal(typeof r.summary.chargeableKg, 'number')
    assert.ok(Array.isArray(r.summary.violations))
  })

  it('solve 遇到非法输入时返回错误对象而不是抛异常', () => {
    const { api } = setup()
    const r = api.solve({ items: [{ code: 'X', dimsCm: { l: 10, w: 10, h: 10 } }] })
    assert.equal(r.ok, false)
    assert.ok(r.error && r.error.length > 0)
  })

  it('upsertSku 拒绝缺尺寸或重量的数据（单位错/字段漏都不放行）', () => {
    const { api } = setup()
    assert.equal(api.upsertSku({ code: 'A' }).ok, false)
    assert.equal(api.upsertSku({ code: 'A', dimsCm: { l: 40, w: 30, h: 25 } }).ok, false)
    assert.equal(api.upsertSku({ code: 'A', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12 }).ok, true)
  })

  it('importCSV 认得中文表头并自动建缺失的 SKU', () => {
    const { api, store } = setup()
    const csv = '货号,品名,长,宽,高,毛重,箱数,订单号,目的港\nYW-1,陶瓷杯,40,30,25,12,100,PO-1,Jebel Ali\nYW-2,餐垫,45,35,12,3.5,200,PO-1,Jebel Ali'
    const r = api.importCSV(csv)
    assert.equal(r.ok, true)
    assert.equal(r.skus, 2)
    assert.equal(r.orders, 1)
    assert.equal(store.listOrders()[0].lines.length, 2)
  })

  it('重复导入同一份 CSV 不会产生重复 SKU', () => {
    const { api, store } = setup()
    const csv = '货号,长,宽,高,毛重,箱数\nYW-1,40,30,25,12,100'
    api.importCSV(csv)
    api.importCSV(csv)
    assert.equal(store.listSkus().length, 1)
  })

  it('addLines 同 SKU 累加箱数', () => {
    const { api, state } = setup()
    api.addLines([{ skuId: 'S1', code: 'S1', boxes: 100 }])
    api.addLines([{ skuId: 'S1', code: 'S1', boxes: 50 }])
    assert.equal(state.lines.length, 1)
    assert.equal(state.lines[0].boxes, 150)
  })

  it('getPlan 在没有方案时给出明确错误，不返回半个对象', () => {
    const { api } = setup()
    const r = api.getPlan()
    assert.equal(r.ok, false)
    assert.ok(r.error)
  })

  it('export 在没有方案时明确失败', () => {
    const { api } = setup()
    assert.equal(api.export('csv').ok, false)
  })

  it('goto 只认四个合法屏，非法值被忽略', () => {
    const { api, calls } = setup()
    api.goto('calc')
    api.goto('admin')
    assert.deepEqual(calls.screens, ['calc'])
  })
})
