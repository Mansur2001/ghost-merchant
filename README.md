# GuriKaabe

Delivery coordination for Somalia, self-hosted end to end. Customers pay the merchant directly
over EVC Plus / eDahab using a USSD `tel:` link; a dedicated Android phone (**the Oracle**)
reads the telecom's SMS receipt and reports it to the backend. No AWS, no WhatsApp, no Google
Maps, no telecom API contract.

The platform **never touches the money** — it only observes that a payment happened. Revenue is
a coordination fee on completed deliveries. `CLAUDE.md` explains why that constraint shapes
almost every design decision here; read it before proposing features.

---

## Start here (new developer, ~10 minutes)

Prerequisites: Docker + Docker Compose, Node 20+, and about 2GB of disk.

```bash
# 1. Config. The placeholder values work fine locally.
cp .env.example .env

# 2. Whole stack: Postgres + MinIO + Redis + backend + Caddy.
#    Migrations run automatically on backend boot and are idempotent.
docker compose up -d --build

# 3. Demo data — one order in every state, two drivers, seeded photos.
docker compose exec backend npm run seed

# 4. Unit tests (no database needed).
cd backend && npm install && npm test
```

Then open the three PWAs. Caddy issues a **self-signed `localhost` cert**, so every browser
shows a one-time warning — accept it once per app. HTTPS isn't optional here: Service Workers
and geolocation refuse to run without it.

| App | URL | Login |
|---|---|---|
| Customer | https://localhost/ | any phone; the passcode is printed to the backend log |
| Driver | https://localhost/driver/ | `Amina` / `1234` or `Bashir` / `5678` |
| Operator | https://localhost/operator/ | `hodan` / `seeded-operator-pw-1` |

Customer login needs the code from `docker compose logs -f backend` — look for the
`[OTP][dev-transport]` line. That is dev-only behaviour; the backend refuses to boot in
production with the log transport enabled.

**Exercise a full payment without owning a phone.** The simulator posts the same signed webhook
the real Android device would:

```bash
cd oracle
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ORACLE_WEBHOOK_SECRET=<same value as .env> BACKEND_URL=https://localhost \
  node simulate.js payment 612345678 7.25   # amount MUST equal the open order's total
  node simulate.js heartbeat                # flips the operator's Oracle badge green
```

The customer PWA should flip to "Payment confirmed" within about a second, over the WebSocket.

### Two gotchas that will cost you an hour

- **Backend changes need a rebuild**, not a restart — the image `COPY`s `src/`:
  `docker compose up -d --build backend`
- **Frontend shell changes need a cache bump.** Edit any `index.html` / `app.js` /
  `styles.css` and you must also bump the `CACHE` constant in that PWA's `sw.js`, or reloads
  keep serving the old version. This is the number one "my change isn't showing" here.

---

## How it fits together

One backend deployable, structured with the seams a microservices split would use, so any
module can be extracted later without a rewrite.

```
   Customer PWA ◄──┐
   Driver PWA   ◄──┤  Backend (Node, one process)
   Operator PWA ◄──┤    routes ─► commands (writes) ─► outbox ─► event bus
        ▲          │    queries (reads) ◄─ Postgres        │
        └─WebSocket┤    realtime layer ◄───────────────────┘
                   │
   Android Oracle ──HMAC-signed webhook──► /api/webhook

   Postgres · MinIO (S3-compatible) · Redis (bus + rate limits) · Caddy (auto-HTTPS)
```

- **Commands** (`backend/src/commands/`) write and enqueue domain events *in the same
  transaction*. **Queries** (`backend/src/queries/`) only read.
- **The order state machine is the single source of truth**
  (`backend/src/domain/stateMachine.js`). Never write `orders.status` directly.

```
PENDING_PAYMENT → PAID_UNASSIGNED → DISPATCHED → IN_TRANSIT → DELIVERED
       └───────────────────────────────────────────────────► FAILED_REFUND
```

Where things live:

| Path | What it is |
|---|---|
| `backend/src/domain/` | Pure logic — state machine, phone parsing, USSD, receipts. No I/O, fully unit-tested. |
| `backend/src/commands/` · `queries/` | The CQRS write and read sides. |
| `backend/src/events/` | Event bus + transactional outbox. |
| `backend/src/notify/` | Outbound SMS (Oracle queue, Twilio) and the IMAP payment sensor. |
| `frontend/{user,driver,operator}/` | Three vanilla-JS PWAs; `frontend/shared/` is common code. |
| `oracle/` | Termux scripts for the Android sensor phone, plus the simulator. |
| `mobile/` | Capacitor wrapper that ships the PWAs as an Android app. |
| `scripts/verify/` | End-to-end suites that run against the live stack. |

