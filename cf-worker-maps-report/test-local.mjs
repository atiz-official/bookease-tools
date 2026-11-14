// Local test: runs the Worker's real code in Node with Google mocked from a saved rank check.
// Usage: node test-local.mjs <rank-json> <discovery-csv> <place-id> <out-json>
import fs from 'node:fs';
import worker, { grid, parseMapsLink } from './worker.js';

const [rankPath, csvPath, placeId, outPath] = process.argv.slice(2);
const rank = JSON.parse(fs.readFileSync(rankPath, 'utf8'));
const csv = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
const head = csv[0].split(',');
const row = csv.find((l) => l.includes(placeId));
if (!row) throw new Error('place not in csv');
const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
const shopRow = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
const shop = { lat: +shopRow.lat, lng: +shopRow.lng };
const pts = grid(shop.lat, shop.lng);
const order = ['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'];
let calls = { ids: 0, enterprise: 0, details: 0, other: 0 };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const mask = (init.headers || {})['X-Goog-FieldMask'] || '';
  const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith(`/places/${placeId}`)) {
    calls.details++;
    return ok({ id: placeId, displayName: { text: shopRow.name }, formattedAddress: shopRow.address, location: { latitude: shop.lat, longitude: shop.lng },
      googleMapsUri: shopRow.maps_url, rating: +shopRow.rating, userRatingCount: +shopRow.reviews, websiteUri: shopRow.website || undefined, businessStatus: shopRow.status });
  }
  if (url.endsWith('places:searchText')) {
    const b = JSON.parse(init.body);
    const c = b.locationBias.circle.center;
    const i = pts.findIndex((p) => Math.abs(p.lat - c.latitude) < 1e-6 && Math.abs(p.lng - c.longitude) < 1e-6);
    const ids = rank.ranks[b.textQuery][order[i]];
    if (mask === 'places.id,nextPageToken') {
      calls.ids++;
      return b.pageToken ? ok({ places: ids.slice(20, 40).map((id) => ({ id })) }) : ok({ places: ids.slice(0, 20).map((id) => ({ id })), nextPageToken: 't' });
    }
    calls.enterprise++;
    return ok({ places: ids.slice(0, 20).filter((id) => rank.details[id]).map((id) => {
      const d = rank.details[id];
      return { id, displayName: { text: d.name }, formattedAddress: d.address, location: { latitude: d.lat, longitude: d.lng }, googleMapsUri: d.maps_url, rating: d.rating, userRatingCount: d.reviews, websiteUri: d.website || undefined };
    }) });
  }
  calls.other++;
  return realFetch(url, init);
};

const env = { GOOGLE_PLACES_KEY: 'test' };
const call = (path, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
  headers: { Origin: 'https://make.bookease.co', 'Content-Type': 'application/json' },
}), env, {});

const check = (name, cond) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) process.exitCode = 1; };
check('bad origin → 403', (await worker.fetch(new Request('https://w.test/report', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } }), env, {})).status === 403);
check('missing key → 500', (await worker.fetch(new Request('https://w.test/report', { method: 'POST', body: '{}', headers: { Origin: 'https://make.bookease.co' } }), {}, {})).status === 500);
check('bad place id → 400 and no Google call', (await call('/report', { placeId: '../x' })).status === 400 && calls.ids + calls.enterprise + calls.details === 0);
check('view without cache → 404', (await call(`/view?p=${placeId}`)).status === 404);
check('non-Google link rejected', (await parseMapsLink('https://evil.example/maps/place/x')) === null);
const parsed = await parseMapsLink('https://www.google.com/maps/place/Relaxing+Time+Massage/@13.74,100.55,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d13.7406751!4d100.5590485');
check('maps link parsed', parsed && parsed.text === 'Relaxing Time Massage' && parsed.lat === 13.7406751 && parsed.lng === 100.5590485);

const res = await call('/report', { placeId });
const rep = await res.json();
check('report 200', res.status === 200);
check('9 points', rep.points.length === 9 && rep.keywords[0].points.length === 9);
check('36 ids + 2 enterprise + 1 details calls', calls.ids === 36 && calls.enterprise === 2 && calls.details === 1 && calls.other === 0);
console.log('calls', calls, '| centreRank', rep.keywords.map((k) => `${k.keyword}:${k.centreRank}`).join(' '), '| top3', rep.keywords.map((k) => k.top3Count).join('/'),
  '| ranks', rep.keywords[0].points.map((p) => p.rank).join(','), '| volume', rep.volume && rep.volume.total, '| ahead', rep.keywords[0].ahead.map((id) => rep.places[id] && rep.places[id].name).join(' · '));
fs.writeFileSync(outPath, JSON.stringify(rep, null, 1));
