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
 *   + 1 × Place Details (reviews), only for a shop Google files under catch-all types alone (e.g. "บริการ")
 *     whose name says nothing either: the search word is then read from its reviews (keywords.js).
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
import { wordFromListing, wordFromReviews } from './keywords.js';
import { MORE, MORE_AS_OF } from './volumes-more.js';

const PLACES = 'https://places.googleapis.com/v1';
const ALLOWED_ORIGINS = ['https://radar.bookease.co', 'https://make.bookease.co', 'https://atiz-official.github.io', 'https://bookease.co'];
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

/**
 * A saved report searched with a word we no longer use: check it again instead of showing it.
 * Reports of a shop outside our own types saved before the automatic search word (KW_VERSION) are all re-checked:
 * some searched Google's catch-all "บริการ" (Art 2026-11-18).
 */
const KW_VERSION = 4; // 4 = ศูนย์ดูแลผู้สูงอายุ (nursing homes), 3 = clinic subtypes, 2026-11-19
const outdated = (r) => !!(r && r.category && r.category.id === 'other' && r.category.kw !== KW_VERSION);

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
// Search volume. Own six types in Bangkok: areas-data.js (2026-11-14/15 pulls). Every other search word, and the six
// outside Bangkok: volumes-more.js (Keyword Planner, location Thailand, types_nationwide.py upload), keyed by the
// search word the report uses (category.label), so a clinic or a car rental gets a number too (Art 2026-11-19).
const more = (label) => (label && MORE[label]) || null;
function areaVolume(cat, a, label) {
  if (cat === 'massage') return { total: a.total, rows: a.rows };
  const own = VOLUMES[cat] && VOLUMES[cat].areas[a.id];
  if (own) return own;
  const m = more(label);
  return (m && m.areas && m.areas[a.id]) || null;
}
function districtVolume(cat, name, label) {
  const same = AREAS.find((a) => a.name === name); // a district that shares its name with an area uses the area's numbers
  if (same) return areaVolume(cat, same, label);
  if (cat === 'massage' && DISTRICTS[name]) return DISTRICTS[name];
  const own = VOLUMES[cat] && VOLUMES[cat].districts[name];
  if (own) return own;
  const m = more(label);
  return (m && m.districts && m.districts[name]) || null;
}
// numbers from volumes-more.js carry its date; the original pulls keep theirs
const isMore = (label, v) => { const m = more(label); return !!(m && v && [m.areas, m.districts, m.places].some((o) => o && Object.values(o).includes(v))); };
const asOfFor = (cat, label, v) => (isMore(label, v) ? MORE_AS_OF : cat === 'massage' ? AREAS_AS_OF : (VOLUMES[cat] && VOLUMES[cat].asOf) || MORE_AS_OF);
const PROVINCE_ALIAS = [['Chon Buri', 'ชลบุรี'], ['Chonburi', 'ชลบุรี'], ['Pattaya', 'พัทยา'], ['Phuket', 'ภูเก็ต'], ['Chiang Mai', 'เชียงใหม่'], ['Hua Hin', 'หัวหิน']];
const PROVINCES_SET = new Set(['กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ',
  'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี',
  'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง',
  'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต', 'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง',
  'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร',
  'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี', 'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ',
  'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี', 'อยุธยา']);
/** Outside Bangkok: the town named in the address (หัวหิน, พัทยา …), else the province. Longest name wins. */
function placeVolume(label, address) {
  const m = more(label);
  if (!m || !m.places) return null;
  let a = String(address || '');
  for (const [en, th] of PROVINCE_ALIAS) if (a.includes(en)) a += ` ${th}`;
  const names = Object.keys(m.places).filter((n) => a.includes(n)).sort((x, y) => y.length - x.length);
  return names.length ? { name: names[0], v: m.places[names[0]] } : null;
}

/**
 * Search volume to show for a shop, for its search word, most local first:
 *   1. the area whose landmark is within AREA_RADIUS_M            → "บริเวณอโศก"
 *   2. the shop's district (เขต) read from its Google address      → "เขตบางบอน"
 *   3. the nearest area landmark within 8 km that has a number    → kind 'nearest', with the distance
 *   4. outside Bangkok: the town named in the address, else the province → kind 'town' / 'province'
 * Nothing is invented: if none applies the report says there is no number for this spot.
 */
