# GuriKaabe

Delivery coordination for Somalia, self-hosted end to end. Customers pay the merchant directly
over EVC Plus, eDahab, Zaad or Sahal using a USSD `tel:` link, tap **"I've paid"**, and an **operator
confirms** the payment by checking the merchant phone. No AWS, no WhatsApp, no Google Maps, no
telecom API contract, no device reading receipts.

The platform **never touches the money**: it only records a payment an operator confirmed. Revenue is
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
#    It wipes every domain table, so it asks first if it finds data it didn't create
#    (e.g. your own test login): add -e SEED_CONFIRM=wipe-local-data to confirm.
docker compose exec backend npm run seed

# 4. Unit tests (no database needed).
cd backend && npm install && npm test
```

Then open the three PWAs. Caddy issues a **self-signed `localhost` cert**, so every browser
shows a one-time warning — accept it once per app. HTTPS isn't optional here: Service Workers
and geolocation refuse to run without it.

| App | URL | Login |
|---|---|---|
| Customer | https://localhost/ | any phone; in dev the code is shown on screen |
| Driver | https://localhost/driver/ | `619876543` / `1234` (Amina) or `651112223` / `5678` (Bashir) |
| Operator | https://localhost/operator/ | `admin` / `change-me-please-1` (admin) or `hodan` / `seeded-operator-pw-1` |

In dev, the customer's code appears on screen and in `docker compose logs -f backend`, on the
`[OTP][dev-transport]` line. That only happens outside production: the backend refuses to
boot in production on the log transport.

With Twilio keys in `.env`, dev sends real texts **only** to numbers on
`DEV_SMS_ALLOWLIST`, so a login as a seeded number never texts a stranger.

Every phone field has a **🇸🇴 +252 / 🇺🇸 +1** switch: pick the country, then type the number
any way you like.

**Walk a payment through.** As a customer, place an order and tap **I've paid**. You can type
any transaction number. In the operator app the order jumps to the top. Tap **Confirm
payment**, and the customer's page flips to paid within about a second, over the WebSocket.

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
| `backend/src/domain/` | Pure logic — state machine, phone parsing, USSD, payment references. No I/O, fully unit-tested. |
| `backend/src/commands/` · `queries/` | The CQRS write and read sides. |
| `backend/src/events/` | Event bus + transactional outbox. |
| `backend/src/notify/` | Outbound SMS and email (Twilio, Twilio SendGrid). |
| `frontend/{user,driver,operator}/` | Three vanilla-JS PWAs; `frontend/shared/` is common code. |
| `mobile/` | Capacitor wrapper that ships the PWAs as an Android app. |
| `scripts/verify/` | End-to-end suites that run against the live stack. |

**Read the invariants in `CLAUDE.md` before changing backend code.** They are short, and each
one is there because the alternative loses money or leaks customer data.

---

## Testing

```bash
cd backend && npm test          # 343 Jest unit tests, no database required
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

Any Linux box with Docker. Compared with local, it has a real domain, real secrets, and no
seed data.

**Prerequisites:** a domain with an A/AAAA record pointing at the VPS, and ports **80 and 443**
open. Caddy needs port 80 to get its certificate.

1. **Write a real `.env`.** Replace every `change_me_*`. Use `openssl rand -hex 32` to
   generate `SESSION_SECRET`. Also set:
   - `DOMAIN=app.example.com`, `NODE_ENV=production`, `CORS_ORIGINS=https://app.example.com,https://localhost`
   - `OPERATOR_PASSWORD`: a **new** password of at least 12 characters. It creates the first
     admin account, `admin`, which must change it at first sign-in. Never reuse a value from
     `CREDENTIALS.md`: the backend refuses to boot while any seeded password still works.
   - `OTP_TRANSPORT=twilio` plus the `TWILIO_*` keys, and `SENDGRID_API_KEY` / `EMAIL_FROM` for
     email codes ([`docs/LIVE_SMS_SETUP.md`](docs/LIVE_SMS_SETUP.md))
   - `REVIEW_PHONE` / `REVIEW_CODE` for the Play reviewer ([`docs/PLAY_RELEASE.md`](docs/PLAY_RELEASE.md) §3)
   - `<WALLET>_MERCHANT` / `<WALLET>_USSD` for each wallet you accept (EVC Plus, eDahab, Zaad,
     Sahal). Only wallets with both lines set are shown; see `.env.example`. Dial each code by
     hand once with a small amount before turning it on.
2. **Put the MinIO AIStor license on the server** as `./minio.license`. It's git-ignored,
   like `.env`, and MinIO won't start without it.
3. **Launch with the production overrides:**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
   `docker-compose.prod.yml` swaps in `Caddyfile.prod`, which uses your domain, an automatic
   certificate and HSTS. It removes the dev listener on port 8080 and the published database
   port. Migrations run on boot. **Never run the seed**: it refuses anyway unless
   `NODE_ENV=development`.
4. **Sign in as `admin`** and change the password. Then add staff from the dashboard. Each
   person gets a setup code by text and chooses their own PIN or password.
5. **Publish the privacy policy and terms:** fill in the placeholders in `docs/PRIVACY.md` and
   `docs/TERMS.md`, then run `node scripts/build-privacy.mjs`. They're served at
   `https://<domain>/privacy.html` and `/terms.html`, and linked from the sign-in screen.
6. **Payments:** keep the merchant phone with whoever runs the desk. An operator confirms
   every order by checking that phone for the money, so the desk must be staffed while orders
   are coming in.

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
- **If `SESSION_SECRET` leaks, anyone can mint an operator session** and confirm payments.
  Rotate it (everyone is logged out), then review recent confirmations in `order_events`.
- **Check the merchant phone before every confirmation.** "I've paid" and the number the
  customer typed are claims, not proof. Only the money on the phone is proof.

Shipping the Android app to Google Play is a separate process — see
**[`docs/PLAY_RELEASE.md`](docs/PLAY_RELEASE.md)**.

---

## Status

Working end to end and verified against the live stack: the full order lifecycle over
WebSocket, operator-driven dispatch, operator-confirmed payments with "I've paid" claims,
photos in MinIO, authentication and per-order authorization on every route and socket, the
transactional outbox, refunds as a ledger, staff access requests with ID review, the offline
write queue, and multi-instance operation behind Redis.

Login and staff setup codes go out through Twilio (SMS) and Twilio SendGrid (email). **Still
unvalidated:** both end to end, and on a Somali network USSD `tel:` dialing and Twilio
delivery to `+252`.

Known gaps: push notifications aren't started, and refunds are settled off-platform by design.

## Further reading

| Document | Covers |
|---|---|
| `CLAUDE.md` | Architecture, invariants, and the reasoning behind them. The important one. |
| `CHANGELOG.md` | Release history and version policy. |
| `mobile/README.md` | Building the Android app. |
| `docs/PLAY_RELEASE.md` | Getting the app into the Play Store. |
| `docs/LIVE_SMS_SETUP.md` | Real SMS and email delivery (Twilio) and the dev allowlists. |
| `docs/PRIVACY.md` · `docs/PLAY_LISTING.md` | Play submission pack. |
| `scripts/brandsheet-icons.py` | Cuts every app icon out of `GuriKaabe-brandsheet.png`. |
