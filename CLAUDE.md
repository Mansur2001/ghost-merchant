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

## Current status — living log (last updated 2026-08-10, outbound SMS path built)
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
- **Authentication + authorization** (P0 #1–#3, landed 2026-08-06): customer OTP login, every
  order-scoped route and WebSocket subscription authorized against the owner, rate limits on
  every login path. See "Authentication & authorization" below.
- **Transactional outbox** (P1 #6, landed 2026-08-07): domain events are written in the same
  transaction as the state change and relayed after commit, so a crash can't leave the DB
  correct while every client is stale. Payment matching is now one transaction too.
- **Jest suite** (141 tests): state machine, phone, USSD, payment edge cases, OTP + session
  tokens, the access rule, the rate limiter, log redaction, operator rules, the outbox relay.
- **UUID order ids** with client-minted, idempotent creation (P1 #7) — the prerequisite for
  the P2 offline queue, and it kills enumeration outright.
- **US (+1) numbers** are full identities for device testing, but cannot pay by USSD; the app
  says so and falls back to the operator's manual path.
- **GuriKaabe Android app** (`mobile/`) — Capacitor shell over the same three PWAs, builds to
  a 3.8MB debug APK / 2.7MB release AAB. See `mobile/README.md`.
- **Outbound SMS without a telecom** (2026-08-10) — login codes are queued and the Oracle
  phone polls for them, so no inbound connectivity or vendor agreement is needed. See P4.
- **Live verification suite** (`scripts/verify/run-all.sh`, P1 #8) — 153 checks over the real
  HTTP + WebSocket layers, including an actual crash-and-restart of the outbox.
- **Version control**: initialized 2026-08-06. Was previously untracked inside the home-dir repo.

**Status: P0 and P1 closed; the Android app (GuriKaabe) builds and installs.** Security, crash-safety and identity work
are all verified against the live stack. **The one remaining blocker to a real launch is P4**:
OTP delivery has never run on real hardware, and the backend refuses to boot in production
without it. A reviewer who can't receive a login code sees a broken app.

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
`Oracle → POST /api/webhook (HMAC) → parseReceipt → recordAndMatchPayment (command) →
transitionOrder → outbox → socket push → PWA updates live.`

**The Oracle is a CONFIRMATION sensor, not a communication device.** It watches the merchant
phone's inbox for any message saying money arrived — EVC Plus, eDahab, Zelle, Cash App,
Venmo — and forwards the RAW text. Conversation between customer, driver and operator never
touches it; that is the in-app chat over WebSocket.

- **Parsing is server-side** (`domain/receipts.js`). Rails reword their receipts without
  warning, and a parser fix must not require physical access to a handset in another country.
  The phone forwards; the server interprets.
- **Only a receipt carrying a PHONE NUMBER can auto-match.** US rails identify the payer by
  display name, so those are recorded and land in the operator's reconcile queue. Matching on
  amount alone would mark the wrong customer's order paid the moment two people owe the same
  amount — which, with a fixed delivery fee, is most of the time.
- **A receipt is evidence, not proof**: sender IDs are spoofable. What holds is the narrow
  match (number + exact amount + an order actually waiting), the reconcile queue for anything
  ambiguous, and `telecom_receipt_id UNIQUE` so a replay can never credit twice.
- **Email sensing is the same job without the phone** (`notify/emailSensor.js`). Every US rail
  emails the notification it also texts, so the server reads a mailbox over IMAP and feeds the
  SAME parsers. No Android device, no APK, no permissions granted by hand — which is three
  manual steps that each fail silently. Somali rails still need the phone; they text, they
  don't email. Both can run at once: the same payment over both transports produces the same
  receipt id, so it cannot credit twice. Setup: `docs/EMAIL_SENSOR_SETUP.md`.
- **A payment REQUEST is not a payment.** "X requests $25 from you" has the same sender, brand
  and amount as a real receipt; booking it would let someone mark an order paid by asking for
  money rather than sending it. `NOT_A_PAYMENT` gates that, along with declines, refunds and
  marketing.
- **Running with no Oracle is supported.** At low volume an operator reads the merchant phone
  and taps "Mark as paid". The dead-man's switch arms itself only once an Oracle has actually
  reported, so a deployment without one shows "Payments: manual" rather than a permanent red
  DOWN — an alarm that is always on is one people learn to ignore.

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
7. **Domain events are written in the same transaction as the state they describe.**
   Commands call `enqueue(client, EVENT, payload)` with the transaction's client — never
   `publish()` directly (`events/outbox.js`). Publishing after COMMIT is two steps with a
   crash-shaped gap between them. Consumers must be idempotent: delivery is at-least-once.
8. **Every order-scoped route is authorized, and the rule lives in one file.**
   `domain/access.js` `canAccessOrder()` is the only definition of who may see an order.
   Adding a route under `/orders/:id` without `requireAuth, requireOrderAccess` is a data
   breach, not a missing feature. Same rule governs WebSocket `subscribe`.

## Authentication & authorization
Three identities, one signing secret (`SESSION_SECRET`), all tokens HMAC-signed (`middleware/auth.js`).

| Role | How they authenticate | Token TTL | Sees |
|---|---|---|---|
| `customer` | phone + 6-digit OTP over SMS | 30 days | only orders under their verified phone |
| `driver` | msisdn + PIN (scrypt) | 12 hours | only orders the operator assigned to them |
| `operator` | username + password (scrypt) | 12 hours | everything |

- **OTP** (`domain/otp.js`, `commands/auth.js`, `routes/auth.js`): 6 uniform random digits,
  scrypt-hashed at rest, 5-minute TTL, single-use, max 5 attempts, 60s resend cooldown
  enforced atomically in the DB (`otp_codes`, one live challenge per phone). Verification
  returns ONE generic error for every failure mode — distinguishing "no challenge" from
  "wrong code" would make the endpoint a phone-number oracle.
- **Delivery** (`notify/smsSender.js`) is per-country, not global — `OTP_TRANSPORT=auto`:
  `+252` → the **Oracle phone** (no vendor, no platform fee: the sovereignty requirement);
  everything else → **Twilio** (your US test handset, and a Play reviewer who must receive a
  code to get past the first screen). A Somali SIM sending internationally is slow, costly and
  often silently dropped. If Twilio is unconfigured, Somali logins are unaffected — the
  business does not depend on it. `log` prints the code and the backend **refuses to boot**
  with it under `NODE_ENV=production`. Setup: `docs/LIVE_SMS_SETUP.md`.
  **The oracle path has never run on real hardware** (P4); Twilio does not solve that.
- **Deny = 404, never 403.** A 403 confirms "this order exists, it just isn't yours" — exactly
  what an enumeration script wants. Order IDs stay sequential until the UUID migration (P1),
  so "not yours" and "doesn't exist" must be byte-identical. Same for WebSocket `subscribe`.
- **The client never chooses its own identity.** Order creation takes the phone from the
  token (not the body); chat `sender` is derived from the role; `subscribe_driver` uses the
  driver id in the token. None of these are expressible as client input.
- **WebSocket**: token in the first frame (browsers can't set handshake headers, and a token
  in the query string lands in every access log). Sockets that don't authenticate within 10s
  are closed (4401). Room members are **re-authorized on every event**, not just at subscribe
  time, so a reassigned driver stops receiving a customer's updates immediately.
- **Operator accounts** (`domain/operator.js`, `commands/operators.js`): usernames are
  normalized to lowercase (so "Amina " and "amina" can't become two accounts and a lookalike);
  passwords are ≥12 chars, scrypt-hashed, and may not contain the username. Login answers one
  generic error for both "no such account" and "wrong password" — the difference enumerates the
  staff roster. Accounts are **deactivated, never deleted** (the audit trail references them),
  you cannot deactivate yourself, and the last active operator cannot be deactivated — locking
  the whole desk out of a running delivery business is a worse outage than any account.
  First boot creates `admin` from `OPERATOR_PASSWORD`, flagged `must_change_password`, because
  that value lives in `.env` and shell history and is a delivery mechanism, not a secret.
- **Rate limits** (`middleware/rateLimit.js`): in-process sliding window on OTP request/verify
  (per IP + per phone), driver login (per IP + per msisdn), operator login. ⚠️ Per-process
  state — with N instances the real limit is N×max. Moves to Redis with the event bus (P2);
  **do not scale the backend horizontally until then.**

---

# Road to production

Ordered by what blocks what. Don't skip ahead — P0 items are not "hardening," they are
open doors that make the current build unsafe to point at real people.

## P0 — security blockers (nothing ships to real customers before these)

1. ~~**The whole customer API is unauthenticated with sequential integer IDs.**~~
   **DONE 2026-08-06.** OTP login → scoped session token → `requireOrderAccess` on every
   order-scoped route. `/orders/by-phone/:phone` is gone, replaced by `/orders/mine`.
2. ~~**WebSocket has no auth at all.**~~ **DONE 2026-08-06.** Token in the first frame,
   10s auth timeout, `subscribe` authorized per order, `subscribe_operator` role-gated,
   `subscribe_driver` added for a driver's own feed.
3. ~~**No rate limiting on auth endpoints.**~~ **DONE 2026-08-06.** Per-IP + per-identity
   sliding-window limiter on OTP request/verify, driver login, and operator login.
4. ~~**No security headers, request logging, global error handler, or graceful shutdown.**~~
   **DONE 2026-08-07.** Security headers on the API + a real CSP on the PWAs (Caddy),
   structured request logs with a request id and a redacted actor, JSON 404/error handling
   with no stack leakage, SIGTERM graceful shutdown.
5. ~~**Operator is one shared password with no per-user identity.**~~ **DONE 2026-08-07.**
   Named accounts in an `operators` table; `order_events.actor` now records
   `operator:<id>:<username>`.

**P0 is closed.** What remains before real customers is P4 (validate the Oracle SMS path on
hardware — the backend won't run in production without it) and, realistically, P1 #6/#8.

## P1 — correctness under real-world failure

6. ~~**Events are lost on crash.**~~ **DONE 2026-08-07.** Transactional outbox
   (`events/outbox.js`, `outbox` table) — see "Event delivery" below. Also fixed the same
   class of bug in payment matching, which used to record the receipt and transition the
   order in two separate transactions.
7. ~~**UUID order IDs**~~ **DONE 2026-08-07.** Migration 006. Clients may mint their own id,
   which makes creation idempotent (a lost response no longer creates a second order).
8. ~~**Integration tests.**~~ **DONE 2026-08-07.** `scripts/verify/run-all.sh` — 153 checks
   over the live HTTP + WebSocket layers. Shell rather than supertest, deliberately: it tests
   the stack as deployed (through Caddy, with the real DB and MinIO), which is where the
   authorization rules actually have to hold.

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

## P3 — mobile app (Capacitor → Play Store) — DONE 2026-08-07

Built as **GuriKaabe** in `mobile/`. Read `mobile/README.md` before touching it; the essentials:

- **`shared/config.js` resolves the API base** (build-time value → `?api=` → same origin). This
  was the blocker: same-origin calls inside a WebView point at the phone.
- **One binary, three roles** — the landing page's role picker, all bundled from the same PWAs.
  `build-www.mjs` copies rather than forks, so web and Android never drift.
- **Cleartext is derived, not configured.** `build-www.mjs` refuses a non-private http base;
  `configure-android.mjs` generates a network-security config permitting cleartext for exactly
  one private host, and sets the WebView scheme to match (an `https://localhost` page cannot
  call `http://192.168.x.x`). A release build regenerates it with no exceptions.
- **The Oracle must never go on Play.** SMS reading needs `READ_SMS`, restricted to default
  SMS-handler apps. Side-loaded Termux on a dedicated phone is the only reviewable architecture.
- **USSD uses `ACTION_DIAL`** — no `CALL_PHONE`, no restricted-permission declaration.
- **R8 is off and AGP warns about compileSdk 35** — see the toolchain notes in the mobile README.
- Submission pack: `docs/PLAY_LISTING.md`, `docs/PRIVACY.md`.

## P4 — validate on real hardware (do this NOW, in parallel — biggest unknown)

`tel:`+USSD `%23` dialing, Oracle SMS interception, and the outbound path that delivers login
codes. All three are **built and verified against the live stack**; none has run on a Somali
network. That gap is the only thing between this build and a real launch:
- the backend refuses to boot with `NODE_ENV=production` unless `OTP_TRANSPORT=oracle`;
- a Play reviewer who cannot receive a login code cannot get past the first screen, and the
  app is rejected as broken.
See `oracle/README.md`.

### How login codes reach a Somali handset — no telecom integration
There is deliberately **no Golis/Hormuud A2P agreement**: it needs a registered local company,
a Somali bank account, and volume pricing this business doesn't have. The code goes out over
the merchant's own SIM instead, as an ordinary subscriber text.

**The backend never pushes to the phone.** A phone cannot accept inbound connections — carrier
NAT on mobile data, a router on WiFi — so an address for it would mean a VPN or tunnel, i.e.
another dependency that can die silently. Direction is inverted: the backend queues
(`notify/smsQueue.js`, `sms_outbox`), the phone POLLS on the tick it already uses for receipts.

`queue → POST /api/oracle/sms/pending (HMAC) → termux-sms-send → POST /api/oracle/sms/sent`

- Collected rows are **claimed** (`FOR UPDATE SKIP LOCKED` + a 60s claim timeout), so two polls
  in flight can't send two *different* codes for one login — a customer who then can't sign in.
- A confirmed send **DELETES** the row. Until then it holds a login code in plaintext; the
  hashed copy in `otp_codes` is the authoritative one. Undelivered rows are swept after 10
  minutes — the code died at 5, so it is a credential with no remaining purpose.
- `isConfigured('oracle')` means **a phone is actually polling**, not that a setting exists.
  With no phone ever seen, dev falls back to `log` — otherwise every local login silently
  queues into a black hole and sign-in just stops working with no error.
- Backlog is visible at `GET /api/operator/sms-queue`. A stalled queue is invisible from the
  inside: customers don't report it, they conclude the app is broken and leave.
- **Honest limit:** a subscriber SIM sending hundreds of near-identical texts a day gets
  rate-limited or blocked. Fine at soft-launch volume; at scale the answer is a commercial
  agreement, and only the transport module changes.

## Event delivery (transactional outbox)
`Command tx { state change + INSERT INTO outbox } → COMMIT → relay → bus → sockets`

- **Write path**: commands call `enqueue(client, EVENT, payload)` inside their transaction,
  then `wakeOutbox()` **after** it commits (waking early would publish an uncommitted event).
  Forgetting to wake costs latency only — the 1s poll catches it.
- **Relay** (`startOutboxRelay`): claims rows with `FOR UPDATE SKIP LOCKED` in `id` order,
  publishes to the in-process bus, stamps `published_at`. A batch is one transaction, so a
  crash mid-batch redelivers rather than loses.
- **At-least-once, so consumers must be idempotent.** Today's consumers are socket
  broadcasts, and every event is a state *snapshot* ("order 4 is IN_TRANSIT"), not a delta —
  keep new events shaped that way and a duplicate stays harmless.
- **Ordering** is by `id` and holds with ONE relay. A second backend instance would interleave
  (SKIP LOCKED hands each a different row) — same single-instance constraint as the rate
  limiter, lifted together in P2.
- **A poison event parks after 5 attempts** (`failed = true`) instead of wedging the queue:
  Postgres is still the truth and clients resync on reload, so one dropped notification beats
  a relay that never moves again. Parked rows need a human.
- **Backlog is visible**: `GET /api/operator/outbox`, surfaced as an alert badge in the
  operator header when the relay falls behind (>20 pending, >30s old, or anything parked).
  A stalled relay looks exactly like "the app is frozen", so it must not be silent.
- Delivered rows are kept **7 days** as the "why did this happen at 3am" record, then swept.
- Oracle heartbeat/down events stay on the direct bus: they're derived from in-memory monitor
  state, not from a database write, so there is nothing to make atomic.

## Observability & operational hygiene (P0 #4)
- **Every response carries `X-Request-Id`**, and every request logs one JSON line
  (`middleware/requestLog.js`): method, masked path, status, ms, ip, actor. When a customer
  disputes a payment, that line plus `order_events.actor` is the whole story.
- **Logs must never undo the API's privacy** (`domain/redact.js`): phone numbers are masked to
  `+252••••••678` — including inside the URL, since `/phone/validate/:phone` puts PII in the
  request line — and token/password/pin/code keys are dropped entirely. Never
  `console.log(req.body)`; use `redact()`.
- **Errors** (`middleware/errorHandler.js`): the client gets a generic message plus the request
  id; the stack goes to the log. Express's default handler renders stack traces into the
  response body outside production — file paths, library versions, sometimes the failing SQL.
  Malformed JSON is 400, oversized bodies are 413, unknown `/api` routes are JSON 404.
- **Graceful shutdown**: SIGTERM stops new work, closes sockets with 1001, drains in-flight
  requests (10s cap), then ends the pg pool. Without it a deploy cuts requests mid-response
  and an order the customer saw succeed may never have committed.
- **CSP on the PWAs** (Caddyfile): `script-src 'self'` — which is why service-worker
  registration lives in `app.js`, not an inline `<script>`. Don't reintroduce inline scripts.
  ⚠️ The CSP has been verified by header inspection but **not yet by loading the PWAs in a
  real browser** — `connect-src 'self'` must permit the same-origin WebSocket; confirm no
  violations in the console before a demo.

---

## Refunds & access requests
- **Refunds are a ledger, not a transfer.** The platform never holds funds (invariant 6), so
  settling means an operator sent money back from their own phone. A `FAILED_REFUND`
  transition opens a `refunds` row **in the same transaction** — an order must never be able
  to end up failed with no record of what is owed, because that record is the only thing that
  will remind anyone to pay it. Nothing is opened if no payment ever arrived.
- **Settle requires a telecom reference** (the receipt of the RETURN transfer): it is the only
  claim in the system we cannot verify ourselves, so it must be checkable against the
  telecom's own log. **Waive is separate from settle** — conflating "we paid this back" with
  "nothing was owed" makes the ledger useless in the argument it exists to settle.
- **ID documents are the most sensitive data here** and are treated accordingly: uploaded with
  a short-lived token scoped to one request (so the request id never goes over the wire and
  nobody can attach to someone else's application), stored only as a key with a random
  component, streamed no-store to an authenticated operator, and **destroyed the moment the
  decision is made**. The row keeps `id_document_at` as proof it was checked and
  `reviewed_by` as who checked it. Holding a government ID after the decision it supported is
  pure liability — a routine breach becomes identity theft. Customers are NEVER asked for one.
- **Nobody self-registers as staff.** `POST /api/signup` records a REQUEST and grants nothing;
  an operator reviews it and then creates the account explicitly, with a password they choose.
  An operator account reads every customer's phone, address, chat and photos — the gate has to
  be a human who recognises the applicant. Reviewing is *not* wired to account creation on
  purpose: minting a credential should be a deliberate act, not a side effect of clicking
  Approve in a list.

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
- Photo reads are authorized like every other order-scoped read, so a plain `<img src>` gets
  a 401 — the PWAs fetch the bytes with the bearer token and render from an object URL.

## Seeding (idempotent, re-runnable)
`backend/src/db/seed.js` (`docker compose exec backend npm run seed`). Local `.env` now sets
`NODE_ENV=development`, so no `SEED_FORCE=1` dance — that flag is only needed if you
deliberately point a production-flagged backend at the seed, which you shouldn't. It `TRUNCATE … RESTART
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

- **User**: identity = phone, **verified by OTP**. Session token in `localStorage`
  (`gm_token`/`gm_phone`) — not `sessionStorage`, because re-verifying costs a real SMS and the
  customer is on one personal handset. Any 401 clears the session and returns to sign-in.
  Resume via `GET /api/orders/mine` (scoped to the token; you can no longer list orders for a
  number you merely typed). Opens on a
  **home/landing** (role picker: Customer / Driver / Operator). Header has **Home** (→ landing),
  **FAQ** (in-app accordion), and the theme toggle. Checkout takes an optional reference photo;
  the order view shows a live photo gallery.
- **Driver**: PIN login → signed token in `sessionStorage` (`driverToken`); the socket
  authenticates then joins `subscribe_driver` (its own feed — it used to take the whole
  operator firehose). The self-serve "Accept order" button is gone with the route. Queue shows **only
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
docker compose exec backend npm run seed   # load/reset the demo dataset
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
Suites live in `backend/tests/`. Pure-domain suites (`stateMachine`, `phone`, `ussd`, `otp`,
`access`, `rateLimit`, `redact`, `operator`) need no DB; `payments` and `outbox` mock the pg
transaction + event bus (`jest.unstable_mockModule`).
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
- **Prisma** owns the schema and ordinary queries (`prisma/schema.prisma`, `db/prisma.js`).
  Migrations are `prisma migrate deploy`, run automatically on container boot.
  ⚠️ **schema.prisma is NOT the whole schema.** Partial indexes and CHECK constraints live in
  raw migration SQL because Prisma cannot express them — including
  `idx_messages_client_id`, the UNIQUE that makes offline message replay idempotent. Rebuild
  from schema.prisma alone and they vanish silently. `npm run db:verify` asserts they exist.
- **Raw SQL survives where Postgres semantics ARE the feature**, via `$queryRaw` inside an
  interactive transaction (single pinned connection): `FOR UPDATE` row locks, the outbox's
  `FOR UPDATE SKIP LOCKED`, `pg_try_advisory_xact_lock` for relay leadership, the conditional
  OTP upsert, and `SET LOCAL synchronous_commit`. Don't "modernize" these into the model API —
  each one is load-bearing and the comment above it says why.
- Object storage through `storage/objectStore.js` (S3 SDK pointed at MinIO). Don't add the
  AWS-hosted S3 — it breaks the sovereignty requirement. Use presigned URLs, never expose
  storage creds to the browser.
- Keep order payloads small (SRS: < 10KB; `express.json({ limit: '32kb' })`).
- Match the surrounding style: concise comments explaining *why*, not *what*.
- **Commit early and often.** Small commits with real messages; the repo is the only backup
  of the source. Secrets (`.env`, `CREDENTIALS.md`) stay git-ignored, always.
