// Clinic Radar · the evidence for one public, self-serve report (radar.bookease.co/clinic/), captured in the cloud browser.
// Template V1.0 (atiz-ops missions/growth-2027/clinic-radar-real/TEMPLATE-V1.md) asks for real screenshots only:
//   1. the clinic's own Google Maps page, numbered boxes on the rows the report talks about (purple, like v16)
//   2. a real Google Maps search for "<type> <area>", searched 3 times (rank + how often), search box + results on screen
//   3. the clinic's website on a phone (first screen), when Google links a real website
// Every fact in the report comes from these same page loads. Public data only: nothing about Dr.Ease customers.
import { CONTEXT, CONSENT_COOKIES } from '../radar/shots/shoot.mjs';

export const CLINIC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clinic_job (id TEXT PRIMARY KEY, place_id TEXT NOT NULL, term TEXT NOT NULL, status TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, base TEXT, result TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS clinic_job_q ON clinic_job (status, created_at)',
];
export const CLINIC_TTL_S = 30 * 24 * 3600; // a report link keeps its pictures 30 days
const SEARCH_ROUNDS = 3;
const MAX_RANK = 60;
const OPEN_CLOSED = /ปิดอยู่|เปิดอยู่|ปิดแล้ว|เปิดเวลา|ปิดเวลา|เปิด 24 ชั่วโมง|ปิดชั่วคราว|ปิดถาวร|จะเปิด|จะปิด|เร็วๆ นี้/;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'th-TH',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };

const bkkNow = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const blocked = (u) => /\/sorry\/|consent\.google\./.test(u);

async function put(env, id, name, buf) {
  await env.REPORTS.put(`clinic/img/${id}/${name}`, new Uint8Array(buf), { expirationTtl: CLINIC_TTL_S });
  return name;
}

