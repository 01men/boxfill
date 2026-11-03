/**
 * 零依赖静态服务器，用来本地跑 H5。
 *
 * 为什么需要它：H5 用的是 ES 模块，浏览器在 file:// 下会拒绝加载模块
 * （跨源策略），双击 index.html 一定白屏。`npm start` 起这个服务再访问即可。
 *
 *   node scripts/serve.mjs [端口]
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.argv[2]) || 5173

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    // 路径穿越防护：normalize 之后必须还在 ROOT 之内
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (rel === '' || rel === 'h5') rel = 'h5/index.html'
    const path = join(ROOT, normalize(rel))
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('403');
      return;
    }
    const info = await stat(path).catch(() => null);
    const target = info && info.isDirectory() ? join(path, 'index.html') : path;
    const buf = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
})

server.listen(PORT, () => {
  console.log(`介绍页（首页）  →  http://localhost:${PORT}/h5/`)
  console.log(`智能装箱 H5    →  http://localhost:${PORT}/h5/app.html`)
  console.log(`旧版单箱计算器 →  http://localhost:${PORT}/index.html`)
})
