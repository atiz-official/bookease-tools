/**
 * bookease · Google Maps visibility report · Cloudflare Worker
 * ───────────────────────────────────────────────────────────
 * Powers make.bookease.co/report. Holds the Google Places key server-side.
 *
 * Secret (CF env, never in the page):
 *   GOOGLE_PLACES_KEY   Places API (New) key
 *
 * Public tool, no login (Art 2026-11-14: "free and quick easy to access").
 * Routes (all JSON):
 *   POST /find    {q}                 Maps link or shop name → up to 5 candidates
 *   POST /report  {placeId, cat?, area?, spacing?}
 *                                     live 9-point rank check → report (cached 7 days).
 *                                     cat = shop type id (left out: read from the shop's Google listing)
 *                                     area = neighbourhood id to search from (left out: the nearest one)
 *                                     spacing = metres between the 9 points: 500 (default), 1000 or 2000
 *   GET  /view?p=<placeId>&c=<cat>&a=<area>&s=<spacing>
 *                                     serves a cached report only, never calls Google
 *
 * Google cost per report (pricing page checked 2026-11-14):
 *   20 × Text Search IDs-only      → not billed (9 points + the area landmark, 1 keyword, 2 pages)
 *    1 × Text Search Enterprise    → 1,000 free / month, then $35 per 1,000
 *    1 × Text Search Pro (names)   → 5,000 free / month, then $32 per 1,000
 *    1 × Place Details Enterprise  → 1,000 free / month, then $20 per 1,000
 *   /find = 1 × Text Search Pro    → 5,000 free / month
 *   ≈ 500 reports / month free, then ≈ $0.09 per report.
 *
 * Cost guards, in place of a login:
 *   - DAILY_CAP: new reports / searches per day, then the tool answers "full for today".
 *     New reports are counted in the REPORTS KV namespace (near-exact). Searches are counted in the edge
 *     cache unless a namespace is bound as RATE_LIMIT (approximate: it misses most of the time).
 *   - a finished report is saved 7 days in KV (binding REPORTS), so re-opening a shop costs nothing.
 *   - origin check (stops other websites, not scripts).
 *   The hard guard is a per-day quota on the key in Google Cloud. Set one.
 */

import { AREAS, AREAS_AS_OF, DISTRICTS, VOLUMES } from './areas-data.js';

const PLACES = 'https://places.googleapis.com/v1';
const ALLOWED_ORIGINS = ['https://radar.bookease.co', 'https://make.bookease.co', 'https://atiz-official.github.io'];
// Shop types. `label` is both the word shown in the report and the phrase searched on Maps, Thai only.
// Checked against the real Google Maps app on 2026-11-14:
//   "ร้านนวด"  → API rank matched Maps (1 vs 2, 33 vs 34).
//   "massage"  → API said "not in top 40" where Maps showed the shop at #6. Not trustworthy → English is off
//   until the cause is found. Do not add English keywords without re-checking against Maps.
// The other labels have NOT been compared with the Maps app yet.
// A type is picked in this order: exact Google primary type → a word in the shop name → broad Google types.
// Google files many nail and hair shops under the broad "beauty_salon", so the name is asked before that.
export const CATEGORIES = [
  { id: 'massage', label: 'ร้านนวด', primary: ['massage', 'massage_spa', 'thai_massage'], broad: ['spa', 'sauna', 'wellness_center'], name: /นวด|สปา|massage|\bspa\b/i },
  { id: 'salon', label: 'ร้านเสริมสวย', primary: ['hair_salon', 'hair_care'], broad: ['beauty_salon', 'beautician', 'makeup_artist'], name: /เสริมสวย|ซาลอน|ทำผม|ร้านผม|salon|hair/i },
  { id: 'barber', label: 'ร้านตัดผม', primary: ['barber_shop'], broad: [], name: /บาร์เบอร์|ตัดผม|barber/i },
  { id: 'nail', label: 'ร้านทำเล็บ', primary: ['nail_salon'], broad: [], name: /เล็บ|nail/i },
  { id: 'clinic', label: 'คลินิกความงาม', primary: ['skin_care_clinic'], broad: [], name: /คลินิก.*(ความงาม|ผิว)|ความงาม.*คลินิก|beauty clinic|aesthetic|skin clinic/i },
  { id: 'tattoo', label: 'ร้านสัก', primary: ['body_art_service', 'tattoo_shop'], broad: [], name: /ร้านสัก|สักลาย|tattoo/i },
];

