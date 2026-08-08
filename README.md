# Ghost Merchant — Sovereign Delivery Coordination MVP

A zero-integration, local-first delivery coordination platform for the East African market
(EVC Plus / eDahab via USSD `tel:` bridging + Android SMS Oracle). Fully self-hosted, no
cloud-vendor lock-in.

## Architecture (modular monolith, event-driven + CQRS + pub/sub)

```
                    ┌──────────────────────────────────────────┐
   User PWA  ◄──────┤  Backend (Node.js, one deployable)        │
   Driver PWA ◄─────┤                                            │
   Operator PWA ◄───┤   routes ──► commands (writes) ──► events │
        ▲           │                                     │      │
        │ WebSocket │   queries (reads) ◄── Postgres      ▼      │
        └───────────┤   realtime layer ◄── event bus (pub/sub)  │
                    └──────────────────────────────────────────┘
   Android Oracle ──HMAC-signed webhook──► /webhook
   Storage: MinIO (self-hosted, S3-compatible)   DB: PostgreSQL   Proxy: Caddy (auto-HTTPS)
```

The command/query/event seams are drawn where microservices would split
(order · dispatch · tracking · payment) so any module can be extracted later without
rewriting logic.

## Build checklist (progress against the SRS)

### Infrastructure (sovereign stack)
- [x] `docker-compose.yml` — Postgres + MinIO + backend + Caddy, one command
- [x] Caddy reverse proxy with auto-HTTPS (required for Service Workers + geolocation)
- [x] `.env.example` for all secrets
- [ ] Deploy target: Hetzner/DigitalOcean VPS (manual)

### Backend core (the risky part — built first)
- [x] Postgres schema + migration (Users, Orders, Transactions, Messages, Drivers)
- [x] Order state machine — single source of truth, enforced transitions
- [x] In-process event bus (pub/sub)
- [x] CQRS: command handlers (writes emit events) / query handlers (reads)
- [x] Signed webhook receiver (HMAC) — the Android Oracle → backend link
- [x] Idempotent payments via UNIQUE `telecom_receipt_id` (anti double-spend)
- [x] WebSocket server, subscribe-by-order_id pub/sub
- [x] Oracle heartbeat + dead-man's-switch alerting
- [x] MinIO object storage adapter (S3 SDK)
- [x] Photo attachments in MinIO — customer reference + driver delivery-proof, idempotent keys
- [x] Idempotent re-runnable seed (`npm run seed`) — one order in every state + unmatched receipt
- [x] Jest test suite (state machine, phone, USSD, payments, OTP, access rule, rate limiter) — `npm test`
- [x] OTP auth (phone-number identity) — code send path via the Oracle phone (unvalidated on real hardware)
- [x] Per-order authorization on every route + authenticated WebSocket subscriptions
- [x] Rate limiting on every login path (OTP request/verify, driver PIN, operator password)
- [x] Named operator accounts — audit trail records who did what (`operator:<id>:<username>`)
- [x] Security headers + CSP, structured request logs (PII-redacted), graceful shutdown
- [x] Transactional outbox — events commit with the state change; crash-safe delivery
- [x] Atomic payment matching — receipt + status transition in one transaction
- [ ] Manual refund / reconciliation workflow

### Frontend (Option A: sovereign in-app chat)
- [x] User PWA: service worker + app shell caching, offline repeat visits
- [x] User: chat thread + progress timeline over WebSocket
- [x] User: checkout with geolocation + mandatory landmark
- [x] User: `tel:` USSD bridge with `%23` encoding
- [x] Driver PWA: PIN login, shopping list, out-of-stock / price adjust, geo: nav
- [x] Operator PWA: live orders, manual "Mark as Paid" override, Oracle health
- [x] Unified home/landing (role picker) + in-app FAQ + light/dark theme (gold trim)
- [x] Photo UX: customer reference photo at checkout, driver delivery-proof, thumbnails for operator
- [ ] Push notifications (optional, later)

### Validate on real hardware (do before scaling)
- [ ] `tel:`+USSD `%23` fires on real Hormuud/Somtel devices
- [ ] Android Oracle SMS interception + HMAC webhook round-trip

## Order state machine

```
PENDING_PAYMENT → PAID_UNASSIGNED → DISPATCHED → IN_TRANSIT → DELIVERED
       └────────────────────────────────────────────────────► FAILED_REFUND
```

## Running locally

For development on your own machine. Caddy issues a self-signed `localhost` cert, so
browsers show a one-time warning — that's expected and required (Service Workers +
geolocation refuse to run over plain HTTP).

