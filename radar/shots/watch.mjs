// Shop Radar · iMac service: shoots every shop that gets a report, so the report shows the shop's real Google Maps page.
// The worker queues a shop when its report is made or opened; this polls the queue every few seconds, shoots the
// shop with shoot.mjs and uploads the picture. Runs under launchd (see radar/shots/README.md); costs nothing.
//
//   SHOT_KEY=… node radar/shots/watch.mjs          # key: 1Password "Atiz Dev" → "Shop Radar shot key"
//                                                   # (launchd reads it from the macOS Keychain, service radar-shot-key)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { shoot, CONTEXT } from './shoot.mjs';

const require = createRequire(process.env.PLAYWRIGHT_FROM || '/Users/sb/Projects/bookease-frontend/package.json');
const { chromium } = require('@playwright/test');

const API = process.env.SHOT_API || 'https://bookease-maps-report.atiz-cloudflare-account.workers.dev';
const POLL_MS = Number(process.env.SHOT_POLL_MS || 4000);
let KEY = process.env.SHOT_KEY || '';
if (!KEY) {
  try { KEY = execFileSync('security', ['find-generic-password', '-s', 'radar-shot-key', '-w'], { encoding: 'utf8' }).trim(); }
  catch (e) { console.error('[watch] no SHOT_KEY and none in the Keychain (service radar-shot-key)', e.message); process.exit(1); }
}
const H = { 'X-Shot-Key': KEY, 'Content-Type': 'application/json' };
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // Bangkok date
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(path, body) {
  const res = await fetch(`${API}${path}`, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
  return out;
}

let browser = null, pg = null;
async function page() {
  if (pg && !pg.isClosed()) return pg;
  if (browser) await browser.close().catch((e) => console.error('[watch] close', e.message));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  pg = await (await browser.newContext(CONTEXT)).newPage();
  return pg;
}

// Can this Mac reach Google at all? A dead connection (router, ISP) is not the shop's fault: the shop stays in the
// queue and is shot when the line is back, instead of being marked failed and skipped for a day (2026-11-23: the
// iMac lost Google from 14:02 and every shop that afternoon got no picture).
async function online() {
  try { const r = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(8000) }); return r.status === 204; }
  catch (e) { return false; }
}

let pausedUntil = 0, offlineSince = 0;
for (;;) {
  try {
    if (Date.now() < pausedUntil) { await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
    const { queue } = await api('/shot/queue');
    for (const item of queue) {
      const t0 = Date.now();
      try {
        const r = await shoot(await page(), item.id);
        await api('/shot/upload', { id: item.id, jpg: r.jpg.toString('base64'), date: today(), name: r.name, marks: r.marks });
        if (offlineSince) { log(`Google reachable again after ${((Date.now() - offlineSince) / 60e3).toFixed(0)} min`); offlineSince = 0; }
        log('ok', ((Date.now() - t0) / 1000).toFixed(1) + 's', `waited ${((Date.now() - item.queuedAt) / 1000).toFixed(0)}s`, item.id, r.name);
      } catch (e) {
        if (e.stop) {
          // Google is showing a block/consent page: stop for 30 minutes, leave the queue as it is, never solve a CAPTCHA.
          console.error('[watch] Google block page, pausing 30 min:', e.message);
          pausedUntil = Date.now() + 30 * 60e3;
          if (pg) await pg.close().catch((err) => console.error('[watch] close page', err.message));
          break;
        }
        if (!(await online())) {
          if (!offlineSince) { offlineSince = Date.now(); console.error('[watch] cannot reach Google, waiting; queue kept:', e.message); }
          pausedUntil = Date.now() + 60e3;
          if (pg) await pg.close().catch((err) => console.error('[watch] close page', err.message));
          break;
        }
        console.error('[watch] shot failed', item.id, e.message);
        await api('/shot/fail', { id: item.id, why: e.message }).catch((err) => console.error('[watch] report fail', err.message));
      }
    }
  } catch (e) {
    console.error('[watch] poll', e.message);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
