# Changelog

Versioning: the repo is tagged `vMAJOR.MINOR.PATCH`, matching the Android app's `versionName`
in `mobile/android/app/build.gradle`. The Android `versionCode` is a separate integer that
must increase on **every** Play upload, even a re-upload of the same version.

While pre-launch we stay on `0.x` — the API and schema are still changing. `1.0.0` is the
first build served to a real paying customer.

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