/** Which type is this shop? Returns a CATEGORIES entry, or null when nothing fits. */
export function detectCategory(shopRaw) {
  const primary = shopRaw.primaryType || '';
  const types = shopRaw.types || [];
  const name = (shopRaw.displayName && shopRaw.displayName.text) || '';
  return CATEGORIES.find((c) => c.primary.includes(primary))
    || CATEGORIES.find((c) => c.name.test(name))
    || CATEGORIES.find((c) => c.broad.includes(primary))
    || CATEGORIES.find((c) => types.some((t) => c.primary.includes(t)))
    || CATEGORIES.find((c) => types.some((t) => c.broad.includes(t)))
    || null;
}
const SPACING_M = 500;       // default distance between check points: the shop's door + 8 points around it
const SPACINGS = [500, 1000, 2000]; // distances the page may ask for
const AREA_RADIUS_M = 3000;  // a shop belongs to the nearest area whose landmark is within this distance
const BIAS_RADIUS_M = 300;   // "someone standing here searches"
const PAGES = 2;             // 20 per page → rank up to 40
const CACHE_SECONDS = 7 * 24 * 3600; // how long a shared link keeps working (/view)
const FRESH_SECONDS = 3 * 3600;      // a new check re-uses a report younger than this; rank moves with time of day
const DAILY_CAP = { report: 300, find: 1500 };

// ── helpers ─────────────────────────────────────────────────────────

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, origin, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(origin), 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) },
  });
}

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function grid(lat, lng, spacing = SPACING_M) {
  const dLat = spacing / 111320;
  const dLng = spacing / (111320 * Math.cos(lat * Math.PI / 180));
  const pts = [];
  for (const row of [1, 0, -1]) for (const col of [-1, 0, 1]) {
    pts.push({ lat: +(lat + row * dLat).toFixed(6), lng: +(lng + col * dLng).toFixed(6), centre: row === 0 && col === 0 });
  }
  return pts;
}

async function google(env, path, mask, body) {
  const res = await fetch(`${PLACES}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': mask },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error('[maps-report] google', path, res.status, detail);
    const err = new Error(`google_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function searchBody(query, lat, lng, radius, token) {
  const b = {
    textQuery: query, pageSize: 20, languageCode: 'th', regionCode: 'TH',
    locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius } },
  };
  if (token) b.pageToken = token;
  return b;
}

async function rankedIds(env, kw, pt) {
  const ids = [];
  let token;
  for (let i = 0; i < PAGES; i++) {
    const r = await google(env, 'places:searchText', 'places.id,nextPageToken', searchBody(kw, pt.lat, pt.lng, BIAS_RADIUS_M, token));
    for (const p of r.places || []) ids.push(p.id);
    token = r.nextPageToken;
    if (!token) break;
  }
  return ids;
}

function slim(p) {
  return {
    id: p.id,
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || '',
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    rating: p.rating == null ? null : p.rating,
    reviews: p.userRatingCount == null ? null : p.userRatingCount,
    website: p.websiteUri || '',
    mapsUrl: p.googleMapsUri || '',
  };
}

// ── /find ───────────────────────────────────────────────────────────

const MAPS_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|share\.google|(www\.|maps\.)?google\.[a-z.]+|consent\.google\.com)$/;
// Links that only forward somewhere else: Maps short links, and the "share" link from Google Search
// (share.google/<code> → google.com/share.google?q=<code> → google.com/search?q=<shop name>).
const isShort = (u) => /goo\.gl$|^g\.co$|^share\.google$/.test(u.hostname) || u.pathname === '/share.google';

/** Turn a Google Maps or Google Search share link into {text, lat, lng}. Only ever fetches Google hosts. */
export async function parseMapsLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!MAPS_HOSTS.test(url.hostname)) return null;

  if (isShort(url)) {
    // short link → follow redirects by hand so we never leave Google hosts
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url.toString(), { redirect: 'manual' });
      const loc = res.headers.get('Location');
      if (!loc) break;
      const next = new URL(loc, url);
      if (!MAPS_HOSTS.test(next.hostname)) return null;
      url = next;
      if (!isShort(url)) break;
    }
    if (isShort(url)) return null; // never resolved: its ?q= is a share code, not a shop name
  }
  if (url.hostname === 'consent.google.com') {
    const cont = url.searchParams.get('continue');
    if (!cont) return null;
    try { url = new URL(cont); } catch { return null; }
    if (!MAPS_HOSTS.test(url.hostname)) return null;
  }

  const out = { text: '', lat: null, lng: null };
  const place = url.pathname.match(/\/maps\/place\/([^/]+)/);
  if (place) out.text = decodeURIComponent(place[1].replace(/\+/g, ' '));
  if (!out.text) out.text = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const pin = url.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (pin) { out.lat = +pin[1]; out.lng = +pin[2]; }
  return out.text ? out : null;
}

