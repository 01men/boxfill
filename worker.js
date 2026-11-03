/**
 * boxfill Worker —— 只干两件事：回静态资源、给缓存策略钉死边界。
 *
 * 为什么需要这个 worker（而不是纯静态部署）：
 * 仓库网络差、用户随时刷新。没有缓存策略的话，边缘可能把旧的 app.js 缓存很久，
 * 用户点了半天看到的还是上个月的排布逻辑，然后得出"这工具不准"的结论——
 * 比工具本身有 bug 更难查。所以这里把缓存分成两类：
 *   · index.html（介绍页）/ app.html（工具）永远 no-cache（保证拿到的是最新版本与入口）
 *   · js/css      短缓存 + ETag，兼顾"改完立刻生效"与"弱网少下载"
 *
 * 另外补几条安全响应头。这个工具会读摄像头、存货号与货值，
 * 不希望被嵌进别人的页面里，也不希望浏览器把带参数的报错页缓存下来。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 仓库里用的都是相对路径，禁止跳出 assets 目录
    if (url.pathname.includes('..')) {
      return new Response('Not Found', { status: 404 });
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);

    const isEntry = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.html';
    if (isEntry) {
      headers.set('Cache-Control', 'no-cache, must-revalidate');
    } else if (/\.(js|css)$/.test(url.pathname)) {
      headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
    } else {
      headers.set('Cache-Control', 'public, max-age=3600');
    }

    // 摄像头是 HTTPS 专属能力，这里明确只允许同源调用，不给外站开口子
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=()',
    );
    // 这个页面只用摄像头，不加载任何外部脚本/字体/样式。
    // 收紧 CSP 顺带挡掉"第三方 CDN 挂了导致整个工具白屏"这类远程故障。
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; "
      + "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; "
      + "media-src 'self' blob:; base-uri 'none'; form-action 'none'",
    );

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
