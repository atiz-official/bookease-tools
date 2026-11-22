// Sales lead list + demo-open count + the 5-step funnel, for the bookease.co admin (staff only, CMS login).
// 30-day plan, stream 1 and 4 (Art 2026-11-21): area + shop types → shops ranked by how likely they are to buy,
// each with its own demo link (the Shop Radar report + ?l=<lead id>) and a ready message the TEAM sends.
// The system never contacts a shop: staff copy the message and tick "ติดต่อแล้ว" themselves.
//
// KV (REPORTS):
//   lead/b/<batch>    one list: { id, area, lat, lng, radius, cats, createdAt, leads: [Lead] }
//   lead/i/<lead>     { batch, placeId } — lets the public open-beacon check the id is real
//   lead/p/<placeId>  lead id — the same shop keeps one lead id across lists
//   lead/index        [batch ids], newest last
// D1 (GROWTH_DB, table hits): a demo open = (placeId, day, 'demo', 'lead:<id>') +1.
//
// Ranking note: the rank here is ONE search from the middle of the area (Text Search, 40 results), a cheap signal
// for sorting a call list. It is not the 9-area check the shop sees in its report; never quote it to a shop.

const LEAD_ID = /^[a-z0-9]{8}$/;
const MAX_LEADS = 60;
const HIT_ACTIONS = ['call', 'map', 'web', 'line', 'book']; // a customer action on our pages (not a page view)

function rid(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join('');
}

/** Why this shop is worth a call, in staff words, and a score to sort by. Nothing here is shown to a shop. */
export function scoreLead(p) {
  const why = [];
  let score = 0;
  if (p.phone) { score += 3; why.push('มีเบอร์โทร'); } else why.push('ไม่มีเบอร์บน Google');
  if (p.reviews >= 50) { score += 2; why.push(`รีวิว ${p.reviews}`); } else if (p.reviews >= 20) { score += 1; why.push(`รีวิว ${p.reviews}`); }
  if (p.rank == null) { score += 1; why.push('ไม่ติด 40 อันดับเมื่อค้นจากกลางย่าน'); }
  else if (p.rank <= 3) why.push(`อันดับ ${p.rank} อยู่แล้ว`);
  else if (p.rank <= 10) { score += 3; why.push(`อันดับ ${p.rank} (ยังไม่ติด 3 อันดับแรก)`); }
  else if (p.rank <= 20) { score += 2; why.push(`อันดับ ${p.rank}`); }
  else { score += 1; why.push(`อันดับ ${p.rank}`); }
  if (p.rating >= 4.3) score += 1;
  if (!p.website) { score += 1; why.push('ไม่มีเว็บไซต์'); }
  return { score, why };
}

/** The message staff copy into LINE / SMS. Wording reuses the report's own words; no numbers that the report has not shown yet. */
export function leadMessage(lead) {
  return [
    `สวัสดีครับ ${lead.name}`,
    `ทีม BookEase ตรวจให้แล้วว่าเวลาคน${lead.area ? `ในย่าน${lead.area}` : 'แถวร้าน'}ค้นหา "${lead.label}" บน Google Maps ร้านคุณขึ้นอันดับไหน เทียบกับร้านรอบข้าง`,
    `ดูรายงานฟรี: ${lead.demo}`,
    'อยากให้ลูกค้าแถวร้านเจอร้านก่อน ทัก LINE @bookease ได้เลยครับ',
  ].join('\n');
}

export function demoLink(placeId, cat, leadId) {
  return `https://radar.bookease.co/?p=${encodeURIComponent(placeId)}&c=${encodeURIComponent(cat)}&l=${leadId}`;
}

const MASK = ['id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'nationalPhoneNumber',
  'websiteUri', 'businessStatus', 'googleMapsUri'];