async function find(env, q) {
  q = String(q || '').trim().slice(0, 500);
  if (q.length < 2) return { error: 'empty' };
  let text = q, lat = 13.7563, lng = 100.5018, radius = 40000; // default: anywhere in Bangkok
  // The share sheet often pastes "shop name + link" together, so the link may sit anywhere in the text.
  const link = q.match(/https?:\/\/\S+/i);
  if (link) {
    const parsed = await parseMapsLink(link[0]);
    const typed = q.replace(link[0], '').trim();
    if (parsed) {
      text = parsed.text;
      if (parsed.lat != null) { lat = parsed.lat; lng = parsed.lng; radius = 500; }
    } else if (typed.length >= 2) {
      text = typed; // unreadable link, but the shop name came with it
    } else {
      return { error: 'bad_link' };
    }
  }
  const r = await google(env, 'places:searchText',
    'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
    { ...searchBody(text, lat, lng, radius), pageSize: 5 });
  // A shop whose name is exactly what was typed (or what the link named) goes first.
  const same = (a) => a.replace(/\s+/g, '').toLowerCase() === text.replace(/\s+/g, '').toLowerCase();
  const candidates = (r.places || []).map(slim);
  candidates.sort((a, b) => same(b.name) - same(a.name));
  return { candidates };
}

// ── /report ─────────────────────────────────────────────────────────

/** Search volume of one shop type in one area / district, or null when Keyword Planner had no number. */
function areaVolume(cat, a) {
  if (cat === 'massage') return { total: a.total, rows: a.rows };
  return (VOLUMES[cat] && VOLUMES[cat].areas[a.id]) || null;
}
function districtVolume(cat, name) {
  const same = AREAS.find((a) => a.name === name); // a district that shares its name with an area uses the area's numbers
  if (same) return areaVolume(cat, same);
  if (cat === 'massage') return DISTRICTS[name] || null;
  return (VOLUMES[cat] && VOLUMES[cat].districts[name]) || null;
}

/**
 * Search volume to show for a shop, for its own shop type, most local first:
 *   1. the area whose landmark is within AREA_RADIUS_M            → "บริเวณอโศก"
 *   2. the shop's district (เขต) read from its Google address      → "เขตบางบอน"
 *   3. the nearest area landmark within 8 km that has a number    → kind 'nearest', with the distance
 * Nothing is invented: if none applies the report says there is no number for this spot.
 */
function volumeFor(cat, shop, area, here) {
  const asOf = cat === 'massage' ? AREAS_AS_OF : (VOLUMES[cat] && VOLUMES[cat].asOf);
  if (area) {
    const v = areaVolume(cat, area);
    if (v) return { kind: 'area', area: area.name, asOf, total: v.total, rows: v.rows };
  }
  const m = /เขต\s*([ก-๙]+)/.exec(shop.address || '');
  if (m) {
    const v = districtVolume(cat, m[1]);
    if (v) return { kind: 'district', area: m[1], asOf, total: v.total, rows: v.rows };
  }
  let near = null, dist = Infinity, nearV = null;
  for (const a of AREAS) {
    const x = metres(here, a);
    if (x >= dist) continue;
    const v = areaVolume(cat, a);
    if (v) { near = a; dist = x; nearV = v; }
  }
  if (near && dist <= 8000) return { kind: 'nearest', area: near.name, km: +(dist / 1000).toFixed(1), asOf, total: nearV.total, rows: nearV.rows };
  return null;
}

function pickedVolume(cat, area) {
  const v = areaVolume(cat, area);
  const asOf = cat === 'massage' ? AREAS_AS_OF : (VOLUMES[cat] && VOLUMES[cat].asOf);
  return v ? { kind: 'area', area: area.name, asOf, total: v.total, rows: v.rows } : null;
}

