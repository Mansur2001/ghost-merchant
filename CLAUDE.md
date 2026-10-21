# CLAUDE.md — GuriKaabe

Guidance for Claude Code (and humans) working in this repo. `README.md` has setup and
deployment; this file is the reasoning you need before changing anything.

## What this is

A **sovereign, local-first delivery coordination platform** for Somalia. It bypasses formal
fintech/telecom APIs: customers pay the merchant peer-to-peer via **USSD `tel:` links** (EVC Plus
/ eDahab), and an **operator confirms each payment** by checking the merchant phone. No device
reads receipts. No AWS, no Meta/WhatsApp, no Google Maps — self-hosted and containerized.

`CREDENTIALS.md` (git-ignored) holds local logins and seeded data.

### Business posture — read before proposing features

The margin is **coordination fees on delivery**, not payment float. It is a thin, honest,
unglamorous business: revenue scales with completed deliveries and operator time, not with
users. Anything that looks like easy money in this niche (holding customer funds, skimming the
USSD flow, sidestepping telecom terms, harvesting contact lists, gray-market FX) is either
illegal, gets the merchant MSISDN frozen, or gets the app pulled from Play. **We don't build
those.** Three consequences:

- **Never custody customer money.** Payment goes customer → merchant MSISDN directly. The
  platform *records* a payment an operator confirmed; it never sits in the funds flow. This is why refunds are
  manual and off-platform — correct, not a shortcut.
- **Cheap to run beats clever.** One small VPS serves the whole thing. Reject dependencies that
  add monthly cost or a vendor relationship.
- **Collect the minimum.** Phone, address, landmark, order contents, photos. Nothing else.
  Every extra field is a liability we can't monetize anyway.

### Ship-fast, build-in-public rules

1. **Never demo with real customer data.** Screenshots and recordings use `npm run seed` data
   only. The operator dashboard shows real phone numbers and addresses — treat it as PII.
2. **Never show `.env` or `CREDENTIALS.md`**, including scrolled-back terminal history.
   `SESSION_SECRET` on screen = anyone can mint an operator session and confirm payments.
3. **Ship behind the state machine, not around it.** Fast shipping breaks this project the
   moment someone writes `orders.status` directly to hit a deadline.
4. **Every ship needs a rollback**: tagged image + `pg_dump` before migration.
5. Speed comes from cutting *scope*, never the invariants below. If a feature can't be done
   safely this week, ship less of it — not an unsafe version.

---

## Architecture: modular monolith (event-driven + CQRS + pub/sub)

One backend deployable, structured with the seams a microservices split would use, so any
module (order / dispatch / tracking / payment) can be extracted later without a rewrite.

- **Commands** (`backend/src/commands/`) = writes. Mutate Postgres and enqueue domain events.
  Never write `orders.status` outside a command.
- **Queries** (`backend/src/queries/`) = reads only. No events, no writes.
- **Event bus** (`backend/src/events/bus.js`) = in-process `EventEmitter`, or Redis pub/sub when
  `REDIS_URL` is set. Event names live in `EVENTS`.
- **Realtime** (`backend/src/realtime/socketServer.js`) subscribes to the bus and fans events to
  WebSocket clients (subscribe-by-`order_id`; operators get everything).

Payment data flow:
`customer pays merchant (USSD) → taps "I've paid" (POST /orders/:id/paid, optional reference) →
operator checks the merchant phone → Confirm payment (POST /operator/orders/:id/mark-paid) →
confirmPayment: payment row + transitionOrder + event, one transaction → outbox → socket push →
customer's page flips to paid live.`

## Non-negotiable invariants

1. **The order state machine is the single source of truth**
   (`domain/stateMachine.js`). All status changes go through `transitionOrder()` →
   `assertTransition()`. Illegal transitions throw. Every transition is written to the
   `order_events` audit table.
   `PENDING_PAYMENT → PAID_UNASSIGNED → DISPATCHED → IN_TRANSIT → DELIVERED`; any live state can
   go to `FAILED_REFUND`.
