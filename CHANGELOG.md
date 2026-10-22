# Changelog

Versioning: the repo is tagged `vMAJOR.MINOR.PATCH`, matching the Android app's `versionName`
in `mobile/android/app/build.gradle`. The Android `versionCode` is a separate integer that
must increase on **every** Play upload, even a re-upload of the same version.

While pre-launch we stay on `0.x` — the API and schema are still changing. `1.0.0` is the
first build served to a real paying customer.

---

## [Unreleased] — errors people can report, logo in every header

### Added
- **Every failure is reportable.** Server errors carry a short `ref` (the start of the request
  id) and, when known, a safe cause: `database unavailable [503 · DB-P1001 · ref 1a2b3c4d]`,
  `could not send code [502 · SMS-21408 · ref …]`. All three apps show the reason in the
  person's language with the code kept as is, and a dead backend (Caddy's empty 502) now says
  "server unavailable" instead of doing nothing. Error toasts stay up 10s so the ref can be read.

### Changed
- The driver and operator headers show the logo instead of the grey dot, like the customer app.

---

## [Unreleased] — sign in by email, Play Store graphics

### Fixed
- **Sign-in "Email" did nothing visible.** It only changed the button label, and still asked
  for a phone number. The **Phone | Email** switch now swaps the phone box for an email box:
  type the email you confirmed in your account and the code goes there. New customers still
  start with a phone number. `POST /api/auth/otp/request {channel:'email', email}` and
  `/auth/otp/verify {email, code}`; the reply never includes the phone, and the cooldown is
  keyed by the email so it can't reveal who owns an address.
- Terms and Privacy links were the browser's default blue, unreadable on the dark theme.
- **A photo re-uploaded in another format didn't replace the old one.** The storage key carries
  the extension, so a PNG after a JPEG made a second object and row, and the order showed two
  photos. `savePhoto` now removes the other copies of that (order, kind), file first, then row.

### Changed
- `users.email` is UNIQUE (migration `20261021150000_users_email_unique`): an email finds one
  account. Confirming an email takes it off any older account that had it.

### Added
- `./scripts/staging.sh shots`: Play Store phone, 7" and 10" tablet screenshots, the feature
  graphic and the 512 icon, rendered from seed data into `play-screenshots/`.

---

## [Unreleased] — local staging + Playwright

### Added
- **Staging** (`./scripts/staging.sh up`): the working tree as a separate Compose project at
  https://localhost:8444 with throwaway data, so changes can be seen and clicked through
  without deploying. `.env.staging` is generated on first run.
- **Playwright workflows** (`e2e/`, `./scripts/staging.sh test`): the full order lifecycle across
  the three apps, email codes, staff invite by email, and smoke checks (CSP/console, flags,
  Somali, legal pages).
- `COMMANDS.md`: every command reused in this project.

### Fixed
- The operator dashboard redraws on every live event, which reset a driver picked but not yet
  assigned and a transaction number being typed. They now survive the redraw. Found by the
  lifecycle test.

---

## [Unreleased] — Twilio, and codes by email

Migration `20261021090000_email_codes` adds nullable `users.email`, `drivers.email`,
`operators.email` and the `email_challenges` table. Additive; back up before deploying anyway.

### Changed
- **ClickSend is replaced by Twilio.** SMS goes through Twilio's Messages API (preferably the
  10DLC Messaging Service); `CLICKSEND_*` is gone, replaced by `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` / `TWILIO_FROM`. `OTP_TRANSPORT` is now
  `twilio` / `auto` / `log`; any other value (including `clicksend`) refuses to boot.
- The phone switch draws its flags instead of using flag emoji, which Windows and some Android
  WebViews show as plain "SO" / "US".

### Added
- **Codes by email** through Twilio SendGrid (`SENDGRID_API_KEY`, `EMAIL_FROM`; optional).
  Customers confirm an email while signed in, then can pick **Text / Email** at sign-in. An
  email request answers the same whether or not the number has an email. Admins can give a
  staff member an email, and their setup codes go there instead of by text.
- `scripts/sms-preflight.mjs` checks Twilio and SendGrid, and can send a test of each.
- `DEV_EMAIL_ALLOWLIST`, the email twin of `DEV_SMS_ALLOWLIST`.

---

## [Unreleased] — wallet picker

Migration `20261020120000_payment_claim_wallet` adds the nullable `orders.payment_claim_wallet`.
Additive; back up before deploying anyway.