function volumeFor(category, shop, area, here) {
  const cat = category.id, label = category.label;
  const out = (kind, name, v, extra = {}) => ({ kind, area: name, asOf: asOfFor(cat, label, v), total: v.total, rows: v.rows, ...extra });
  if (area) {
    const v = areaVolume(cat, area, label);
    if (v) return out('area', area.name, v);
  }
  const m = /เขต\s*([ก-๙]+)/.exec(shop.address || '');
  if (m) {
    const v = districtVolume(cat, m[1], label);
    if (v) return out('district', m[1], v);
  }
  let near = null, dist = Infinity, nearV = null;
  for (const a of AREAS) {
    const x = metres(here, a);
    if (x >= dist) continue;
    const v = areaVolume(cat, a, label);
    if (v) { near = a; dist = x; nearV = v; }
  }
  if (near && dist <= 8000) return out('nearest', near.name, nearV, { km: +(dist / 1000).toFixed(1) });
  const p = placeVolume(label, shop.address);
  if (p) return out(PROVINCES_SET.has(p.name) ? 'province' : 'town', p.name, p.v);
  return null;
}

function pickedVolume(category, area) {
  const v = areaVolume(category.id, area, category.label);
  return v ? { kind: 'area', area: area.name, asOf: asOfFor(category.id, category.label, v), total: v.total, rows: v.rows } : null;
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

  // Shop type: the one asked for, else read from the Google listing. A shop outside our own types still gets a
  // search word, chosen automatically (keywords.js: Google type → name → Google's Thai name → reviews), but no
  // search volume. The owner is never asked (Art 2026-11-18).
  const asked = CATEGORIES.find((c) => c.id === catId) || null;
  let found = asked || detectCategory(shopRaw);
  let other = found ? null : wordFromListing(shopRaw);
  let reviewHits = 0;
  if (!found && !other) {
    // Only Google's catch-all types: read the reviews. One extra Place Details (Atmosphere) call, these shops only.
    const rv = await google(env, `places/${placeId}?languageCode=th`, 'reviews', null);
    const texts = (rv.reviews || []).map((r) => (r.text && r.text.text) || (r.originalText && r.originalText.text) || '');
    const best = wordFromReviews(texts, CATEGORIES.map((c) => [c.name, c.id]));
    const ours = best && CATEGORIES.find((c) => c.id === best.value);
    if (ours) found = ours;
    else if (best) other = { label: best.value, from: 'reviews' };
    reviewHits = best ? best.hits : 0;
  }
  if (!found && !other) return { error: 'unknown_type' };
  const category = found
    ? { id: found.id, label: found.label, auto: !asked, ...(reviewHits ? { from: 'reviews' } : {}) }
    : { id: 'other', label: other.label, auto: true, from: other.from, kw: KW_VERSION };
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
    volume: picked ? pickedVolume(category, picked) : volumeFor(category, shop, area, here),
  };
}

/**
 * A saved report with no search volume gets one looked up again when it is read: volumes-more.js grows after
 * reports were saved (Keyword Planner pull 2026-11-19), and the lookup costs no Google call.
 */
