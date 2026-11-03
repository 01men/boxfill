/**
 * MCP 服务器 · stdio 形态。
 *
 * 给本机的 Agent 工具用（Claude Code、WorkBuddy 等）：进程起在用户机器上，
 * 数据在本地 SQLite，stdin/stdout 走 JSON-RPC。这是**接入成本最低**的形态——
 * Agent 配置里写一行命令就能连上，不用开端口、不用 TLS。
 *
 *   node server/stdio.js
 *   # 指定库位置：BOXFILL_DB=/path/to/boxfill.db node server/stdio.js
 *
 * 工具的 schema 与行为全在 mcp-server.js（与 HTTP 入口共用），
 * 业务实现在 tools.js（与 H5 共用）。本文件只负责"用 stdio 把它跑起来"。
 *
 * ── 一条铁律 ────────────────────────────────────────────────────────
 * stdout 是 JSON-RPC 通道，**任何日志写 stdout 都会污染协议流、把连接搞崩**。
 * 所以这个文件里没有 console.log；需要提示时一律走 console.error（走 stderr）。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './mcp-server.js';
import { TOOLS } from './tools.js';
import { openStore, defaultDbPath } from './sqlite-storage.js';

async function main() {
  const dbPath = process.env.BOXFILL_DB || defaultDbPath();
  const store = openStore({ file: dbPath });
  const server = buildServer(store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 只走 stderr：stdout 是协议通道
  console.error(`[boxfill] MCP stdio 已启动 · 库：${dbPath} · 工具 ${TOOLS.length} 个`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  main().catch(err => {
    console.error('[boxfill] 启动失败：', err);
    process.exit(1);
  });
}