### Added
- **Wallet picker:** the customer chooses EVC Plus, eDahab, Zaad or Sahal, and each button
  dials that network's code to its own merchant number (`<WALLET>_MERCHANT` / `<WALLET>_USSD`).
  Only fully configured wallets appear; the customer's own network is first.
- "I've paid" records which wallet was used, and the operator dashboard names it with its
  merchant number.
- **Terms of Service** (`docs/TERMS.md` → `/terms.html`), built with the privacy policy by
  `scripts/build-privacy.mjs`. The sign-in screen now shows the SMS consent line (rates,
  STOP/HELP) and links to both pages, which a 10DLC campaign review checks for.

### Changed
- `MERCHANT_MSISDN` / `USSD_TEMPLATE` are no longer read (a warning says so); use
  `EVC_MERCHANT` / `EVC_USSD`. There is no default merchant number any more: with no wallet
  configured, orders use the operator-confirmed manual path instead of dialing a placeholder.
- The boot refuses a half-set wallet, a non-Somali merchant number, or a dial code that isn't
  `*…{NUM}…{AMT}%23`.

---

## [Unreleased] — no Oracle: payments confirmed by an operator

Migration `20261016090000_manual_payment_confirmation` adds `orders.payment_claimed_at` /
`payment_claim_ref` and **drops** `sms_outbox` and `call_challenges`. Neither held anything
worth keeping. Back up before deploying.

### Removed
- **The Oracle device and everything that existed for it:**
  - `oracle/` (Termux scripts and simulator), the HMAC payment webhook, the heartbeat monitor
    and Oracle badge, and the phone's outbound-SMS queue;
  - `ORACLE_WEBHOOK_SECRET`, which is no longer required to boot;
  - missed-call sign-in, which needed the phone to see the call;
  - the IMAP email payment sensor, the receipt parsers, and the reconcile queue for unmatched
    receipts. Somali rails don't email, and the queue only ever filled from those sensors.
- `imapflow` dependency; `TELECOM_SENDER_IDS`, `ORACLE_HEARTBEAT_TIMEOUT_SECONDS`, `IMAP_*`,
  `VERIFY_CALL_NUMBER` settings.

### Added
- **"I've paid"** for customers, with an optional EVC/eDahab transaction number. Claimed
  orders jump to the top of the operator's list, with a live alert and the number pre-filled.
  A claim never changes the order's status.
- **Confirm payment** for operators: records the payment, with its transaction number, and
  moves the order to paid, in one transaction. A number already used for another order is
  refused, so one payment can't confirm two orders.

### Fixed
- **Manually confirmed orders opened no refund when failed.** "Mark as paid" never recorded a
  payment, and the refund ledger sums recorded payments, so failing such an order owed nothing.
  Confirming now always records one.

---

## [Earlier unreleased] — launch prep: ClickSend, staff onboarding, Somali, production hardening

Migration `20261015120000_staff_invites` (additive). Back up before deploying.

### Added
- **Staff onboarding by invite.** An admin creates a driver/operator account, from an approved
  access request or directly. The person gets a one-time setup code by SMS and chooses their
  own PIN/password (`POST /api/staff/setup`, "Set up account" in both apps). "Send setup code"
  doubles as a reset. New `staff_invites` table; `operators.is_admin`, `operators.phone`,
  `drivers.pin_set_at`, and `access_requests.account_created_at`/`account_ref`.
- **Admin role.** Only admins create, disable or reset staff, review access requests, or view
  ID documents. The last active admin can't be removed. The bootstrap `admin` is the first admin.
- **English ↔ Somali** toggle on the customer and driver apps (`shared/i18n.js`), in plain,
  everyday Somali.
- **🇸🇴 +252 / 🇺🇸 +1 switch** on every phone field. Within the chosen country, any format is
  accepted.
- **Play review login** (`REVIEW_PHONE` / `REVIEW_CODE`): one fixed number with a fixed code
  and no SMS, so a reviewer can sign in.
- **Production files:** `docker-compose.prod.yml` + `Caddyfile.prod` (domain, HSTS, no `:8080`,
  no published database port).
- Privacy page at `/privacy.html`, built from `docs/PRIVACY.md` by `scripts/build-privacy.mjs`,
  which refuses to build while placeholders remain.
- Brand icons from `GuriKaabe-brandsheet.png` (`scripts/brandsheet-icons.py`).