function withVolume(r) {
  if (!r || r.volume || !r.shop || !r.category) return r;
  const area = r.area ? AREAS.find((a) => a.id === r.area.id) || null : null;
  const here = { lat: r.shop.lat, lng: r.shop.lng };
  const volume = area && r.area.auto === false ? pickedVolume(r.category, area) : volumeFor(r.category, r.shop, area, here);
  return volume ? { ...r, volume } : r;
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
// D1 (binding GROWTH_DB, table hits — growth-schema.sql): one row per place, Bangkok day, action, source; atomic +1
//   g/try/<id>         last attempt while the shop was closed (stops retrying every 15 minutes)
const G_ACTIONS = ['view', 'call', 'map', 'web', 'line', 'book', 'review', 'open'];
const G_SPACINGS = [500, 2000];          // near the door, and the wider neighbourhood (≈ 4 km across)
const G_EVERY_MS = 6 * 24 * 3600 * 1000;   // re-check a shop once 6 days have passed
const G_RETRY_MS = 3 * 3600 * 1000;        // shop closed → try again in 3 hours (Google pushes closed shops down)
const bkkDay = (t = Date.now()) => new Date(t + 7 * 3600 * 1000).toISOString().slice(0, 10);
const gid = (v) => (/^[A-Za-z0-9_-]{10,200}$/.test(v || '') ? v : '');

const CMS_API = 'https://atizrail.bookease.co';
/** True when the token is a live bookease.co CMS session (the admin login the team already has). */
async function isCmsAdmin(token) {
  if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/.test(token)) return false;
  try {
    const r = await fetch(`${CMS_API}/api/admin/cms/session`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok;
  } catch (e) {
    console.error('[growth-admin] session check', e);
    return false;
  }
}
async function gIndex(env) { return (await env.REPORTS.get('g/index', 'json')) || []; }

/**
 * One weekly rank check for a tracked shop. Rank lists use Text Search IDs-only (not billed);
 * the shop itself is one Place Details call (reviews, rating, open now). Skips when the shop is closed.
 * At most 2 × 9 × 2 + 2 + 1 = 39 Google calls, under the 50-subrequest limit of one Worker run.
 */
async function growthSnapshot(env, cfg) {
  const raw = await google(env, `places/${cfg.id}?languageCode=th`, 'id,displayName,location,rating,userRatingCount,currentOpeningHours.openNow,photos', null);
  const open = raw.currentOpeningHours && typeof raw.currentOpeningHours.openNow === 'boolean' ? raw.currentOpeningHours.openNow : null;
  if (open === false) return { skipped: 'closed' };
  if (!raw.location) return { skipped: 'no_location' };
  // own six types by id; any other shop type carries its search word (cfg.word, set by growth-admin --word)
  const cat = CATEGORIES.find((c) => c.id === cfg.cat) || (cfg.cat === 'other' && cfg.word ? { id: 'other', label: String(cfg.word) } : null);
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
  const name = raw.displayName && raw.displayName.text;
  const photos = raw.photos || [];
  const own = photos.find((ph) => (ph.authorAttributions || []).some((a) => a.displayName === name)) || photos[0];
  return { at: new Date().toISOString(), keyword: cat.label, maxRank: PAGES * 20, open,
    rating: raw.rating == null ? null : raw.rating, reviews: raw.userRatingCount == null ? null : raw.userRatingCount, spacings, hub,
    photo: own ? own.name : null };
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
// ── LINE: link the owner, push the weekly card ──
const LINE_API = 'https://api.line.me/v2/bot/message';
const LINK_RE = /เชื่อมรายงาน\s+([A-Za-z0-9_-]{10,200})/;

async function lineSignatureOk(secret, raw, signature) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function lineCall(env, path, payload) {
  if (!env.LINE_CHANNEL_TOKEN) { console.error('[line] no LINE_CHANNEL_TOKEN; not sending', path); return false; }
  const r = await fetch(`${LINE_API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` }, body: JSON.stringify(payload) });
  if (!r.ok) { console.error('[line]', path, r.status, (await r.text()).slice(0, 300)); return false; }
  return true;
}

/** "เชื่อมรายงาน <placeId>" from the owner → remember their LINE user for that shop and answer with this week's card. */
async function lineEvent(env, ev) {
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.source || !ev.source.userId) return;
  const m = LINK_RE.exec(ev.message.text || '');
  if (!m) return; // any other chat is the team's to answer
  const id = gid(m[1]);
  const cfg = id ? await env.REPORTS.get(`g/shop/${id}`, 'json') : null;
  if (!cfg || cfg.kind !== 'shop') {
    await lineCall(env, 'reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text: 'ยังไม่พบรายงานของร้านนี้ครับ ทีมงานจะตรวจสอบและติดต่อกลับ' }] });
    return;
  }
  const old = (await env.REPORTS.get(`g/line/${id}`, 'json')) || {};
  await env.REPORTS.put(`g/line/${id}`, JSON.stringify({ ...old, userId: ev.source.userId, linkedAt: new Date().toISOString() }));
  const data = await growthData(env, id);
  const messages = [{ type: 'text', text: `เชื่อมรายงานของ ${cfg.name} แล้วครับ ทุกวันจันทร์จะส่งการ์ดสรุปให้ที่นี่` }];
  if (data && data.hist.length) messages.push(growthFlex(data.card));
  await lineCall(env, 'reply', { replyToken: ev.replyToken, messages });
}

/** Monday from 10:00 Bangkok: one push per linked, paying shop per week. Off until LINE_CHANNEL_TOKEN is set. */
async function lineWeekly(env, now = Date.now()) {
  if (!env.LINE_CHANNEL_TOKEN) return 0;
  const bkk = new Date(now + 7 * 3600 * 1000);
  if (bkk.getUTCDay() !== 1 || bkk.getUTCHours() < 10) return 0;
  let sent = 0;
  for (const item of await gIndex(env)) {
    if (item.kind !== 'shop') continue;
    const [line, billing] = await Promise.all([env.REPORTS.get(`g/line/${item.id}`, 'json'), env.REPORTS.get(`g/billing/${item.id}`, 'json')]);
    if (!line || !line.userId || !billing) continue;
    if (line.pushedAt && now - Date.parse(line.pushedAt) < 6 * 24 * 3600 * 1000) continue;
    const data = await growthData(env, item.id);
    if (!data || !data.hist.length || data.shop.active === false) continue;
    if (await lineCall(env, 'push', { to: line.userId, messages: [growthFlex(data.card)] })) {
      await env.REPORTS.put(`g/line/${item.id}`, JSON.stringify({ ...line, pushedAt: new Date(now).toISOString() }));
      sent += 1;
    }
  }
  return sent;
}