async function buildReport(env, placeId, catId, areaId, spacing = SPACING_M) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return { error: 'bad_place_id' };

  const shopRaw = await google(env, `places/${placeId}?languageCode=th`,
    'id,displayName,formattedAddress,location,googleMapsUri,rating,userRatingCount,websiteUri,businessStatus,currentOpeningHours.openNow,types,primaryType,primaryTypeDisplayName', null);
  const shop = slim(shopRaw);
  shop.detail = true;
  shop.status = shopRaw.businessStatus || '';
  shop.openNow = shopRaw.currentOpeningHours && typeof shopRaw.currentOpeningHours.openNow === 'boolean' ? shopRaw.currentOpeningHours.openNow : null;
  if (shop.lat == null) return { error: 'no_location' };

  // Shop type: the one asked for, else read from the Google listing. A type we have no keyword list for
  // (a restaurant, a gym) is still ranked, under Google's own Thai name for it, but gets no search volume.
  const asked = CATEGORIES.find((c) => c.id === catId) || null;
  const found = asked || detectCategory(shopRaw);
  const googleName = (shopRaw.primaryTypeDisplayName && shopRaw.primaryTypeDisplayName.text) || '';
  if (!found && !googleName) return { error: 'unknown_type' };
  const category = found
    ? { id: found.id, label: found.label, auto: !asked }
    : { id: 'other', label: googleName, auto: true };
  const KEYWORDS = [category.label];

  // Which neighbourhood? The one the person picked, else the nearest area landmark within AREA_RADIUS_M.
  const here = { lat: shop.lat, lng: shop.lng };
  const picked = AREAS.find((a) => a.id === areaId) || null;
  let area = picked, areaDist = picked ? metres(here, picked) : Infinity;
  if (!picked) {
    for (const a of AREAS) {
      const d = metres(here, a);
      if (d < areaDist && d <= AREA_RADIUS_M) { area = a; areaDist = d; }
    }
  }
  // The ten neighbourhoods nearest the shop, for the picker on the page.
  const areas = AREAS.map((a) => ({ id: a.id, name: a.name, km: +(metres(here, a) / 1000).toFixed(1) }))
    .sort((x, y) => x.km - y.km).slice(0, 10);

  const points = grid(shop.lat, shop.lng, spacing);
  const centre = points.find((p) => p.centre);
  const hub = area ? { lat: area.lat, lng: area.lng } : centre; // where the "shops shown first" list is taken

  const DETAIL = 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.rating,places.userRatingCount,places.websiteUri';
  const NAMES = 'places.id,places.displayName,places.googleMapsUri';
  const rankJobs = [];
  for (const kw of KEYWORDS) for (const pt of points) rankJobs.push(rankedIds(env, kw, pt));
  const hubJobs = KEYWORDS.map((kw) => (area ? rankedIds(env, kw, hub) : null));
  const detailJobs = KEYWORDS.map((kw) => google(env, 'places:searchText', DETAIL, searchBody(kw, hub.lat, hub.lng, BIAS_RADIUS_M)));
  const nameJobs = KEYWORDS.map((kw) => (area ? google(env, 'places:searchText', NAMES, searchBody(kw, centre.lat, centre.lng, BIAS_RADIUS_M)) : null));
  const [rankLists, hubLists, detailLists, nameLists] = await Promise.all([
    Promise.all(rankJobs), Promise.all(hubJobs), Promise.all(detailJobs), Promise.all(nameJobs)]);

  const places = {};
  for (const d of nameLists) for (const p of (d && d.places) || []) places[p.id] = { ...slim(p), detail: false };
  for (const d of detailLists) for (const p of d.places || []) places[p.id] = { ...slim(p), detail: true };
  places[shop.id] = shop;

  const keywords = KEYWORDS.map((kw, ki) => {
    const pts = points.map((pt, pi) => {
      const ids = rankLists[ki * points.length + pi];
      const at = ids.indexOf(shop.id);
      return { rank: at === -1 ? null : at + 1, top: ids.slice(0, 3), seen: ids.length };
    });
    const hubIds = area ? hubLists[ki] : rankLists[ki * points.length + points.indexOf(centre)];
    const hubAt = hubIds.indexOf(shop.id);
    const ahead = [];
    for (const id of hubIds) {
      if (id === shop.id || ahead.length >= 5) break;
      ahead.push(id);
    }
    return {
      keyword: kw,
      points: pts,
      top3Count: pts.filter((p) => p.rank != null && p.rank <= 3).length,
      centreRank: pts[points.indexOf(centre)].rank,
      hubRank: hubAt === -1 ? null : hubAt + 1,
      ahead,
      top10: hubIds.slice(0, 10), // the first ten shops Google shows from the hub, the shop included if it is there
    };
  });

  return {
    version: 9,
    checkedAt: new Date().toISOString(),
    maxRank: PAGES * 20,
    spacingM: spacing,
    spacings: SPACINGS,
    shop, category, categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label })), points, keywords, places,
    area: area && { id: area.id, name: area.name, hub: area.hub, lat: area.lat, lng: area.lng, distanceM: Math.round(areaDist), auto: !picked },
    areas,
    // A picked neighbourhood shows its own number or none; it never falls back to another place's number.
    volume: category.id === 'other' ? null
      : picked ? pickedVolume(category.id, picked)
      : volumeFor(category.id, shop, area, here),
  };
}

