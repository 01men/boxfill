/**
 * MCP 服务器装配：把共用工具层挂成一个 McpServer。
 *
 * 单独成文件而不是塞在 stdio.js 里，是因为 HTTP 入口也要用它——
 * 两种 transport 共用这一个函数，才谈得上"一套工具定义"。
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, callTool, ToolError } from './tools.js';

/** 会写主数据的工具。给 readOnlyHint 用：Agent 常据此决定要不要先问用户 */
const MUTATING = new Set(['upsert_sku', 'import_pi']);

/**
 * 组装一个已注册全部工具的 McpServer。
 * @param {Store} store 数据口（H5 里是 localStorage 版，服务端是 SQLite 版）
 */
export function buildServer(store) {
  const ctx = { store };
  const server = new McpServer(
    { name: 'boxfill', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toZodShape(tool.inputSchema),
        annotations: { readOnlyHint: !MUTATING.has(tool.name), openWorldHint: false },
      },
      async (args) => {
        try {
          const result = await callTool(ctx, tool.name, args || {});
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: wrapStructured(result),
          };
        } catch (err) {
          // isError 让 Agent 看到"这次调用失败"，而不是把一段错误文本当正常结果。
          // 把 hint 一起带上：只说"尺寸不完整"Agent 不知道该补什么，
          // 补上"三边都要大于 0"它才知道下一步怎么做。
          const msg = err instanceof ToolError
            ? `${err.message}${err.hint ? `\n提示：${err.hint}` : ''}`
            : `执行失败：${err.message}`;
          return { isError: true, content: [{ type: 'text', text: msg }] };
        }
      },
    );
  }
  return server;
}

/**
 * JSON Schema → zod raw shape。
 *
 * MCP 的 registerTool 收 zod shape；本项目的工具定义写 JSON Schema，
 * 是因为 JSON Schema 能原样给 Agent 看、也能被其他客户端复用。
 * 这里做一次机械转换，避免为了协议适配把 schema 写两遍。
 *
 * 只覆盖工具实际用到的关键字——够用就够，不为了"支持完整 JSON Schema"引入依赖。
 */
function toZodShape(schema) {
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    shape[key] = zodFor(prop, !!(schema.required || []).includes(key));
  }
  return shape;
}

function zodFor(prop, required) {
  let inner;
  if (prop.type === 'number') inner = z.number();
  else if (prop.type === 'integer') inner = z.number().int();
  else if (prop.type === 'boolean') inner = z.boolean();
  else if (prop.type === 'array') {
    // 数组元素统一按宽松类型收：items 的细节由 tools.js 的 normalizeItems 校验，
    // 那里的报错信息比 zod 的更具体（会告诉 Agent 缺哪个字段、单位是什么）
    inner = z.array(z.unknown());
  } else if (prop.type === 'object') inner = z.record(z.string(), z.unknown());
  else inner = z.string();

  if (prop.enum) inner = z.enum(prop.enum);
  if (prop.description) inner = inner.describe(prop.description);
  return required ? inner : inner.optional();
}

/** structuredContent 必须是对象，标量结果包一层 */
function wrapStructured(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return { result };
}