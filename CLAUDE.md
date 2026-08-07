# CLAUDE.md — Ghost Merchant

Guidance for Claude Code (and humans) working in this repo.

## What this is
A **sovereign, local-first delivery coordination platform** for the East African market
(Somalia). It bypasses formal fintech/telecom APIs: users pay peer-to-peer via **USSD
`tel:` links** (EVC Plus / eDahab), and a dedicated **Android phone ("the Oracle")**
intercepts the telecom SMS receipt and reports it to the backend. No AWS, no Meta/WhatsApp,
no Google Maps — everything self-hosted and containerized.

Read `README.md` for the architecture diagram and the SRS-derived build checklist.
`CREDENTIALS.md` (git-ignored) holds local logins and seeded data.

### Business posture (read before proposing features)
The margin here is **coordination fees on delivery**, not payment float. It is a thin,
honest, unglamorous business: revenue scales with completed deliveries and operator time,
not with users. Anything that looks like easy money in this niche (holding customer funds,
skimming the USSD flow, sidestepping telecom terms, harvesting contact lists, gray-market
FX) is either illegal, gets the merchant MSISDN frozen, or gets the app pulled from Play.
**We don't build those.** Design decisions follow from that:

- **Never custody customer money.** Payment goes peer-to-peer, customer → merchant MSISDN.
  The platform *observes* the receipt; it never sits in the middle of the funds flow.
  This is why refunds are manual and off-platform, and that's correct, not a shortcut.
- **Cheap to run beats clever.** One small VPS should serve the whole thing. Reject
  dependencies that add monthly cost or a vendor relationship.
- **Collect the minimum.** Phone, address, landmark, order contents, photos. Nothing else.
  Every extra field is a liability we can't monetize anyway.

## Ship-fast + build-in-public rules
The plan is rapid shipping with public update posts. That's fine, with guardrails:

1. **Never demo with real customer data.** Screenshots, screen recordings, and streams use
   `npm run seed` data only. The operator dashboard shows real phone numbers and addresses —
   treat it as PII-on-screen and never post it.
2. **Never show `.env`, `CREDENTIALS.md`, or a terminal with them scrolled back.**
   `ORACLE_WEBHOOK_SECRET` on screen = anyone can forge payment confirmations.
3. **Ship behind the state machine, not around it.** Fast shipping breaks this project the
   moment someone writes `orders.status` directly to hit a deadline. Don't.
4. **Every ship needs a rollback**: tagged image + `pg_dump` before migration. See Ops.
5. Speed comes from cutting *scope*, never from cutting the invariants below. If a feature
   can't be done safely this week, ship less of it, not an unsafe version of it.

## Current status — living log (last updated 2026-08-06)
Read this first when resuming: it's the running snapshot of where the project is, so a new
session doesn't need re-discovery. Keep it current as work lands.

**Working end-to-end today** (all verified via the live stack + `npm test`):
- Full order lifecycle in sync over WebSocket: customer creates order → operator marks paid (or
  Oracle auto-matches) → **operator explicitly assigns a driver** (→ DISPATCHED) → driver
  secures (→ IN_TRANSIT) → delivered. Illegal transitions rejected (409).
- **Dispatch is operator-driven** — drivers no longer self-serve a shared pool; each driver's
  queue is only what the operator assigned to them. See the Frontend section.
- **Photos in MinIO**: customer reference photo at checkout + driver delivery-proof, idempotent
  keys, streamed back through the backend. See the Photos section.
- **Three PWAs**: user home/landing (role picker) + in-app FAQ; light/dark theme (black↔white,
  gold trim, `shared/theme.js`); Home nav on every PWA; fluid responsive sizing; `.scroll-list`
  panes so long lists scroll inside a container, not the page.
- **Idempotent, re-runnable seed** (`npm run seed`) — one order in every state + an unmatched
  receipt + seeded photos. This is the ONLY seed; there's no static fixture elsewhere.
- **Jest suite** (51 tests): state machine, phone normalization, USSD encoding, payment edge cases.
- **Version control**: initialized 2026-08-06. Was previously untracked inside the home-dir repo.

**Status: MVP-complete, NOT production-safe.** The demo loop works; the security model does
not exist yet. See "Road to production" — do not put this in front of real customers until
P0 is closed.

