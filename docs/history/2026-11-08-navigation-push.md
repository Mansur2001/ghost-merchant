# 2026-11-08: navigation, OSM search, help-chat widget, push notifications

All on `main` and deployed to https://app.gurikaabe.com (backups taken before each deploy:
`/root/backups/*-pre-nav.sql.gz`, `*-pre-push.sql.gz`).

## What changed

- **Turn-by-turn navigation** on our own OSRM (Somalia road network from OpenStreetMap,
  `scripts/fetch-routing-data.sh`, running in production). Drivers: full-screen guidance with
  re-routing; customers: the driver's road route and live ETA.
- **OpenStreetMap place search** (Nominatim, through our backend, on submit, 1 req/s, cached).
- **Street map** installed in production (`tiles/somalia.pmtiles`, 501 MB; phones fetch only
  what is on screen). Fixed `fetch-map-tiles.sh` (head + pipefail killed it after the download).
- **GPS outside Somalia ignored** (testers abroad saw Seattle).
- **Help chat**: standard support widget (corner launcher, collapsible panel / bottom sheet).
  Groq retired `llama-3.3-70b-versatile`; now `openai/gpt-oss-120b` with low reasoning.
  `scripts/assistant-check.mjs` diagnoses it in one command.
- **Push notifications**: Web Push live (VAPID keys generated on the server, never printed);
  Android FCM built and dormant until a Firebase project exists.
- **Admin lockout recovery**: `scripts/reset-staff-access.mjs` (server only, audited).
- Order lists truncate long text inside the card.

## Decided

- Inference is hosted (Groq), not on the VPS (owner's call after the CPU trial).
- Routing IS on the VPS: OSRM for Somalia is light (~400 MB) and has no per-route cost.
- Nominatim's public service is fine at launch volume; self-host it if traffic grows.

## Bugs the tests found

GPS throttle dropped the last reading; arrival ignored off-road pins; a late as-you-type filter
replaced search results; sign-out hung waiting for a service worker that didn't exist.
Not a bug: 45-minute test runs were the Mac sleeping (`pmset` showed 2,705 s ≈ the "2,702,324 ms"
transaction age) — run suites under `caffeinate -i`.

## Tests

527 unit, 82 live checks (`09-rides.mjs`), 26 Playwright, 65-step simulation.

## Open threads

1. Upload Android build 8 (navigation, widget, push-ready); Play Data safety: precise location.
2. Firebase project → `google-services.json` + `FCM_SERVICE_ACCOUNT` for app push.
3. Privacy policy: help-chat questions go to an AI provider; push notification tokens.
4. Starter prices/pins checked on the ground; WaafiPay keys; wallet licence decision.
5. A Chrome tab on the dev Mac has used a full core for days — close it before long test runs.

## 2026-11-09: bug reports

- The owner's team bug tracker (github.com/UWT-TCSS460-SP26/group-project-bug-tracker-front-end-group-8,
  Next.js + a class API on Render) rebuilt as Help → Report a problem in the customer app, on our
  own backend (`bug_reports`, migration `20261109120000_bug_reports`), with desk triage under
  Bug reports. Same fields, limits, states and three outcomes; EN + plain SO.
- Android builds paused at the owner's request (build 8 is ready; upload later).
- Tests: 533 unit, 28 Playwright, 82 live, 65-step simulation.

## 2026-11-09: map POIs, live location, local search

- **Points of interest** on every map: protomaps-leaflet never drew the tiles' `pois` layer, so
  businesses and landmarks were invisible. Now emoji discs by kind (health, money, travel,
  shops, food, stay, public, green), names from z16, Somali names in Somali.
- **Watermarks**: the layer's own "Protomaps © OpenStreetMap" line (doubled with ours) is gone;
  the OSM credit the licence requires is a small ⓘ. Search results lost the "OSM" tag (they
  show their distance instead); one credit line stays under them.
- **Live location**: "my location" button (live dot + accuracy, follows until dragged) on the
  ride, delivery, tracking and driver job maps. Driver dot glides; faded + "last seen" when
  stale. **Bug fixed**: after a socket reconnect the tracking page never re-read the order or
  the driver's position, so it froze until a reload.
- **Search**: biased to the map's area (Bakaara → Suuqa Bakaaraha, not a hamlet in Gedo;
  "hospital" now finds hospitals), country-wide fallback, distance on each result.
- Verified with a synthetic tile file on staging (no real extract locally). Tests: 535 unit,
  28 Playwright, 65-step simulation. **Deployed** 2026-11-09 19:40 (backup
  `db-2026-11-09-1937-pre-maps.sql.gz`, rollback image `gurikaabe-backend:pre-maps-715d332`).
  Checked on the server: the street file (OSM 2026-11-06, schema 4.15.2) has the `pois` layer
  (kind, min_zoom, name — no `name:so`, so POIs show their OSM name); OSRM answers.
- Caddy access log in production (`/data/access.log`, 14 days, filtered). Needed a Caddy
  recreate, not a reload (COMMANDS.md).

## 2026-11-09 (later): POIs visible, tracking from abroad

- The owner saw no businesses: most POIs are tagged min_zoom 16, our maps open at 13–15, and a
  z14 tile carries only what is tagged ≤15. Icons now 2 zooms early, names 1 early; kinds the
  file really holds were counted from production (560 POIs around KM4) and added.
- Tracking from anywhere: the server keeps a driver position outside Somalia (was refused),
  the driver app shares it with an "outside Somalia, no rides here" note, the map isn't
  bounded to Somalia, the "my location" dot shows anywhere. Booking points stay Somalia-only.
  A throttled `POST /driver/location` was answered 400; now 200.
- Decided with the owner: no "book anywhere" switch and no outside tile server; ride dispatch
  from abroad not needed now.
