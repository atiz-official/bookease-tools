// End-to-end against the REAL Xendit sandbox (test mode). Key comes from env only, never printed.
// Usage: XENDIT_SECRET_KEY=$(op read "op://Atiz Dev/Xendit TEST secret key (sandbox)/credential") node --no-warnings sandbox-test.mjs [orderId]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as pay from './growth-pay.js';

if (!String(process.env.XENDIT_SECRET_KEY || '').startsWith('xnd_development_')) { console.error('need a xnd_development_ key in env'); process.exit(1); }
const file = new URL('./.sandbox.sqlite', import.meta.url).pathname;
const fresh = !existsSync(file);
const sq = new DatabaseSync(file);
if (fresh) sq.exec(readFileSync(new URL('./growth-schema.sql', import.meta.url), 'utf8'));
const db = { prepare(sql) { const st = sq.prepare(sql); const mk = (v) => ({
  async run() { const r = st.run(...v); return { meta: { changes: Number(r.changes) } }; },
  async first() { return st.get(...v) || null; }, async all() { return { results: st.all(...v) }; } });
  return { bind: (...v) => mk(v), ...mk([]) }; } };
const env = { GROWTH_PAY: 'on', XENDIT_SECRET_KEY: process.env.XENDIT_SECRET_KEY, GROWTH_DB: db };

const arg = process.argv[2];
if (!arg) {
  const r = await pay.checkout(env, { placeId: 'ChIJPxz0o_iZ4jARqOODkDRBYCw', tier: 1000, shopName: 'ร้านทดสอบ sandbox', returnUrl: 'https://radar.bookease.co/offer/' });
  console.log(JSON.stringify(r));
  if (r.order) writeFileSync(new URL('./.sandbox-last.json', import.meta.url), JSON.stringify(r.order));
} else {
  const t0 = Date.now();
  const o = await pay.verify(env, arg, { force: true });
  console.log(JSON.stringify({ status: o && o.status, amount: o && o.amount, paid_amount: o && o.paid_amount, method: o && o.payment_method, ms: Date.now() - t0 }));
}