### Changed
- **SMS: ClickSend replaces Twilio, and carries every number.**
- **MinIO → AIStor**, pinned to `RELEASE.2026-09-19T17-05-25Z`, with the license read from the
  git-ignored `./minio.license`.
- Customer and driver copy rewritten for accuracy. It said customers pay "a driver" (they pay
  the merchant), and claimed "no foreign servers". Status badges show words, not
  `IN_TRANSIT`.
- Seed: refuses unless `NODE_ENV` is explicitly `development`/`test`, and refuses to wipe data
  it didn't create without `SEED_CONFIRM=wipe-local-data`. The `SEED_FORCE` override is gone.

### Fixed (security)
- **The 5-wrong-tries cap on login codes never took effect.** The `attempts++` was rolled back
  along with the error inside the same transaction. It now commits before the error is raised.
- **"Add driver" with an existing number silently replaced that driver's PIN** (an upsert),
  which was an account takeover. It now refuses with a 409.
- Customer-typed landmarks and driver names were rendered into the operator dashboard without
  escaping. Now escaped.
- Production refuses to boot while any seeded (public) password or PIN still logs in.
- Dev never texts numbers outside `DEV_SMS_ALLOWLIST`. Seed numbers may belong to real people.

### Fixed
- "Pay now" stayed visible on paid and delivered orders, inviting double payment.
- A US number was displayed, and rewritten in the input, as `+252 20 668 76538`.
- Header buttons overflowed on 360px phones (theme and log-out pushed off screen).

---

## [Earlier unreleased] — documentation and naming cleanup

No behaviour changes. Everything here is naming, documentation, or de-duplication; the 340
unit tests pass unchanged before and after.

### Changed
- **`ghost` naming retired in favour of the product name, GuriKaabe.** Package names, the Redis
  pub/sub channel and connection names, Service Worker cache keys, and the `config.js` defaults
  for the database, MinIO bucket and credentials. The customer PWA's `short_name` was still
  `"Ghost"` — that one was visible under the home-screen icon.
- **`.env.example` now provisions a fresh stack as `gurikaabe`.** ⚠️ This does **not** rename an
  existing database: those names are baked into the `postgres_data` volume on first boot. An
  existing deployment keeps working with its current `.env`; `.env.example` documents the
  `ALTER DATABASE` / `ALTER ROLE` migration for when you want to move.
- **Verification suites read Postgres credentials from `.env`** (`scripts/verify/lib.sh`)
  instead of hardcoding them in nine places, so a rename is one line rather than a search.
- **Twilio's role is documented as the toll-free A2P path** for `+1` — chosen because toll-free
  carries A2P traffic without 10DLC brand registration. Recorded alongside the constraint that
  makes the split necessary: toll-free reaches US/Canada only and **cannot** deliver to `+252`,
  which is why the Somali path stays on the Oracle phone.
- **`README.md` rewritten as an onboarding document** — clone to running stack in four commands,
  a map of where things live, and the two gotchas (image rebuild, Service Worker cache bump)
  that otherwise cost a new developer an hour each.
- **`CLAUDE.md` cut from 574 to ~430 lines.** Removed the P0/P1 completion log and dated
  "DONE" annotations, which git already records. Corrected stale status: P2 (Redis bus, shared
  rate limiter, offline write queue), refunds, and missed-call verification had all shipped but
  were still described as pending.

- **Compose project name pinned to `gurikaabe`** (`docker-compose.yml`). It previously came
  from the directory basename, which meant renaming or re-cloning the checkout folder silently
  pointed the stack at empty volumes. ⚠️ Volumes created under the old `ghost-merchant_*` prefix
  are now orphaned rather than deleted: locally, reseed; to keep the data, copy it across before
  discarding them.

### Added
- **`docs/PLAY_RELEASE.md`** — the ordered path from repo to Play Store, tying together the
  build in `mobile/README.md` and the Console answers in `docs/PLAY_LISTING.md`. Leads with the
  two clocks that dominate the schedule: identity verification, and the 14-day / 12-tester
  closed test required of personal developer accounts.

---

## [0.1.0] — 2026-08-07 — soft-launch candidate

First version that could plausibly be put in front of a real person. Everything before this
was a working demo with no security model.

### Added

