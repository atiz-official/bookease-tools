// Shop Radar · real Google Maps screenshots of each shop's own page (Art 2026-11-22: "ถ้าแคปหน้า Google Maps ของร้านเขาไปอยู่ในรายงาน เขาจะไม่สงสัยอีกเลย").
// Runs on the iMac (headless Chrome, no cost). Writes radar/shots/<placeId>.jpg + radar/shots/index.json; the report and offer pages show the picture when it exists.
//
//   node radar/shots/capture.mjs shops.json          # shops.json = [{ "id": "ChIJ…", "name": "…" }, …]
//
// Rules this script keeps:
// - The opening-hours row (open/closed, times) is hidden before the shot and the picture is rejected if any open/closed text is left:
//   Radar never mentions open/closed or time of day (Art 2026-11-19).
// - The picture is Google's page as it is (no boxes, Art 2026-11-23); beside it, a short list of what we found:
//   rating, phone, Google's own booking button, a real website (a LINE / Facebook / IG link in that row is flagged).
// - If Google shows a block/consent page the run stops: no CAPTCHA solving, ever.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shoot, CONTEXT } from './shoot.mjs';

const require = createRequire(process.env.PLAYWRIGHT_FROM || '/Users/sb/Projects/bookease-frontend/package.json');
const { chromium } = require('@playwright/test');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(DIR, 'index.json');

const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // Bangkok date

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext(CONTEXT);
const pg = await ctx.newPage();
const failed = [];

for (const shop of list) {
  const t0 = Date.now();
  try {
    const r = await shoot(pg, shop.id);
    fs.writeFileSync(path.join(DIR, `${shop.id}.jpg`), r.jpg);
    index[shop.id] = { date: today, name: r.name, marks: r.marks };
    fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 1)}\n`);
    console.log(`ok   ${((Date.now() - t0) / 1000).toFixed(1)}s ${shop.id} ${r.name} · ${r.marks.map((m) => `${m.kind === 'ok' ? '✓' : '!'} ${m.text}`).join(' · ')}${r.hoursHidden ? '' : ' (no hours row)'}`);
  } catch (e) {
    console.error(`FAIL ${shop.id} ${shop.name}:`, e.message);
    failed.push({ id: shop.id, name: shop.name, why: e.message });
    if (e.stop) break;
  }
  await pg.waitForTimeout(1500 + Math.random() * 1500); // gentle pace
}
await browser.close();
console.log(`done: ${list.length - failed.length}/${list.length} ok`);
if (failed.length) { console.log(JSON.stringify(failed, null, 1)); process.exitCode = 1; }
