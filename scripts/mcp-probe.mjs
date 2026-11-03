/**
 * MCP 服务器自检：起一个 client 连上去，列出工具并真调一次。
 *
 * 为什么需要它：协议层的问题（schema 转换写错、transport 接错、stdout 被日志污染）
 * 在"能启动"和"能跑测试"之间是看不见的——单测只覆盖业务逻辑，
 * 而 Agent 能不能真的用上，取决于这一层。这个脚本把两件事一次性验掉：
 *   ① tools/list 能拿到全部工具，描述与 schema 都在
 *   ② tools/call 能返回一个 Agent 可直接使用的结构化结果
 *
 *   npm run mcp:probe          # 验 stdio
 *   npm run mcp:probe -- http  # 验 HTTP（需先起 mcp:http）
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] || 'stdio';

/** 用临时库，绝不碰用户真实数据 —— 自检脚本没有理由写坏生产库 */
const dbDir = mkdtempSync(join(tmpdir(), 'boxfill-probe-'));
const dbFile = join(dbDir, 'probe.db');

let ok = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

async function probe(transport, label) {
  console.log(`\n==> ${label}`);
  const client = new Client({ name: 'boxfill-probe', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  check(`列出 ${tools.length} 个工具`, tools.length >= 10, `实际 ${tools.length}`);
  check('每个工具都有描述', tools.every(t => t.description && t.description.length > 10));
  check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

  const names = tools.map(t => t.name);
  for (const must of ['plan_containers', 'calc_freight', 'suggest_consolidation', 'gen_docs', 'import_pi', 'analyze_photo']) {
    check(`含关键工具 ${must}`, names.includes(must));
  }

  // 真调一次主入口：Agent 能不能用，全看这个
  const res = await client.callTool({
    name: 'plan_containers',
    arguments: {
      items: [{ code: 'BX-1001', dimsCm: { l: 60, w: 40, h: 35 }, weightKg: 8, boxes: 500 }],
    },
  });
  check('plan_containers 返回非错误', !res.isError, res.content?.[0]?.text?.slice(0, 120));
  const payload = JSON.parse(res.content[0].text);
  check('返回了柜数与利用率', payload.containers >= 1 && typeof payload.totals.utilVol === 'number');
  check('structuredContent 可用', !!res.structuredContent && typeof res.structuredContent.containers === 'number');

  // 写库 → 再查回：验证 SQLite 真的落盘了
  const up = await client.callTool({
    name: 'upsert_sku',
    arguments: { code: 'PROBE-1', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12 },
  });
  check('upsert_sku 成功', !up.isError, up.content?.[0]?.text?.slice(0, 120));
  const list = await client.callTool({ name: 'list_skus', arguments: { query: 'PROBE' } });
  const listed = JSON.parse(list.content[0].text);
  check('写入后可查回（SQLite 落盘）', listed.count === 1, `查到 ${listed.count} 条`);

  // 错误路径：脏数据要给出可执行的提示，而不是 undefined 或堆栈
  const bad = await client.callTool({
    name: 'plan_containers',
    arguments: { items: [{ code: 'X', dimsCm: { l: 60, w: 40 }, weightKg: 8, boxes: 10 }] },
  });
  check('脏输入返回 isError', bad.isError === true);
  check('错误信息含可执行提示', /提示/.test(bad.content[0].text), bad.content[0].text.slice(0, 100));

  await client.close();
}

try {
  if (MODE === 'http') {
    const url = process.env.BOXFILL_HTTP || 'http://localhost:8787/mcp';
    await probe(new StreamableHTTPClientTransport(new URL(url)), `HTTP @ ${url}`);
  } else {
    // 只 spawn client 内部那一个 server 进程；这里再起一个的话两个进程会抢同一个库，
    // 自检就变成了"测 SQLite 并发"——那不是它该验的东西
    await probe(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, 'server', 'stdio.js')],
        env: { ...process.env, BOXFILL_DB: dbFile },
        stderr: 'pipe',
      }),
      'stdio',
    );
  }
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${ok} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);