# 2026-11-05 — Proof of delivery, delivery-app layout, first release build

> Public repo: this file records decisions and state only. It contains no secrets, passwords or customer data.

## What was built

- **Proof-of-delivery standard** (`domain/proof.js`, `commands/proofs.js`, CLAUDE.md invariant 9).
  - Before this, a driver could tap "secured" and "delivered" with no evidence.
  - Pickup now needs a photo. Delivery needs the customer's 4-digit code, or a door photo plus a reason (flagged).
  - Each step records GPS and the distance from the drop pin.
  - The code lives in its own table, because order rows reach the driver.
- **Operator Deliveries review**: flagged deliveries wait for "Mark checked".
- **UI rebuilt** to a standard delivery-app layout in all three apps:
  - customer: tabs, checkout, a tracking screen;
  - driver: a stepper with a proof panel;
  - operator: a sidebar console.
- **`scripts/new-server.sh`**: generates `.env.production` with fresh secrets, provisions a VPS (Docker, ufw, nightly `pg_dump`), and runs a health check.
- **First release build**: `0.2.0`, versionCode 1, signed with a new upload key (`~/gurikaabe-release.jks`, password in the git-ignored `mobile/android/app/keystore.properties`).
- **Email-only mode**: with no Twilio in production, `/auth/channels` says `sms:false`, so sign-in shows Email only and staff invites require an email.
- **"I didn't get my order"**: for 72 h after delivery, the customer can put it back in the operator's review queue.
- The live verify suites were stale (no `phone` at checkout since `97ef273`; error `ref` in compared bodies). Fixed; all 247 checks pass.
- Tests: 397 unit, 17 Playwright (two new: the code path and the photo-no-code path).

## Later the same day

- **SendGrid**: the key is valid with `mail.send`; a real send from `gurikaabe@gmail.com` was accepted (202). It is a restricted key, so it can't list senders.
- **Server 80.240.16.128 is unusable.** Every large inbound transfer dies after 30–290 KB (curl 56, apt "Hash Sum mismatch", git "decryption failed"). Ping is clean and local memory is fine, so it's the host's network. It also runs Ubuntu 26.10, an interim release. Replace it with Ubuntu 24.04 LTS.
- **npm**:
  - Fixed `proxy-addr` (critical: IP spoofing under trust proxy), `body-parser` (high) and `qs` (moderate, via an override).
  - Left `deepmerge-ts`: it sits inside the Prisma CLI and no request reaches it.
  - The lockfiles pointed at `registry.npmmirror.com`, so production would have installed from a third-party mirror. They now point at the official registry, pinned by a `.npmrc` in each package.
- **`./scripts/staging.sh simulate`** plays out 5 scenarios (40 steps, all passing) across the three apps:
  - a normal order;
  - no code at the door, then a dispute;
  - a delivery from a dead zone;
  - cheating attempts;
  - a failure after payment.

- **Production is live on 136.244.93.174** (Ubuntu 24.04, 2 vCPU / 8 GB, Frankfurt). Checked from outside:
  - HTTPS with a Let's Encrypt certificate, plus HSTS and CSP;
  - only ports 22, 80 and 443 open;
  - email-only mode (`sms:false`);
  - CORS accepts the Android app;
  - migrations applied and all schema guards present;
  - a nightly backup tested;
  - a real email code delivered.
  The database is empty apart from the bootstrap `admin`.

## Decisions

- **GPS is evidence, not a gate.** Refusing a delivery because a cheap handset has no fix would strand a driver who did the job. It is flagged instead.
- **Operators can't read the code.** If they could, an operator and a driver together could "prove" a delivery that never happened. The no-code path exists for this case, and it is reviewed.
- **The app talks to `https://app.gurikaabe.com`**, not the IP. Moving servers is a DNS change, not a rebuild.

## Open threads

1. New server `80.240.16.128` (replaced the pending 136.244.87.28).
   - Point DNS at it.
   - Fill in Twilio/SendGrid in `.env.production`.
   - Run `./scripts/new-server.sh setup 80.240.16.128`.
2. Upload `GuriKaabe-0.2.0-vc1.aab` to Play **internal testing**.
3. **Back up** the upload keystore and `keystore.properties` off this laptop.
4. Native-speaker review of the new Somali strings.
5. Carried over: wallets, 10DLC, the review login, real-handset tests in Somalia.