**Authentication and authorization (P0 #1–#3, #5)**
- Customer login by phone + 6-digit SMS code: scrypt-hashed at rest, 5-minute TTL,
  single-use, 5 attempts, 60s resend cooldown enforced atomically in the database.
- `domain/access.js` — one definition of who may see an order, used by both the HTTP layer
  and the WebSocket layer. Denials answer **404, never 403**, so "not yours" and "doesn't
  exist" are indistinguishable.
- WebSocket authentication in the first frame, 10s auth timeout, per-order authorization,
  role-gated operator feed, and a per-driver feed. Room members are re-authorized on **every**
  event, so a reassigned driver stops receiving a customer's updates immediately.
- Named operator accounts. `order_events.actor` records `operator:<id>:<username>` instead of
  a shared `operator:super`, so a payment dispute can name a person.
- Sliding-window rate limits on every login path (OTP request/verify, driver PIN, operator
  password), per IP and per identity.

**Operational hygiene (P0 #4)**
- Security headers on the API, Content-Security-Policy on the PWAs.
- One structured JSON log line per request with a request id and a redacted actor. Phone
  numbers are masked — including inside the URL, since `/phone/validate/:phone` puts PII in
  the request line.
- Global error handler: the client gets a request id, the stack goes to the log.
- SIGTERM graceful shutdown; in-flight requests drain before the pool closes.

**Correctness under failure (P1 #6–#8)**
- Transactional outbox: domain events are written in the same transaction as the state change
  and relayed after commit. Delivery is at-least-once, so consumers must be idempotent.
- UUID order ids, mintable by the client — which makes order creation idempotent, so a lost
  response on a bad connection can't produce a second order the customer pays for twice.
- Live verification suite (`scripts/verify/run-all.sh`): 153 checks over the real HTTP and
  WebSocket layers, including stopping the backend, committing an event, and confirming
  delivery on restart.

**Mobile (P3)**
- **GuriKaabe** Android app (`mobile/`) — Capacitor shell over the same three PWAs. 3.6MB
  debug APK, 2.7MB release AAB. `so.gurikaabe.app`, minSdk 22, targetSdk 35.
- `shared/config.js` resolves the API base at build time; this was the blocker, since
  same-origin calls inside a WebView point at the phone.
- Cleartext access is *derived* from the backend URL rather than configured: a dev build
  permits it for exactly one private host, a release build permits none.
- Play submission pack: `docs/PRIVACY.md`, `docs/PLAY_LISTING.md`.

**Other**
- US (+1) numbers are full identities for device testing. They cannot pay by USSD — EVC Plus
  is a Somali rail — so the app explains that instead of showing a dead pay button.

### Fixed
- **Payment matching was two transactions.** Recording the receipt and transitioning the
  order could be interrupted between them, leaving money received against an order still
  reading "awaiting payment". Now one commit, with `FOR UPDATE` so simultaneous receipts
  serialize.
- Operator assign and manual receipt assignment had the same split; both are now atomic.
- Driver photo gallery used a bare `<img src>` and would have 401'd under the new
  authorization.

### Removed
- `GET /orders/by-phone/:phone` — it listed any number's orders on request. Replaced by
  token-scoped `/orders/mine`.
- Driver self-serve `accept` route: it contradicted operator-driven dispatch and was the one
  route that needed to bypass the assignment check.

### Security notes
- Bare 10-digit phone input is rejected on purpose. With length-based country detection a
  Somali customer typing one digit too many (`6123456789`) becomes a *valid* US number, and
  would create an order under an identity that isn't theirs.
- The backend refuses to boot with `NODE_ENV=production` unless `OTP_TRANSPORT=oracle`, since
  the dev transport prints login codes into the server log.

### Known gaps
- **P4 — not validated on real hardware.** `tel:`+USSD dialing, Oracle SMS interception, and
  the outbound SMS that delivers login codes. This is the only blocker to a real launch.
- P2 — offline write queue and the Redis/NATS event bus. Until the bus and rate limiter move
  off in-process state, **do not run more than one backend instance**.
- Refunds record state only; money moves off-platform.
- Push notifications not started.

### Test coverage at this tag
255 Jest unit tests · 153 live end-to-end checks.

---

## [0.0.1] — 2026-08-06 — initial commit
MVP as inherited: order lifecycle, state machine, CQRS seams, HMAC webhook, MinIO photos,
three PWAs, 51 tests. No authentication, no authorization — every order readable by anyone
who could guess a sequential integer.
