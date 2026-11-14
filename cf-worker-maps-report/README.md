# bookease-maps-report · Worker for make.bookease.co/report

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
- **Rank swings with opening hours.** Same shop, same day: Relaxing Time was #33 at 01:30 (closed) and
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