**Read the invariants in `CLAUDE.md` before changing backend code.** They are short, and each
one is there because the alternative loses money or leaks customer data.

---

## Testing

```bash
cd backend && npm test          # 340 Jest unit tests, no database required
./scripts/verify/run-all.sh     # live end-to-end suites against the running stack
```

The Jest suites cover pure domain logic. The shell suites exist because authorization rules
have to hold *as deployed* — through Caddy, against the real database and MinIO — which is a
different question from whether the functions are correct. Run both before a release.

`run-all.sh` resets the stack between suites on purpose: the rate limiter and the accounts the
suites create are stateful, and a suite that only passes on a fresh database is one people
quietly stop running.

---

## Deploying to a VPS

Any Linux box with Docker. The differences from local are a real domain, real secrets, and no
seed.

**Prerequisites:** a domain with an A/AAAA record pointing at the VPS, and ports **80 and 443**
open — Caddy needs 80 for the ACME challenge.

1. **Point Caddy at your domain.** Replace the `localhost` block in `./Caddyfile` with
   `app.example.com { …same handle blocks… }`. Certificates are then automatic.
2. **Write a real `.env`.** Every `change_me_*` must be replaced.
   `openssl rand -hex 32` generates `ORACLE_WEBHOOK_SECRET` and `SESSION_SECRET`. Also set:
   - `NODE_ENV=production`
   - `CORS_ORIGINS=https://app.example.com`
   - `OPERATOR_PASSWORD` — bootstraps the first operator account, then goes inert
   - `MERCHANT_MSISDN`, `USSD_TEMPLATE`, `TELECOM_SENDER_IDS` — match the live telecom
   - `OTP_TRANSPORT=oracle` (or `auto`) — **required**; the backend refuses to boot in
     production with the dev `log` transport, which would print login codes to the server log
3. **Launch:** `docker compose up -d --build`. Migrations run on boot.
   **Never run the seed** — it truncates the domain tables.
4. **Point the Oracle phone at the domain** (`oracle/Instructions.md`) and confirm the operator's
   Oracle badge goes green before taking live orders.

### Operational rules

- **Back up before every migration**, off the box:
  `docker compose exec postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > backup-$(date +%F).sql.gz`
- **Two volumes hold everything that matters:** `postgres_data` (orders, payments, audit trail)
  and `minio_data` (photos). `docker compose down -v` destroys both — never run it on the VPS.
- **Rollback = previous image tag + the pre-migration dump.** Tag images per release; don't
  deploy `latest` from a laptop.
- **Migrations are forward-only and additive.** Add, backfill, then switch reads.
- **Don't scale past one backend instance without `REDIS_URL` set.** The bus and rate limiter
  fall back to in-process state, and clients on instance B miss instance A's events.
- **If `ORACLE_WEBHOOK_SECRET` leaks, payments can be forged.** Rotate it on the VPS and the
  phone together, then reconcile every transaction since the leak by hand.
- **Watch the Oracle heartbeat.** A red badge means payments are silently not matching;
  operators fall back to manual "Mark as paid".

Shipping the Android app to Google Play is a separate process — see
**[`docs/PLAY_RELEASE.md`](docs/PLAY_RELEASE.md)**.

---

## Status

Working end to end and verified against the live stack: the full order lifecycle over
WebSocket, operator-driven dispatch, payment matching (Oracle SMS + IMAP email sensing),
photos in MinIO, authentication and per-order authorization on every route and socket, the
transactional outbox, refunds as a ledger, staff access requests with ID review, the offline
write queue, and multi-instance operation behind Redis.

**The one blocker to a real launch is hardware validation.** USSD `tel:` dialing, Oracle SMS
interception, and outbound login codes are all built and pass against the live stack, but none
has run on a Somali network. See `oracle/Instructions.md` and P4 in `CLAUDE.md`.

Known gaps: push notifications aren't started, and refunds are settled off-platform by design.

## Further reading

| Document | Covers |
|---|---|
| `CLAUDE.md` | Architecture, invariants, and the reasoning behind them. The important one. |
| `CHANGELOG.md` | Release history and version policy. |
| `oracle/Instructions.md` | Setting up the Android sensor phone. |
| `mobile/README.md` | Building the Android app. |
| `docs/PLAY_RELEASE.md` | Getting the app into the Play Store. |
| `docs/LIVE_SMS_SETUP.md` | Real SMS delivery on hardware. |
| `docs/MISSED_CALL_VERIFICATION.md` | Verifying a phone without sending anything. |
| `docs/EMAIL_SENSOR_SETUP.md` | Payment sensing over IMAP. |
| `docs/PRIVACY.md` · `docs/PLAY_LISTING.md` | Play submission pack. |
