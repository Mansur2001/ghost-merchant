# Getting GuriKaabe into the Play Store

The ordered path from this repo to a published app. Each step links to the document that has
the detail — this page is the sequence, not a duplicate of them.

> **Start the account admin before you start the engineering.** Identity verification takes
> days, and the closed test takes **14 continuous days** with **12+ testers**. Those two clocks
> run regardless of how ready the code is, so start them first.

---

## The timeline that surprises people

Google requires **personal (non-organisation) developer accounts** to run a closed test with at
least 12 testers opted in for 14 continuous days before you may even *apply* for production
access. Approval after that is not instant.

So the realistic order is: register and verify → build something installable → recruit 12
testers → run the 14 days → apply for production → submit. Budget a month, not a weekend.

---

## 1. Account setup (do this first, in parallel with everything else)

- Register a Play Console account — one-off $25.
- Complete **identity verification**. Required for everyone; start it immediately.
- Publish the privacy policy at a public URL. Content is drafted in
  [`PRIVACY.md`](PRIVACY.md); it must be reachable at a stable link before submission.

## 2. Get the backend production-ready

The app is a thin shell over the PWAs — a reviewer opening it is hitting your live server. If
the backend is down or unreachable during review, the app is rejected as broken.

Follow *Deploying to a VPS* in the root [`README.md`](../README.md), then confirm:

- Real domain with a valid certificate, `NODE_ENV=production`.
- `CORS_ORIGINS` includes your domain **and** `https://localhost` — the WebView's own origin.
- The dev `:8080` cleartext listener is removed from the `Caddyfile` and `docker-compose.yml`.
- Database backups are running, off the box.

## 3. Make sure a reviewer can actually sign in

**This is the top rejection risk for this app.** The only way into GuriKaabe is a phone number
plus a login code. A reviewer who never receives one cannot get past the first screen.

The reviewer will be using a **US number**, which routes through Twilio rather than the Oracle
phone (`backend/src/notify/smsSender.js`). So before submitting:

- Configure Twilio and verify the toll-free number in the console. Toll-free carries A2P
  traffic without 10DLC brand registration, but it must be verified to deliver at volume, and
  **it reaches US and Canadian numbers only**.
- Set `OTP_TRANSPORT=auto` so `+252` keeps using the Oracle and `+1` uses Twilio. (Plain
  `oracle` also satisfies the production boot check, but then a US reviewer gets nothing.)
- **Send yourself a real code on a real US handset.** Not the simulator, not the log transport.
- Validate the Oracle SMS path on Somali hardware for your actual customers — see
  [`LIVE_SMS_SETUP.md`](LIVE_SMS_SETUP.md) and `oracle/Instructions.md`.
- Fill in the reviewer notes under **App access** in the Console, including a test number and
  how the reviewer gets its code. Template is in [`PLAY_LISTING.md`](PLAY_LISTING.md) §7.

## 4. Build and sign the release

Full detail in [`mobile/README.md`](../mobile/README.md) → *Releasing to Play*. In short:

```bash
cd mobile && source env.sh
# One time: create the keystore, then android/app/keystore.properties
GM_API_BASE=https://your-domain.example npm run build   # HTTPS only
cd android && ./gradlew bundleRelease
# -> app/build/outputs/bundle/release/app-release.aab
```

- **Bump `versionCode`** in `android/app/build.gradle` for every upload; Play rejects
  duplicates. Keep `versionName` in step with the repo tag (see `CHANGELOG.md`).
- **Back the keystore up somewhere that is not the build laptop.** Lose it and you can never
  update this listing again.
- `applicationId` is `so.gurikaabe.app` and is **permanent** — changing it creates a different
  app and orphans every installed user.

## 5. Fill in the Console

All the answers are pre-drafted in [`PLAY_LISTING.md`](PLAY_LISTING.md): store listing text,
Data Safety table, permissions declarations, content rating, and the graphics you still have to
produce (feature graphic and screenshots).

Two rules worth repeating:

- **Data Safety must match `PRIVACY.md` and the actual code.** A mismatch is grounds for
  removal, and it does get checked.
- **Screenshots come from `npm run seed` data only.** Real ones would publish a customer's
  phone number and home landmark in a public store listing.

## 6. Closed test, then production

Upload the AAB to a **closed testing** track, recruit your 12+ testers, and leave it running
for 14 continuous days. Then apply for production access and submit.

Ship the final pre-flight list in [`PLAY_LISTING.md`](PLAY_LISTING.md) §8 before you upload.

---

## The Oracle never goes on Play

Worth stating plainly, because it looks like a missing feature: the Oracle phone's software is
**not** part of this app and must never be. Reading SMS requires `READ_SMS`, which Play
restricts to apps that are the user's default SMS handler — which GuriKaabe is not and should
not be. The Oracle is side-loaded Termux on a dedicated handset you control (`oracle/Instructions.md`).
That separation is the only reviewable architecture, not a workaround.
