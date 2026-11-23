// Shop Radar · shoot one shop's own Google Maps page (shared by capture.mjs = batch from a list, and watch.mjs = the
// iMac service that shoots every new report). Rules: see capture.mjs.
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const CONTEXT = { viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 2, locale: 'th-TH', userAgent: UA };
const OPEN_CLOSED = /ปิดอยู่|เปิดอยู่|ปิดแล้ว|เปิดเวลา|ปิดเวลา|เปิด 24 ชั่วโมง|ปิดชั่วคราว|ปิดถาวร|จะเปิด|จะปิด|เร็วๆ นี้/;

/** Returns { jpg: Buffer, name, marks }. Throws on failure; err.stop = true when Google shows a block/consent page. */
export async function shoot(pg, id) {
  await pg.goto(`https://www.google.com/maps/place/?q=place_id:${id}&hl=th`, { waitUntil: 'domcontentloaded' });
  if (/sorry|consent\./.test(pg.url())) throw Object.assign(new Error(`Google block/consent page: ${pg.url()}`), { stop: true });
  await pg.waitForSelector('h1', { timeout: 30000 });
  await pg.waitForTimeout(2500);

  const info = await pg.evaluate((openClosedSrc) => {
    const OC = new RegExp(openClosedSrc);
    // Hide the opening-hours row: climb from Google's hours button to the row that sits beside the address row.
    // Some pages use another layout without that button, so any row whose text says open/closed is hidden the same way.
    const hideRow = (el) => {
      let row = el;
      while (row.parentElement && !row.parentElement.querySelector('[data-item-id="address"]')) row = row.parentElement;
      if (row.parentElement && row !== document.body && !row.querySelector('h1, [data-item-id="address"]')) { row.style.display = 'none'; return true; }
      return false;
    };
    let hours = document.querySelector('[jsaction*="pane.openhours"]');
    if (hours) hideRow(hours);
    const ocWalk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let oc;
    while ((oc = ocWalk.nextNode())) if (OC.test(oc.textContent) && oc.parentElement.getBoundingClientRect().width && hideRow(oc.parentElement)) hours = hours || oc.parentElement;
    const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? { x: b.x, y: b.y, w: b.width, h: b.height } : null; };
    const stars = document.querySelector('span[role="img"][aria-label*="ดาว"]');
    const reviews = document.querySelector('span[role="img"][aria-label*="รีวิว"]');
    const starsRow = stars && stars.parentElement && stars.parentElement.parentElement;
    // Only Google's own booking button (its whole label is "จองออนไลน์" etc.), never a shop name, a post or an owner's link row that happens to contain "จอง".
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
    const addrEl = document.querySelector('[data-item-id="address"]');
    const addrY = addrEl ? addrEl.getBoundingClientRect().y : 900;
    const book = [...document.querySelectorAll('a,button')].find((e) => /^(จองออนไลน์|จอง|จองโต๊ะ|จองคิว|นัดหมายออนไลน์|Book online|Reserve a table)$/i.test(label(e))
      && !e.closest('[data-item-id]') && !/facebook\.com|instagram\.com/.test(e.href || '') && box(e) && box(e).x < 520 && box(e).y < addrY); // Google's button sits above the address row; owner posts further down can say "จอง" too
    const web = document.querySelector('a[data-item-id="authority"]');
    const phone = document.querySelector('button[data-item-id^="phone"]');
    // What we found, in plain words, for the list beside the picture (Art 2026-11-23: clean picture, no boxes or numbers).
    // kind 'ok' = found on the page · 'warn' = not found, or the website row holds a LINE / Facebook / IG link.
    const marks = [];
    const starsText = stars && stars.getAttribute('aria-label').replace(/\s+/g, ' ').trim().replace(/\s*ดาว$/, '');
    const nReviews = reviews && (reviews.getAttribute('aria-label').match(/[\d,]+/) || [''])[0];
    if (starsText && nReviews) marks.push({ kind: 'ok', text: `คะแนน ${starsText} จาก ${nReviews} รีวิว` });
    else marks.push({ kind: 'warn', text: 'ยังไม่พบรีวิวบน Google' });
    const tel = phone && (phone.getAttribute('aria-label') || '').replace(/^โทรศัพท์:\s*/, '').trim();
    marks.push(tel ? { kind: 'ok', text: `มีเบอร์โทร ${tel}` } : { kind: 'warn', text: 'ยังไม่พบเบอร์โทร' });
    marks.push(book ? { kind: 'ok', text: 'มีปุ่มจองออนไลน์บน Google' } : { kind: 'warn', text: 'ยังไม่พบปุ่มจองออนไลน์บน Google' });
    const site = (web && (web.getAttribute('aria-label') || '').replace(/^เว็บไซต์:\s*/, '').trim()) || '';
    if (!web) marks.push({ kind: 'warn', text: 'ยังไม่พบเว็บไซต์ร้าน' });
    else if (/lin\.ee|line\.me/i.test(site)) marks.push({ kind: 'warn', text: 'ช่องเว็บไซต์เป็นลิงก์ LINE ไม่ใช่เว็บร้าน' });
    else if (/facebook\.com|fb\.com/i.test(site)) marks.push({ kind: 'warn', text: 'ช่องเว็บไซต์เป็นเพจ Facebook ไม่ใช่เว็บร้าน' });
    else if (/instagram\.com/i.test(site)) marks.push({ kind: 'warn', text: 'ช่องเว็บไซต์เป็น Instagram ไม่ใช่เว็บร้าน' });
    else marks.push({ kind: 'ok', text: `มีเว็บไซต์ร้าน ${site}` });
    marks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'ok' ? -1 : 1)); // what is fine first, then what to fix
    // The picture ends a little below the last of these rows (stars, booking button, address, website, phone).
    const rowBoxes = [starsRow, book, addrEl, web, phone].map(box).filter(Boolean);
    const bottom = Math.min(1500, Math.max(400, ...rowBoxes.map((m) => m.y + m.h)) + 40);
    // Start a little above the shop name: keeps a strip of the shop photo, drops the tall photo and Google's search bar.
    const h1 = document.querySelector('h1');
    const top = Math.max(0, Math.floor((h1 ? h1.getBoundingClientRect().y : 0) - 70));
    // Anything about open/closed still visible inside the picture area rejects the shot.
    const leftovers = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) {
      if (!OC.test(t.textContent)) continue;
      const r = t.parentElement.getBoundingClientRect();
      if (r.width && r.x < 516 && r.x + r.width > 60 && r.y < bottom && r.y + r.height > top && getComputedStyle(t.parentElement).visibility !== 'hidden') leftovers.push(t.textContent.trim());
    }
    return { h1: h1?.textContent?.trim(), hoursHidden: !!hours, marks, rows: rowBoxes.length, top, bottom, leftovers };
  }, OPEN_CLOSED.source);

  if (info.leftovers.length) throw new Error(`open/closed text still in picture: ${info.leftovers.join(' | ')}`);
  if (!info.rows) throw new Error('no shop rows found on the page (Google layout changed?)');
  const jpg = await pg.screenshot({ type: 'jpeg', quality: 82, clip: { x: 60, y: info.top, width: 456, height: info.bottom - info.top } });
  return { jpg, name: info.h1, marks: info.marks, hoursHidden: info.hoursHidden };
}
