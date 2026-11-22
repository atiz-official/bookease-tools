// Local test of the lead-list routes (leads.js): real worker code; KV, D1, Google and the CMS session check mocked.
// Usage: node test-leads.mjs
import assert from 'node:assert/strict';
import worker from './worker.js';
import { scoreLead, leadMessage } from './leads.js';

class KV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}
const kv = new KV();
// D1 mock: hits rows keyed id|day|action|src; answers the three statements leads.js uses.
const hits = new Map();
const db = { prepare(sql) { return { bind(...v) { return {
  async run() { assert.match(sql, /ON CONFLICT/); const k = v.slice(0, 4).join('|'); hits.set(k, (hits.get(k) || 0) + 1); return {}; },
  async all() {
    const rows = [...hits].map(([k, n]) => { const [id, day, action, src] = k.split('|'); return { id, day, action, src, n }; });
    if (/action = 'demo'/.test(sql)) {
      const by = {};
      rows.filter((r) => r.action === 'demo').forEach((r) => { const x = (by[r.src] = by[r.src] || { src: r.src, first: r.day, last: r.day, n: 0 }); x.n += r.n; });
      return { results: Object.values(by) };
    }
    return { results: rows.filter((r) => v.includes(r.id) && ['call', 'map', 'web', 'line', 'book'].includes(r.action)) };
  } }; } }; } };
const env = { GOOGLE_PLACES_KEY: 'test', REPORTS: kv, GROWTH_DB: db };

const PAID = 'ChIJpaid_customer_00001';
kv.m.set('g/index', JSON.stringify([{ id: PAID, kind: 'shop' }]));
kv.m.set(`g/shop/${PAID}`, JSON.stringify({ name: 'ร้านที่จ่ายแล้ว', since: '2026-11-19' }));
kv.m.set(`g/billing/${PAID}`, JSON.stringify({ plan: 'basic', priceTHB: 1290, paidAt: '2026-11-19', paymentVerified: true, receipt: 'X' }));
hits.set(`${PAID}|2026-11-20|call|qr`, 2);

const C = { latitude: 13.8255, longitude: 100.6779 };
const place = (id, dLat, extra = {}) => ({ id, displayName: { text: `ร้าน ${id.slice(-3)}` }, formattedAddress: 'กทม',
  location: { latitude: C.latitude + dLat, longitude: C.longitude }, rating: 4.5, userRatingCount: 60, businessStatus: 'OPERATIONAL', ...extra });
let googleCalls = 0, session = true;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/admin/cms/session')) return new Response('{}', { status: session ? 200 : 401 });
  googleCalls++;
  if (u.endsWith('places:searchText')) {
    const body = JSON.parse(init.body);
    if (body.pageToken) return new Response(JSON.stringify({ places: [] }));
    return new Response(JSON.stringify({ places: [
      place('ChIJtop_ranked_one_001', 0.001, { nationalPhoneNumber: '02 111 1111', websiteUri: 'https://a.co' }), // rank 1
      place('ChIJrank_two_000000002', 0.002),
      place('ChIJrank_three_00000003', 0.003),
      place('ChIJrank_four_000000004', 0.004, { nationalPhoneNumber: '081 000 0000' }), // rank 4 + phone + no web → top lead
      place(PAID, 0.001), // a paying shop: never in a lead list
      place('ChIJfar_away_0000000006', 0.2, { nationalPhoneNumber: '081' }), // 22 km: outside the area
      place('ChIJclosed_00000000007', 0.001, { businessStatus: 'CLOSED_PERMANENTLY' }),
    ], nextPageToken: 'n' }));
  }
  if (u.endsWith('places:searchNearby')) return new Response(JSON.stringify({ places: [place('ChIJunseen_nearby_0008', 0.0005, { userRatingCount: 3 })] }));
  if (u.includes('/places/ChIJlandmark')) return new Response(JSON.stringify({ id: 'ChIJlandmark_000000000', location: C }));
  throw new Error(`unexpected fetch ${u}`);
};
const call = async (path, body) => {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: 'POST', headers: { Origin: 'https://bookease.co' }, body: JSON.stringify(body) }), env, {});
  return { status: res.status, data: await res.json() };
};
const ok = (c, m) => { assert.ok(c, m); console.log('PASS', m); };