// ── cache + rate limit ──────────────────────────────────────────────

// One saved report per shop, shop type, neighbourhood and distance. 'auto' = "whatever the tool chose".
const reportKey = (placeId, cat, area, spacing) => `report/v9/${cat || 'auto'}/${area || 'auto'}/${spacing || SPACING_M}/${placeId}`;

// Where reports are kept. Workers KV (binding REPORTS) gives the same answer on every request for 7 days.
// Without the binding they go to the edge cache, which on *.workers.dev answered only about one request in
// six when measured on 2026-11-15, so shared links kept re-checking Google.
async function loadReport(env, url, key) {
  if (env.REPORTS) return env.REPORTS.get(key, 'json');
  if (typeof caches === 'undefined' || !caches.default) return null;
  const hit = await caches.default.match(new Request(`${new URL(url).origin}/__cache/${key}`));
  return hit ? hit.json() : null;
}

async function saveReport(env, url, keys, report) {
  const body = JSON.stringify(report);
  try {
    if (env.REPORTS) {
      await Promise.all(keys.map((k) => env.REPORTS.put(k, body, { expirationTtl: CACHE_SECONDS })));
      return;
    }
    if (typeof caches === 'undefined' || !caches.default) return;
    await Promise.all(keys.map((k) => caches.default.put(new Request(`${new URL(url).origin}/__cache/${k}`), new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    }))));
  } catch (e) {
    console.error('[maps-report] could not save report', keys[0], e); // the person still gets the report; only the saved copy is missing
  }
}
const catParam = (v) => (CATEGORIES.some((c) => c.id === v) ? v : '');
const areaParam = (v) => (AREAS.some((a) => a.id === v) ? v : '');
const spacingParam = (v) => (SPACINGS.includes(Number(v)) ? Number(v) : SPACING_M);

/** Count one use of `kind` today. Returns false once today's cap is reached. */
async function underDailyCap(env, url, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const cap = DAILY_CAP[kind];
  const kv = env.RATE_LIMIT || (kind === 'report' ? env.REPORTS : null);
  if (kv) {
    const key = `cap:${kind}:${day}`;
    const n = parseInt((await kv.get(key)) || '0', 10);
    if (n >= cap) return false;
    try { await kv.put(key, String(n + 1), { expirationTtl: 90000 }); }
    catch (e) { console.error('[maps-report] could not count today\'s use', kind, e); }
    return true;
  }
  if (typeof caches === 'undefined' || !caches.default) return true; // local test: nothing to count in
  const key = new Request(`${new URL(url).origin}/__cache/cap/${kind}/${day}`);
  const hit = await caches.default.match(key);
  const n = hit ? parseInt(await hit.text(), 10) || 0 : 0;
  if (n >= cap) return false;
  await caches.default.put(key, new Response(String(n + 1), { headers: { 'Cache-Control': 'public, max-age=90000' } }));
  return true;
}

// ── BookEase Growth: work log, weekly rank history, contact counts (2026-11-16) ──
// Every paying shop gets a weekly report built only from these records, so nobody has to write one.
// Rule (Art + Codex 2026-11-16): a number we cannot measure is shown as "ยังวัดไม่ได้"; a measured zero is shown as 0.
//
// KV keys (namespace REPORTS), written by the team with growth-admin.mjs (wrangler, needs a Cloudflare login):
//   g/index            [{id, kind:'shop'|'building'}]   what is tracked; nothing else is counted
//   g/shop/<id>        {id, kind, name, cat, area, since, buildings[], status, ...}
//   g/log/<id>         [{at, what, where, minutes, evidence}]   work we did for the shop
// written by this worker:
//   g/hist/<id>        [{at, keyword, reviews, rating, spacings:[{m, ranks[9], top3, found}], hub}]
//   g/counts/<id>      {"2026-11-16": {"call|site": 2, ...}}   Bangkok dates
//   g/try/<id>         last attempt while the shop was closed (stops retrying every 15 minutes)
const G_ACTIONS = ['view', 'call', 'map', 'web', 'line', 'book', 'review', 'open'];
const G_SPACINGS = [500, 2000];          // near the door, and the wider neighbourhood (≈ 4 km across)
const G_EVERY_MS = 6 * 24 * 3600 * 1000;   // re-check a shop once 6 days have passed
const G_RETRY_MS = 3 * 3600 * 1000;        // shop closed → try again in 3 hours (Google pushes closed shops down)
const bkkDay = (t = Date.now()) => new Date(t + 7 * 3600 * 1000).toISOString().slice(0, 10);
const gid = (v) => (/^[A-Za-z0-9_-]{10,200}$/.test(v || '') ? v : '');

