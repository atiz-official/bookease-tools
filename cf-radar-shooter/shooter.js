// Radar shooter · Cloudflare cloud browser (Browser Run) for Shop Radar and Clinic Radar.
// Replaces the iMac service radar/shots/watch.mjs (Art 2026-11-28: everything must run in the cloud at all times).
//
// Every minute a cron run takes a D1 lease (one run at a time), then watches the queues for ~50 s:
//   shot_queue   → Shop Radar: the shop's own Google Maps page (radar/shots/shoot.mjs, the same code the iMac ran)
//   clinic_job   → Clinic Radar: the clinic's page + a real Maps search 3 times + its website on a phone (clinic.js)
// It opens a browser only when there is work and closes it when the queue is empty: on the free plan idle browser time
// counts against 10 min/day, and only 3 new browsers may open per minute.
import { launch, limits } from '@cloudflare/playwright';
import { shoot, CONTEXT, CONSENT_COOKIES } from '../radar/shots/shoot.mjs';
import { runClinicJob, CLINIC_SCHEMA } from './clinic.js';

const SHOT_TTL_S = 7 * 24 * 3600;   // same as the main worker (CACHE_SECONDS)
const SHOT_FAIL_TTL_S = 24 * 3600;  // a shop that really could not be shot is not retried for a day
const RUN_MS = 50_000;              // one cron run watches the queue this long
const POLL_MS = 3_000;
const LEASE_MS = 58_000;

const bkkDay = (t = Date.now()) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS shot_queue (place_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS shot_state (place_id TEXT PRIMARY KEY, meta TEXT NOT NULL, jpg BLOB, until INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS shooter_lease (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)'),
    ...CLINIC_SCHEMA.map((sql) => db.prepare(sql)),
  ]);
}

/** One run at a time: take the lease if it is free or expired. */
async function takeLease(db, owner) {
  const now = Date.now();
  await db.prepare('INSERT INTO shooter_lease (id, owner, until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, until = excluded.until WHERE shooter_lease.until < ?')
    .bind(owner, now + LEASE_MS, now).run();
  const row = await db.prepare('SELECT owner FROM shooter_lease WHERE id = 1').first();
  return row && row.owner === owner;
}
const dropLease = (db, owner) => db.prepare('UPDATE shooter_lease SET until = 0 WHERE id = 1 AND owner = ?').bind(owner).run();

// ── Shop Radar: same result format as the main worker's /shot/upload (KV for old readers, D1 shot_state first) ──
async function saveShot(env, id, r) {
  const marks = (r.marks || []).slice(0, 6).map((m, i) => ({ n: i + 1, kind: String(m.kind || '').slice(0, 10), text: String(m.text || '').slice(0, 120) }));
  const meta = { status: 'ready', date: bkkDay(), name: String(r.name || '').slice(0, 160), marks, by: 'cloud' };
  const jpg = new Uint8Array(r.jpg);
  await env.REPORTS.put(`shot/img/${id}`, jpg, { expirationTtl: SHOT_TTL_S });
  await env.REPORTS.put(`shot/meta/${id}`, JSON.stringify(meta), { expirationTtl: SHOT_TTL_S });
  await env.GROWTH_DB.prepare('INSERT OR REPLACE INTO shot_state (place_id, meta, jpg, until) VALUES (?, ?, ?, ?)')
    .bind(id, JSON.stringify(meta), jpg.buffer, Date.now() + SHOT_TTL_S * 1000).run();
  await env.GROWTH_DB.prepare('DELETE FROM shot_queue WHERE place_id = ?').bind(id).run();
}
async function failShot(env, id, why) {
  console.error('[shooter] shop shot failed', id, why);
  await env.REPORTS.put(`shot/meta/${id}`, JSON.stringify({ status: 'none' }), { expirationTtl: SHOT_FAIL_TTL_S });
  await env.GROWTH_DB.prepare('INSERT OR REPLACE INTO shot_state (place_id, meta, jpg, until) VALUES (?, ?, NULL, ?)')
    .bind(id, JSON.stringify({ status: 'none' }), Date.now() + SHOT_FAIL_TTL_S * 1000).run();
  await env.GROWTH_DB.prepare('DELETE FROM shot_queue WHERE place_id = ?').bind(id).run();
}