// ── 1. the clinic's own Google Maps page ──────────────────────────────────────────────────────────────────────────
async function placePage(pg, placeId) {
  await pg.goto(`https://www.google.com/maps/place/?q=place_id:${placeId}&hl=th&gl=th`, { waitUntil: 'domcontentloaded' });
  if (blocked(pg.url())) throw Object.assign(new Error(`Google block/consent page: ${pg.url()}`), { stop: true });
  await pg.waitForSelector('h1', { timeout: 30000 });
  await pg.waitForTimeout(2500);
  // Read everything first (one load), then cut a clean picture of the info rows (no boxes) for the action cards.
  const info = await pg.evaluate((ocSrc) => {
    const OC = new RegExp(ocSrc);
    const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? { x: b.x, y: b.y, w: b.width, h: b.height } : null; };
    // Opening hours are never shown (Radar rule): hide the hours row, and any row that says open/closed.
    const hideRow = (el) => {
      let row = el;
      while (row.parentElement && !row.parentElement.querySelector('[data-item-id="address"]')) row = row.parentElement;
      if (row.parentElement && row !== document.body && !row.querySelector('h1, [data-item-id="address"]')) { row.style.display = 'none'; return true; }
      return false;
    };
    const hours = document.querySelector('[jsaction*="pane.openhours"]');
    if (hours) hideRow(hours);
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t; (t = tw.nextNode());) if (OC.test(t.textContent) && t.parentElement.getBoundingClientRect().width) hideRow(t.parentElement);
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
    const h1 = document.querySelector('h1');
    const stars = document.querySelector('span[role="img"][aria-label*="ดาว"]');
    const reviews = document.querySelector('span[role="img"][aria-label*="รีวิว"]');
    const starsRow = stars && stars.parentElement && stars.parentElement.parentElement;
    const cat = document.querySelector('button[jsaction*="category"]');
    const addr = document.querySelector('[data-item-id="address"]');
    const addrY = addr ? addr.getBoundingClientRect().y : 900;
    // Google's own big booking button (from its booking partners) links to /maps/reserve; a booking link the clinic
    // adds itself shows as an info row with a calendar icon (data-item-id "action:N").
    const partner = [...document.querySelectorAll('a[href*="/maps/reserve"], a, button')].find((e) => (/\/maps\/reserve/.test(e.href || '') || /^(จองออนไลน์|จอง|นัดหมายออนไลน์)$/.test(label(e)))
      && !e.closest('[data-item-id]') && box(e) && box(e).x < 520 && box(e).y < addrY);
    const linkRow = document.querySelector('[data-item-id^="action:"]');
    const web = document.querySelector('a[data-item-id="authority"]');
    const phone = document.querySelector('button[data-item-id^="phone"]');
    const claim = document.querySelector('[data-item-id="merchant"]');
    const site = (web && (web.getAttribute('aria-label') || '').replace(/^เว็บไซต์:\s*/, '').trim()) || '';
    const rows = { stars: box(starsRow), partner: box(partner), linkRow: box(linkRow), web: box(web), phone: box(phone), claim: box(claim), addr: box(addr) };
    const rating = stars ? parseFloat((stars.getAttribute('aria-label').match(/[\d.]+/) || [])[0]) : null;
    const nrev = reviews ? parseInt((reviews.getAttribute('aria-label').replace(/,/g, '').match(/\d+/) || [])[0], 10) : null;
    const top = Math.max(0, Math.floor((h1 ? h1.getBoundingClientRect().y : 0) - 70));
    const leftovers = [];
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t; (t = w2.nextNode());) {
      if (!OC.test(t.textContent)) continue;
      const r = t.parentElement.getBoundingClientRect();
      if (r.width && r.x < 516 && r.x + r.width > 60 && r.y < 1500 && r.y + r.height > top && getComputedStyle(t.parentElement).visibility !== 'hidden') leftovers.push(t.textContent.trim());
    }
    return { name: h1 && h1.textContent.trim(), category: cat ? label(cat) : '', rating, reviews: nrev,
      partner: !!partner, linkRow: linkRow ? label(linkRow) : '', website: site, phone: phone ? label(phone).replace(/^โทรศัพท์:\s*/, '') : '',
      claimable: !!claim, address: addr ? label(addr).replace(/^ที่อยู่:\s*/, '') : '', rows, top, leftovers };
  }, OPEN_CLOSED.source);
  if (info.leftovers.length) throw new Error(`open/closed text still in picture: ${info.leftovers.join(' | ')}`);
  if (!info.rows.addr && !info.rows.stars) throw new Error('no clinic rows found (Google layout changed?)');

  // Clean crop of the info rows (address → website/phone/booking row) for action card "ตอนนี้".
  const infoRows = [info.rows.addr, info.rows.linkRow, info.rows.web, info.rows.phone].filter(Boolean);
  const rowsTop = Math.min(...infoRows.map((b) => b.y)) - 8, rowsBot = Math.max(...infoRows.map((b) => b.y + b.h)) + 8;
  const rowsJpg = await pg.screenshot({ type: 'jpeg', quality: 82, clip: { x: 60, y: rowsTop, width: 436, height: rowsBot - rowsTop } });
  const claimJpg = info.rows.claim ? await pg.screenshot({ type: 'jpeg', quality: 82, clip: { x: 60, y: info.rows.claim.y - 6, width: 436, height: info.rows.claim.h + 12 } }) : null;

  // Numbered purple boxes on what the report talks about (v16 order): 1 stars+reviews · 2 booking · 3 website · 4 claim.
  const marks = [];
  if (info.rows.stars) marks.push({ n: 0, key: 'stars', b: info.rows.stars, inset: false, text: 'ดาวและจำนวนรีวิว' });
  if (info.rows.partner) marks.push({ key: 'book', b: info.rows.partner, inset: false, text: 'ปุ่มจองออนไลน์' });
  else if (info.rows.linkRow) marks.push({ key: 'book', b: info.rows.linkRow, inset: true, text: 'ลิงก์จอง' });
  if (info.rows.web) marks.push({ key: 'web', b: info.rows.web, inset: true, text: 'เว็บไซต์' });
  if (info.rows.claim) marks.push({ key: 'claim', b: info.rows.claim, inset: true, text: 'อ้างสิทธิ์ธุรกิจนี้' });
  marks.forEach((m, i) => { m.n = i + 1; });
  await pg.evaluate((ms) => {
    for (const m of ms) {
      const b = m.inset ? { x: m.b.x + 12, y: m.b.y + 3, w: m.b.w - 24, h: m.b.h - 6 } : { x: m.b.x - 6, y: m.b.y - 4, w: m.b.w + 12, h: m.b.h + 8 };
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:2.5px solid #7C3AED;border-radius:10px;z-index:99999;pointer-events:none;box-sizing:border-box`;
      const n = document.createElement('div');
      n.textContent = String(m.n);
      n.style.cssText = 'position:absolute;right:-11px;top:-11px;width:22px;height:22px;border-radius:50%;background:#7C3AED;color:#fff;font:700 13px/22px Arial,sans-serif;text-align:center';
      d.appendChild(n);
      document.body.appendChild(d);
    }
  }, marks);
  const all = [info.rows.stars, info.rows.partner, info.rows.linkRow, info.rows.web, info.rows.phone, info.rows.addr, info.rows.claim].filter(Boolean);
  const bottom = Math.min(1500, Math.max(400, ...all.map((b) => b.y + b.h)) + 30);
  const pageJpg = await pg.screenshot({ type: 'jpeg', quality: 82, clip: { x: 50, y: info.top, width: 476, height: bottom - info.top } });
  return { info, pageJpg, rowsJpg, claimJpg, marks: marks.map(({ n, key, text }) => ({ n, key, text })) };
}