async function growthTick(env) {
  const pushed = await lineWeekly(env).catch((e) => { console.error('[line] weekly', e && e.stack || e); return 0; });
  if (pushed) console.log('[line] weekly cards sent', pushed);
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
  if (!env.GROWTH_DB) { console.error('[growth] hit: GROWTH_DB not bound'); return { error: 'server_misconfigured' }; }
  // One atomic +1 in D1. (KV lost taps: two taps in the same second read the same old value.)
  await env.GROWTH_DB.prepare(
    'INSERT INTO hits (id, day, action, src, n) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (id, day, action, src) DO UPDATE SET n = n + 1',
  ).bind(id, bkkDay(), a, src).run();
  return { counted: true };
}

/** Counts for some places as {id: {"2026-11-16": {"call|site": 2}}}, last 400 days. */
async function growthCounts(env, ids) {
  const out = Object.fromEntries(ids.map((i) => [i, {}]));
  if (!env.GROWTH_DB || !ids.length) return out;
  const since = bkkDay(Date.now() - 400 * 86400e3);
  const { results } = await env.GROWTH_DB.prepare(
    `SELECT id, day, action, src, n FROM hits WHERE day >= ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
  ).bind(since, ...ids).all();
  for (const r of results || []) {
    const day = (out[r.id][r.day] = out[r.id][r.day] || {});
    day[`${r.action}|${r.src}`] = r.n;
  }
  return out;
}

/** Everything the weekly report page needs for one shop, from the records above only. */
async function growthData(env, id) {
  const cfg = await env.REPORTS.get(`g/shop/${id}`, 'json');
  if (!cfg) return null;
  const bIds = cfg.buildings || [];
  const [log, hist, counts, bcfgs, plan] = await Promise.all([
    env.REPORTS.get(`g/log/${id}`, 'json'), env.REPORTS.get(`g/hist/${id}`, 'json'), growthCounts(env, [id, ...bIds]),
    Promise.all(bIds.map((b) => env.REPORTS.get(`g/shop/${b}`, 'json'))), env.REPORTS.get(`g/plan/${id}`, 'json')]);
  const buildings = bcfgs.map((bc, i) => bc && { ...bc, counts: counts[bIds[i]] || {} }).filter(Boolean);
  const line = await env.REPORTS.get(`g/line/${id}`, 'json');
  const data = { shop: cfg, log: log || [], plan: plan || [], hist: hist || [], counts: counts[id] || {}, buildings, today: bkkDay(),
    lineLinked: Boolean(line && line.userId), linePushedAt: (line && line.pushedAt) || null };
  data.card = growthCard(data);
  return data;
}

// ── The weekly LINE card ──
// Approved by Art 2026-11-16 (9.2/10, "do not redesign further"): a picture, not text.
//   headline (3–4 words) · "จากอันดับ 6 → 8" · ค้นหา “<type>” แถว <hub> · rank ladder with the shop's own photo ·
//   📞 กดโทรหาร้าน N ครั้ง · one button "ดูว่าเราทำอะไรให้ร้าน" (work done, plans and every other number live behind it).
// Rules: plain words · ≤ 2 numbers · a bad week is said plainly (red) · never "ลูกค้าเพิ่มขึ้น" · calls are counted as taps (ครั้ง),
// not people · the work list is never on the card and never linked to the result.
// One source for the picture the team sends today and the Flex message the LINE bot will push.
const G_REPORT_URL = 'https://radar.bookease.co/growth/?p=';
const G_WORKER_URL = 'https://bookease-maps-report.atiz-cloudflare-account.workers.dev';
const G_TONE = { up: '#15803D', down: '#B42318', same: '#2D55EB', start: '#2D55EB', wait: '#2D55EB' };

/** Rows of the rank ladder: the top spot, the shop, the row above it, last week's spot; "gap" where numbers jump. */
function growthLadder(r, p, max, kind) {
  const pos = (x) => (x == null ? max + 1 : x);           // not found = just below the list
  const lab = (x) => (x == null ? `${max}+` : String(x));
  const me = pos(r), was = p === undefined ? null : pos(p);
  const nums = new Set([1, me, Math.max(1, me - 1)]);
  if (was != null && was !== me) nums.add(was);
  if (kind === 'down' && was != null) for (let x = was + 1; x < me && x <= was + 1; x++) nums.add(x);
  if (kind === 'start' || kind === 'same') nums.add(me + 1 <= max ? me + 1 : me);
  const sorted = [...nums].filter((x) => x >= 1 && x <= max + 1).sort((a, b) => a - b);
  const rows = [];
  sorted.forEach((x, i) => {
    if (i && x - sorted[i - 1] > 1) rows.push({ kind: 'gap' });
    rows.push({ n: x === me ? lab(r) : x === was ? lab(p) : String(x), kind: x === me ? 'me' : x === was && kind !== 'same' ? 'was' : '' });
  });
  return rows;
}

function growthCard(d) {
  const s = d.shop, hist = d.hist || [], last = hist[hist.length - 1], prev = hist[hist.length - 2];
  const week = Math.max(1, Math.floor((Date.parse(d.today) - Date.parse(s.since)) / (7 * 86400e3)) + 1);
  const from7 = bkkDay(Date.parse(d.today) - 6 * 86400e3 - 7 * 3600e3);
  let calls7 = 0;
  for (const [day, row] of Object.entries(d.counts || {})) {
    if (day < from7 || day > d.today) continue;
    for (const [k, n] of Object.entries(row)) if (k.split('|')[0] === 'call') calls7 += n;
  }
  const photoName = (last && last.photo) || s.photo || '';
  const out = (tone, headline, from, where, ladder) => ({
    name: s.name, week, tone, color: G_TONE[tone], headline, from: from || '', where: where || '', ladder: ladder || [],
    calls: `กดโทรหาร้าน ${calls7} ครั้ง`, cta: 'ดูว่าเราทำอะไรให้ร้าน', url: `${G_REPORT_URL}${s.id}#work`,
    photo: photoName ? `${G_WORKER_URL}/photo?w=200&name=${encodeURIComponent(photoName)}` : '',
  });
  if (!last) return out('wait', 'เริ่มดูแลร้านคุณแล้ว', '', 'เราจะตรวจอันดับร้านคุณครั้งแรกเร็วๆ นี้');

  const kw = last.keyword, max = last.maxRank || 40;
  if (last.hub) {
    const where = `ค้นหา “${kw}” แถว ${last.hub.name}`;
    const r = last.hub.rank, lab = (x) => (x == null ? `${max}+` : x);
    if (!prev || !prev.hub) return out('start', r ? `ตอนนี้อยู่อันดับ ${r}` : `ยังไม่ติด ${max} ร้านแรก`, '', where, growthLadder(r, undefined, max, 'start'));
    const p = prev.hub.rank, pos = (x) => (x == null ? max + 1 : x);
    const from = `จากอันดับ ${lab(p)} → ${lab(r)}`;
    if (pos(r) < pos(p)) return out('up', `ขึ้นเป็นอันดับ ${r} ↑`, from, where, growthLadder(r, p, max, 'up'));
    if (pos(r) > pos(p)) return out('down', r ? `ตกไปอันดับ ${r} ↓` : `หลุด ${max} ร้านแรก ↓`, from, where, growthLadder(r, p, max, 'down'));
    return out('same', r ? `ยังอยู่อันดับ ${r}` : `ยังไม่ติด ${max} ร้านแรก`, '', where, growthLadder(r, p, max, 'same'));
  }
  // No area hub for this shop: no ladder; the result is the wider ring around the shop (Art's locked wording).
  const found = (h) => h.spacings[1].top3;
  const say = (n) => (n === 9 ? 'เจอร้านคุณทุกพื้นที่ค้นหา' : n === 0 ? 'ยังไม่เจอร้านคุณ' : `เจอร้านคุณ ${n} ใน 9 พื้นที่ค้นหา`);
  const where = `ค้นหา “${kw}” รอบร้าน 2 กม.`;
  if (!prev) return out('start', say(found(last)), '', where);
  const n = found(last), b = found(prev);
  return out(n > b ? 'up' : n < b ? 'down' : 'same', say(n), n === b ? '' : `จาก ${b} → ${n} ใน 9`, where);
}