2. **Writes touching sensitive data are idempotent — enforced in the DB, not just code.**
   Payments: `transactions.telecom_receipt_id UNIQUE` — the EVC/eDahab transaction reference,
   normalized (`domain/paymentRef.js`), so one real payment can never confirm two orders.
   Customers: `users.phone_number` PK + `ON CONFLICT DO NOTHING`. Drivers: `msisdn UNIQUE`,
   never upserted (an upsert silently replaced an existing driver's PIN). Photos: `order_photos.object_key UNIQUE` with a deterministic key per (order, kind),
   so a re-upload overwrites one object/row instead of leaking duplicate copies of an image.
3. **Only an operator's confirmation makes an order paid** (`commands/payments.js`
   `confirmPayment`). A customer's "I've paid" (`claimPayment`) is a hint for the operator and
   never changes status — anyone can tap a button. Confirming records the payment row in the
   SAME transaction as the transition, because the refund ledger sums those rows: a paid order
   with no payment row would fail owing nothing.
4. **Phone numbers are the customer identity.** Validate/normalize at every trust boundary with
   `domain/phone.js` → canonical E.164 (`+252XXXXXXXXX`). Rule: 2-digit operator prefix +
   7 digits = 9-digit national number. `frontend/shared/phone.js` mirrors this for live input
   feedback; the backend copy is the enforced source of truth. Keep the prefix maps in sync.
5. **USSD `#` must be `%23`.** `domain/ussd.js` builds the `tel:` URIs with the trailing `#`
   pre-encoded. A bare `#` reaching the browser makes Android truncate the dial string.
   Each wallet's template is validated at boot (`domain/wallets.js`), so a bare `#` refuses to
   start rather than reaching a customer.
6. **Money never flows through the platform.** No wallet, no balance, no held funds, no
   platform-initiated transfer. The backend only *records* a payment an operator confirmed.
7. **Domain events are written in the same transaction as the state they describe.** Commands
   call `enqueue(client, EVENT, payload)` with the transaction's client — never `publish()`
   directly (`events/outbox.js`). Publishing after COMMIT is two steps with a crash-shaped gap
   between them. Consumers must be idempotent: delivery is at-least-once.
8. **Every order-scoped route is authorized, and the rule lives in one file.**
   `domain/access.js` `canAccessOrder()` is the only definition of who may see an order. Adding
   a route under `/orders/:id` without `requireAuth, requireOrderAccess` is a data breach, not a
   missing feature. The same rule governs WebSocket `subscribe`.

---

## Payment confirmation: a person, not a device

There is **no Oracle**. An earlier design had an Android phone read the merchant's SMS receipts
and post them to a signed webhook; it was removed with everything it needed (webhook + HMAC,
heartbeat monitor, receipt parsers, IMAP email sensor, reconcile queue, missed-call sign-in).
Git history has it if it's ever wanted back.

- **Wallet picker** (`domain/wallets.js`): EVC Plus, eDahab, Zaad and Sahal, each with its
  own merchant number and dial code (`<WALLET>_MERCHANT` / `<WALLET>_USSD`). A wallet is
  offered only when both are set — **no built-in codes or numbers**, because a guessed code or
  placeholder number takes a customer's money nowhere. Half-set or malformed refuses to boot.
  The customer's own network is listed first. No wallet configured = the manual path.
- **Customer:** taps their wallet, pays over USSD, then taps **"I've paid"**, optionally typing
  the transaction number from their payment message. Stored as `orders.payment_claimed_at` /
  `payment_claim_ref` / `payment_claim_wallet`; a `payment.claimed` event reaches operators
  live, naming the wallet and its merchant number so they check the right phone. Status
  unchanged.
- **Operator:** claimed orders sort to the top of the dashboard with the reference pre-filled.
  They check the merchant phone, then **Confirm payment**. Confirming without a reference is
  allowed but warned against: without it, the same payment could be confirmed twice.
- `confirmPayment` takes the order row `FOR UPDATE`, refuses anything not `PENDING_PAYMENT`, and
  refuses a reference already used (`409`, naming the other order) before UNIQUE would.
- **The honest limit:** this costs operator time per order, and the operator is now the payment
  check — they must look at the merchant phone, not trust the customer's reference. If volume
  outgrows it, the fix is a telecom merchant API, not reviving the phone.

### Outbound SMS and email: Twilio

Every code the platform sends — customer login codes (`+252` and `+1`) and staff setup codes —
goes through **Twilio**: SMS over the Messages API (`notify/smsSender.js`), email over Twilio
SendGrid (`notify/emailSender.js`). Pay-as-you-go. It is the one deliberate vendor exception,
and it is bounded: it carries a code, never money. No SDK — one HTTPS call each.

