/**
 * MCP 服务器 · HTTP 形态（Streamable HTTP transport）。
 *
 * 给远程/多端 Agent 用（DSH、WorkBuddy 服务端、以及多个客户端共享一份数据）。
 * 与 stdio 共用 buildServer()——工具的 schema、描述、错误处理只有一份，
 * 不存在"HTTP 版和 stdio 版工具行为不一致"这回事。
 *
 *   node server/http.js                       # 默认 127.0.0.1:8787/mcp
 *   PORT=9000 HOST=0.0.0.0 node server/http.js
 *
 * ── 为什么默认只听 127.0.0.1 ────────────────────────────────────────
 * 这个服务**没有鉴权**：任何能访问端口的人都能读全部主数据、改主数据。
 * 默认绑回环地址，让"忘了配鉴权就暴露到公网"这件事不发生。
 * 真要对外暴露，至少得在前面挂一层带鉴权的反代——那是部署决策，不该由本进程默认替你做。
 *
 * 多用户隔离同理：现在是单库单账本。要多店铺隔离应给每个店铺一个
 * BOXFILL_DB，或按 client 身份分库（见 README 的多租户一节）。
 */

import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { buildServer } from './mcp-server.js';
import { TOOLS } from './tools.js';
import { openStore, defaultDbPath } from './sqlite-storage.js';
import { analyzeImage, MAX_IMAGE_BYTES, DISCLAIMER } from './vision.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PATHNAME = process.env.MCP_PATH || '/mcp';

/**
 * 每个会话一个 McpServer 实例。
 *
 * MCP 的 session 是有状态的（客户端的 initialize → notifications/initialized → 调用），
 * 多个客户端共用一个实例会串号，所以按 sessionId 分开建。
 *
 * store/sessions/httpServer 由 startHttpServer() 装配（见文件末尾）：
 * 做成可导出的函数而不是模块顶层直接 listen，集成测试才能用随机端口起服务。
 */
const sessions = new Map();
let store = null;

function newSession() {
  const server = buildServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, { server, transport }); },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };
  return { server, transport };
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    // 走到这里说明协议层出了非预期问题：回 JSON-RPC error 而不是让连接裸死，
    // 否则 Agent 只能看到"连接断开"，无从判断是自己的请求有问题还是服务端坏了
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err && err.message || err) }, id: null }));
    } else {
      res.end();
    }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  // ── REST 端点（给 H5 网页直连用，不走 MCP 协议）────────────────────
  if (url.pathname === '/api/vision/analyze') return handleVision(req, res);
  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, tools: TOOLS.length, node: process.version });
  }

  // MCP 的 JSON-RPC 走 POST + JSON body；Node 的 http 不解析请求体，
  // 而 transport 期待 req.body 已经是对象，所以这里必须自己读一次
  req.body = await readJsonBody(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version, last-event-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (url.pathname !== PATHNAME) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`Not Found。MCP 端点是 ${PATHNAME}\n`);
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  const entry = sessionId ? sessions.get(sessionId) : null;

  // 无 sessionId 的 initialize 请求 → 建新会话；其余必须走已有会话
  if (!entry) {
    if (sessionId) {
      res.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '会话不存在或已过期，请重新 initialize' }, id: null }));
      return;
    }
    const created = newSession();
    await created.server.connect(created.transport);
    await created.transport.handleRequest(req, res, req.body);
    return;
  }
  await entry.transport.handleRequest(req, res, req.body);
}