async function gIndex(env) { return (await env.REPORTS.get('g/index', 'json')) || []; }

/**
 * One weekly rank check for a tracked shop. Rank lists use Text Search IDs-only (not billed);
 * the shop itself is one Place Details call (reviews, rating, open now). Skips when the shop is closed.
 * At most 2 × 9 × 2 + 2 + 1 = 39 Google calls, under the 50-subrequest limit of one Worker run.
 */
async function growthSnapshot(env, cfg) {
  const raw = await google(env, `places/${cfg.id}?languageCode=th`, 'id,location,rating,userRatingCount,currentOpeningHours.openNow', null);
  const open = raw.currentOpeningHours && typeof raw.currentOpeningHours.openNow === 'boolean' ? raw.currentOpeningHours.openNow : null;
  if (open === false) return { skipped: 'closed' };
  if (!raw.location) return { skipped: 'no_location' };
  const cat = CATEGORIES.find((c) => c.id === cfg.cat);
  if (!cat) return { skipped: 'no_category' };
  const lat = raw.location.latitude, lng = raw.location.longitude;
  const spacings = [];
  for (const m of G_SPACINGS) {
    const lists = await Promise.all(grid(lat, lng, m).map((pt) => rankedIds(env, cat.label, pt)));
    const ranks = lists.map((ids) => { const i = ids.indexOf(cfg.id); return i === -1 ? null : i + 1; });
    spacings.push({ m, ranks, top3: ranks.filter((r) => r && r <= 3).length, found: ranks.filter(Boolean).length });
  }
  const area = AREAS.find((a) => a.id === cfg.area) || null;
  let hub = null;
  if (area) {
    const ids = await rankedIds(env, cat.label, area);
    const i = ids.indexOf(cfg.id);
    hub = { name: area.hub || area.name, rank: i === -1 ? null : i + 1 };
  }
  return { at: new Date().toISOString(), keyword: cat.label, maxRank: PAGES * 20, open,
    rating: raw.rating == null ? null : raw.rating, reviews: raw.userRatingCount == null ? null : raw.userRatingCount, spacings, hub };
}

/** Is this tracked shop due a check? Returns the config, or null. */
async function growthDue(env, id) {
  const [cfg, hist, tried] = await Promise.all([
    env.REPORTS.get(`g/shop/${id}`, 'json'), env.REPORTS.get(`g/hist/${id}`, 'json'), env.REPORTS.get(`g/try/${id}`)]);
  if (!cfg || cfg.kind !== 'shop' || cfg.active === false) return null;
  const last = hist && hist.length ? Date.parse(hist[hist.length - 1].at) : 0;
  if (Date.now() - last < G_EVERY_MS) return null;
  if (tried && Date.now() - Number(tried) < G_RETRY_MS) return null;
  return cfg;
}

async function growthRun(env, cfg) {
  const snap = await growthSnapshot(env, cfg);
  if (snap.skipped) {
    await env.REPORTS.put(`g/try/${cfg.id}`, String(Date.now()), { expirationTtl: 86400 });
    return snap;
  }
  const hist = (await env.REPORTS.get(`g/hist/${cfg.id}`, 'json')) || [];
  hist.push(snap);
  await env.REPORTS.put(`g/hist/${cfg.id}`, JSON.stringify(hist.slice(-104))); // two years of weeks
  return snap;
}

/** Cron (every 15 min, 10:00–19:45 Bangkok): check the first due shop, at most one per run. */
async function growthTick(env) {
  for (const item of await gIndex(env)) {
    if (item.kind !== 'shop') continue;
    const cfg = await growthDue(env, item.id);
    if (!cfg) continue;
    const out = await growthRun(env, cfg);
    console.log('[growth] tick', item.id, out.skipped || 'checked');
    if (!out.skipped) return;
  }
}

