# 2026-11-07: rides, catalog + cart, maps, in-app pay, help chat

Branch `feature/rides-catalog-maps`. Not deployed yet: waiting for the owner's go.

## What changed

- **Rides first, delivery second** (the client asked for the Yassir model). One `orders` table
  (`kind` RIDE | DELIVERY), one state machine. Fixed fare from pickup → destination by vehicle
  (bajaj, car), prepaid; the nearest free online driver in that vehicle within 8 km.
- **Generic catalog + cart**: admin-edited items, prices and places (audited, hide-not-delete);
  the server prices every cart. Custom line with a budget + photo for anything else.
- **Maps**: Leaflet + protomaps-leaflet with one self-hosted Somalia PMTiles file; customer GPS
  with accuracy and a draggable pin; driver online switch shares the latest position (no trail);
  rider sees the driver live; operator live map. Optional OSRM for road distance.
- **WaafiPay adapter** (EVC Plus, Zaad, Sahal) — built and tested against a staging simulator,
  off until the merchant keys arrive. Sahal has no public direct API; WaafiPay carries it.
- **Driver release** before pickup (`DISPATCHED → PAID_UNASSIGNED`), customer cancel before
  dispatch (refund opened if paid).
- **Help chat**: FAQ (EN + plain Somali) first, then a hosted open model when configured.

## Decided

- **No cash on delivery, no customer wallet / top-up.** Everything prepaid to the merchant
  wallet; drivers never hold customer money. A wallet needs an e-money licence.
- **Help-chat model is hosted, not on the VPS.** Tried qwen2.5:1.5b on CPU in staging: 45–70 s
  per answer. Owner asked for a cheap hosted option: Groq (Llama 3.3 70B), free tier then
  per-token; their terms say no training on inputs. Turn on Zero Data Retention in the console.
- Seed starts delivery drivers OFFLINE so "waiting for a driver" survives the 30 s dispatch timer.

## Tests

- 497 unit, 22 Playwright (incl. rides, cancel/refund, help chat), live `09-rides.mjs` 63 checks,
  `staging.sh simulate` 65 steps (now starts with a ride paid in the app).
- Bugs the tests found: 0 m GPS accuracy treated as "unknown"; driver job view missing ride
  fields; stale position used as delivery evidence; map layers over the app header.

## Open threads

1. **Deploy**: owner's go. Then on the server: `./scripts/fetch-map-tiles.sh` (street map).
2. **Check starter data on the ground**: place pins are approximate, catalog prices are
   placeholders (Operator → Catalog).
3. **WaafiPay keys**; check field names against their merchant docs; one $0.10 payment per wallet.
4. **Groq key** for the help chat (`ASSISTANT_URL`, `ASSISTANT_API_KEY`); update the privacy
   policy to say help-chat questions go to an AI provider before switching it on.
5. Android: new build (versionCode 7) so installed apps get rides, maps and location permission
   prompts; the old build keeps working (legacy order shape kept).
6. Native-speaker review of the new Somali strings.
7. Location sharing is foreground-only (browser/WebView limit): drivers keep the app open.