/** 读 JSON 请求体；空体（GET/SSE 通知）返回 undefined 而不是报错 */
function readJsonBody(req) {
  if (req.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      // 防御性上限：主数据导入可能很大，但 64MB 足够，再大就该走文件而不是 MCP
      if (raw.length > 64 * 1024 * 1024) {
        reject(new Error('请求体超过 64MB'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`请求体不是合法 JSON：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

/** 读二进制请求体（PNG 原图直传） */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = Object.assign(new Error('图片过大'), { code: 'TOO_LARGE' });
    // content-length 在头里就能看到：超限直接拒，别把 body 读进来浪费带宽
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();   // 把剩余 body 冲掉而不是砸连接——砸了客户端只会看到 ECONNRESET，收不到 413
      return reject(tooLarge);
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // chunked 上传没有长度头，读超了才拦：同样冲掉剩余、保住连接
        req.removeAllListeners('data');
        req.resume();
        return reject(tooLarge);
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * POST /api/vision/analyze —— 云端视觉解析（附赠能力）
 *
 * 两种请求体都收：
 *   · multipart 不支持（省掉 formidable 依赖），因此约定
 *     content-type: image/png → body 直接是 PNG 字节，参数走 query string
 *     content-type: application/json → { imageBase64, roi, refRealCm, ... }
 *
 * 失败一律返回 200 + ok:false？**不**——参数错误回 4xx，让调用方能区分
 * "图片拍糊了"（200 + ok:false，正常的业务失败）和"请求本身有问题"（4xx）。
 */
async function handleVision(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: '请用 POST', hint: '上传 PNG 并带上 roi / refRealCm 参数' });
  }

  try {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
    let imagePng;
    let opts;

    if (ct === 'application/json') {
      const body = JSON.parse((await readRawBody(req, 24 * 1024 * 1024)).toString('utf8') || '{}');
      const b64 = String(body.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
      if (!b64) return json(res, 400, { ok: false, error: '缺少 imageBase64' });
      imagePng = Buffer.from(b64, 'base64');
      opts = body;
    } else if (ct === 'image/png' || ct === '') {
      // 参数从 query 读：?roi=0.2,0.1,0.6,0.5&refRealCm=29.7&refPx=297&scaleRegion=0.2,0.7,0.6,0.2
      // 注意取的是 searchParams——URL 对象本身没有 .get()
      const q = new URL(req.url, 'http://x').searchParams;
      imagePng = await readRawBody(req, MAX_IMAGE_BYTES);
      opts = {
        roi: parseRect(q.get('roi')),
        scaleRegion: parseRect(q.get('scaleRegion')),
        refRealCm: numOrUndef(q.get('refRealCm')),
        refPx: numOrUndef(q.get('refPx')),
        scaleUnit: q.get('scaleUnit') || 'kg',
        tareKg: numOrUndef(q.get('tareKg')),
      };
    } else {
      return json(res, 415, { ok: false, error: `不支持的 content-type: ${ct}`, hint: '用 image/png 或 application/json' });
    }

    const result = analyzeImage(imagePng, opts);
    // 解析失败（拍糊了/没标定）是**正常业务结果**，不是接口错误 → 200
    return json(res, 200, result);
  } catch (err) {
    const isVisionError = err && err.name === 'VisionError';
    if (err && err.code === 'TOO_LARGE') {
      return json(res, 413, { ok: false, error: '图片超过 8MB 上限', hint: '等比缩到 1600px 以内再上传' });
    }
    if (isVisionError) {
      return json(res, 400, { ok: false, error: err.message, hint: err.hint, disclaimer: DISCLAIMER });
    }
    return json(res, 500, { ok: false, error: `解析失败：${err && err.message || err}`, disclaimer: DISCLAIMER });
  }
}

/** "?roi=0.2,0.1,0.6,0.5" → {x,y,w,h}；解析不了就 undefined（由 vision 层兜底） */
function parseRect(s) {
  if (!s) return null;
  const p = String(s).split(',').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null;
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}
function numOrUndef(s) {
  if (s == null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 装配并启动 HTTP 服务。
 *
 * 导出而不是模块顶层直接 listen：集成测试要用随机端口（port: 0）起停服务，
 * 而被 import 时绝不该占端口。正式启动仍由 `node server/http.js` 走 main 分支。
 *
 * @returns {Promise<{httpServer, store, port:number}>}
 */
export function startHttpServer({ port = PORT, host = HOST, dbFile, log = true } = {}) {
  if (store) throw new Error('HTTP 服务已在运行（本进程只允许一个实例）');
  store = openStore({ file: dbFile || process.env.BOXFILL_DB || defaultDbPath() });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      const actual = httpServer.address().port;
      if (log) {
        // 日志走 stdout 是安全的：HTTP 模式下 stdout 不是协议通道
        console.log(`[boxfill] MCP HTTP 已启动 → http://${host}:${actual}${PATHNAME}`);
        console.log(`[boxfill] 工具 ${TOOLS.length} 个 · 库：${dbFile || process.env.BOXFILL_DB || defaultDbPath()}`);
        console.log(`[boxfill] 视觉解析（附赠）→ POST http://${host}:${actual}/api/vision/analyze`);
        if (host !== '127.0.0.1' && host !== 'localhost') {
          console.warn('[boxfill] ⚠ 监听非回环地址且无鉴权：任何能连到本端口的客户端都能读写全部主数据。');
        }
      }
      resolve({ httpServer, store, port: actual });
    });
  });
}

/** 优雅退出：关会话、关端口。测试环境不注册（进程由测试自己收） */
function installShutdownHooks() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[boxfill] 收到 ${sig}，关闭 ${sessions.size} 个会话`);
      for (const { transport } of sessions.values()) {
        try { transport.close(); } catch { /* 关不上也不该拦下退出 */ }
      }
      httpServer.close(() => process.exit(0));
    });
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  startHttpServer()
    .then(() => installShutdownHooks())
    .catch(err => {
      console.error('[boxfill] 启动失败：', err);
      process.exit(1);
    });
}