**Conventions for updating this log:** convert relative dates to absolute; when a "not done"
item ships, move it up and tick the README checklist; keep entries one line.

## Architecture: modular monolith (event-driven + CQRS + pub/sub)
One backend deployable, but structured with the seams a microservices split would use, so
any module (order / dispatch / tracking / payment) can be extracted later without rewriting.

- **Commands** (`backend/src/commands/`) = writes. They mutate Postgres and **publish domain
  events** to the in-process bus. Never write to `orders.status` outside a command.
- **Queries** (`backend/src/queries/`) = reads only. No events, no writes.
- **Event bus** (`backend/src/events/bus.js`) = in-process pub/sub (Node `EventEmitter`).
  Swap this one file for Redis/NATS to go distributed. Event names live in `EVENTS`.
- **Realtime** (`backend/src/realtime/socketServer.js`) subscribes to the bus and fans
  events to WebSocket clients (subscribe-by-`order_id`; operators get everything).

Data flow for a payment:
`Oracle → POST /api/webhook (HMAC) → recordAndMatchPayment (command) → transitionOrder →
publish(ORDER_STATE_CHANGED / PAYMENT_RECEIVED) → socket push → PWA updates live.`

## Non-negotiable invariants
1. **The order state machine is the single source of truth**
   (`backend/src/domain/stateMachine.js`). All status changes go through
   `transitionOrder()` → `assertTransition()`. Illegal transitions throw. Every transition
   is written to the `order_events` audit table.
   `PENDING_PAYMENT → PAID_UNASSIGNED → DISPATCHED → IN_TRANSIT → DELIVERED`; any live state
   can go to `FAILED_REFUND`.
