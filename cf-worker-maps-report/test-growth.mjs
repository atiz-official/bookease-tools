// Local test of the BookEase Growth routes: real worker code, KV and Google mocked.
// Usage: node test-growth.mjs
import assert from 'node:assert/strict';
import worker from './worker.js';

const SHOP = 'ChIJPxz0o_iZ4jARqOODkDRBYCw';
const BLD = 'ChIJ-7PwX7iZ4jARp_rFql-yzO4';
const OTHER = 'ChIJ_not_tracked_000000';

class KV {
  constructor() { this.m = new Map(); this.writes = 0; }
  async get(k, type) { const v = this.m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.writes++; this.m.set(k, v); }
}
const kv = new KV();
// D1 mock: just the two statements the worker uses
const rows = new Map();
const db = { prepare(sql) { return { bind(...v) { return {
  async run() { assert.match(sql, /ON CONFLICT .* n = n \+ 1/); const k = v.slice(0, 4).join(''); rows.set(k, (rows.get(k) || 0) + 1); return {}; },
  async all() { const [since, ...ids] = v; return { results: [...rows].map(([k, n]) => { const [id, day, action, src] = k.split(''); return { id, day, action, src, n }; })
    .filter((r) => r.day >= since && ids.includes(r.id)) }; } }; } }; } };
const env = { GOOGLE_PLACES_KEY: 'test', REPORTS: kv, GROWTH_DB: db };
let open = true, calls = 0;
globalThis.fetch = async (url, init = {}) => {
  calls++;
  const u = String(url);
  if (u.includes('/places/') && !u.includes(':search')) {
    return new Response(JSON.stringify({ id: SHOP, location: { latitude: 13.7154665, longitude: 100.4680209 }, rating: 5, userRatingCount: 17, currentOpeningHours: { openNow: open } }));
  }
  if (u.endsWith('places:searchText')) {
    const body = JSON.parse(init.body);
    const page2 = !!body.pageToken;
    // the shop is 4th on page 1 near the door; absent further out
    const near = Math.abs(body.locationBias.circle.center.latitude - 13.7154665) < 0.01;
    const ids = Array.from({ length: 20 }, (_, i) => `ChIJfiller_${page2 ? 20 + i : i}_xxxxx`);
    if (near && !page2) ids[3] = SHOP;
    return new Response(JSON.stringify({ places: ids.map((id) => ({ id })), nextPageToken: page2 ? undefined : 't' }));
  }
  throw new Error('unexpected fetch ' + u);
};

const ctx = { waitUntil: (p) => p };
const req = (path, body, method = body ? 'POST' : 'GET') => worker.fetch(new Request('https://w.test' + path, {
  method, headers: { Origin: 'https://radar.bookease.co', 'Content-Type': 'text/plain' }, body: body ? JSON.stringify(body) : undefined }), env, ctx);

// set up records the way growth-admin.mjs writes them
await kv.put('g/index', JSON.stringify([{ id: SHOP, kind: 'shop' }, { id: BLD, kind: 'building' }]));
await kv.put(`g/shop/${SHOP}`, JSON.stringify({ id: SHOP, kind: 'shop', name: 'ร้านเสริมสวยลลิศา', cat: 'salon', area: 'thaphra', since: '2026-11-16', buildings: [BLD], active: true }));
await kv.put(`g/shop/${BLD}`, JSON.stringify({ id: BLD, kind: 'building', name: 'Aqua Residences', status: 'sample' }));
await kv.put(`g/log/${SHOP}`, JSON.stringify([{ at: '2026-11-15', what: 'ตรวจ Google Maps 6 จุด', where: 'Google Maps', minutes: null, evidence: '' }]));

// 1. hits: tracked counted, untracked not, bad input refused
let r = await (await req('/hit', { p: SHOP, a: 'call', src: 'site' })).json();
assert.equal(r.counted, true);
await req('/hit', { p: SHOP, a: 'call', src: 'site' });
await req('/hit', { p: BLD, a: 'view', src: 'qr' });
r = await (await req('/hit', { p: OTHER, a: 'call', src: 'site' })).json();
assert.equal(r.counted, false);
let res = await req('/hit', { p: SHOP, a: 'steal', src: 'site' });
assert.equal(res.status, 400);
res = await req('/hit', { p: SHOP, a: 'call', src: '<script>' });
assert.equal(res.status, 400);
assert.equal([...rows.keys()].some((k) => k.startsWith(OTHER)), false);
// 20 taps at the same moment must all count (KV lost these)
await Promise.all(Array.from({ length: 20 }, () => req('/hit', { p: SHOP, a: 'map', src: 'b:x' })));
const counts = (await (await req('/growth?p=' + SHOP)).json()).counts;
assert.equal(Object.values(counts)[0]['call|site'], 2);
assert.equal(Object.values(counts)[0]['map|b:x'], 20);

// 2. snapshot: closed shop is skipped and not retried for 3 hours
open = false;
res = await req('/growth/snap', { p: SHOP });
assert.equal(res.status, 409);
assert.equal((await res.json()).skipped, 'closed');
res = await req('/growth/snap', { p: SHOP });
assert.equal((await res.json()).error, 'not_due'); // retry guard
kv.m.delete(`g/try/${SHOP}`);

