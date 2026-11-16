// Local test of BookEase Growth payments: real worker + growth-pay code, real SQLite (D1 stand-in), Xendit mocked.
// Usage: node test-pay.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

// D1 stand-in on node:sqlite (prepare → bind → run/first/all)
const sq = new DatabaseSync(':memory:');
sq.exec(readFileSync(new URL('./growth-schema.sql', import.meta.url), 'utf8'));
const db = { prepare(sql) { const st = sq.prepare(sql); const mk = (v) => ({
  async run() { const r = st.run(...v); return { meta: { changes: Number(r.changes) } }; },
  async first() { return st.get(...v) || null; },
  async all() { return { results: st.all(...v) }; } });
  return { bind: (...v) => mk(v), ...mk([]) }; } };

// Xendit mock
const invoices = new Map(); let created = 0; let lastAuth = '';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  lastAuth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  if (u === 'https://xendit.mock/v2/invoices' && init.method === 'POST') {
    created++; const b = JSON.parse(init.body);
    const inv = { id: `inv_${created}`, external_id: b.external_id, amount: b.amount, currency: b.currency, status: 'PENDING', invoice_url: `https://checkout.mock/${created}`, expiry_date: new Date(Date.now() + 86400e3).toISOString(), _body: b };
    invoices.set(inv.id, inv); return new Response(JSON.stringify(inv), { status: 200 });
  }
  const m = u.match(/^https:\/\/xendit\.mock\/v2\/invoices\/(.+)$/);
  if (m) { const inv = invoices.get(decodeURIComponent(m[1])); return new Response(JSON.stringify(inv || { error_code: 'NOT_FOUND' }), { status: inv ? 200 : 404 }); }
  throw new Error('unexpected fetch ' + u);
};

