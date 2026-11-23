# Shop Radar · real Google Maps picture of the shop

Locked by Art 2026-11-23: the report starts with the shop's own Google Maps page ("proof first"), boxes and numbers in BookEase blue `#2D55EB`.

## How a picture gets on a report
1. Someone opens or makes a report → the worker (`cf-worker-maps-report`) puts the shop in the queue (D1 table `shot_queue`) before it answers.
2. The page shows "กำลังเปิดหน้า Google Maps ของร้านคุณ…" and asks the worker every few seconds (`GET /shot?p=`).
3. The iMac service `watch.mjs` checks the queue every 4 s, shoots the shop with `shoot.mjs` (headless Chrome) and uploads it (`POST /shot/upload`).
   Picture and its numbered list are kept in KV for 7 days, like reports. Tested 2026-11-23: on screen about 4 s after the service picks it up.
4. If the shot fails (Google layout, or open/closed text left in the picture), the shop is marked "none" for a day and the box disappears.
   If the page waits 3 minutes with no picture (iMac asleep or off), the box disappears; the report is unchanged.

Rules kept by `shoot.mjs`: the opening-hours row is hidden and any open/closed text rejects the picture (Radar never
mentions open/closed); boxes only on rows that exist; booking box = only Google's own button above the address; a
Facebook/IG link in the website row is called a page; a Google block page pauses the service 30 minutes (never solve a CAPTCHA).

## The iMac service
- Key: 1Password "Atiz Dev" → **Shop Radar shot key**. Same value as worker secret `SHOT_KEY` and the macOS Keychain
  item `radar-shot-key` (the service reads it from the Keychain).
- Install / restart:
  `cp radar/shots/co.bookease.radar-shots.plist ~/Library/LaunchAgents/ && launchctl bootout gui/$(id -u)/co.bookease.radar-shots 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.bookease.radar-shots.plist`
- Log: `~/Library/Logs/radar-shots.log` (one line per shop: time taken and how long it waited).
- Needs: the iMac awake, Google Chrome installed, Playwright from `bookease-frontend/node_modules`.

## Batch (the 36 Rama 3 shops, before the service existed)
`node radar/shots/capture.mjs list.json` writes `<placeId>.jpg` + `index.json` here; the page uses these first.