/** LINE Messaging API flex message for the card (push it once the bot has the channel token). */
function growthFlex(c) {
  const t = (text, o = {}) => ({ type: 'text', text, wrap: true, ...o });
  const rung = (row) => {
    if (row.kind === 'gap') return t('···', { size: 'sm', color: '#8A827B', align: 'center', margin: 'xs' });
    const num = t(row.n, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center', flex: 0, color: row.kind === 'me' ? c.color : '#8A827B' });
    let bar;
    if (row.kind === 'me') {
      bar = { type: 'box', layout: 'horizontal', flex: 1, height: '36px', cornerRadius: '10px', backgroundColor: c.color, paddingStart: '6px', spacing: 'sm', alignItems: 'center', contents: [
        ...(c.photo ? [{ type: 'box', layout: 'vertical', width: '26px', height: '26px', cornerRadius: '13px', flex: 0, contents: [{ type: 'image', url: c.photo, size: 'full', aspectMode: 'cover', aspectRatio: '1:1' }] }] : []),
        t('ร้านคุณ', { size: 'sm', weight: 'bold', color: '#FFFFFF', gravity: 'center', paddingStart: c.photo ? '0px' : '8px' })] };
    } else if (row.kind === 'was') {
      bar = { type: 'box', layout: 'horizontal', flex: 1, height: '36px', cornerRadius: '10px', borderWidth: '2px', borderColor: '#D9D2CB', paddingStart: '10px', alignItems: 'center', contents: [t('สัปดาห์ก่อน', { size: 'xs', color: '#8A827B', gravity: 'center' })] };
    } else {
      bar = { type: 'box', layout: 'vertical', flex: 1, height: '36px', cornerRadius: '10px', backgroundColor: '#EFEBE7', contents: [] };
    }
    return { type: 'box', layout: 'horizontal', spacing: 'md', margin: 'sm', alignItems: 'center', contents: [{ type: 'box', layout: 'vertical', width: '30px', flex: 0, contents: [num] }, bar] };
  };
  return {
    type: 'flex', altText: `${c.headline} · ${c.name}`.slice(0, 400),
    contents: {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', contents: [{ type: 'span', text: 'book', color: '#0A0A0A', weight: 'bold' }, { type: 'span', text: 'ease', color: '#2D55EB', weight: 'bold' }], size: 'sm' },
          t(`สัปดาห์ที่ ${c.week}`, { size: 'xs', color: '#8A827B', align: 'end' })] },
        t(c.headline, { size: 'xl', weight: 'bold', color: c.color, margin: 'md' }),
        ...(c.from ? [t(c.from, { size: 'sm', weight: 'bold', color: c.color, margin: 'xs' })] : []),
        ...(c.where ? [t(c.where, { size: 'xs', color: '#8A827B', margin: 'xs' })] : []),
        ...(c.ladder.length ? [{ type: 'box', layout: 'vertical', margin: 'md', contents: c.ladder.map(rung) }] : []),
        { type: 'box', layout: 'horizontal', margin: 'lg', paddingAll: '12px', cornerRadius: '12px', backgroundColor: '#F7F5F2', contents: [t(`📞 ${c.calls}`, { size: 'md', weight: 'bold', color: '#14110F' })] },
      ] },
      footer: { type: 'box', layout: 'vertical', paddingStart: '18px', paddingEnd: '18px', paddingBottom: '18px', paddingTop: '0px', contents: [
        { type: 'button', style: 'primary', color: '#2D55EB', height: 'sm', action: { type: 'uri', label: c.cta, uri: c.url } }] },
    },
  };
}