const base = { GOOGLE_PLACES_KEY: 'test', REPORTS: { get: async () => null, put: async () => {} }, GROWTH_DB: db, XENDIT_API_BASE_URL: 'https://xendit.mock' };
const on = { ...base, GROWTH_PAY: 'on', XENDIT_SECRET_KEY: 'xnd_development_TEST', XENDIT_CALLBACK_TOKEN: 'cb_token', GROWTH_ADMIN_TOKEN: 'admin' };
const call = async (env, method, path, { body, headers = {}, origin = 'https://radar.bookease.co' } = {}) => {
  const h = { ...headers }; if (origin) h.Origin = origin; if (body) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request('https://w.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
};
const SHOP = 'ChIJPxz0o_iZ4jARqOODkDRBYCw';

// 1. switched off → nothing created
let r = await call(base, 'POST', '/growth/checkout', { body: { placeId: SHOP, tier: 1000 } });
assert.equal(r.status, 503); assert.equal(r.data.error, 'payments_off'); assert.equal(created, 0);

// 2. bad tier / client-chosen amount is impossible
r = await call(on, 'POST', '/growth/checkout', { body: { placeId: SHOP, tier: 1, amount: 1 } });
assert.equal(r.data.error, 'bad_tier'); assert.equal(created, 0);

// 3. checkout → one invoice, amount from tier, THB, external_id = order id, auth = collect key
r = await call(on, 'POST', '/growth/checkout', { body: { placeId: SHOP, tier: 2000, shopName: 'ร้านเสริมสวยลลิศา', returnUrl: 'https://radar.bookease.co/offer/?p=x&c=salon' } });
assert.equal(r.status, 200); const o = r.data.order;
assert.match(o.orderId, /^growth-[A-Za-z0-9]{10}-\d{6}-[a-z0-9]{6}$/); assert.equal(o.amount, 2000); assert.equal(o.status, 'PENDING');
const inv = invoices.get('inv_1'); assert.equal(inv._body.amount, 2000); assert.equal(inv._body.currency, 'THB'); assert.equal(inv._body.external_id, o.orderId);
assert.ok(inv._body.success_redirect_url.startsWith('https://radar.bookease.co/offer/?p=')); assert.ok(inv._body.success_redirect_url.includes(o.orderId)); assert.ok(inv._body.success_redirect_url.includes('&c=salon'));
assert.equal(lastAuth, 'Basic ' + btoa('xnd_development_TEST:'));

// 4. second tap same shop/tier/month → same order, no second invoice
r = await call(on, 'POST', '/growth/checkout', { body: { placeId: SHOP, tier: 2000 } });
assert.equal(r.data.order.orderId, o.orderId); assert.equal(created, 1);

// 5. status while unpaid stays PENDING
r = await call(on, 'GET', `/growth/order?id=${o.orderId}`); assert.equal(r.data.order.status, 'PENDING');

// 6. paid at Xendit but WRONG amount → REVIEW, never PAID
const o2 = (await call(on, 'POST', '/growth/checkout', { body: { placeId: 'ChIJ_other_shop_1234', tier: 1000 } })).data.order;
const inv2 = [...invoices.values()].find((i) => i.external_id === o2.orderId); inv2.status = 'PAID'; inv2.paid_amount = 999;
sq.prepare('UPDATE growth_orders SET checked_at = 0').run();
r = await call(on, 'GET', `/growth/order?id=${o2.orderId}`); assert.equal(r.data.order.status, 'REVIEW');

// 7. webhook with wrong token → 403, no change; with token → re-reads Xendit (body is not trusted)
inv.status = 'PAID'; inv.paid_amount = 2000; inv.paid_at = new Date().toISOString(); inv.payment_channel = 'PROMPTPAY';
r = await call(on, 'POST', '/growth/xendit-webhook', { origin: '', headers: { 'x-callback-token': 'nope' }, body: { external_id: o.orderId, status: 'PAID' } });
assert.equal(r.status, 403);
r = await call(on, 'POST', '/growth/xendit-webhook', { origin: '', headers: { 'x-callback-token': 'cb_token' }, body: { external_id: o.orderId, status: 'PAID', amount: 1 } });
assert.equal(r.status, 200);
r = await call(on, 'GET', `/growth/order?id=${o.orderId}`); assert.equal(r.data.order.status, 'PAID'); assert.equal(r.data.order.invoiceUrl, undefined);

// 8. duplicate webhook / re-check → still one PAID row, paid_at unchanged
const paidAt = sq.prepare('SELECT paid_at FROM growth_orders WHERE order_id = ?').get(o.orderId).paid_at;
await call(on, 'POST', '/growth/xendit-webhook', { origin: '', headers: { 'x-callback-token': 'cb_token' }, body: { external_id: o.orderId } });
assert.equal(sq.prepare('SELECT paid_at FROM growth_orders WHERE order_id = ?').get(o.orderId).paid_at, paidAt);
assert.equal(sq.prepare("SELECT COUNT(*) n FROM growth_orders WHERE status = 'PAID'").get().n, 1);

// 9. paid this month → checkout returns the paid order, no new invoice
r = await call(on, 'POST', '/growth/checkout', { body: { placeId: SHOP, tier: 2000 } });
assert.equal(r.data.order.status, 'PAID'); assert.equal(created, 2);

// 10. lost webhook: cron sweep alone confirms payment
const o3 = (await call(on, 'POST', '/growth/checkout', { body: { placeId: 'ChIJ_third_shop_5678', tier: 3000 } })).data.order;
const inv3 = [...invoices.values()].find((i) => i.external_id === o3.orderId); inv3.status = 'SETTLED'; inv3.paid_amount = 3000;
await worker.scheduled({ cron: '*/10 * * * *' }, on, { waitUntil: async (p) => p });
await new Promise((res) => setTimeout(res, 50));
assert.equal(sq.prepare('SELECT status FROM growth_orders WHERE order_id = ?').get(o3.orderId).status, 'PAID');

// 11. team list needs the admin token
assert.equal((await call(on, 'GET', '/growth/orders')).status, 403);
r = await call(on, 'GET', '/growth/orders', { headers: { authorization: 'Bearer admin' } });
assert.equal(r.data.orders.length, 3);

// 12. next month = renewal = a new order (period differs)
assert.equal(new Set(sq.prepare('SELECT period FROM growth_orders').all().map((x) => x.period)).size, 1);
console.log('test-pay: all 12 checks passed');