// 3. open shop: one check, ranks recorded, under 50 Google calls
open = true; calls = 0;
res = await req('/growth/snap', { p: SHOP });
assert.equal(res.status, 200);
const snap = await res.json();
assert.ok(calls <= 50, `google calls ${calls}`);
assert.equal(snap.keyword, 'ร้านเสริมสวย');
assert.equal(snap.reviews, 17);
assert.equal(snap.spacings.length, 2);
assert.deepEqual(snap.spacings[0].ranks, Array(9).fill(4)); // 500 m: all within 0.01° of the shop
assert.equal(snap.spacings[0].top3, 0);
assert.equal(snap.hub.name, 'MRT ท่าพระ');
console.log('google calls for one weekly check:', calls);

// 4. not due again within 6 days; untracked shop never runs
res = await req('/growth/snap', { p: SHOP });
assert.equal((await res.json()).error, 'not_due');
res = await req('/growth/snap', { p: OTHER });
assert.equal((await res.json()).error, 'not_due');

// 5. cron picks the due shop (history made old)
const hist = JSON.parse(kv.m.get(`g/hist/${SHOP}`));
hist[0].at = new Date(Date.now() - 7 * 86400e3).toISOString();
await kv.put(`g/hist/${SHOP}`, JSON.stringify(hist));
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((ok) => setTimeout(ok, 50));
assert.equal(JSON.parse(kv.m.get(`g/hist/${SHOP}`)).length, 2);

// 6. report data
res = await req('/growth?p=' + SHOP);
const data = await res.json();
assert.equal(data.shop.name, 'ร้านเสริมสวยลลิศา');
assert.equal(data.log.length, 1);
assert.equal(data.hist.length, 2);
assert.equal(data.buildings[0].name, 'Aqua Residences');
assert.equal(Object.values(data.buildings[0].counts)[0]['view|qr'], 1);
res = await req('/growth?p=' + OTHER);
assert.equal(res.status, 404);

// 7. weekly card (approved 2026-11-16): headline · "จากอันดับ p → r" · ค้นหา “…” แถว … · ladder · calls in ครั้ง · one CTA
const cardFor = async (lastRank, prevRank) => {
  const h = JSON.parse(kv.m.get(`g/hist/${SHOP}`));
  h[0].hub = { ...h[0].hub, rank: prevRank }; h[1].hub = { ...h[1].hub, rank: lastRank };
  await kv.put(`g/hist/${SHOP}`, JSON.stringify(h));
  return (await (await req('/growth?p=' + SHOP)).json()).card;
};
const rungs = (c) => c.ladder.map((x) => (x.kind === 'gap' ? '···' : x.n + (x.kind ? `[${x.kind}]` : ''))).join(' ');
assert.match(data.card.url, /growth\/\?p=ChIJ.*#work$/);
assert.equal(data.card.calls, 'กดโทรหาร้าน 2 ครั้ง'); // the two 'call' taps above — taps, not people
assert.equal(data.card.cta, 'ดูว่าเราทำอะไรให้ร้าน');
assert.equal(data.card.where, 'ค้นหา “ร้านเสริมสวย” แถว MRT ท่าพระ');
assert.equal(data.card.did, undefined); // no work checklist on the card
let card = await cardFor(12, 12);
assert.equal(card.tone, 'same'); assert.equal(card.headline, 'ยังอยู่อันดับ 12'); assert.equal(card.from, '');
assert.equal(rungs(card), '1 ··· 11 12[me] 13');
card = await cardFor(5, 6);
assert.equal(card.tone, 'up'); assert.equal(card.headline, 'ขึ้นเป็นอันดับ 5 ↑'); assert.equal(card.from, 'จากอันดับ 6 → 5');
assert.equal(rungs(card), '1 ··· 4 5[me] 6[was]');
card = await cardFor(8, 6);
assert.equal(card.tone, 'down'); assert.equal(card.headline, 'ตกไปอันดับ 8 ↓'); assert.equal(card.from, 'จากอันดับ 6 → 8');
assert.equal(rungs(card), '1 ··· 6[was] 7 8[me]');
card = await cardFor(null, 12);
assert.equal(card.tone, 'down'); assert.equal(card.headline, 'หลุด 40 ร้านแรก ↓'); assert.equal(card.from, 'จากอันดับ 12 → 40+');
card = await cardFor(30, null);
assert.equal(card.tone, 'up'); assert.equal(card.from, 'จากอันดับ 40+ → 30');
for (const r of [[5, 6], [8, 6], [12, 12], [null, 12]]) {
  const c = await cardFor(...r);
  const text = [c.headline, c.from, c.where, c.calls, c.cta].join(' ');
  assert.ok(!/ลูกค้าเพิ่ม|จุด|\/ ?9|คนกดโทร/.test(text), 'banned words: ' + text);
}
const flex = await (await req('/growth/flex?p=' + SHOP)).json();
assert.equal(flex.type, 'flex');
assert.equal(flex.contents.type, 'bubble');
assert.ok(flex.altText.length <= 400);
assert.equal(flex.contents.footer.contents[0].action.uri, card.url);
assert.ok(JSON.stringify(flex).length < 30000, 'flex under LINE size limit');
assert.equal((await req('/growth/flex?p=' + OTHER)).status, 404);

console.log('all growth tests passed · KV writes', kv.writes);
