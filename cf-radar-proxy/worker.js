/**
 * radar.bookease.co serves the Shop Radar pages from the bookease-tools repo (main branch), address bar stays short.
 *   /            → radar/index.html          (search + report)
 *   /guide/      → radar/guide/index.html    (neighbourhood guide preview)
 *   /brand/*, /favicon.ico, /images/* → same path at the repo root (the radar pages link to ../brand etc.)
 * Fetched from raw.githubusercontent.com because make.bookease.co (GitHub Pages, DNS-only) loops when fetched from a
 * Worker on the same zone. Raw content is cached by GitHub for about 5 minutes after a push.
 */
const RAW = 'https://raw.githubusercontent.com/atiz-official/bookease-tools/main';
const ROOT_PATHS = ['/brand/', '/favicon.ico', '/images/'];
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', json: 'application/json; charset=utf-8' };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/guide' || url.pathname === '/next') return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    let path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    if (path.includes('..')) return new Response('Not found', { status: 404 });
    if (!ROOT_PATHS.some((p) => url.pathname.startsWith(p))) path = `/radar${path}`;
    let res;
    try {
      res = await fetch(`${RAW}${path}`, { cf: { cacheTtl: 120, cacheEverything: true } });
    } catch (e) {
      console.error('[radar-proxy] upstream fetch failed', path, e);
      return new Response('Shop Radar is unavailable, please try again', { status: 502 });
    }
    if (res.status === 404) return new Response('Not found', { status: 404 });
    if (!res.ok) { console.error('[radar-proxy] upstream status', res.status, path); return new Response('Shop Radar is unavailable, please try again', { status: 502 }); }
    const ext = (path.split('.').pop() || '').toLowerCase();
    return new Response(res.body, { status: 200, headers: {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === 'html' ? 'public, max-age=60' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    } });
  },
};