/** Shops of one type around the centre: Text Search order (rank 1–40) plus the 20 nearest of the type (rank null if unseen). */
async function shopsOfType(d, cat, lat, lng, radius) {
  const ranked = [];
  let token;
  for (let i = 0; i < 2; i++) {
    const body = { textQuery: cat.label, pageSize: 20, languageCode: 'th', regionCode: 'TH',
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius } } };
    if (token) body.pageToken = token;
    const r = await d.google(d.env, 'places:searchText', `${MASK.map((f) => `places.${f}`).join(',')},nextPageToken`, body);
    ranked.push(...(r.places || []));
    token = r.nextPageToken;
    if (!token) break;
  }
  const near = await d.google(d.env, 'places:searchNearby', MASK.map((f) => `places.${f}`).join(','),
    { includedTypes: cat.primary, maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'th', regionCode: 'TH',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } } })
    .catch((e) => { console.error('[leads] nearby', cat.id, e); return { places: [] }; });
  const out = new Map();
  const add = (p, rank) => {
    if (!p || !p.id || out.has(p.id) || p.businessStatus === 'CLOSED_PERMANENTLY' || !p.location) return;
    const m = Math.round(d.metres({ lat, lng }, { lat: p.location.latitude, lng: p.location.longitude }));
    if (m > radius) return; // Text Search is only biased to the circle; keep the list inside the area
    out.set(p.id, { placeId: p.id, name: (p.displayName && p.displayName.text) || '', address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '', website: p.websiteUri || '', mapsUrl: p.googleMapsUri || '',
      rating: p.rating == null ? null : p.rating, reviews: p.userRatingCount || 0, m, rank, cat: cat.id, label: cat.label });
  };
  ranked.forEach((p, i) => add(p, i + 1));
  (near.places || []).forEach((p) => add(p, null));
  return [...out.values()];
}

async function batches(env) {
  const ids = (await env.REPORTS.get('lead/index', 'json')) || [];
  return (await Promise.all(ids.map((id) => env.REPORTS.get(`lead/b/${id}`, 'json')))).filter(Boolean);
}

/** Demo opens per lead id: { id: { first, last, n } }. */
async function demoOpens(env) {
  const out = {};
  if (!env.GROWTH_DB) return out;
  const { results } = await env.GROWTH_DB.prepare(
    "SELECT src, MIN(day) AS first, MAX(day) AS last, SUM(n) AS n FROM hits WHERE action = 'demo' GROUP BY src",
  ).bind().all();
  for (const r of results || []) {
    const id = String(r.src || '').replace(/^lead:/, '');
    if (LEAD_ID.test(id)) out[id] = { first: r.first, last: r.last, n: r.n };
  }
  return out;
}

/** Customer actions (call/map/web/line/book) on our pages for paying shops, per Bangkok day. */
async function shopActions(env, ids) {
  const out = Object.fromEntries(ids.map((i) => [i, {}]));
  if (!env.GROWTH_DB || !ids.length) return out;
  const { results } = await env.GROWTH_DB.prepare(
    `SELECT id, day, action, SUM(n) AS n FROM hits WHERE action IN (${HIT_ACTIONS.map((a) => `'${a}'`).join(',')})
     AND id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) GROUP BY id, day, action`,
  ).bind(...ids).all();
  for (const r of results || []) {
    const day = (out[r.id][r.day] = out[r.id][r.day] || {});
    day[r.action] = r.n;
  }
  return out;
}

/**
 * Routes. Returns a Response, or null when the path is not ours.
 * d = { env, json, origin, google, isCmsAdmin, underDailyCap, requestUrl, CATEGORIES, metres, bkkDay, gIndex }
 */