/** Count one contact or view, only for tracked shops and buildings (keeps KV writes small). */
async function growthHit(env, body) {
  const id = gid(String(body.p || ''));
  const a = String(body.a || '');
  const src = String(body.src || 'direct').slice(0, 120);
  if (!id || !G_ACTIONS.includes(a) || !/^[A-Za-z0-9_:.-]{1,120}$/.test(src)) return { error: 'bad_request' };
  if (!(await gIndex(env)).some((x) => x.id === id)) return { counted: false };
  const key = `g/counts/${id}`;
  const counts = (await env.REPORTS.get(key, 'json')) || {};
  const day = bkkDay();
  counts[day] = counts[day] || {};
  counts[day][`${a}|${src}`] = (counts[day][`${a}|${src}`] || 0) + 1;
  await env.REPORTS.put(key, JSON.stringify(counts));
  return { counted: true };
}

/** Everything the weekly report page needs for one shop, from the records above only. */
async function growthData(env, id) {
  const cfg = await env.REPORTS.get(`g/shop/${id}`, 'json');
  if (!cfg) return null;
  const [log, hist, counts] = await Promise.all([
    env.REPORTS.get(`g/log/${id}`, 'json'), env.REPORTS.get(`g/hist/${id}`, 'json'), env.REPORTS.get(`g/counts/${id}`, 'json')]);
  const buildings = await Promise.all((cfg.buildings || []).map(async (b) => {
    const [bc, bcounts] = await Promise.all([env.REPORTS.get(`g/shop/${b}`, 'json'), env.REPORTS.get(`g/counts/${b}`, 'json')]);
    return bc && { ...bc, counts: bcounts || {} };
  }));
  return { shop: cfg, log: log || [], hist: hist || [], counts: counts || {}, buildings: buildings.filter(Boolean), today: bkkDay() };
}

// ── handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin_forbidden' }, 403, origin);
    if (!env.GOOGLE_PLACES_KEY) return json({ error: 'server_misconfigured' }, 500, origin);

    try {
      if (request.method === 'GET' && url.pathname === '/view') {
        const placeId = url.searchParams.get('p') || '';
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json({ error: 'bad_place_id' }, 400, origin);
        const q = url.searchParams;
        const saved = await loadReport(env, request.url,
          reportKey(placeId, catParam(q.get('c')), areaParam(q.get('a')), spacingParam(q.get('s'))));
        if (!saved) return json({ error: 'not_found' }, 404, origin);
        return json(saved, 200, origin);
      }

      // A shop's Google photo, fetched server-side so the key never reaches the page. Only Places photo names.
      if (request.method === 'GET' && url.pathname === '/photo') {
        const name = url.searchParams.get('name') || '';
        if (!/^places\/[A-Za-z0-9_-]{10,200}\/photos\/[A-Za-z0-9_-]{10,1500}$/.test(name)) return json({ error: 'bad_photo' }, 400, origin);
        const w = Math.min(Math.max(parseInt(url.searchParams.get('w') || '800', 10) || 800, 200), 1600);
        const res = await fetch(`${PLACES}/${name}/media?maxWidthPx=${w}&key=${env.GOOGLE_PLACES_KEY}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
        if (!res.ok) { console.error('[maps-report] photo', res.status, name.slice(0, 80)); return json({ error: 'photo_unavailable' }, 502, origin); }
        return new Response(res.body, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
      }

      // BookEase Growth weekly report data for one tracked shop (read-only).
      if (request.method === 'GET' && url.pathname === '/growth') {
        const id = gid(url.searchParams.get('p'));
        if (!id) return json({ error: 'bad_place_id' }, 400, origin);
        const data = await growthData(env, id);
        return data ? json(data, 200, origin) : json({ error: 'not_tracked' }, 404, origin);
      }

      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, origin); }

      // A view or a tap on call / map / web… (sendBeacon from our pages). Counts tracked shops only.
      if (url.pathname === '/hit') {
        const out = await growthHit(env, body);
        return json(out, out.error ? 400 : 200, origin);
      }

      // Take this week's rank check now. Safe without a login: only tracked shops that are due, once a week.
      if (url.pathname === '/growth/snap') {
        const id = gid(String(body.p || ''));
        if (!id) return json({ error: 'bad_place_id' }, 400, origin);
        const cfg = await growthDue(env, id);
        if (!cfg) return json({ error: 'not_due' }, 409, origin);
        const snap = await growthRun(env, cfg);
        return json(snap, snap.skipped ? 409 : 200, origin);
      }

      if (url.pathname === '/find') {
        if (!(await underDailyCap(env, request.url, 'find'))) return json({ error: 'full_today' }, 429, origin);
        const out = await find(env, body.q);
        return json(out, out.error ? 400 : 200, origin);
      }

      // Shops of one Google type around a point (for a building's service menu). Read-only.
      if (url.pathname === '/nearby') {
        const lat = Number(body.lat), lng = Number(body.lng), type = String(body.type || '');
        const types = type.split(',').map((t) => t.trim()).filter(Boolean);
        const radius = Math.min(Math.max(Number(body.radius) || 1000, 100), 2000);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !types.length || types.length > 6 || !types.every((t) => /^[a-z_]{3,40}$/.test(t))) return json({ error: 'bad_request' }, 400, origin);
        if (!(await underDailyCap(env, request.url, 'find'))) return json({ error: 'full_today' }, 429, origin);
        const r = await google(env, 'places:searchNearby',
          'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.rating,places.userRatingCount,places.websiteUri,places.businessStatus,places.primaryType,places.photos',
          { includedTypes: types, maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'th', regionCode: 'TH',
            locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } } });
        return json({ places: (r.places || []).filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY')
          .map((p) => ({ ...slim(p), primaryType: p.primaryType || '', photo: ((p.photos || [])[0] || {}).name || '' })) }, 200, origin);
      }

      // One shop's public Google profile, for the free listing and the Google Maps check (read-only).
      if (url.pathname === '/place') {
        const placeId = String(body.placeId || '');
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json({ error: 'bad_place_id' }, 400, origin);
        if (!(await underDailyCap(env, request.url, 'find'))) return json({ error: 'full_today' }, 429, origin);
        const p = await google(env, `places/${encodeURIComponent(placeId)}?languageCode=th&regionCode=TH`,
          'id,displayName,formattedAddress,location,googleMapsUri,rating,userRatingCount,websiteUri,nationalPhoneNumber,'
          + 'regularOpeningHours.weekdayDescriptions,types,primaryTypeDisplayName,businessStatus,photos,editorialSummary,reviews');
        return json({
          photos: (p.photos || []).slice(0, 10).map((ph) => ({
            name: ph.name, w: ph.widthPx, h: ph.heightPx,
            by: ((ph.authorAttributions || [])[0] || {}).displayName || '',
          })),
          reviewList: (p.reviews || []).map((r) => ({
            rating: r.rating, text: (r.text && r.text.text) || (r.originalText && r.originalText.text) || '',
            by: (r.authorAttribution && r.authorAttribution.displayName) || '', when: r.relativePublishTimeDescription || '',
          })).filter((r) => r.text),
          ...slim(p),
          phone: p.nationalPhoneNumber || '',
          hours: (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || [],
          types: p.types || [],
          primaryType: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
          status: p.businessStatus || '',
          photoCount: (p.photos || []).length,
          summary: (p.editorialSummary && p.editorialSummary.text) || '',
        }, 200, origin);
      }

      if (url.pathname === '/report') {
        const placeId = String(body.placeId || '');
        const cat = catParam(String(body.cat || ''));
        const area = areaParam(String(body.area || ''));
        const spacing = spacingParam(body.spacing);
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json({ error: 'bad_place_id' }, 400, origin);
        const key = reportKey(placeId, cat, area, spacing);
        const old = await loadReport(env, request.url, key);
        if (old && Date.now() - Date.parse(old.checkedAt) < FRESH_SECONDS * 1000) return json({ ...old, cached: true }, 200, origin);
        if (!(await underDailyCap(env, request.url, 'report'))) return json({ error: 'full_today' }, 429, origin);
        const report = await buildReport(env, placeId, cat, area, spacing);
        if (report.error) return json(report, 400, origin);
        // Save under the key that was asked for, and under the shop type it resolved to, so a link that
        // carries &c=<type> and one that does not both open the same report.
        const keys = [key];
        if (report.category.id !== 'other' && report.category.id !== cat) keys.push(reportKey(placeId, report.category.id, area, spacing));
        // Saved before answering (about 0.1 s) so the link works the moment the report is on screen.
        await saveReport(env, request.url, keys, report);
        return json(report, 200, origin);
      }

      return json({ error: 'not_found' }, 404, origin);
    } catch (err) {
      console.error('[maps-report]', url.pathname, err && err.stack || err);
      const quota = err && err.status === 429;
      return json({ error: quota ? 'google_quota' : 'upstream_failed' }, quota ? 429 : 502, origin);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.GOOGLE_PLACES_KEY || !env.REPORTS) { console.error('[growth] tick: missing key or KV'); return; }
    ctx.waitUntil(growthTick(env).catch((e) => console.error('[growth] tick failed', e && e.stack || e)));
  },
};
