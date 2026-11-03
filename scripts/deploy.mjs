/**
 * 部署到 Cloudflare Worker（boxfill.ybkkasi.com）。
 *
 *   npm run deploy            部署并端到端验证
 *   npm run deploy -- --dry   只跑本地检查，不动线上
 *
 * 为什么要单独包一层，而不是直接把 wrangler 命令写进 package.json：
 * ① 本机 DNS 把 dash.cloudflare.com 劫持到黑洞，wrangler 需要 dnsfix.cjs 猴补丁，
 *    路径含空格还要额外加引号（见 cloudflare 工作区 README §6.1）——写在 package.json
 *    里没法可靠地处理这些引号；
 * ② 部署完必须验证。wrangler 说 "Published" 不等于用户能打开：DNS 记录、证书、
 *    缓存策略任一处不对，页面表现都是"打不开"，而工具人分不清是网络还是站点挂了。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CF_WS = join(process.env.HOME, 'Documents', 'cloudflare 工作区')
const DNSFIX = join(CF_WS, 'dnsfix.cjs')
const HOST = 'boxfill.ybkkasi.com'
const DRY = process.argv.includes('--dry')

const NODE_BIN = join(process.env.HOME, '.local', 'node-v22', 'bin')
const WRANGLER = join(NODE_BIN, 'wrangler')

/* ── 部署前的本地检查 ─────────────────────────────────────────────
   这些检查放在部署之前，是因为部署要花几十秒，而下面几项任何一条不过，
   线上必然是一个打不开或者白屏的页面。 */
function preflight() {
  const problems = []
  const mustExist = ['h5/index.html', 'h5/app.html', 'h5/css/app.css', 'h5/js/app.js', 'worker.js', 'wrangler.toml']
  for (const f of mustExist) {
    if (!existsSync(join(ROOT, f))) problems.push(`缺少文件 ${f}`)
  }
  // 两个 HTML 入口里的 ES 模块引用都必须能对到实际文件：错一个就是整页白屏。
  // index.html 是介绍页（站点首页），app.html 是工具本体。
  for (const entry of ['h5/index.html', 'h5/app.html']) {
    if (!existsSync(join(ROOT, entry))) continue
    const html = readFileSync(join(ROOT, entry), 'utf8')
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      const ref = m[1].replace(/^\.?\//, '')
      if (!existsSync(join(ROOT, 'h5', ref))) problems.push(`${entry} 引用了不存在的 ${ref}`)
    }
    // worker.js 的 CSP 是 script-src 'self'，内联脚本会被浏览器直接拒掉。
    // 介绍页的复制按钮全靠那段脚本，误写成内联的话线上就是一个不会动的按钮。
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      problems.push(`${entry} 里有内联脚本，会被 CSP script-src 'self' 拦掉，请外置到 js/`)
    }
  }
  if (!existsSync(WRANGLER)) problems.push(`找不到 wrangler（${WRANGLER}）`)
  if (!existsSync(DNSFIX)) problems.push(`找不到 dnsfix.cjs（${DNSFIX}），本机 DNS 会劫持 dash.cloudflare.com`)

  if (problems.length) {
    console.error('部署前检查未通过：')
    for (const p of problems) console.error('  ✗ ' + p)
    process.exit(1)
  }
  console.log(`==> 本地检查通过（${mustExist.length} 个关键文件齐全）`)
}

function run(cmd, args, env, label) {
  return new Promise((resolve) => {
    console.log(`==> ${label}`)
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    })
    child.on('close', code => resolve(code))
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 取一份**完整**的响应。
 *
 * 两个绕不开的现实（工作区 README §6.1 / §9 都有记录）：
 *  ① 本机 DNS 时不时把域名解析到黑洞，Node 内置 fetch 直接 "fetch failed"；
 *  ② 即使连上了，响应体也经常传到一半断流（200 + 正确 content-length，body 却缺一截）。
 *
 * 所以验证不走 Node fetch，改用 curl + 从 1.1.1.1 取真实 IP 直连（cfapi.sh 同一套办法），
 * 并按 content-length 判完整性。curl 的退出码与字节数都拿得到，判断才靠得住。
 */
function exec(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = Buffer.alloc(0), err = ''
    child.stdout.on('data', d => { out = Buffer.concat([out, d]) })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => resolve({ code: -1, buf: Buffer.alloc(0), err: String(e.message) }))
    child.on('close', code => resolve({ code, buf: out, err }))
  })
}

const curl = args => exec('curl', args)

/**
 * 从公共解析器取真实边缘 IP，绕开本机 DNS 劫持；拿不到就退回系统解析。
 *
 * 注意必须用 dig 而不是 curl 去问 1.1.1.1：`@1.1.1.1` 是 dig 的查询语法，
 * 传给 curl 会被当成 URL 的一部分，结果永远拿不到地址，验证脚本会一路报"解析失败"。
 */