// ── 2. a real Google Maps search, SEARCH_ROUNDS times ──────────────────────────────────────────────────────────
// The map opens at the clinic's own location (zoom 15), as a patient nearby sees it. Without this, results follow the
// browser's IP location: from a Bangkok IP, Agafar (Siam) was not in the first 91; centred on Siam it was #20, which
// matches the hand check of 24 Nov (#21). Checked 2026-11-28.
async function searchOnce(pg, term, placeId, here, withShot) {
  const centre = here && here.lat != null ? `/@${(+here.lat).toFixed(6)},${(+here.lng).toFixed(6)},15z` : '';
  await pg.goto(`https://www.google.com/maps/search/${encodeURIComponent(term)}${centre}?hl=th&gl=th`, { waitUntil: 'domcontentloaded' });
  if (blocked(pg.url())) throw Object.assign(new Error(`Google block/consent page: ${pg.url()}`), { stop: true });
  const feed = await pg.waitForSelector('div[role="feed"]', { timeout: 25000 }).catch(() => null);
  if (!feed) return { list: false };
  await pg.waitForTimeout(2000);
  const read = () => pg.evaluate(() => [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].map((a) => {
    const card = a.parentElement;
    const star = card.querySelector('span[role="img"][aria-label*="ดาว"]');
    const al = star ? star.getAttribute('aria-label').replace(/,/g, '') : '';
    return { name: a.getAttribute('aria-label') || '', id: (a.href.match(/!19s(ChI[^!?&]+)/) || [])[1] || '',
      rating: al ? parseFloat((al.match(/[\d.]+/) || [])[0]) : null, reviews: al ? parseInt((al.match(/(\d+)\s*รีวิว/) || [])[1] || '', 10) || null : null,
      ad: /ได้รับการสนับสนุน|Sponsored|โฆษณา/.test(card.textContent || '') };
  }).filter((r) => !r.ad));
  // Opening hours are never shown (Radar rule): hide every open/closed line in the result cards.
  const hideHours = () => pg.evaluate((ocSrc) => {
    const OC = new RegExp(ocSrc), feed = document.querySelector('div[role="feed"]');
    const left = [];
    for (let pass = 0; pass < 3; pass++) {
      left.length = 0;
      const tw = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT);
      for (let t; (t = tw.nextNode());) {
        if (!OC.test(t.textContent) || !t.parentElement.getBoundingClientRect().width) continue;
        let el = t.parentElement;
        for (let up = 0; up < pass; up++) if (el.parentElement && !el.parentElement.querySelector('a.hfpxzc')) el = el.parentElement;
        el.style.display = 'none';
        left.push(t.textContent.trim());
      }
      if (!left.length) break;
    }
    const still = [];
    const tw = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT);
    for (let t; (t = tw.nextNode());) if (OC.test(t.textContent) && t.parentElement.getBoundingClientRect().width) still.push(t.textContent.trim());
    return still;
  }, OPEN_CLOSED.source);
  // The picture is taken before any scrolling: the search box and the first results, as a patient sees them.
  let shot = null, boxed = false;
  let list = await read();
  if (withShot) {
    const at = list.findIndex((r) => r.id === placeId);
    if (at >= 0 && at < 3) {
      boxed = await pg.evaluate((pid) => {
        const a = [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].find((x) => x.href.includes(`!19s${pid}`));
        const b = a && a.parentElement.getBoundingClientRect();
        if (!b || !b.width || b.bottom > 1480) return false;
        const d = document.createElement('div');
        d.style.cssText = `position:fixed;left:${b.x + 4}px;top:${b.y + 2}px;width:${b.width - 8}px;height:${b.height - 4}px;border:3px solid #7C3AED;border-radius:12px;z-index:99999;pointer-events:none;box-sizing:border-box`;
        document.body.appendChild(d);
        return true;
      }, placeId);
    }
    const still = await hideHours();
    if (still.length) throw new Error(`open/closed text still in search picture: ${still.slice(0, 3).join(' | ')}`);
    // Search box + first 3 results (the feed's third card bottom), left panel only.
    const cut = await pg.evaluate(() => {
      const cards = [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].map((a) => a.parentElement.getBoundingClientRect());
      const three = cards.slice(0, 3).filter((r) => r.width);
      return three.length ? Math.min(1480, Math.max(...three.map((r) => r.bottom)) + 10) : 900;
    });
    shot = await pg.screenshot({ type: 'jpeg', quality: 82, clip: { x: 60, y: 0, width: 456, height: cut } });
  }
  for (let i = 0; i < 8 && !list.some((r) => r.id === placeId) && list.length < MAX_RANK; i++) {
    const more = await pg.evaluate(() => {
      const f = document.querySelector('div[role="feed"]');
      const end = /จุดสิ้นสุดของรายการ|end of the list/i.test(f.innerText);
      f.scrollTop = f.scrollHeight;
      return !end;
    });
    if (!more) break;
    await pg.waitForTimeout(1500);
    list = await read();
  }
  const at = list.findIndex((r) => r.id === placeId);
  return { list: true, rank: at >= 0 ? at + 1 : null, seen: list.length, top: list.slice(0, 3), shot, boxed };
}