2. **Writes touching sensitive data are idempotent — enforced in the DB, not just code.**
   Payments: `transactions.telecom_receipt_id UNIQUE` (a replayed SMS can't credit twice).
   Customers: `users.phone_number` PK + `ON CONFLICT DO NOTHING`. Drivers: `msisdn UNIQUE` +
   upsert. Photos: `order_photos.object_key UNIQUE` with a deterministic key per (order, kind),
   so a re-upload overwrites the one object/row instead of leaking duplicate copies of a phone
   number or image. Schema migrations are tracked in `schema_migrations`; the seed uses
   `TRUNCATE … RESTART IDENTITY` so it too is idempotent.
3. **The Oracle webhook is HMAC-signed** (`X-Oracle-Signature`, `middleware/hmac.js`). The
   endpoint is public; unsigned requests are rejected. The webhook route uses a raw-body
   parser and must stay registered **before** the global `express.json()` in `index.js`.
4. **Phone numbers are the customer identity.** Validate/normalize at every trust boundary
   with `backend/src/domain/phone.js` → store canonical E.164 (`+252XXXXXXXXX`). Rule:
   2-digit operator prefix + 7 digits = 9-digit national number (matches the SRS's
   `61XXXXXXX`). `frontend/shared/phone.js` is the browser mirror for live input feedback;
   the backend copy is the enforced source of truth. Keep the two prefix maps in sync.
5. **USSD `#` must be `%23`.** `domain/ussd.js` builds the `tel:` URI; the trailing `#` is
   pre-encoded in `USSD_TEMPLATE`. Never let it reach the browser as a bare `#` or Android
   truncates the dial string.
6. **Money never flows through the platform.** No wallet, no balance, no held funds, no
   platform-initiated transfer. The backend only ever *records* an observed telecom receipt.

---

# Road to production

Ordered by what blocks what. Don't skip ahead — P0 items are not "hardening," they are
open doors that make the current build unsafe to point at real people.

## P0 — security blockers (nothing ships to real customers before these)

1. **The whole customer API is unauthenticated with sequential integer IDs.**
   Every route in `routes/orders.js` is open — there is no `requireRole` in that file.
   `GET /api/orders/:id`, `/messages`, `/photos/:pid/raw`, `/by-phone/:phone`, and
   `POST /orders/:id/messages` are all reachable by anyone. Iterating `:id` from 1 dumps
   every customer's phone, address, chat, and photos.
   **Fix:** OTP on the phone number → scoped session token → per-order authorization check
   (`order.phone_number === req.auth.phone`), plus UUID order IDs (see P1) to kill enumeration.
2. **WebSocket has no auth at all.** `socketServer.js` accepts `{type:'subscribe_operator'}`
   from any client and streams every order, payment, and message in the system. `subscribe`
   accepts any `orderId`. **Fix:** require the session token in the connect handshake;
   authorize `subscribe` against order ownership; gate `subscribe_operator` on the operator role.
3. **No rate limiting on auth endpoints.** Operator login is a *single shared password* and
   driver login is a *4-digit PIN* — both brute-forceable at line speed. **Fix:** per-IP and
   per-identity limiter on `/operator/login` and `/driver/login`, with lockout + backoff.
4. **No security headers, request logging, global error handler, or graceful shutdown.**
   Stack traces can leak to clients; there's no audit trail of who did what from where.
5. **Operator is one shared password with no per-user identity.** Every operator action is
   attributed to "the operator." **Fix:** per-operator accounts before there's more than one
   person on the dashboard; the `order_events` audit table needs a real actor.

## P1 — correctness under real-world failure

6. **Events are lost on crash.** Commands commit to Postgres, then publish to the in-process
   `EventEmitter`. Die in between and the DB is right while every connected client is
   permanently stale. **Fix: transactional outbox** — write the event row in the same
   transaction as the state change, relay it after commit, mark it sent.
7. **UUID order IDs** (client-generatable). Kills enumeration *and* is the prerequisite for
   the offline write queue in P2 — the phone must be able to mint an ID with no network.
8. **Integration tests.** Domain logic is covered; the HTTP and socket layers are not.
   Once P0 lands, the authorization rules are exactly the thing that must be regression-tested
   (supertest + a throwaway Postgres).

## P2 — CAP: what we actually choose

Today there is one Postgres, one backend process, one in-process bus. That isn't a CAP
tradeoff, it's a single node: no partition tolerance, and any partition is total downtime.
Over Somali mobile networks **P is not optional**, so the design is picking C or A
*per operation*:

- **Money and state transitions → CP.** `recordAndMatchPayment`, `transitionOrder`, driver
  assignment must be linearizable. Postgres primary + synchronous replica; on partition,
  **refuse the write**. The `telecom_receipt_id UNIQUE` invariant already encodes this — never
  trade it for availability, because the failure mode is crediting a payment twice.
- **Tracking, chat, photos → AP.** This is what the mobile app buys us: client-generated UUID
  idempotency keys, an offline write queue in SQLite, optimistic local state, reconcile on
  reconnect. A driver in a dead zone must still be able to mark delivered and have it sync later.
- **Event bus → Redis Streams / NATS JetStream.** The `bus.js` seam already exists. Required
  before running >1 backend instance, or clients on instance B miss instance A's events.
- **Conflict rule:** the server's state machine always wins over a queued client transition.
  A rejected offline action surfaces in the UI as "couldn't sync" — never silently dropped.

## P3 — mobile app (Ionic Capacitor → Play Store)

**The frontend does not run in a WebView as written.** Every call is same-origin relative
(`fetch('/api' + path)`, `new WebSocket(\`${proto}://${location.host}/ws\`)`). In Capacitor the
origin is the local asset server, so all of it 404s on launch.

- **First change:** a configurable API base URL threaded through all three apps
  (`shared/config.js`, injected at build time). Nothing else in P3 works until this lands.
- **One binary, not three.** Play wants one app per listing — bundle the existing role picker
  into a single app. Driver/operator can stay web or side-loaded if review gets awkward.
- **Service workers become redundant** in Capacitor; native asset bundling replaces the shell
  cache. Simplification, not a loss — but the *offline data* queue (P2) is still ours to write.
- **Real domain + Let's Encrypt is a prerequisite.** A WebView won't accept the self-signed cert.
- **The Oracle must never go on Play.** SMS reading needs `READ_SMS`, restricted to default
  SMS-handler apps; it would be rejected. Side-loaded Termux on a dedicated phone is the
  correct and only reviewable architecture.
- **USSD:** use `ACTION_DIAL` (prefills the dialer, user presses call). No `CALL_PHONE`
  permission, no policy risk.
- **Play Console checklist:** $25 account, privacy policy URL, Data Safety form (must be true —
  see P0), signed AAB, current target API level, prominent disclosure for location permission.

## P4 — validate on real hardware (do this NOW, in parallel — biggest unknown)

`tel:`+USSD `%23` dialing and Oracle SMS interception on actual Hormuud/Somtel SIMs. If either
misbehaves the payment design changes and P0–P3 partly rework, so this is the schedule risk.
Don't leave it until last. See `oracle/README.md`.

---

## Photos / object storage (MinIO)
Two photo types, both stored in MinIO and indexed in `order_photos`:
- **`order_ref`** — customer attaches a reference photo at checkout (`POST /api/orders/:id/photos/order_ref`).
- **`delivery_proof`** — driver uploads proof at delivery (`POST /api/driver/orders/:id/delivery-proof`, auth).

Rules (`commands/photos.js`):
- Bytes are the raw request body (route-scoped `express.raw`, 6MB cap — separate from the
  sub-10KB order-JSON budget). The global `express.json` skips non-JSON bodies, so images pass
  through untouched.
- **Deterministic key** `orders/<id>/<kind>.<ext>` → one object + one row per (order, kind).
  Re-upload upserts (`ON CONFLICT (object_key)`) — no duplicate copies of sensitive images pile up.
- Browser never talks to MinIO. `GET /api/orders/:id/photos` lists metadata with a backend
  URL; `…/photos/:pid/raw` **streams the bytes through the backend** (`storage/objectStore.js`
  `getObject`). `presignGet` is kept for real deploys where MinIO is browser-reachable behind
  Caddy — locally `minio:9000` only resolves inside the docker network, so we stream instead.
- ⚠️ Photo reads are currently unauthenticated (P0 #1). Anyone with an order ID gets the bytes.

## Seeding (idempotent, re-runnable)
`backend/src/db/seed.js` (`npm run seed`, or `docker compose exec -e SEED_FORCE=1 backend npm run seed`
since `.env` sets `NODE_ENV=production`, which the seed guards against). It `TRUNCATE … RESTART
IDENTITY`s the domain tables then inserts a fixed dataset, so **every run converges to the same
state** — reset here whenever data drifts. Covers one order in **every** state
(PENDING_PAYMENT → FAILED_REFUND), two drivers (Amina/1234, Bashir/5678), matched receipts, one
**unmatched** receipt for the operator reconcile queue, chat/audit rows, and two seeded SVG photos
(a reference + a delivery proof). There is no static seed anywhere else — this file is the source.

**Seed data is the only data that may appear in screenshots or demo videos.** Never run the
seed against prod — it truncates.

## Frontend (three PWAs, vanilla JS, no framework)
`frontend/user`, `frontend/driver`, `frontend/operator`, plus `frontend/shared`
(`styles.css`, `phone.js`, `theme.js`). Kept framework-free to respect the SRS data budget
(initial load < 1.5MB). Each PWA has a Service Worker (`sw.js`) that cache-first serves its shell.

- **User**: identity = phone; resume via `localStorage` (`gm_last`) + `GET
  /api/orders/by-phone/:phone`. Auth is currently trust-on-phone (no OTP yet — P0 #1). Opens on a
  **home/landing** (role picker: Customer / Driver / Operator). Header has **Home** (→ landing),
  **FAQ** (in-app accordion), and the theme toggle. Checkout takes an optional reference photo;
  the order view shows a live photo gallery.
- **Driver**: PIN login → signed token in `sessionStorage` (`driverToken`). Queue shows **only
  orders the operator assigned to this driver** (`getDriverQueue` = `driver_id = me AND status IN
  (DISPATCHED, IN_TRANSIT)`) — no shared self-serve pool. Order detail can capture a
  **delivery-proof** photo. **Home** link → `/`.
- **Operator**: single super-user password → token in `sessionStorage` (`opToken`). Order cards
  show photo thumbnails; PAID_UNASSIGNED cards have a **driver picker → `POST
  /operator/orders/:id/assign`** which sets `driver_id` and transitions to DISPATCHED (explicit
  dispatch). A **Drivers** panel (`GET /operator/drivers`) lists the roster with live workload
  stats. **Home** link → `/`.
- **Scrollable lists**: operator orders/receipts/drivers, the driver queue, and the user resume
  list use `.scroll-list` (fixed max-height, `overflow-y:auto`, `overscroll-behavior:contain`).
- **Theme** (`shared/theme.js`): black (dark) ↔ white (light), gold trim constant in both;
  set before paint (no flash), persisted in `localStorage` (`gm_theme`) across all three PWAs.

### ⚠️ When you change any frontend shell file (index.html / app.js / styles.css / phone.js)
**Bump the `CACHE` constant** in that PWA's `sw.js` (e.g. `ghost-user-vN`), or reloads keep
serving the cached old version. This is the #1 "my change isn't showing" gotcha here.

## Running & verifying
```bash
cp .env.example .env          # first time; edit secrets
docker compose up -d --build  # whole stack: postgres + minio + backend + caddy
docker compose exec -e SEED_FORCE=1 backend npm run seed   # load/reset the demo dataset
docker compose logs -f backend
docker compose down           # stop (keep data)   |   down -v  wipes data
```
- URLs: User `https://localhost/` · Driver `/driver/` · Operator `/operator/`.
- Caddy serves a **self-signed localhost cert** (needed for SW + geolocation) — browsers
  warn; that's expected locally. Real deploys use a domain + Let's Encrypt automatically.
- **After editing backend `src/`**, rebuild: `docker compose up -d --build backend`
  (a plain restart won't pick up code — the image COPYs `src/`). Migrations run on boot and
  are idempotent (tracked in `schema_migrations`).

### Test the full loop without a phone
```bash
cd oracle
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ORACLE_WEBHOOK_SECRET=<from .env> BACKEND_URL=https://localhost \
  node simulate.js payment 612345678 7.25   # amount MUST equal the order total
  node simulate.js heartbeat                 # turns operator Oracle badge green
```
The user PWA (with an open order for that phone/amount) should flip to "Payment confirmed"
within ~1s over the socket.

### Tests
```bash
cd backend && npm install   # first time (installs jest + cross-env devDeps)
npm test                    # Jest, ESM via --experimental-vm-modules
```
Suites live in `backend/tests/`. Pure-domain suites (`stateMachine`, `phone`, `ussd`) need
no DB; `payments` mocks the pg transaction + event bus (`jest.unstable_mockModule`).
`tests/setup/env.js` seeds the env vars `config.js` requires at import. Jest is a
devDependency — the Docker image (`npm install --omit=dev`) does not ship it.

Quick syntax check without the runner:
```bash
cd backend && for f in $(find src -name '*.js'); do node --check "$f"; done
```

## Ops (how to handle the running system)
Once there's a VPS, these are the rules that keep a fast-shipping cadence from losing data:

- **Back up before every migration.** `docker compose exec postgres pg_dump -U $POSTGRES_USER
  $POSTGRES_DB | gzip > backup-$(date +%F-%H%M).sql.gz`, off the box. Automate daily.
- **The two volumes that matter**: `postgres_data` (orders, payments, audit trail) and
  `minio_data` (customer + delivery-proof photos). `docker compose down -v` destroys both —
  never run it on the VPS.
- **Rollback = previous image tag + the pre-migration dump.** Tag images per release; don't
  deploy `latest` from a laptop.
- **Migrations must be forward-only and additive** (add column/table, backfill, then switch
  reads). A destructive migration on a live order table has no undo but the dump.
- **Rotate `OPERATOR_PASSWORD` / `SESSION_SECRET`** and `docker compose up -d` to apply.
  Rotating `SESSION_SECRET` logs everyone out — that's the intended panic button.
- **If `ORACLE_WEBHOOK_SECRET` leaks, payments can be forged.** Rotate it on the VPS and the
  Oracle phone together, and reconcile every transaction since the leak by hand.
- **Watch the Oracle heartbeat.** Badge red = payments are silently not being matched;
  operators must fall back to manual "Mark as Paid" and reconcile from the telecom SMS log.

## Conventions
- ES modules everywhere (`"type": "module"`). Node 20+.
- No ORM — parameterized `pg` queries via `db/pool.js` (`query`, `withTransaction`).
- Object storage through `storage/objectStore.js` (S3 SDK pointed at MinIO). Don't add the
  AWS-hosted S3 — it breaks the sovereignty requirement. Use presigned URLs, never expose
  storage creds to the browser.
- Keep order payloads small (SRS: < 10KB; `express.json({ limit: '32kb' })`).
- Match the surrounding style: concise comments explaining *why*, not *what*.
- **Commit early and often.** Small commits with real messages; the repo is the only backup
  of the source. Secrets (`.env`, `CREDENTIALS.md`) stay git-ignored, always.
