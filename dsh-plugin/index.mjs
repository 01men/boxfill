/**
 * boxfill DSH 插件 —— 让 DSH 会话里的 Agent 直接测算装柜方案、运费与拼单。
 *
 * 设计约束（与 kizuna 插件同源，刻意为之）：
 * - **零外部依赖**：不 import `@deepseek-ai/*`。npm 上的 dsh-tools 版本与 profile 内置版本
 *   不一致，声明依赖会在安装期拉错版本。工具定义按原生 ToolRuntime 契约手写
 *   （name / description / parameters / output{schema,render} / execute）。
 * - **只用仓库内的共用实现**：直接 import `../h5/js/core/*` 的引擎、计费、拼单，
 *   与 H5 网页端、MCP 服务端跑的是同一份代码 —— 三端结果必然一致。
 * - **工具 schema 不重抄**：输入 schema 直接取自 `server/tools.js` 的注册表，
 *   免得同一份定义写两遍然后各自漂移。
 * - **主数据落在插件自己的内存库里**：DSH 会话没有浏览器 localStorage，用内存存储兜底；
 *   需要持久化主数据的场景走 MCP 服务端（`npm run mcp:http`）。
 */

import { Store } from '../h5/js/core/store.js'
import { TOOLS, callTool } from '../server/tools.js'

export const name = 'boxfill-container-packing'
export const inject = ['tools']

/** 内存存储：DSH 进程内有效，进程结束即丢。 */
function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

/**
 * 暴露给 DSH 的工具清单。
 * 只开「读多写少、纯计算」的工具：算方案、算运费、算拼单、查柜型、查单据。
 * 建档类（upsert_sku / import_pi）不在此列 —— 主数据是业务事实，
 * 不该在一次会话里悄悄写进内存库然后丢掉。
 */
const EXPOSED = [
  { tool: 'plan_containers', name: 'boxfill_plan_containers' },
  { tool: 'calc_freight', name: 'boxfill_calc_freight' },
  { tool: 'suggest_consolidation', name: 'boxfill_suggest_consolidation' },
  { tool: 'check_fits', name: 'boxfill_check_fits' },
  { tool: 'list_containers', name: 'boxfill_list_containers' },
  { tool: 'list_orders', name: 'boxfill_list_orders' },
  { tool: 'get_order_boxes', name: 'boxfill_get_order_boxes' },
]

export function apply(ctx, config) {
  const store = new Store({
    storage: memoryStorage(),
    now: () => new Date().toISOString(),
  })
  const toolCtx = { store }

  for (const entry of EXPOSED) {
    const def = TOOLS.find((t) => t.name === entry.tool)
    if (!def) continue
    ctx.tools.register({
      name: entry.name,
      description: def.description,
      parameters: toParameters(def.inputSchema),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return await callTool(toolCtx, entry.tool, args || {})
      },
    })
  }
}

/**
 * 工具层的 JSON Schema → DSH 工具定义要的 parameters。
 * 保持 JSON Schema 原文（不转 zod），Agent 读到的字段说明与 MCP 客户端完全一致。
 */
function toParameters(schema) {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const params = { type: 'object', properties: {}, additionalProperties: false }
  for (const [key, prop] of Object.entries(properties)) {
    params.properties[key] = { ...prop, required: required.has(key) }
  }
  if (required.size) params.required = [...required]
  return params
}