// ── 3. the clinic's website on a phone ─────────────────────────────────────────────────────────────────────────
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|line\.me|lin\.ee|tiktok\.com|linktr\.ee|youtube\.com)$/i;
async function websiteOnPhone(browser, site) {
  let u;
  try { u = new URL(/^https?:/i.test(site) ? site : `https://${site}`); } catch { return { kind: 'bad' }; }
  if (SOCIAL.test(u.hostname)) return { kind: 'social', host: u.hostname.replace(/^www\./, '') };
  const ctx = await browser.newContext(PHONE);
  try {
    const pg = await ctx.newPage();
    let status = 0, err = '';
    try {
      const res = await pg.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
      status = res ? res.status() : 0;
    } catch (e) { err = String(e && e.message || e).slice(0, 160); }
    if (err) return { kind: 'broken', host: u.hostname.replace(/^www\./, ''), why: err, login: /AUTH_CREDENTIALS|401/.test(err) };
    await pg.waitForTimeout(2500);
    const seen = await pg.evaluate(() => {
      const H = innerHeight;
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 20 && r.height > 10 && r.top < H && r.bottom > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const els = [...document.querySelectorAll('a,button')].filter(vis);
      const txt = (e) => (e.textContent || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return {
        book: els.some((e) => /จอง|นัดหมาย|นัดคิว|ทำนัด|book|appointment|reserv/i.test(txt(e))),
        line: els.some((e) => /line\.me|lin\.ee/i.test(e.href || '') || /^line$|แอดไลน์|add line|@line/i.test(txt(e))),
        login: /password|รหัสผ่าน|sign in|เข้าสู่ระบบ/i.test(document.body.innerText.slice(0, 1500)) && !!document.querySelector('input[type="password"]'),
        title: document.title.slice(0, 120),
      };
    });
    const jpg = await pg.screenshot({ type: 'jpeg', quality: 78 });
    const finalHost = new URL(pg.url()).hostname.replace(/^www\./, '');
    return { kind: status >= 400 || seen.login ? 'broken' : 'ok', host: u.hostname.replace(/^www\./, ''), finalHost, status, ...seen, jpg };
  } finally { await ctx.close().catch((e) => console.error('[clinic] phone ctx close', e)); }
}

/** Runs one queued clinic job end to end and stores the result. Throws browser trouble so the caller keeps it queued. */
export async function runClinicJob(env, browser, id) {
  const db = env.GROWTH_DB;
  const job = await db.prepare('SELECT * FROM clinic_job WHERE id = ?').bind(id).first();
  if (!job) return;
  await db.prepare("UPDATE clinic_job SET status = 'running', updated_at = ?, tries = tries + 1 WHERE id = ?").bind(Date.now(), id).run();
  const fail = async (why) => {
    await db.prepare("UPDATE clinic_job SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(job.tries + 1 >= 2 ? 'failed' : 'queued', String(why).slice(0, 300), Date.now(), id).run();
  };
  try {
    const checkedAt = bkkNow();
    const ctx = await browser.newContext(CONTEXT);
    await ctx.addCookies(CONSENT_COOKIES);
    let place, rounds = [];
    try {
      const pg = await ctx.newPage();
      place = await placePage(pg, job.place_id);
      const base = JSON.parse(job.base || '{}');
      for (let i = 0; i < SEARCH_ROUNDS; i++) rounds.push(await searchOnce(pg, job.term, job.place_id, base, i === 0));
    } finally { await ctx.close().catch((e) => console.error('[clinic] ctx close', e)); }
    const site = place.info.website ? await websiteOnPhone(browser, place.info.website) : { kind: 'none' };

    const img = {};
    img.page = await put(env, id, 'page.jpg', place.pageJpg);
    img.rows = await put(env, id, 'rows.jpg', place.rowsJpg);
    if (place.claimJpg) img.claim = await put(env, id, 'claim.jpg', place.claimJpg);
    if (rounds[0] && rounds[0].shot) img.search = await put(env, id, 'search.jpg', rounds[0].shot);
    if (site.jpg) img.phone = await put(env, id, 'phone.jpg', site.jpg);
    const { rows, leftovers, top, ...facts } = place.info;
    const result = {
      checkedAt, term: job.term, place: facts, marks: place.marks, img,
      search: rounds.map(({ shot, ...r }) => r),
      site: { ...site, jpg: undefined },
    };
    await db.prepare("UPDATE clinic_job SET status = 'ready', result = ?, error = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(result), Date.now(), id).run();
  } catch (e) {
    if (e.stop || /429|rate limit|browser time|Unable to create new browser|has been closed|websocket/i.test(String(e && e.message))) {
      await db.prepare("UPDATE clinic_job SET status = 'queued', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
      throw e;
    }
    await fail(e && e.message || e);
    throw e;
  }
}
