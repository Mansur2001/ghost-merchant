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
- Publish the privacy policy at a public URL. Fill in the placeholders in
  [`PRIVACY.md`](PRIVACY.md), then run `node scripts/build-privacy.mjs`. It writes
  `frontend/user/privacy.html`, which is served at `https://<your domain>/privacy.html`. The
  script refuses to build while placeholders remain.

## 2. Get the backend production-ready

The app is a thin shell over the PWAs — a reviewer opening it is hitting your live server. If
the backend is down or unreachable during review, the app is rejected as broken.

Follow *Deploying to a VPS* in the root [`README.md`](../README.md). It runs the stack with
`docker-compose.prod.yml`, which uses `Caddyfile.prod`: your domain, a real certificate and
HSTS, with no dev listener on port 8080 and no published database port. Then confirm:

- `DOMAIN` is set, `NODE_ENV=production`, and the certificate is valid.
- `CORS_ORIGINS` includes your domain **and** `https://localhost`, the WebView's own origin.
- The backend booted. It refuses to start while any of the dev seed's public passwords still
  works, so never copy a dev database to the server.
- Database backups are running, and stored off the server.

## 3. Make sure a reviewer can actually sign in

**This is the top rejection risk for this app.** The only way in is a phone number plus a
login code. A reviewer who never receives one can't get past the first screen.

Reviewers don't receive texts at a number you control, so give them a **review login**: one
fixed number whose code is fixed, with no SMS sent.

```bash
# .env on the server
REVIEW_PHONE=+1XXXXXXXXXX   # a number nobody else will register: it's a real customer account
REVIEW_CODE=XXXXXXXX        # exactly 6 digits, not 123456
```
The backend refuses to boot if only one of the two is set, or if the code isn't 6 digits. The
review login still goes through every normal limit: resend cooldown, attempt cap, rate limits,
single use. It can only ever reach that one account's own orders.

Before submitting:

- Set up Twilio for real customers ([`LIVE_SMS_SETUP.md`](LIVE_SMS_SETUP.md)), with
  `OTP_TRANSPORT=twilio` and the **10DLC-registered Messaging Service** for US numbers.
- **Send yourself a real code on a real handset**, from the deployed server. Not the log
  transport.
- Sign in with the review number yourself, using the switch on 🇺🇸 +1 and the review code.
- Fill in the reviewer notes under **App access** in the Console: the review number, its
  code, and that the switch must be on +1. The template is in
  [`PLAY_LISTING.md`](PLAY_LISTING.md) §7.

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
