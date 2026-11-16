// BookEase Growth · payments (Xendit hosted invoice = "Payment Link").
//
// One order = one invoice, keyed by order_id (also Xendit external_id).
// Amount comes ONLY from the tier table below — never from the page.
// An order turns PAID only after we read the invoice back from Xendit's API and the
// amount, currency and external_id all match. The webhook (if ever pointed here) is just a
// "please check now" signal: we never trust its body.
// Status is re-checked when the shopper returns from the payment page and by the cron,
// so a missing webhook never leaves a paid order unconfirmed.
//
// Secrets (Worker secrets, never in code): XENDIT_SECRET_KEY (collect key only — never the disburse key),
// XENDIT_CALLBACK_TOKEN (dashboard "Verification Token", only if a webhook is ever routed here),
// GROWTH_ADMIN_TOKEN (team view of orders).
// Switch: GROWTH_PAY = "on". Off (or no key) → /growth/checkout answers payments_off and nothing is created.

export const TIERS = { 1000: 'ให้ลูกค้าแถวร้านเจอคุณก่อน', 2000: 'ให้ลูกค้าเลือกร้านคุณ', 3000: 'ให้ร้านเด่นกว่าร้านอื่น' };
const INVOICE_SECONDS = 24 * 3600;
const RECHECK_MS = 20 * 1000; // don't ask Xendit about the same order more often than this

const bkk = (t = Date.now()) => new Date(t + 7 * 3600e3);
export const periodOf = (t = Date.now()) => bkk(t).toISOString().slice(0, 7).replace('-', ''); // YYYYMM, Bangkok
const placeOk = (v) => /^[A-Za-z0-9_-]{10,200}$/.test(v || '');
const orderOk = (v) => /^growth-[A-Za-z0-9_-]{4,40}-\d{6}-[a-z0-9]{6}$/.test(v || '');
const apiBase = (env) => (env.XENDIT_API_BASE_URL || 'https://api.xendit.co').replace(/\/$/, '');
const auth = (env) => 'Basic ' + btoa(`${env.XENDIT_SECRET_KEY}:`);
export const payEnabled = (env) => env.GROWTH_PAY === 'on' && !!env.XENDIT_SECRET_KEY && !!env.GROWTH_DB;

function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function newOrderId(placeId, period) {
  const tail = placeId.replace(/[^A-Za-z0-9]/g, '').slice(-10);
  const rnd = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return `growth-${tail}-${period}-${rnd}`;
}

const pub = (o) => o && ({ orderId: o.order_id, status: o.status, tier: o.tier, amount: o.amount, shop: o.shop_name, period: o.period, invoiceUrl: o.status === 'PENDING' ? o.invoice_url : undefined, paidAt: o.paid_at || undefined });

async function getOrder(env, orderId) {
  return env.GROWTH_DB.prepare('SELECT * FROM growth_orders WHERE order_id = ?').bind(orderId).first();
}

/**
 * Create (or re-use) the order + Xendit invoice for one shop, one tier, this month.
 * Re-uses an open invoice for the same shop/tier/month instead of making a second one.
 */