// ── handler ─────────────────────────────────────────────────────────

export { growthCard, growthFlex, growthLadder, lineWeekly, lineSignatureOk };

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
        if (!saved || outdated(saved)) return json({ error: 'not_found' }, 404, origin);
        return json(withVolume(saved), 200, origin);
      }

      // A shop's Google photo, fetched server-side so the key never reaches the page. Only Places photo names.
      if (request.method === 'GET' && url.pathname === '/photo') {
        const name = url.searchParams.get('name') || '';
        if (!/^places\/[A-Za-z0-9_-]{10,200}\/photos\/[A-Za-z0-9_-]{10,1500}$/.test(name)) return json({ error: 'bad_photo' }, 400, origin);
        const w = Math.min(Math.max(parseInt(url.searchParams.get('w') || '800', 10) || 800, 200), 1600);
        const res = await fetch(`${PLACES}/${name}/media?maxWidthPx=${w}&key=${env.GOOGLE_PLACES_KEY}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
        if (!res.ok) { console.error('[maps-report] photo', res.status, name.slice(0, 80)); return json({ error: 'photo_unavailable' }, 502, origin); }
        return new Response(res.body, { headers: { ...cors(origin), 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
      }

      // BookEase Growth weekly report data for one tracked shop (read-only).
      if (request.method === 'GET' && url.pathname === '/growth') {
        const id = gid(url.searchParams.get('p'));
        if (!id) return json({ error: 'bad_place_id' }, 400, origin);
        const data = await growthData(env, id);
        return data ? json(data, 200, origin) : json({ error: 'not_tracked' }, 404, origin);
      }

      // The weekly card as a LINE flex message (what the bot will push; paste into LINE Flex Simulator to preview).
      if (request.method === 'GET' && url.pathname === '/growth/flex') {
        const id = gid(url.searchParams.get('p'));
        if (!id) return json({ error: 'bad_place_id' }, 400, origin);
        const data = await growthData(env, id);
        return data ? json(growthFlex(data.card), 200, origin) : json({ error: 'not_tracked' }, 404, origin);
      }

      // LINE OA @bookease webhook: the owner links the weekly card by sending "เชื่อมรายงาน <placeId>" (prefilled link
      // from the staff page). Every other message is left alone for the team. Off until LINE_CHANNEL_SECRET is set.
      if (request.method === 'POST' && url.pathname === '/line/webhook') {
        if (!env.LINE_CHANNEL_SECRET) return json({ error: 'line_off' }, 503, origin);
        const raw = await request.text();
        if (!(await lineSignatureOk(env.LINE_CHANNEL_SECRET, raw, request.headers.get('x-line-signature') || ''))) return json({ error: 'bad_signature' }, 401, origin);
        let events = [];
        try { events = JSON.parse(raw).events || []; } catch (e) { console.error('[line] bad body', e); return json({ error: 'invalid_json' }, 400, origin); }
        for (const ev of events) {
          try { await lineEvent(env, ev); } catch (e) { console.error('[line] event', e && e.stack || e); }
        }
        return json({ ok: true }, 200, origin);
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
      // Team registration of BookEase Growth shops, from the bookease.co admin (its CMS login is the only key:
      // the worker asks atizrail whether the token is a live CMS session). Billing stays in g/billing/<id>,
      // never in g/shop, because the public report page returns g/shop to the browser.
      if (url.pathname === '/growth/admin/list' || url.pathname === '/growth/admin/save') {
        if (!(await isCmsAdmin(String(body.token || '')))) return json({ error: 'unauthorized' }, 401, origin);
        if (url.pathname === '/growth/admin/list') {
          const index = (await gIndex(env)).filter((x) => x.kind === 'shop');
          const rows = await Promise.all(index.map(async ({ id }) => {
            const [shop, billing, hist, log, plan] = await Promise.all(['shop', 'billing', 'hist', 'log', 'plan']
              .map((k) => env.REPORTS.get(`g/${k}/${id}`, 'json')));
            const h = hist || [];
            const ring = (snap, m) => { const r = snap && (snap.spacings || []).find((x) => x.m === m); return r ? r.top3 : null; };
            return { id, shop, billing, first: h[0] ? { at: h[0].at, near: ring(h[0], 500), wide: ring(h[0], 2000) } : null,
              last: h.length ? { at: h[h.length - 1].at, near: ring(h[h.length - 1], 500), wide: ring(h[h.length - 1], 2000),
                rating: h[h.length - 1].rating, reviews: h[h.length - 1].reviews } : null,
              checks: h.length, workDone: (log || []).length, lastWork: (log || []).length ? log[log.length - 1].at : null,
              planned: (plan || []).filter((x) => !x.done).length };
          }));
          return json({ rows }, 200, origin);
        }
        const id = gid(String(body.placeId || ''));
        if (!id) return json({ error: 'bad_place_id' }, 400, origin);
        const name = String(body.name || '').trim().slice(0, 120);
        const word = String(body.word || '').trim().slice(0, 60);
        const cat = word ? 'other' : String(body.cat || '');
        if (!name) return json({ error: 'name_required' }, 400, origin);
        if (!['salon', 'massage', 'barber', 'nail', 'clinic', 'tattoo', 'other'].includes(cat)) return json({ error: 'bad_cat' }, 400, origin);
        const plan = String(body.plan || '');
        if (!['basic', 'custom', 'premium'].includes(plan)) return json({ error: 'bad_plan' }, 400, origin);
        const price = Math.round(Number(body.priceTHB));
        if (!Number.isFinite(price) || price < 0 || price > 1000000) return json({ error: 'bad_price' }, 400, origin);
        const period = body.period === 'yearly' ? 'yearly' : 'monthly';
        const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
        const text = (v, n) => String(v || '').trim().slice(0, n);
        const old = (await env.REPORTS.get(`g/shop/${id}`, 'json')) || {};
        const shop = { ...old, id, kind: 'shop', name, cat, word: cat === 'other' ? word : undefined,
          area: text(body.area, 40) || old.area || '', since: old.since || day(body.since) || bkkDay(),
          buildings: old.buildings || [], active: body.active !== false };
        const oldBilling = (await env.REPORTS.get(`g/billing/${id}`, 'json')) || {};
        const billing = { ...oldBilling, id, plan, priceTHB: price, period, paidAt: day(body.paidAt),
          receipt: text(body.receipt, 64), paymentVerified: Boolean(body.paymentVerified) && Boolean(text(body.receipt, 64)),
          gbpManager: Boolean(body.gbpManager), contact: text(body.contact, 120), note: text(body.note, 300),
          updatedAt: new Date().toISOString() };
        await env.REPORTS.put(`g/shop/${id}`, JSON.stringify(shop));
        await env.REPORTS.put(`g/billing/${id}`, JSON.stringify(billing));
        const index = await gIndex(env);
        if (!index.some((x) => x.id === id)) await env.REPORTS.put('g/index', JSON.stringify([...index, { id, kind: 'shop' }]));
        return json({ ok: true, shop, billing }, 200, origin);
      }

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
      // Every service shop within 1 km of a building, for the bookease.co Nearby Services page (/r/<code>).
      // One Google pass per building per day (cached in KV): the page is a daily picture, not a live one.
      if (url.pathname === '/directory') {
        const b = String(body.b || '');
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(b)) return json({ error: 'bad_place_id' }, 400, origin);
        const key = `dir/v1/${b}`;
        const cached = env.REPORTS ? await env.REPORTS.get(key, 'json') : null;
        if (cached) return json(cached, 200, origin);
        if (!(await underDailyCap(env, request.url, 'find'))) return json({ error: 'full_today' }, 429, origin);
        const place = await google(env, `places/${encodeURIComponent(b)}?languageCode=th&regionCode=TH`, 'id,displayName,location');
        if (!place || !place.location) return json({ error: 'not_found' }, 404, origin);
        const lat = place.location.latitude, lng = place.location.longitude;
        const TYPES = [['massage', 'spa'], ['hair_salon'], ['barber_shop'], ['nail_salon'], ['beauty_salon', 'beautician'],
          ['skin_care_clinic'], ['dental_clinic'], ['physiotherapist'], ['gym', 'fitness_center', 'yoga_studio'], ['laundry']];
        let failed = 0;
        const lists = await Promise.all(TYPES.map((types) => google(env, 'places:searchNearby',
          'places.id,places.displayName,places.location,places.googleMapsUri,places.rating,places.userRatingCount,places.businessStatus,places.primaryType,places.photos,places.nationalPhoneNumber',
          { includedTypes: types, maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'th', regionCode: 'TH',
            locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 1000 } } })
          .catch((e) => { console.error('[directory] nearby', types.join(','), e); failed += 1; return { places: [] }; })));
        const seen = new Map();
        lists.forEach((r, i) => (r.places || []).forEach((p) => {
          if (p.id === b || seen.has(p.id) || p.businessStatus === 'CLOSED_PERMANENTLY') return;
          const s2 = slim(p);
          const x = (s2.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180), y = (s2.lat - lat) * 110540;
          seen.set(p.id, { id: s2.id, name: s2.name, rating: s2.rating, reviews: s2.reviews, mapsUrl: s2.mapsUrl,
            phone: p.nationalPhoneNumber || '', primaryType: p.primaryType || '', group: i,
            photo: ((p.photos || [])[0] || {}).name || '', m: Math.round(Math.hypot(x, y)) });
        }));
        const out = { building: { id: b, name: (place.displayName && place.displayName.text) || '', lat, lng },
          shops: [...seen.values()], at: new Date().toISOString() };
        // A partial answer is served but not cached, so tomorrow's visitors do not inherit a missing group.
        if (env.REPORTS && !failed) await env.REPORTS.put(key, JSON.stringify(out), { expirationTtl: 86400 });
        return json(out, 200, origin);
      }

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
        if (old && !outdated(old) && Date.now() - Date.parse(old.checkedAt) < FRESH_SECONDS * 1000) return json({ ...withVolume(old), cached: true }, 200, origin);
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