- `OTP_TRANSPORT`: `twilio` (production, both channels), `auto` (= twilio, but a dev box
  without keys shows the code on screen), `log` (dev only — **refuses to boot** in production).
  Anything else refuses to boot.
- **Dev never messages strangers.** Outside production, real SMS/email goes only to
  `DEV_SMS_ALLOWLIST` / `DEV_EMAIL_ALLOWLIST`; everything else gets the on-screen code. Both
  channels share one rule (`resolveTransport`). The seed's numbers are valid Somali numbers that
  may belong to real people.
- A Twilio message created as `failed`, or SendGrid answering anything but 202, is a failure,
  never "sent". Twilio's error code is kept in the log line (21408 = country not enabled).
- US delivery needs the **10DLC-registered Messaging Service** (`TWILIO_MESSAGING_SERVICE_SID`);
  carriers filter unregistered senders. `+252` needs Somalia enabled in Geo permissions.
  Setup and troubleshooting: `docs/LIVE_SMS_SETUP.md`.

### Email codes: never an identity

The phone number is still the customer (invariant 4). Email is only a second way to receive a
code, and only for an email the customer **confirmed while signed in** (the session proves the
phone, a code proves the email; `email_challenges`, kept apart from `otp_codes` so a code sent to
an unconfirmed address can never log anyone in). Sign-in "Email me a code" sends to
`users.email` or to nobody — and answers identically either way, cooldown included, so it can't
be used to learn which numbers have accounts. Staff setup codes go by email when the admin gives
one (`drivers.email` / `operators.email`); the claim still needs the phone and the code.

---

## Authentication & authorization

Three identities, one signing secret (`SESSION_SECRET`), all tokens HMAC-signed
(`middleware/auth.js`).

| Role | Authenticates with | Token TTL | Sees |
|---|---|---|---|
| `customer` | phone + 6-digit OTP over SMS (or a confirmed email) | 30 days | only orders under their verified phone |
| `driver` | msisdn + PIN (scrypt), chosen by the driver via a setup code | 12 hours | only orders the operator assigned to them |
| `operator` | username + password (scrypt), chosen via a setup code | 12 hours | everything; **admins** also manage staff |

- **OTP** (`domain/otp.js`, `commands/auth.js`, `routes/auth.js`): 6 uniform random digits,
  scrypt-hashed at rest, 5-minute TTL, single-use, max 5 attempts, 60s resend cooldown enforced
  atomically in the DB (`otp_codes`, one live challenge per phone). Verification returns ONE
  generic error for every failure mode — distinguishing "no challenge" from "wrong code" would
  make the endpoint a phone-number oracle.
- **Delivery** is Twilio for every number, or email if confirmed (see *Outbound SMS and email* above). **Play review login**:
  `REVIEW_PHONE` + `REVIEW_CODE` (6 digits) make one fixed number's code fixed, with no SMS —
  a reviewer can't receive texts at your number. It still runs the whole OTP path (cooldown,
  attempt cap, rate limits, single use), reaches only that account, and a half-set or malformed
  pair refuses to boot (`domain/otp.js` `reviewCodeFor`).
- **Failure paths RETURN from the transaction, then throw.** A throw inside `withTransaction`
  rolls back everything — including the `attempts++` that enforces "5 wrong tries burns the
  code". That bug made the cap a no-op. `verifyOtp` and `claimSetup` now return a
  failure outcome, commit the count, and raise after.
- **Deny = 404, never 403.** A 403 confirms "this order exists, it just isn't yours" — exactly
  what an enumeration script wants. Same for WebSocket `subscribe`.
- **The client never chooses its own identity.** Order creation takes the phone from the token
  (not the body); chat `sender` is derived from the role; `subscribe_driver` uses the driver id
  in the token. None of these are expressible as client input.
- **WebSocket**: token in the first frame (browsers can't set handshake headers, and a token in
  the query string lands in every access log). Sockets that don't authenticate within 10s are
  closed (4401). Room members are **re-authorized on every event**, not just at subscribe time,
  so a reassigned driver stops receiving a customer's updates immediately.
