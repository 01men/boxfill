/**
 * DSH 插件契约测试。
 *
 * 守的是什么：插件注册的工具名不能悄悄变（DSH 会话里 Agent 按名字调），
 * 暴露的工具集合不能越界（建档类不该在一次会话里写进内存库再丢掉），
 * 以及插件跑出来的数必须跟共用实现一致——不是另写一份算法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, name as pluginName, inject } from '../dsh-plugin/index.mjs';
import { TOOLS } from '../server/tools.js';

/** 起一个假 ctx，把注册到的工具收集起来。 */
function collect() {
  const registered = [];
  apply({ tools: { register: (def) => registered.push(def) } }, {});
  return registered;
}

test('插件声明了 DSH 需要的导出', () => {
  assert.equal(pluginName, 'boxfill-container-packing');
  assert.deepEqual(inject, ['tools']);
});

test('注册 7 个工具，命名统一带 boxfill_ 前缀', () => {
  const names = collect().map((d) => d.name);
  assert.equal(names.length, 7);
  for (const n of names) {
    assert.ok(n.startsWith('boxfill_'), `工具名应以 boxfill_ 开头：${n}`);
  }
  assert.ok(names.includes('boxfill_plan_containers'));
  assert.ok(names.includes('boxfill_calc_freight'));
  assert.ok(names.includes('boxfill_suggest_consolidation'));
});

test('暴露的工具都在共用注册表里存在（不是另写一份）', () => {
  const shared = new Set(TOOLS.map((t) => t.name));
  for (const def of collect()) {
    const bare = def.name.replace(/^boxfill_/, '');
    assert.ok(shared.has(bare), `共用注册表里没有 ${bare}`);
  }
});

test('不暴露建档类工具（主数据不该在会话内存库里写完就丢）', () => {
  const names = collect().map((d) => d.name);
  for (const forbidden of ['boxfill_upsert_sku', 'boxfill_import_pi', 'boxfill_gen_docs']) {
    assert.ok(!names.includes(forbidden), `不应暴露 ${forbidden}`);
  }
});

test('plan_containers 的出参与共用实现一致', async () => {
  const def = collect().find((d) => d.name === 'boxfill_plan_containers');
  const res = await def.execute({
    items: [{ code: 'A-001', nameCn: '陶瓷杯', dimsCm: { l: 60, w: 40, h: 50 }, weightKg: 12, boxes: 20 }],
  });
  assert.equal(res.boxType, '20GP');
  assert.equal(res.containers, 1);
  assert.equal(res.totals.boxes, 20);
  assert.equal(res.totals.cbm, 2.4);
  assert.deepEqual(res.spill, []);
  assert.deepEqual(res.violations, []);
});

test('尺寸不完整时报错并说清缺什么（不是一句 undefined）', async () => {
  const def = collect().find((d) => d.name === 'boxfill_plan_containers');
  await assert.rejects(
    () => def.execute({ items: [{ code: 'B-1', dimsCm: { l: 60, w: 40 }, weightKg: 5, boxes: 1 }] }),
    /尺寸不完整|三边都要大于 0/,
  );
});

test('工具 schema 来自共用注册表，不是手抄', () => {
  const def = collect().find((d) => d.name === 'boxfill_plan_containers');
  const shared = TOOLS.find((t) => t.name === 'plan_containers');
  assert.equal(def.description, shared.description);
  assert.deepEqual(Object.keys(def.parameters.properties), Object.keys(shared.inputSchema.properties));
});