// scoring + message
const s = scoreLead({ phone: '081', reviews: 60, rank: 4, rating: 4.5, website: '' });
ok(s.score === 10 && s.why.includes('อันดับ 4 (ยังไม่ติด 3 อันดับแรก)'), 'score: phone + reviews + rank 4 + rating + no web = 10');
ok(scoreLead({ phone: '', reviews: 5, rank: 2, rating: 4, website: 'x' }).score === 0, 'score: already top, no phone = 0');
const msg = leadMessage({ name: 'ร้าน A', area: 'รามอินทรา', label: 'คลินิกความงาม', demo: 'https://radar.bookease.co/?p=x&c=clinic&l=abcdefgh' });
ok(msg.includes('ในย่านรามอินทรา') && msg.includes('LINE @bookease') && !/AI|Growth|จุด|\/9/.test(msg), 'message: area words, no banned words');

// auth
session = false;
ok((await call('/leads/admin/list', { token: 'x'.repeat(20) })).status === 401, 'list needs a CMS login');
session = true;
const T = { token: 't'.repeat(24) };

// build by landmark
googleCalls = 0;
const b = await call('/leads/admin/build', { ...T, area: 'รามอินทรา', b: 'ChIJlandmark_000000000', radius: 2000, cats: ['clinic', 'nail'] });
ok(b.status === 200, `build answers 200 (${b.status} ${JSON.stringify(b.data).slice(0, 80)})`);
const leads = b.data.batch.leads;
ok(googleCalls === 1 + 2 * 3, `google calls = landmark + 3 per type (${googleCalls})`);
ok(!leads.some((l) => l.placeId === PAID), 'paying shop left out');
ok(!leads.some((l) => /far_away|closed/.test(l.placeId)), 'outside-area and closed-for-good shops left out');
ok(leads[0].placeId === 'ChIJrank_four_000000004', `best lead first (${leads[0].placeId})`);
ok(leads.find((l) => l.placeId === 'ChIJunseen_nearby_0008').rank === null, 'nearby shop not in the 40 → rank null');
ok(/^https:\/\/radar\.bookease\.co\/\?p=ChIJrank_four_000000004&c=clinic&l=[a-z0-9]{8}$/.test(leads[0].demo), 'demo link carries place, type, lead id');
ok(leads[0].message.includes(leads[0].demo), 'message carries the demo link');

// same shop keeps its id in a second list
const b2 = await call('/leads/admin/build', { ...T, area: 'รามอินทรา', lat: C.latitude, lng: C.longitude, cats: ['clinic'] });
ok(b2.data.batch.leads.find((l) => l.placeId === leads[0].placeId).id === leads[0].id, 'same shop → same lead id across lists');
ok((await call('/leads/admin/build', { ...T, area: '', lat: 1, lng: 1, cats: ['clinic'] })).status === 400, 'area required');
ok((await call('/leads/admin/build', { ...T, area: 'x', lat: 1, lng: 1, cats: ['nope'] })).status === 400, 'unknown type refused');

// demo opens: real id counts, fake id and wrong place do not; no login needed
const L = leads[0];
ok((await call('/lead/open', { l: L.id, p: L.placeId })).data.counted === true, 'open counted');
await call('/lead/open', { l: L.id, p: L.placeId });
ok((await call('/lead/open', { l: 'zzzzzzzz' })).data.counted === false, 'unknown lead id not counted');
ok((await call('/lead/open', { l: L.id, p: 'ChIJother_place_000000' })).data.counted === false, 'wrong place not counted');
ok((await call('/lead/open', { l: '<script>' })).data.counted === false, 'junk id not counted');

// mark contacted
const m = await call('/leads/admin/mark', { ...T, id: L.id, contacted: true, note: 'โทรแล้ว เจ้าของให้ส่ง LINE' });
ok(m.status === 200 && m.data.lead.contactedAt && m.data.lead.note.startsWith('โทรแล้ว'), 'mark contacted + note');

// list: lists, opens, customers with actions
const list = (await call('/leads/admin/list', T)).data;
ok(list.batches.length === 2, 'two lists');
ok(list.opens[L.id] && list.opens[L.id].n === 2, `opens counted per lead (${JSON.stringify(list.opens[L.id])})`);
ok(list.batches.flatMap((x) => x.leads).filter((l) => l.id === L.id && l.contactedAt).length >= 1, 'contacted saved in its list');
ok(list.customers.length === 1 && list.customers[0].billing.paidAt === '2026-11-19', 'paying shop + billing for the funnel');
ok(list.actions[PAID]['2026-11-20'].call === 2, 'customer actions per paying shop');
console.log('all lead tests passed');
