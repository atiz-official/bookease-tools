# Shop Radar · Worker `bookease-maps-report` for make.bookease.co/radar

Product name locked by Art 2026-11-14: **Shop Radar** (tagline changed by Art 2026-11-15: ลูกค้าเจอร้านคุณไหม?). The page lives in `radar/`; `report/` only redirects to it.

Status 2026-11-14: **written and tested locally, NOT deployed.** Branch `feat/maps-report` (worktree
`C:\Users\saras\Projects\bookease-tools-wt-report`), nothing pushed.

## What it does
`report/index.html` (page) → this Worker → Google Places API (New). See the header of `worker.js`
for routes and the Google cost per report.

## To go live (in order)
1. Cloudflare API token ("Edit Cloudflare Workers" template) → 1Password, vault Atiz Dev.
2. Deploy `worker.js` as a NEW script `bookease-maps-report` (module format; same REST method as
   SYSTEM_MAP.md §7 — do not touch `bookease-anthropic-proxy`).
3. Worker secret: `GOOGLE_PLACES_KEY` (the merchant-discovery key in 1Password, or better a second
   key restricted to Places API (New)). No PIN: Art decided 2026-11-14 the tool is public and free.
   Cost guard = DAILY_CAP in worker.js (300 new reports/day) + 7-day cache.
4. Check `CONFIG.api` in `report/index.html` matches the Worker URL.
5. Optional, for a zoomable map: enable Maps JavaScript API in GCP project bookease2024, create a
   browser key restricted to `https://make.bookease.co/*`, put it in `CONFIG.mapsJsKey`.
   Without it the page shows a locked Google map picture with the points on top (works today).
6. Merge to `main` → GitHub Pages publishes make.bookease.co/report/.
7. Recommended: set a per-day quota on the Places key in GCP so a leaked PIN cannot run up a bill.

## Test without deploying
    cd cf-worker-maps-report
    node test-local.mjs <rank-json> <discovery-csv> <place-id> ../report/demo-local.json
Runs the real Worker code in Node with Google mocked from a saved rank check; writes a report JSON.
Preview: serve the repo root, open `/report/?demo=demo-local.json` (localhost only; the demo file is
gitignored because it holds real shop names and ranks).

## Found on day one (2026-11-14)
- **SUPERSEDED for sales (Art 2026-11-19): shop open/closed and time of day are not a factor to act on. Never tell anyone to wait or re-check by the hour; daily freshness is enough.** Original note: **Rank swings with opening hours.** Same shop, same day: Relaxing Time was #33 at 01:30 (closed) and
  #1 at its own door at 10:40 (open); Worrapan was top-3 at 9/9 points at 01:30 (open) and outside the
  top 40 everywhere at 10:40 (closed). The report now carries `shop.openNow` and the page says so.
  Always check a shop during its opening hours before quoting a rank to the owner.
- Measured on Cloudflare: /find 0.6 s, fresh /report 2.1 s, cached 0.08 s.
- Status: LIVE at https://make.bookease.co/report/ (Worker deployed via `wrangler login` OAuth as
  official@atiz.com, account "Atiz Cloudflare Account"; no API token was created).

## Not verified yet
- Real seconds per report on Cloudflare (36 parallel Google calls; expected a few seconds).
- Short links (maps.app.goo.gl) from Cloudflare's network — parser tested on long links only.
- Google terms on keeping a report for 7 days (`CACHE_SECONDS`); lower it if terms require.
- Search volume exists for Asok only (`VOLUME_AREAS`); other areas show no volume line.

## What the report can be asked for (2026-11-15)

- **Shop type** is read from the Google listing: massage, salon, barber, nail, beauty clinic, tattoo. Another type
  is ranked under Google's own Thai name for it and gets no search volume. The page shows the types as chips.
- **Neighbourhood** (`area`): left out, the nearest landmark within 3 km. The page offers the ten nearest; picking one
  re-checks the volume and the "searched from <landmark>" list there.
- **Distance** (`spacing`): 500 m (default), 1 km or 2 km between the 9 points.
- Links carry all three: `/radar/?p=<place>&c=<type>&a=<area>&s=<metres>`.
- **Saved reports** live in the Workers KV namespace `RADAR_REPORTS` (binding `REPORTS`, see wrangler.toml) for 7 days;
  a repeat inside 3 hours is answered from it without calling Google. The edge cache was tried first and answered
  about one request in six on workers.dev.
- **Search volume** = searches that name the neighbourhood ("ร้านทำผม ท่าพระ"), Keyword Planner, Bangkok city.
  Searches without a place name ("ร้านเสริมสวยใกล้ฉัน") are far larger but Keyword Planner only gives them for
  Bangkok as a whole (it has no district targets except Sathon): see
  `bookease-official/tools/merchant-discovery/out/generic-volumes-raw-bangkok-2026-11-15.txt`.