async function realEdgeIp() {
  const r = await exec('dig', ['+short', '@1.1.1.1', HOST, 'A']);
  if (r.code !== 0) return null;
  const ip = r.buf.toString().trim().split('\n')[0].trim();
  return /^[0-9.]+$/.test(ip) ? ip : null;
}

/**
 * 取 api.cloudflare.com 的真实 IP（部署 wrangler 用）。
 *
 * 本机 DNS 会把它劫持到 103.73.220.188（自签证书黑洞），wrangler 的所有 API 调用
 * 全部 "fetch failed"——工作区 dnsfix.cjs 只钉了 dash，没管 api（2026-10-09 实测翻车）。
 * 逐个试公共解析器，1.1.1.1 在这条网络上时通时断，223.5.5.5 最稳。
 */
async function realApiIp() {
  for (const resolver of ['223.5.5.5', '1.1.1.1', '8.8.8.8']) {
    const r = await exec('dig', ['+short', `@${resolver}`, 'api.cloudflare.com', 'A']);
    if (r.code !== 0) continue;
    const ip = r.buf.toString().split('\n').map(s => s.trim()).find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    if (ip) return ip;
  }
  return null;
}

/**
 * 生成临时的 dns 猴补丁：把 api.cloudflare.com 钉到真实 IP。
 * 先 require 工作区的 dnsfix（保住 dash 的补丁），再补上它漏掉的 api 域名。
 */
function makeApiPinFile(apiIp) {
  const file = join(tmpdir(), `boxfill-apipin-${process.pid}.cjs`);
  writeFileSync(file, `// 自动生成（scripts/deploy.mjs），用完即删
try { require(${JSON.stringify(DNSFIX)}); } catch {}
const dns = require('node:dns');
const orig = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (hostname !== 'api.cloudflare.com') return orig.call(dns, hostname, options, callback);
  let opts = options, cb = callback;
  if (typeof options === 'function') { cb = options; opts = {}; }
  const all = !!(opts && opts.all);
  const entry = { address: ${JSON.stringify(apiIp)}, family: 4 };
  process.nextTick(() => (all ? cb(null, [entry]) : cb(null, entry.address, 4)));
};
`);
  return file;
}

async function fetchFull(path, tries = 6) {
  const edge = await realEdgeIp();
  const resolveArgs = edge ? ['--resolve', `${HOST}:443:${edge}`] : [];
  const tmp = join(tmpdir(), `boxfill-verify-${process.pid}-${Math.abs(hash(path))}.bin`);
  let lastReason = '未知';
  for (let i = 0; i < tries; i++) {
    // body 落盘、状态信息走 stdout：两路分开，就不会再出现"正文被当成状态行切掉一字节"
    // 这种解析歧义（之前按字节位置切分，硬是把 23140 字节的文件判成 23139）。
    const res = await curl([
      '-s', '--max-time', '25',
      ...resolveArgs,
      '-o', tmp,
      '-w', '%{http_code} %{size_download} %{content_type}',
      `https://${HOST}${path}`,
    ]);
    const clean = () => { try { unlinkSync(tmp) } catch { /* 临时文件，删不掉也无所谓 */ } };

    if (res.code !== 0) {
      clean();
      lastReason = res.code === 6
        ? '本机 DNS 解析不到该域名，且公共解析也没取到边缘 IP（工作区 §6.1 记录过 DNS 劫持）'
        : res.code === 28
          ? `连接/读取超时（curl ${res.code}）`
          : `curl 退出码 ${res.code}：${res.err.trim().split('\n').pop() || '无输出'}`;
      await sleep(2500);
      continue;
    }

    const [code, size, type] = res.buf.toString('utf8').trim().split(/\s+/);
    if (code !== '200') {
      clean();
      lastReason = `HTTP ${code}`;
      await sleep(2500);
      continue;
    }

    let buf;
    try {
      buf = readFileSync(tmp);
    } catch {
      lastReason = '响应体落盘失败';
      await sleep(2500);
      continue;
    }
    clean();

    // size_download 是 curl 实际收到的字节数，与文件大小不一致 = 本机断流
    if (buf.length < Number(size)) {
      lastReason = `响应被截断（收到 ${buf.length}/${size} 字节，本机网络断流）`;
      await sleep(2500);
      continue;
    }
    return { ok: true, text: buf.toString('utf8'), buf, type: type || '', tries: i + 1, networkFailures: i };
  }
  return { ok: false, reason: lastReason };
}

const hash = str => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
};

/** 响应头（只查首页够用了） */
async function fetchHeaders() {
  const edge = await realEdgeIp()
  const resolveArgs = edge ? ['--resolve', `${HOST}:443:${edge}`] : []
  const res = await curl(['-s', '--max-time', '20', '-D', '-', '-o', '/dev/null', ...resolveArgs, `https://${HOST}/`])
  return res.code === 0 ? res.buf.toString('utf8') : ''
}

