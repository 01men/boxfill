/**
 * HTTP 服务的集成测试：真起一个服务（随机端口、临时库），用 fetch 打端点。
 *
 * REST 视觉端点不在 MCP 协议里，probe 覆盖不到；而这里的每一个断言
 * 都对应一次真实事故：q.get 不是函数（500）、超限先验格式（错误报错）、
 * 砸连接导致客户端收不到 413（ECONNRESET）。协议层 bug 只有用真 HTTP 才能抓到。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { startHttpServer } from '../server/http.js'

/* ── 合成 PNG（与 tests/vision.test.mjs 同一套工具函数） ── */

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const i of buf) c = CRC[(c ^ i) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, cr])
}
/** 深色垫板 + 600×400 亮箱体，1000×800 画布 */
function boxPhoto() {
  const W = 1000, H = 800, box = { x: 200, y: 100, w: 600, h: 400 }
  const raw = Buffer.alloc((W * 3 + 1) * H)
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0
    for (let x = 0; x < W; x++) {
      const v = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h ? 180 : 25
      raw[o++] = v; raw[o++] = v; raw[o++] = v
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── 起服务：随机端口 + 临时库，进程结束自动清理 ── */

const dir = mkdtempSync(join(tmpdir(), 'bx-http-'))
let base = null
let stop = null

async function ensureServer() {
  if (base) return base
  const { httpServer, port } = await startHttpServer({
    port: 0, host: '127.0.0.1', dbFile: join(dir, 't.db'), log: false,
  })
  base = `http://127.0.0.1:${port}`
  stop = () => new Promise(r => httpServer.close(r))
  return base
}

after(async () => {
  if (stop) await stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('HTTP 视觉端点 · /api/vision/analyze', () => {
  it('PNG 直传 + 标定参数 → 量出尺寸，带免责声明与可编辑标记', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze?refRealCm=50&refPx=600`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: boxPhoto(),
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.ok(Math.abs(j.dimsCm.l - 50) < 1, `长 ${j.dimsCm.l}`)
    assert.match(j.disclaimer, /仅供参考/)
    assert.equal(j.editable, true)
  })

  it('JSON base64 分支同样可用', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: boxPhoto().toString('base64'), refRealCm: 50, refPx: 600 }),
    })
    const j = await res.json()
    assert.equal(res.status, 200)
    assert.equal(j.ok, true)
    assert.ok(j.dimsCm.l > 49 && j.dimsCm.l < 51)
  })

  it('业务失败（没参照物）是 200 + ok:false，与请求错误区分开', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: boxPhoto(),
    })
    assert.equal(res.status, 200, '拍得不好是正常业务结果，不是接口错误')
    const j = await res.json()
    assert.equal(j.ok, false)
    assert.ok(j.warnings.some(w => w.code === 'NEED_CALIBRATION'))
  })

  it('非 PNG → 400 + 可执行提示', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('not png'),
    })
    assert.equal(res.status, 400)
    const j = await res.json()
    assert.match(j.error, /PNG/)
    assert.ok(j.hint)
  })

  it('超限图片 → 413，且客户端能收到响应（不能砸连接给 ECONNRESET）', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024) },
      body: Buffer.alloc(10 * 1024 * 1024),
    })
    assert.equal(res.status, 413)
    const j = await res.json()
    assert.match(j.error, /8MB/)
  })

  it('GET 请求 → 405 并说明用法', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/vision/analyze`)
    assert.equal(res.status, 405)
  })

  it('/api/health 探活', async () => {
    const url = await ensureServer()
    const res = await fetch(`${url}/api/health`)
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.ok(j.tools >= 12)
  })

  it('同一进程重复 startHttpServer 被拒绝（防端口意外二次占用）', async () => {
    await ensureServer()
    // startHttpServer 的守卫是同步 throw，包一层 async 让 rejects 接得住
    await assert.rejects(
      async () => startHttpServer({ port: 0, dbFile: join(dir, 'x.db'), log: false }),
      /已在运行/,
    )
  })
})