export async function leadRoute(path, body, d) {
  const { env, json, origin } = d;

  // Public: the demo page says "this lead opened it". Only real lead ids count; a bad id is a quiet no.
  if (path === '/lead/open') {
    const id = String(body.l || '');
    if (!LEAD_ID.test(id)) return json({ counted: false }, 200, origin);
    const ref = await env.REPORTS.get(`lead/i/${id}`, 'json');
    if (!ref || (body.p && body.p !== ref.placeId)) return json({ counted: false }, 200, origin);
    if (!env.GROWTH_DB) { console.error('[leads] open: GROWTH_DB not bound'); return json({ error: 'server_misconfigured' }, 500, origin); }
    await env.GROWTH_DB.prepare(
      'INSERT INTO hits (id, day, action, src, n) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (id, day, action, src) DO UPDATE SET n = n + 1',
    ).bind(ref.placeId, d.bkkDay(), 'demo', `lead:${id}`).run();
    return json({ counted: true }, 200, origin);
  }

  if (!['/leads/admin/build', '/leads/admin/list', '/leads/admin/mark'].includes(path)) return null;
  if (!(await d.isCmsAdmin(String(body.token || '')))) return json({ error: 'unauthorized' }, 401, origin);

  if (path === '/leads/admin/build') {
    const area = String(body.area || '').trim().slice(0, 60);
    const radius = Math.min(Math.max(Math.round(Number(body.radius) || 2000), 500), 3000);
    const cats = [...new Set((Array.isArray(body.cats) ? body.cats : []).map(String))]
      .map((c) => d.CATEGORIES.find((x) => x.id === c)).filter(Boolean);
    if (!area) return json({ error: 'area_required' }, 400, origin);
    if (!cats.length || cats.length > 6) return json({ error: 'bad_cats' }, 400, origin);
    let lat = Number(body.lat), lng = Number(body.lng);
    const b = String(body.b || '');
    if (b) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(b)) return json({ error: 'bad_place_id' }, 400, origin);
      const place = await d.google(env, `places/${encodeURIComponent(b)}?languageCode=th&regionCode=TH`, 'id,location', null);
      if (!place || !place.location) return json({ error: 'not_found' }, 404, origin);
      lat = place.location.latitude; lng = place.location.longitude;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: 'bad_centre' }, 400, origin);
    if (!(await d.underDailyCap(env, d.requestUrl, 'find'))) return json({ error: 'full_today' }, 429, origin);

    const lists = await Promise.all(cats.map((c) => shopsOfType(d, c, lat, lng, radius)));
    const paid = new Set((await d.gIndex(env)).map((x) => x.id));
    const seen = new Map();
    lists.flat().forEach((s) => { if (!seen.has(s.placeId) && !paid.has(s.placeId)) seen.set(s.placeId, s); });
    const ranked = [...seen.values()].map((s) => ({ ...s, ...scoreLead(s) }))
      .sort((x, y) => y.score - x.score || (y.reviews || 0) - (x.reviews || 0)).slice(0, MAX_LEADS);

    const batchId = rid(8);
    const leads = [];
    for (const s of ranked) {
      let id = await env.REPORTS.get(`lead/p/${s.placeId}`);
      if (!id || !LEAD_ID.test(id)) {
        id = rid(8);
        await env.REPORTS.put(`lead/p/${s.placeId}`, id);
      }
      await env.REPORTS.put(`lead/i/${id}`, JSON.stringify({ batch: batchId, placeId: s.placeId }));
      const lead = { id, ...s, area, demo: demoLink(s.placeId, s.cat, id), contactedAt: null, note: '' };
      lead.message = leadMessage(lead);
      leads.push(lead);
    }
    const rec = { id: batchId, area, lat, lng, radius, cats: cats.map((c) => c.id), createdAt: new Date().toISOString(), leads };
    await env.REPORTS.put(`lead/b/${batchId}`, JSON.stringify(rec));
    const index = (await env.REPORTS.get('lead/index', 'json')) || [];
    await env.REPORTS.put('lead/index', JSON.stringify([...index, batchId].slice(-50)));
    return json({ batch: rec, skippedCustomers: lists.flat().filter((s) => paid.has(s.placeId)).length }, 200, origin);
  }

  if (path === '/leads/admin/mark') {
    const id = String(body.id || '');
    if (!LEAD_ID.test(id)) return json({ error: 'bad_lead' }, 400, origin);
    const ref = await env.REPORTS.get(`lead/i/${id}`, 'json');
    const rec = ref && await env.REPORTS.get(`lead/b/${ref.batch}`, 'json');
    const lead = rec && rec.leads.find((x) => x.id === id);
    if (!lead) return json({ error: 'not_found' }, 404, origin);
    lead.contactedAt = body.contacted ? (lead.contactedAt || new Date().toISOString()) : null;
    if (body.note !== undefined) lead.note = String(body.note || '').trim().slice(0, 300);
    await env.REPORTS.put(`lead/b/${ref.batch}`, JSON.stringify(rec));
    return json({ lead }, 200, origin);
  }

  // list: every lead list, demo opens, and the paying shops with their customer actions (for the funnel page).
  const [all, opens, index] = await Promise.all([batches(env), demoOpens(env), d.gIndex(env)]);
  const shopIds = index.filter((x) => x.kind === 'shop').map((x) => x.id);
  const customers = await Promise.all(shopIds.map(async (id) => {
    const [shop, billing] = await Promise.all([env.REPORTS.get(`g/shop/${id}`, 'json'), env.REPORTS.get(`g/billing/${id}`, 'json')]);
    return { id, name: (shop && shop.name) || '', since: (shop && shop.since) || '', active: !shop || shop.active !== false,
      billing: billing ? { plan: billing.plan, priceTHB: billing.priceTHB, period: billing.period, paidAt: billing.paidAt,
        paymentVerified: billing.paymentVerified } : null };
  }));
  const actions = await shopActions(env, shopIds);
  return json({ batches: all, opens, customers, actions }, 200, origin);
}