/** 线上验证：状态码 + 关键文件真的取到了完整内容 */
async function verify() {
  const checks = [
    // 首页除原有文案外，还必须含 contact-channels 元素——联系我们的入口不能只在本地有
    { path: '/', must: /该用几个柜[\s\S]*contact-channels/, name: '首页(介绍页)' },
    // CF 静态资产会把 /app.html 307 到无扩展名的 /app（美化 URL），查 /app 才是真实入口
    { path: '/app', must: /物流箱体测算/, name: '工具入口' },
    { path: '/js/app.js', must: /applyHash|installDshApi/, name: '主控模块' },
    { path: '/js/core/engine.js', must: /solvePlan/, name: '装箱引擎' },
    { path: '/js/vision/ocr.js', must: /readScale|SEG_MASK/, name: '秤屏 OCR' },
    { path: '/js/vision/camera.js', must: /startCamera|liveVerdict/, name: '采集管线' },
    { path: '/js/core/billing.js', must: /buildBilling|chargeableKg/, name: '运费测算' },
    { path: '/css/app.css', must: /tabs-bottom/, name: '样式表' },
    // 介绍页：演示脚本 import 了引擎，任一环 404 都会让演示区整块空白
    { path: '/js/tree.js', must: /mountDemo/, name: '演示模块' },
    { path: '/js/intro.js', must: /copy-prompt/, name: '介绍页交互' },
    { path: '/css/intro.css', must: /demo-stage/, name: '介绍页样式' },
    { path: '/contact-channels/contact-channels.js', must: /contact-channels/, name: '联系组件' },
  ]
  const edge = await realEdgeIp()
  console.log(`==> 线上验证 ${HOST}${edge ? `（直连边缘 ${edge}）` : '（走系统 DNS）'}`)
  let bad = 0
  for (const c of checks) {
    const r = await fetchFull(c.path)
    if (!r.ok) {
      bad++
      console.log(`  ✗ ${c.name.padEnd(10)} ${c.path.padEnd(22)} ${r.reason}`)
      continue
    }
    if (!c.must.test(r.text)) {
      bad++
      console.log(`  ✗ ${c.name.padEnd(10)} ${c.path.padEnd(22)} 内容不匹配（返回的不是预期文件）`)
      continue
    }
    const note = r.tries > 1 ? `（重试 ${r.tries} 次）` : ''
    console.log(`  ✓ ${c.name.padEnd(10)} ${c.path.padEnd(22)} 200 · ${r.buf.length} 字节 · ${(r.type || '').split(';')[0]}${note}`)
  }

  const hdr = await fetchHeaders()
  const camOk = /permissions-policy:[^\r\n]*camera=\(self\)/i.test(hdr)
  const cspOk = /content-security-policy:/i.test(hdr)
  if (!camOk) bad++
  if (!cspOk) bad++
  console.log(`  ${camOk ? '✓' : '✗'} 摄像头权限声明 camera=(self)`)
  console.log(`  ${cspOk ? '✓' : '✗'} CSP 响应头`)

  if (bad) {
    console.error(`\n线上验证有 ${bad} 项不通过，先分清是哪一类：`)
    console.error('  · 报「响应被截断 / 解析不到域名」→ 本机网络问题，不是部署问题；等网络恢复后重跑，或直接用手机打开看。')
    console.error('  · 报「HTTP 404」→ 资产没上传成功，检查 wrangler.toml 的 assets.directory。')
    console.error('  · 报「内容不匹配」→ 边缘缓存了旧版本，改一下文件名或等边缘失效。')
    process.exitCode = 1
  } else {
    console.log(`\n完成 → https://${HOST}/`)
    console.log('手机上打开这个地址即可用（摄像头需要 HTTPS，本部署已满足）。')
  }
}

async function main() {
  preflight()
  if (DRY) {
    console.log('dry-run：本地检查通过，未执行部署。去掉 --dry 即可真正发布。')
    return
  }

  const env = { PATH: `${NODE_BIN}:${process.env.PATH}` }
  const apiIp = await realApiIp()
  if (apiIp) {
    const pinFile = makeApiPinFile(apiIp)
    env.NODE_OPTIONS = `--require "${pinFile}"`
    console.log(`==> api.cloudflare.com 劫持规避：钉到 ${apiIp}`)
  } else if (existsSync(DNSFIX)) {
    // 公共 DNS 也解析不到时不钉 api，退回原行为——成败看运气，但至少和以前一样
    env.NODE_OPTIONS = `--require "${DNSFIX}"`
  }
  env.npm_config_registry = 'https://registry.npmmirror.com'

  const code = await run(WRANGLER, ['deploy'], env, 'wrangler deploy')
  if (apiIp) unlinkSync(join(tmpdir(), `boxfill-apipin-${process.pid}.cjs`))
  if (code !== 0) {
    console.error('wrangler deploy 失败，未做任何后续操作。')
    process.exit(code || 1)
  }
  await verify()
}

main()