/** Errors that are about the cloud browser (quota, rate, connection), not about the shop: keep the job queued. */
const browserTrouble = (e) => /429|rate limit|browser time|quota|Unable to create new browser|Target page, context or browser has been closed|websocket|ECONNRESET/i.test(String(e && e.message || e));

async function nextWork(db) {
  const shop = await db.prepare('SELECT place_id FROM shot_queue ORDER BY queued_at LIMIT 1').first();
  if (shop) return { kind: 'shop', id: shop.place_id };
  const clinic = await db.prepare("SELECT id FROM clinic_job WHERE status = 'queued' ORDER BY created_at LIMIT 1").first();
  if (clinic) return { kind: 'clinic', id: clinic.id };
  return null;
}

async function run(env, why) {
  const db = env.GROWTH_DB;
  await ensureSchema(db);
  const owner = crypto.randomUUID();
  if (!(await takeLease(db, owner))) return { skipped: 'another run holds the lease' };
  const end = Date.now() + RUN_MS;
  let browser = null, done = 0;
  try {
    while (Date.now() < end) {
      const work = await nextWork(db);
      if (!work) { if (browser) { await browser.close().catch((e) => console.error('[shooter] close', e)); browser = null; } await sleep(POLL_MS); continue; }
      if (!browser) {
        const lim = await limits(env.BROWSER).catch((e) => { console.error('[shooter] limits', e); return null; });
        if (lim && !lim.allowedBrowserAcquisitions) { console.error('[shooter] browser not allowed now, wait', lim.timeUntilNextAllowedBrowserAcquisition); break; }
        browser = await launch(env.BROWSER, { keep_alive: 60_000 });
      }
      const t0 = Date.now();
      try {
        if (work.kind === 'shop') {
          const ctx = await browser.newContext(CONTEXT);
          await ctx.addCookies(CONSENT_COOKIES);
          try { await saveShot(env, work.id, await shoot(await ctx.newPage(), work.id)); }
          finally { await ctx.close().catch((e) => console.error('[shooter] ctx close', e)); }
        } else {
          await runClinicJob(env, browser, work.id);
        }
        done++;
        console.log('[shooter] ok', work.kind, work.id, `${((Date.now() - t0) / 1000).toFixed(1)}s`, why);
      } catch (e) {
        if (browserTrouble(e) || e.stop) {
          // Cloud browser trouble or a Google block page: leave the job queued and stop this run.
          console.error('[shooter] stop run, job kept', work.kind, work.id, e && e.message);
          break;
        }
        if (work.kind === 'shop') await failShot(env, work.id, e && e.message);
        else console.error('[shooter] clinic job failed', work.id, e && e.stack || e); // runClinicJob marks the job itself
      }
      await db.prepare('UPDATE shooter_lease SET until = ? WHERE id = 1 AND owner = ?').bind(Date.now() + LEASE_MS, owner).run();
    }
  } finally {
    if (browser) await browser.close().catch((e) => console.error('[shooter] close', e));
    await dropLease(db, owner).catch((e) => console.error('[shooter] lease', e));
  }
  return { done };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, 'cron').then((r) => { if (r.done || r.skipped) console.log('[shooter] run', JSON.stringify(r)); })
      .catch((e) => console.error('[shooter] run failed', e && e.stack || e)));
  },
  // Health only (no secrets, no work): how the queue looks.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') return new Response('not found', { status: 404 });
    await ensureSchema(env.GROWTH_DB);
    const q = await env.GROWTH_DB.prepare('SELECT COUNT(*) n, MIN(queued_at) oldest FROM shot_queue').first();
    const c = await env.GROWTH_DB.prepare("SELECT COUNT(*) n FROM clinic_job WHERE status = 'queued'").first();
    const l = await env.GROWTH_DB.prepare('SELECT until FROM shooter_lease WHERE id = 1').first();
    return Response.json({ shopQueue: q.n, oldestQueuedAgoS: q.oldest ? Math.round((Date.now() - q.oldest) / 1000) : null,
      clinicQueue: c.n, running: !!(l && l.until > Date.now()) }, { headers: { 'Cache-Control': 'no-store' } });
  },
};