```bash
# 1. Config — copy the template and fill in secrets (any values are fine locally).
cp .env.example .env
#    Leaving the change_me_* placeholders works locally, but set them anyway to
#    practice the prod flow. MERCHANT_MSISDN / USSD_TEMPLATE only matter with a real SIM.

# 2. Stand up the whole stack (Postgres + MinIO + backend + Caddy).
docker compose up -d --build
#    Migrations run automatically on backend boot (idempotent, tracked in schema_migrations).

# 3. Load the demo dataset (one order in every state, two drivers, seeded photos).
#    (Local .env uses NODE_ENV=development. In production the seed refuses to run at all.)
docker compose exec backend npm run seed

# 4. Open the PWAs (accept the self-signed cert warning once per PWA):
#    User      https://localhost/
#    Driver    https://localhost/driver/     (Amina / 1234, Bashir / 5678)
#    Operator  https://localhost/operator/   (admin / change-me-please-1, or hodan / seeded-operator-pw-1)

docker compose logs -f backend   # tail logs
docker compose down              # stop, keep data   |   down -v  wipes DB + MinIO
```

**Exercise the full payment loop without a phone** — the Oracle simulator posts a signed
webhook exactly as the real Android device would:

```bash
cd oracle
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ORACLE_WEBHOOK_SECRET=<same as .env> BACKEND_URL=https://localhost \
  node simulate.js payment 612345678 7.25   # amount MUST equal the open order's total
  node simulate.js heartbeat                 # flips the operator's Oracle badge green
```

**After editing backend `src/`** rebuild the image (a plain restart won't pick up code):
`docker compose up -d --build backend`. **After editing any frontend shell file** bump the
`CACHE` constant in that PWA's `sw.js`, or reloads keep serving the cached old version.

### Tests

```bash
cd backend && npm install   # first time — installs jest + cross-env devDeps
npm test                    # Jest (141 tests): domain, payments, OTP, access, limiter, redaction, operators, outbox
```

## Running in production

Deploys to any Linux VPS (Hetzner / DigitalOcean / etc.). Same `docker compose` stack; the
differences are a **real domain** (so Caddy gets a trusted Let's Encrypt cert automatically),
**real secrets**, and **no demo seed**.

**Prerequisites:** a VPS with Docker + Docker Compose, a domain's A/AAAA record pointed at the
VPS IP, and ports **80 + 443 open** (Caddy needs 80 for the ACME HTTP challenge).

```bash
# 1. Point Caddy at your domain — replace the `localhost` block in ./Caddyfile:
#      app.example.com {   ...same handle blocks...   }
#    Caddy then provisions + renews a Let's Encrypt cert with no extra config.

# 2. Real .env — every change_me_* MUST be replaced. Generate strong secrets:
#      openssl rand -hex 32        # for ORACLE_WEBHOOK_SECRET, SESSION_SECRET
#    Set for prod:
#      NODE_ENV=production
#      CORS_ORIGINS=https://app.example.com     # your domain, not localhost
#      OPERATOR_PASSWORD=<strong password, 12+ chars — bootstraps the first operator account>
#      MERCHANT_MSISDN=<real EVC Plus / eDahab number>
#      USSD_TEMPLATE / TELECOM_SENDER_IDS       # match the live telecom
#      POSTGRES_PASSWORD, S3_SECRET_KEY         # strong, unique
#      OTP_TRANSPORT=oracle                     # REQUIRED in prod — the backend refuses to
#      ORACLE_SMS_URL=<Oracle device endpoint>  # boot with the dev "log" transport, which
#                                               # would print customer login codes to the log.

# 3. Launch.
docker compose up -d --build
#    Migrations run on boot. Do NOT run the seed in prod — it TRUNCATEs the domain tables.

# 4. Point the Android Oracle at the domain: set BACKEND_URL=https://app.example.com and the
#    matching ORACLE_WEBHOOK_SECRET on the device (see oracle/README.md). Confirm the operator
#    Oracle badge goes green (heartbeat) before taking live orders.
```

**Operational notes:**
- **Back up the data volumes** — `postgres_data` (orders, payments, audit trail) and
  `minio_data` (customer + delivery-proof photos). `docker compose down -v` destroys both.
- **Secrets never enter git.** `.env` and `CREDENTIALS.md` are git-ignored; keep them so.
- **Validate on real hardware first** (see checklist below): `tel:`+USSD `%23` dialing and
  Oracle SMS interception on actual Hormuud/Somtel SIMs before onboarding real customers.
- Rotate `OPERATOR_PASSWORD` / `SESSION_SECRET` and `docker compose up -d` to apply.

## Sovereignty notes
- **MinIO** speaks the S3 API but is self-hosted — no AWS. Code uses the standard S3 SDK.
- No Meta/WhatsApp dependency. Chat is in-app over your own WebSocket, stored in your Postgres.
- Entire stack is containerized and portable to any VPS.
