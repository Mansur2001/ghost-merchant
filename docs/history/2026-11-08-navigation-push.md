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