export async function checkout(env, { placeId, tier, shopName, returnUrl }) {
  if (!payEnabled(env)) return { error: 'payments_off', status: 503 };
  if (!placeOk(placeId)) return { error: 'bad_place_id', status: 400 };
  const amount = Number(tier);
  if (!TIERS[amount]) return { error: 'bad_tier', status: 400 };
  const name = String(shopName || '').slice(0, 120) || placeId;
  const period = periodOf();
  const now = Date.now();

  const open = await env.GROWTH_DB.prepare(
    "SELECT * FROM growth_orders WHERE place_id = ? AND tier = ? AND period = ? AND status = 'PENDING' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(placeId, amount, period, now + 10 * 60 * 1000).first();
  if (open) return { order: pub(open) };

  const already = await env.GROWTH_DB.prepare(
    "SELECT * FROM growth_orders WHERE place_id = ? AND period = ? AND status = 'PAID' LIMIT 1",
  ).bind(placeId, period).first();
  if (already) return { order: pub(already) };

  const orderId = newOrderId(placeId, period);
  const okReturn = returnUrl && /^https:\/\/(radar|make)\.bookease\.co\//.test(returnUrl);
  let cat = '';
  try { cat = okReturn ? (new URL(returnUrl).searchParams.get('c') || '') : ''; } catch (e) { console.error('[pay] returnUrl', e); }
  const back = (okReturn ? returnUrl : 'https://radar.bookease.co/offer/').replace(/[?#].*$/, '')
    + `?p=${encodeURIComponent(placeId)}${/^[a-z_]{2,30}$/.test(cat) ? `&c=${cat}` : ''}&order=${encodeURIComponent(orderId)}`;
  const th = bkk(now);
  const monthTh = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][th.getUTCMonth()];
  const body = {
    external_id: orderId,
    amount,
    currency: 'THB',
    description: `แพ็กเกจโปรโมทร้าน ${amount.toLocaleString('en-US')} บาท/เดือน · ${name} · ${monthTh} ${th.getUTCFullYear() + 543}`,
    invoice_duration: INVOICE_SECONDS,
    success_redirect_url: back,
    failure_redirect_url: back,
    items: [{ name: `BookEase Growth ${amount.toLocaleString('en-US')}`, quantity: 1, price: amount }],
  };
  let res, data;
  try {
    res = await fetch(`${apiBase(env)}/v2/invoices`, {
      method: 'POST',
      headers: { Authorization: auth(env), 'Content-Type': 'application/json', 'Idempotency-key': orderId },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    console.error('[pay] create invoice network/json', orderId, e);
    return { error: 'gateway_unreachable', status: 502 };
  }
  if (!res.ok || !data || !data.id || !data.invoice_url) {
    console.error('[pay] create invoice failed', orderId, res.status, data && (data.error_code || data.message));
    return { error: 'gateway_error', status: 502 };
  }
  if (data.external_id !== orderId || Number(data.amount) !== amount || data.currency !== 'THB') {
    console.error('[pay] invoice mismatch on create', orderId, data.external_id, data.amount, data.currency);
    return { error: 'gateway_mismatch', status: 502 };
  }
  const expires = Date.parse(data.expiry_date) || now + INVOICE_SECONDS * 1000;
  await env.GROWTH_DB.prepare(
    `INSERT INTO growth_orders (order_id, place_id, shop_name, tier, amount, currency, period, status, invoice_id, invoice_url, created_at, expires_at, checked_at)
     VALUES (?, ?, ?, ?, ?, 'THB', ?, 'PENDING', ?, ?, ?, ?, 0)`,
  ).bind(orderId, placeId, name, amount, amount, period, data.id, data.invoice_url, now, expires).run();
  return { order: pub(await getOrder(env, orderId)) };
}

/**
 * Ask Xendit for the truth about one order and record it. Safe to call any number of times:
 * the PAID update only applies to a row that is still PENDING, so a payment is recorded once.
 */
export async function verify(env, orderId, { force = false } = {}) {
  const o = await getOrder(env, orderId);
  if (!o) return null;
  if (o.status !== 'PENDING') return o;
  if (!force && Date.now() - (o.checked_at || 0) < RECHECK_MS) return o;
  if (!env.XENDIT_SECRET_KEY) return o;
  let res, inv;
  try {
    res = await fetch(`${apiBase(env)}/v2/invoices/${encodeURIComponent(o.invoice_id)}`, { headers: { Authorization: auth(env) } });
    inv = await res.json();
  } catch (e) {
    console.error('[pay] get invoice network/json', orderId, e);
    return o;
  }
  await env.GROWTH_DB.prepare('UPDATE growth_orders SET checked_at = ? WHERE order_id = ?').bind(Date.now(), orderId).run();
  if (!res.ok || !inv) { console.error('[pay] get invoice failed', orderId, res.status, inv && inv.error_code); return o; }

  const st = String(inv.status || '').toUpperCase();
  const paidAmount = Number(inv.paid_amount != null ? inv.paid_amount : inv.amount);
  if (st === 'PAID' || st === 'SETTLED') {
    if (inv.external_id !== o.order_id || inv.currency !== 'THB' || paidAmount !== Number(o.amount)) {
      console.error('[pay] PAID but mismatch — not activating', orderId, inv.external_id, inv.currency, paidAmount, o.amount);
      await env.GROWTH_DB.prepare("UPDATE growth_orders SET status = 'REVIEW', note = ? WHERE order_id = ? AND status = 'PENDING'")
        .bind(`mismatch: ${inv.external_id} ${inv.currency} ${paidAmount}`, orderId).run();
      return getOrder(env, orderId);
    }
    const r = await env.GROWTH_DB.prepare(
      "UPDATE growth_orders SET status = 'PAID', paid_at = ?, paid_amount = ?, payment_method = ? WHERE order_id = ? AND status = 'PENDING'",
    ).bind(Date.parse(inv.paid_at) || Date.now(), paidAmount, String(inv.payment_channel || inv.payment_method || ''), orderId).run();
    if (r && r.meta && r.meta.changes === 1) console.log('[pay] PAID', orderId, o.shop_name, o.amount); // team notification hook goes here
  } else if (st === 'EXPIRED') {
    await env.GROWTH_DB.prepare("UPDATE growth_orders SET status = 'EXPIRED' WHERE order_id = ? AND status = 'PENDING'").bind(orderId).run();
  }
  return getOrder(env, orderId);
}

export async function orderStatus(env, orderId) {
  if (!env.GROWTH_DB) return { error: 'server_misconfigured', status: 500 };
  if (!orderOk(orderId)) return { error: 'bad_order_id', status: 400 };
  const o = await verify(env, orderId);
  return o ? { order: pub(o) } : { error: 'not_found', status: 404 };
}

/** Webhook: token check, then re-read the invoice from Xendit. The body only tells us which order to check. */
export async function webhook(env, request) {
  if (!env.XENDIT_CALLBACK_TOKEN || !sameSecret(request.headers.get('x-callback-token'), env.XENDIT_CALLBACK_TOKEN)) {
    return { error: 'forbidden', status: 403 };
  }
  let b = {};
  try { b = await request.json(); } catch (e) { console.error('[pay] webhook body', e); return { error: 'bad_body', status: 400 }; }
  const orderId = String(b.external_id || '');
  if (!orderOk(orderId)) return { ok: true, ignored: true }; // not a Growth order
  await verify(env, orderId, { force: true });
  return { ok: true };
}

/** Cron: re-check every open order (covers a lost webhook or a shopper who never came back). */
export async function sweep(env) {
  if (!env.GROWTH_DB || !env.XENDIT_SECRET_KEY) return 0;
  const { results } = await env.GROWTH_DB.prepare(
    "SELECT order_id FROM growth_orders WHERE status = 'PENDING' AND created_at > ? ORDER BY created_at LIMIT 50",
  ).bind(Date.now() - 3 * 24 * 3600 * 1000).all();
  for (const r of results || []) await verify(env, r.order_id, { force: true });
  return (results || []).length;
}

/** Team view (needs GROWTH_ADMIN_TOKEN): latest orders, newest first. */
export async function listOrders(env, request) {
  if (!env.GROWTH_ADMIN_TOKEN || !sameSecret(request.headers.get('authorization'), `Bearer ${env.GROWTH_ADMIN_TOKEN}`)) {
    return { error: 'forbidden', status: 403 };
  }
  const { results } = await env.GROWTH_DB.prepare('SELECT * FROM growth_orders ORDER BY created_at DESC LIMIT 100').all();
  return { orders: (results || []).map((o) => ({ ...pub(o), placeId: o.place_id, createdAt: o.created_at, paidAmount: o.paid_amount, method: o.payment_method, note: o.note })) };
}