- **Operator accounts** (`domain/operator.js`, `commands/operators.js`): usernames normalized to
  lowercase (so "Amina " and "amina" can't become two accounts and a lookalike); passwords ≥12
  chars, scrypt-hashed, may not contain the username. Login answers one generic error for both
  "no such account" and "wrong password" — the difference enumerates the staff roster. Accounts
  are **deactivated, never deleted** (the audit trail references them), you cannot deactivate
  yourself, and neither the last active operator nor the **last active admin** can be
  deactivated or demoted. First boot creates `admin` (an admin) from `OPERATOR_PASSWORD`,
  flagged `must_change_password`: that value lives in `.env` and shell history, so it is a
  delivery mechanism, not a secret.
- **Admins** (`operators.is_admin`) create, disable and reset staff accounts and review access
  requests (including ID documents); ordinary operators dispatch. Checked against the DB on
  every request (`adminOnly` in `routes/operator.js`), so removing admin rights is immediate.

- **Rate limits** (`middleware/rateLimit.js`): sliding window on OTP request/verify, driver
  login, operator login and staff setup, keyed per IP and per identity. Backed by Redis when configured
  (shared across instances, via a Lua script so the read-then-write can't interleave), otherwise
  in-process. If Redis is unreachable it falls back to the in-process limiter rather than failing
  closed — failing closed would take down login for everyone during a blip.

### Staff onboarding by invite (`commands/staffAccounts.js`, `domain/staffInvite.js`)

The industry-standard pattern, and the only way staff accounts are created:
**admin creates the account → system texts a one-time setup code → the person chooses their
own PIN/password with it.** Nobody ever types or knows another person's secret.

- An invited account holds an **unclaimable** random secret until claimed (`drivers.pin_set_at`
  null = waiting for setup). Setup codes: 8 digits, scrypt-hashed, 24h, 5 attempts, deleted on
  use, **one live code per account** (re-send replaces it). `POST /api/staff/setup` is public,
  rate-limited, and answers one generic error for every failure.
- **Re-send doubles as reset**: the old PIN/password keeps working until the new one is set, so
  a reset can't lock anyone out.
- **Never upsert a driver by phone.** "Add driver" with an existing number is a 409 — the old
  upsert silently replaced that driver's PIN, an account takeover by anyone with a dashboard.
- Driver PINs chosen at setup: 6 digits, not repeated or sequential (old 4-digit PINs still log in).
- The SMS goes out **after** the transaction commits (a text can't be rolled back); if it
  fails, the account exists and "Send setup code" retries.

---

## Event delivery (transactional outbox)

`Command tx { state change + INSERT INTO outbox } → COMMIT → relay → bus → sockets`

- **Write path**: commands call `enqueue(client, EVENT, payload)` inside their transaction, then
  `wakeOutbox()` **after** it commits (waking early would publish an uncommitted event).
  Forgetting to wake costs latency only — the 1s poll catches it.
- **Relay** (`startOutboxRelay`): claims rows with `FOR UPDATE SKIP LOCKED` in `id` order,
  publishes to the bus, stamps `published_at`. A batch is one transaction, so a crash mid-batch
  redelivers rather than loses. Leadership is a `pg_try_advisory_xact_lock`, so exactly one
  instance relays and ordering by `id` holds even when scaled out.
- **At-least-once, so consumers must be idempotent.** Today's consumers are socket broadcasts,
  and every event is a state *snapshot* ("order 4 is IN_TRANSIT"), not a delta — keep new events
  shaped that way and a duplicate stays harmless.
- **A poison event parks after 5 attempts** (`failed = true`) instead of wedging the queue:
  Postgres is still the truth and clients resync on reload, so one dropped notification beats a
  relay that never moves again. Parked rows need a human.
- **Backlog is visible**: `GET /api/operator/outbox`, surfaced as a badge in the operator header
  when the relay falls behind (>20 pending, >30s old, or anything parked). A stalled relay looks
  exactly like "the app is frozen", so it must not be silent.
- Delivered rows are kept **7 days** as the "why did this happen at 3am" record, then swept.

## CAP: what we actually choose

Over Somali mobile networks **P is not optional**, so the design picks C or A *per operation*:

- **Money and state transitions → CP.** `confirmPayment`, `transitionOrder` and driver
  assignment must be linearizable. On partition, **refuse the write**. The
  `telecom_receipt_id UNIQUE` invariant already encodes this — never trade it for availability,
  because the failure mode is crediting a payment twice. `PG_CP_COMMIT` / `PG_CRITICAL_TIMEOUT_MS`
  turn a hung synchronous commit into a loud 503 rather than an indefinite wait.
- **Tracking, chat, photos → AP.** Client-minted UUID idempotency keys, an offline write queue
  in IndexedDB (`frontend/shared/queue.js`), optimistic local state, reconcile on reconnect. A
  driver in a dead zone must still be able to mark delivered and have it sync later.
- **Conflict rule:** the server's state machine always wins over a queued client transition. A
  rejected offline action surfaces as "couldn't sync" — never silently dropped.
- **Scaling out requires `REDIS_URL`.** Without it the bus and rate limiter are in-process, so
  clients on instance B miss instance A's events and the effective limit is N×max.

## Observability & operational hygiene

- **Every response carries `X-Request-Id`**, and every request logs one JSON line
  (`middleware/requestLog.js`): method, masked path, status, ms, ip, actor. When a customer
  disputes a payment, that line plus `order_events.actor` is the whole story.
- **Logs must never undo the API's privacy** (`domain/redact.js`): phone numbers are masked to
  `+252••••••678` — including inside the URL, since `/phone/validate/:phone` puts PII in the
  request line — and token/password/pin/code keys are dropped entirely. Never
  `console.log(req.body)`; use `redact()`.
- **Errors** (`middleware/errorHandler.js`): the client gets a generic message plus the request
  id; the stack goes to the log. Express's default handler renders stack traces into the
  response body outside production. Malformed JSON is 400, oversized bodies 413, unknown `/api`
  routes a JSON 404.
- **Graceful shutdown**: SIGTERM stops new work, closes sockets with 1001, drains in-flight
  requests (10s cap), then ends the pool. Without it a deploy cuts requests mid-response and an
  order the customer saw succeed may never have committed.
- **CSP on the PWAs** (`Caddyfile`): `script-src 'self'` — which is why service-worker
  registration lives in `app.js`, not an inline `<script>`. Don't reintroduce inline scripts.

---

## Refunds & access requests

- **Refunds are a ledger, not a transfer.** The platform never holds funds (invariant 6), so
  settling means an operator sent money back from their own phone. A `FAILED_REFUND` transition
  opens a `refunds` row **in the same transaction** — an order must never end up failed with no
  record of what is owed, because that record is the only thing that will remind anyone to pay
  it. Nothing is opened if no payment ever arrived.
- **Settle requires a telecom reference** (the receipt of the RETURN transfer): it is the only
  claim in the system we cannot verify ourselves, so it must be checkable against the telecom's
  own log. **Waive is separate from settle** — conflating "we paid this back" with "nothing was
  owed" makes the ledger useless in the argument it exists to settle.
- **ID documents are the most sensitive data here.** Uploaded with a short-lived token scoped to
  one request (so nobody can attach to someone else's application), stored only as a key with a
  random component, streamed no-store to an authenticated operator, and **destroyed the moment
  the decision is made**. The row keeps `id_document_at` as proof it was checked and
  `reviewed_by` as who checked it. Holding a government ID after the decision it supported turns
  a routine breach into identity theft. Customers are NEVER asked for one.
- **Nobody self-registers as staff.** `POST /api/signup` records a REQUEST and grants nothing; an
  **admin** approves it, then — as a separate, deliberate click — creates the account, which
  texts the applicant a setup code (*Staff onboarding by invite*). An operator account reads
  every customer's phone, address, chat and photos — the gate has to be a human who recognises
  the applicant. Approving is *not* wired to account creation on purpose: minting a credential
  should never be a side effect of clicking Approve. An approved request stays in the queue
  until its account exists (`access_requests.account_created_at`).

## Photos / object storage (MinIO)

MinIO runs the **AIStor** image, pinned to an exact release in `docker-compose.yml`. It reads its
license from a **file** (`./minio.license`, git-ignored like `.env`) and will not start without
it. Never `latest`: an `up` must not change the storage engine under the photos by accident.

Two photo types, stored in MinIO and indexed in `order_photos`:
**`order_ref`** (customer attaches at checkout) and **`delivery_proof`** (driver uploads at
delivery). Rules (`commands/photos.js`):

- Bytes are the raw request body (route-scoped `express.raw`, 6MB cap — separate from the
  sub-10KB order-JSON budget). The global `express.json` skips non-JSON bodies.
- **Deterministic key** `orders/<id>/<kind>.<ext>` → one object + one row per (order, kind).
  Re-upload upserts (`ON CONFLICT (object_key)`), so duplicate copies of sensitive images can't
  pile up.
- Browser never talks to MinIO. `GET /api/orders/:id/photos` lists metadata;
  `…/photos/:pid/raw` **streams the bytes through the backend**. `presignGet` is kept for real
  deploys where MinIO is browser-reachable behind Caddy — locally `minio:9000` only resolves
  inside the docker network.
- Photo reads are authorized like every other order-scoped read, so a plain `<img src>` gets a
  401 — the PWAs fetch bytes with the bearer token and render from an object URL.

## Frontend (three PWAs, vanilla JS, no framework)

`frontend/user`, `frontend/driver`, `frontend/operator`, plus `frontend/shared`. Kept
framework-free to respect the SRS data budget (initial load < 1.5MB). Each PWA has a Service
Worker that cache-first serves its shell.

- **User**: identity = phone, verified by OTP. Session token in `localStorage`
  (`gm_token`/`gm_phone`) — not `sessionStorage`, because re-verifying costs a real SMS and the
  customer is on one personal handset. Any 401 clears the session. Resume via
  `GET /api/orders/mine` (token-scoped). Opens on a home/landing role picker; header has Home,
  FAQ and the theme toggle. Checkout takes an optional reference photo.
- **Driver**: PIN login → token in `sessionStorage` (`driverToken`); the socket authenticates
  then joins `subscribe_driver` (its own feed, not the operator firehose). Queue shows **only
  orders the operator assigned to this driver** — there is no shared self-serve pool. Order
  detail can capture a delivery-proof photo.
- **Operator**: password → token in `sessionStorage` (`opToken`). Order cards show photo
  thumbnails; PAID_UNASSIGNED cards have a driver picker →
  `POST /operator/orders/:id/assign`, which sets `driver_id` and transitions to DISPATCHED.
  A Drivers panel lists the roster with live workload stats.
- **Theme** (`shared/theme.js`): black ↔ white with constant gold trim, set before paint (no
  flash), persisted in `localStorage` (`gm_theme`) across all three PWAs.
- **Language** (`shared/i18n.js`): English ↔ Somali toggle (SO/EN in the header) on the customer
  and driver PWAs, persisted as `gm_lang`. Static text via `data-i18n*` attributes, dynamic text
  via `GMI18n.t()`, server errors mapped by `GMI18n.err()`. **The Somali is deliberately plain,
  everyday Somali** — short sentences, common words, nothing formal. Every new string needs both
  languages, equally brief. The operator console is English only.
- **Phone fields** (`shared/phone.js` `attach()`): a **🇸🇴 +252 / 🇺🇸 +1 switch** in front of every
  phone input. The switch picks the country; within it, any format is understood. Send
  `SomPhone.e164Of(input)`, never the raw text. The server still never guesses: bare digits are
  Somali, because a Somali number with an extra digit (`6123456789`) is also a valid US number.
- **Escape everything user-supplied** before it reaches `innerHTML` (`escapeHtml` in the operator
  app). Landmarks, names and chat come from the public; CSP blocks script, not injected markup.
- **Icons** come from `GuriKaabe-brandsheet.png`: `scripts/brandsheet-icons.py` (needs Pillow)
  writes the masters, `mobile/make-icons.sh` resizes them into Android densities.

### ⚠️ When you change any frontend shell file (index.html / app.js / styles.css / phone.js)

**Bump the `CACHE` constant** in that PWA's `sw.js` (e.g. `gurikaabe-user-vN`), or reloads keep
serving the cached old version. This is the #1 "my change isn't showing" gotcha here.

---

## Seeding

`backend/src/db/seed.js` (`docker compose exec backend npm run seed`). `TRUNCATE … RESTART
IDENTITY` then a fixed dataset (`db/seedFixtures.js`), so **every run converges to the same
state** — reset here whenever data drifts. Covers one order in every state, two drivers
(Amina/1234, Bashir/5678), two operators (`admin` — an admin — and `hodan`), recorded payments
for the paid orders, an "I've paid" claim on the pending order, chat/audit rows, and two seeded
SVG photos.

**Seed data is the only data that may appear in screenshots or demo videos.**

Guards (`db/seedSafety.js`), because the seed truncates everything and its passwords are public:
- Runs only with `NODE_ENV` **explicitly** `development` or `test` — no override. ("Not
  production" isn't enough: an unset `NODE_ENV` reads as development in `config.js`.)
- Refuses to wipe rows it didn't create (your own test login, staff, access requests) unless
  `SEED_CONFIRM=wipe-local-data`. `scripts/verify/run-all.sh` passes it for its throwaway stack.
- **Production refuses to boot while any seeded password or PIN still logs in** (`index.js`).

## Testing

```bash
cd backend && npm install && npm test   # 343 Jest unit tests, ESM via --experimental-vm-modules
./scripts/verify/run-all.sh             # live suites over real HTTP + WebSocket
```

Pure-domain suites need no DB; `payments` and `outbox` mock the pg transaction and event bus
(`jest.unstable_mockModule`). `tests/setup/env.js` seeds the env vars `config.js` requires at
import. Jest is a devDependency — the Docker image (`npm install --omit=dev`) doesn't ship it.

The live suites are shell/Node rather than supertest, deliberately: they test the stack **as
deployed** — through Caddy, with the real DB and MinIO — which is where the authorization rules
actually have to hold. `scripts/verify/lib.sh` resolves Postgres credentials from `.env`, so a
database rename is a one-line change rather than an edit to every suite.

Quick syntax check without the runner:
`cd backend && for f in $(find src -name '*.js'); do node --check "$f"; done`

## Conventions

- ES modules everywhere (`"type": "module"`). Node 20+.
- Paths below are relative to `backend/src/` unless noted.
- **Prisma** owns the schema and ordinary queries (`backend/prisma/schema.prisma`,
  `db/prisma.js`).
  Migrations are `prisma migrate deploy`, run on container boot.
  ⚠️ **schema.prisma is NOT the whole schema.** Partial indexes and CHECK constraints live in
  raw migration SQL because Prisma can't express them — including `idx_messages_client_id`, the
  UNIQUE that makes offline message replay idempotent. Rebuild from schema.prisma alone and they
  vanish silently. `npm run db:verify` asserts they exist.
- **Raw SQL survives where Postgres semantics ARE the feature**, via `$queryRaw` inside an
  interactive transaction (single pinned connection): `FOR UPDATE` row locks, the outbox's
  `FOR UPDATE SKIP LOCKED`, `pg_try_advisory_xact_lock` for relay leadership, the conditional OTP
  upsert, and `SET LOCAL synchronous_commit`. Don't "modernize" these into the model API — each
  is load-bearing and the comment above it says why.
- Object storage through `storage/objectStore.js` (S3 SDK pointed at MinIO). Don't add
  AWS-hosted S3 — it breaks the sovereignty requirement. Never expose storage creds to the
  browser.
- Keep order payloads small (SRS: < 10KB; `express.json({ limit: '32kb' })`).
- Match the surrounding style: concise comments explaining *why*, not *what*.
- **Commit early and often.** Secrets (`.env`, `CREDENTIALS.md`) stay git-ignored, always.

---

## Status and what's left before launch

Working and verified against the live stack: full order lifecycle over WebSocket,
operator-confirmed payments with "I've paid" claims, operator-driven dispatch, photos in MinIO
AIStor, authentication and per-order authorization everywhere, the transactional outbox,
refunds as a ledger, staff onboarding by invite (admin-only), the offline write queue,
multi-instance operation behind Redis, login codes delivered to a real US handset (then over ClickSend, now Twilio), and
the EN/SO interface. The Android app builds and installs.

**Still to validate:** Twilio SMS and SendGrid email end to end, Twilio delivery to `+252` and `tel:`/USSD `%23`
dialing. A Play reviewer signs in with the review login (`REVIEW_PHONE`/`REVIEW_CODE`), not a
real text. Production deploy: `docker-compose.prod.yml` (+ `Caddyfile.prod`). See
`docs/PLAY_RELEASE.md`.

Not started: push notifications.
