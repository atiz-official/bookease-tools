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
 *   POST /report  {placeId}           live 9-point rank check → report (cached 7 days)
 *   GET  /view?p=<placeId>            serves a cached report only, never calls Google
 *
 * Google cost per report (pricing page checked 2026-11-14):
 *   40 × Text Search IDs-only      → not billed (9 points + the area landmark, 2 keywords, 2 pages)
 *    2 × Text Search Enterprise    → 1,000 free / month, then $35 per 1,000
 *    2 × Text Search Pro (names)   → 5,000 free / month, then $32 per 1,000
 *    1 × Place Details Enterprise  → 1,000 free / month, then $20 per 1,000
 *   /find = 1 × Text Search Pro    → 5,000 free / month
 *   ≈ 500 reports / month free, then ≈ $0.09 per report.
 *
 * Cost guards, in place of a login:
 *   - DAILY_CAP: new reports / searches per day, then the tool answers "full for today".
 *     Counted in KV if a namespace is bound as RATE_LIMIT (exact), otherwise in the edge cache
 *     (approximate: per Cloudflare data centre, not atomic).
 *   - a finished report is cached 7 days, so re-opening a shop costs nothing.
 *   - origin check (stops other websites, not scripts).
 *   The hard guard is a per-day quota on the key in Google Cloud. Set one.
 */

import { AREAS, AREAS_AS_OF } from './areas-data.js';

const PLACES = 'https://places.googleapis.com/v1';
const ALLOWED_ORIGINS = ['https://make.bookease.co', 'https://atiz-official.github.io'];
const KEYWORDS = ['ร้านนวด', 'massage'];
const SPACING_M = 500;       // distance between check points: the shop's door + 8 points around it
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

export function grid(lat, lng) {
  const dLat = SPACING_M / 111320;
  const dLng = SPACING_M / (111320 * Math.cos(lat * Math.PI / 180));
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

const MAPS_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|(www\.|maps\.)?google\.[a-z.]+|consent\.google\.com)$/;

/** Turn a Maps link into {text, lat, lng}. Only ever fetches Google Maps hosts. */
export async function parseMapsLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!MAPS_HOSTS.test(url.hostname)) return null;

  if (/goo\.gl$|^g\.co$/.test(url.hostname)) {
    // short link → follow redirects by hand so we never leave Google hosts
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url.toString(), { redirect: 'manual' });
      const loc = res.headers.get('Location');
      if (!loc) break;
      const next = new URL(loc, url);
      if (!MAPS_HOSTS.test(next.hostname)) return null;
      url = next;
      if (!/goo\.gl$|^g\.co$/.test(url.hostname)) break;
    }
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
  if (/^https?:\/\//i.test(q)) {
    const parsed = await parseMapsLink(q);
    if (!parsed) return { error: 'bad_link' };
    text = parsed.text;
    if (parsed.lat != null) { lat = parsed.lat; lng = parsed.lng; radius = 500; }
  }
  const r = await google(env, 'places:searchText',
    'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
    { ...searchBody(text, lat, lng, radius), pageSize: 5 });
  return { candidates: (r.places || []).map(slim) };
}

// ── /report ─────────────────────────────────────────────────────────

async function buildReport(env, placeId) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return { error: 'bad_place_id' };

  const shopRaw = await google(env, `places/${placeId}`,
    'id,displayName,formattedAddress,location,googleMapsUri,rating,userRatingCount,websiteUri,businessStatus,currentOpeningHours.openNow', null);
  const shop = slim(shopRaw);
  shop.detail = true;
  shop.status = shopRaw.businessStatus || '';
  shop.openNow = shopRaw.currentOpeningHours && typeof shopRaw.currentOpeningHours.openNow === 'boolean' ? shopRaw.currentOpeningHours.openNow : null;
  if (shop.lat == null) return { error: 'no_location' };

  // Which neighbourhood is this shop in? Nearest area landmark within AREA_RADIUS_M.
  const here = { lat: shop.lat, lng: shop.lng };
  let area = null, areaDist = Infinity;
  for (const a of AREAS) {
    const d = metres(here, a);
    if (d < areaDist && d <= AREA_RADIUS_M) { area = a; areaDist = d; }
  }

  const points = grid(shop.lat, shop.lng);
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
    };
  });

  return {
    version: 4,
    checkedAt: new Date().toISOString(),
    maxRank: PAGES * 20,
    spacingM: SPACING_M,
    shop, points, keywords, places,
    area: area && { id: area.id, name: area.name, hub: area.hub, lat: area.lat, lng: area.lng, distanceM: Math.round(areaDist) },
    volume: area && { area: area.name, asOf: AREAS_AS_OF, total: area.total, rows: area.rows },
  };
}

// ── cache + rate limit ──────────────────────────────────────────────

function cacheKey(url, placeId) {
  return new Request(`${new URL(url).origin}/__cache/report/v4/${placeId}`);
}

/** Count one use of `kind` today. Returns false once today's cap is reached. */
async function underDailyCap(env, url, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const cap = DAILY_CAP[kind];
  if (env.RATE_LIMIT) {
    const key = `cap:${kind}:${day}`;
    const n = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
    if (n >= cap) return false;
    await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: 90000 });
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

// ── handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const hasCache = typeof caches !== 'undefined' && caches.default;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin_forbidden' }, 403, origin);
    if (!env.GOOGLE_PLACES_KEY) return json({ error: 'server_misconfigured' }, 500, origin);

    try {
      if (request.method === 'GET' && url.pathname === '/view') {
        const placeId = url.searchParams.get('p') || '';
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json({ error: 'bad_place_id' }, 400, origin);
        const hit = hasCache && await caches.default.match(cacheKey(request.url, placeId));
        if (!hit) return json({ error: 'not_found' }, 404, origin);
        return json(await hit.json(), 200, origin);
      }

      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, origin); }

      if (url.pathname === '/find') {
        if (!(await underDailyCap(env, request.url, 'find'))) return json({ error: 'full_today' }, 429, origin);
        const out = await find(env, body.q);
        return json(out, out.error ? 400 : 200, origin);
      }

      if (url.pathname === '/report') {
        const placeId = String(body.placeId || '');
        const key = hasCache && cacheKey(request.url, placeId);
        if (key) {
          const hit = await caches.default.match(key);
          if (hit) {
            const old = await hit.json();
            if (Date.now() - Date.parse(old.checkedAt) < FRESH_SECONDS * 1000) return json({ ...old, cached: true }, 200, origin);
          }
        }
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json({ error: 'bad_place_id' }, 400, origin);
        if (!(await underDailyCap(env, request.url, 'report'))) return json({ error: 'full_today' }, 429, origin);
        const report = await buildReport(env, placeId);
        if (report.error) return json(report, 400, origin);
        if (key) {
          const stored = new Response(JSON.stringify(report), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
          });
          const put = caches.default.put(key, stored);
          if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
        }
        return json(report, 200, origin);
      }

      return json({ error: 'not_found' }, 404, origin);
    } catch (err) {
      console.error('[maps-report]', url.pathname, err && err.stack || err);
      const quota = err && err.status === 429;
      return json({ error: quota ? 'google_quota' : 'upstream_failed' }, quota ? 429 : 502, origin);
    }
  },
};
