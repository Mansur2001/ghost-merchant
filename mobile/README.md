# GuriKaabe — Android app

A Capacitor shell around the three GuriKaabe PWAs. The web apps stay the single source
of truth: `build-www.mjs` copies `frontend/` into `www/` rather than forking it, so a fix to
the customer flow ships to web and Android from the same file.

| | |
|---|---|
| App name | **GuriKaabe** |
| Application ID | `so.gurikaabe.app` — permanent; changing it means a new Play listing |
| Version | `versionName 0.1.0`, `versionCode 1` |
| Min / target SDK | 22 (Android 5.1) / 35 |

`minSdk 22` is deliberate: the target market runs old, cheap handsets, and every version you
drop is customers you can't serve.

---

## One-time setup

```bash
cd mobile
npm install
source env.sh          # sets ANDROID_HOME and picks a JDK Gradle can run on
```

**About the JDK.** Capacitor 6 pins Gradle 8.2, which cannot run on Java 20+ — it fails with
`Unsupported class file major version 67`, an error that looks nothing like "wrong Java
version". This machine's default `java` is 23. `env.sh` finds a compatible JDK (17–19), and
Android Studio uses its own bundled runtime, so the IDE is unaffected.

Watch out: `/usr/libexec/java_home -v 17` on macOS means "17 **or newer**" and will happily
hand back Java 23. `env.sh` asks each candidate what it actually is.

---

## Testing on your own phone

The phone needs to reach the backend on your laptop. It can't use `https://localhost`
(that's the phone), and it won't accept Caddy's self-signed certificate — so debug builds
talk to a **dev-only plain-HTTP listener on port 8080** over your LAN.

```bash
# 1. Backend up, demo data loaded.
cd .. && docker compose up -d --build && docker compose exec backend npm run seed

# 2. Find your LAN IP (the one your phone can see).
ipconfig getifaddr en0

# 3. Build the app against it.
cd mobile
GM_API_BASE=http://<your-lan-ip>:8080 npm run sync

# 4. Plug the phone in (USB debugging on), then:
source env.sh
adb devices                       # confirm it's listed
npm run run:device                # or: cd android && ./gradlew installDebug
```

Sanity check from the phone's browser first: open `http://<your-lan-ip>:8080` — if the PWA
doesn't load there, the app won't work either, and it's a network problem (firewall, or the
laptop and phone on different networks), not an app problem.

### What's safe about the cleartext path
- `build-www.mjs` **refuses** to build cleartext against a non-private address.
- `configure-android.mjs` generates a network-security config that denies cleartext globally
  and permits it for **that one private host**. A production build regenerates the file with
  no exceptions — there's no flag to forget.
- The WebView's own scheme follows the backend's (`http` for a cleartext dev backend), because
  an `https://localhost` page cannot call `http://192.168.x.x`. `http://localhost` is still a
  *secure context*, so geolocation, `crypto.randomUUID` and the camera keep working.

**Delete the `:8080` block from the Caddyfile and its port mapping before deploying to a
public VPS.** On a public IP it would serve customer addresses and session tokens in the clear.

---

## Testing the whole product on one handset

All three roles are in the one app — the landing page is the role picker.

| Role | How to sign in | Seeded credentials |
|---|---|---|
| Customer | phone + SMS code | any number; in dev the code is shown on screen |
| Driver | phone + PIN | `619876543` / `1234` (Amina), `651112223` / `5678` (Bashir) |
| Operator | username + password | `admin` / `change-me-please-1` (admin), `hodan` / `seeded-operator-pw-1` |

New drivers and operators are added by an admin in the dashboard. They get a setup code by
text and choose their own PIN or password under **Set up account**.

**US numbers work for login and everything else**, so you can test on your own handset: tap
the **🇺🇸 +1** switch in front of the phone field, then type the number any way you like. A `+1` number **cannot pay by USSD** —
EVC Plus is a Somali telecom rail with no NANP equivalent — so the app shows an explanation
instead of a dead pay button, and the operator's "Mark as paid" is the path. That's the
honest behaviour, not a limitation to work around.

With the switch on 🇸🇴 +252, a 10-digit number is refused with a hint to tap +1. It isn't
guessed, because a Somali customer typing one digit too many (`6123456789`) would otherwise
become a valid US number.

### A full end-to-end pass
1. **Customer:** landing → *I'm a customer* → enter your number → code appears on screen →
   verify → describe an order, set location, add a landmark, attach a photo → create.
2. **Operator** (same app, or `https://localhost/operator/` on the laptop): the order appears
   → *Confirm payment* → assign a driver.
3. **Driver:** sign in as Amina → the order is in the queue → *Items secured* → capture a
   delivery-proof photo → *Mark delivered*.
4. Watch the customer screen update live at each step — that's the WebSocket layer.

The customer can tap **I've paid** (with any transaction number) before step 2. The order
then jumps to the top of the operator's list with the number pre-filled, and **Confirm payment**
in the operator app is step 2.

---

## Releasing to Play

This section covers **building and signing**. For the whole path to a published listing — account
setup, the 14-day closed test, Console answers, and the pre-submission checks — follow
[`../docs/PLAY_RELEASE.md`](../docs/PLAY_RELEASE.md).

### 1. Create your signing keystore — once, and never lose it
Play identifies an app by its signing key. **Lose it and you can never update this app
again**; leak it and someone else can publish to your users.

```bash
source env.sh
keytool -genkeypair -v \
  -keystore ~/gurikaabe-release.jks \
  -alias gurikaabe -keyalg RSA -keysize 2048 -validity 10000
```

Then create `mobile/android/app/keystore.properties` (git-ignored):
```properties
storeFile=/Users/you/gurikaabe-release.jks
storePassword=...
keyAlias=gurikaabe
keyPassword=...
```

Back the `.jks` up somewhere that isn't this laptop. Enrolling in **Play App Signing** (the
default for new apps) means Google holds the distribution key and this one becomes your
upload key — still important, but recoverable if lost.

A release build without this file fails immediately with an explanation, rather than
producing an unsigned artifact Play rejects on upload.

### 2. Build the release bundle
```bash
GM_API_BASE=https://your-domain.example npm run build   # HTTPS — required
cd android && ./gradlew bundleRelease
# -> app/build/outputs/bundle/release/app-release.aab
```

Bump `versionCode` in `android/app/build.gradle` for **every** upload — Play rejects a
duplicate.

### 3. Before you submit
- [ ] Backend deployed on a real domain with a valid certificate (see the root `README.md`)
- [ ] `OTP_TRANSPORT=clicksend` with a real code received on a handset
      (`../docs/LIVE_SMS_SETUP.md`). The backend refuses to boot in production on the dev
      transport, which prints login codes into the server log.
- [ ] `REVIEW_PHONE` / `REVIEW_CODE` set for the Play reviewer (`../docs/PLAY_RELEASE.md` §3)
- [ ] `NODE_ENV=production`, `CORS_ORIGINS` includes your domain **and** `https://localhost`
      (the app's own WebView origin)
- [ ] Deployed with `docker-compose.prod.yml` (no dev `:8080` listener)
- [ ] Privacy policy published at a public URL (see `../docs/PRIVACY.md`)
- [ ] Data Safety form filled in (see `../docs/PLAY_LISTING.md`)

---

## Files

| Path | Purpose |
|---|---|
| `build-www.mjs` | assembles `www/` from `frontend/`, injects `GM_API_BASE` |
| `configure-android.mjs` | generates the network-security config + WebView scheme from that URL |
| `make-icons.sh` | resizes the icon masters in `resources/` (cut from the brand sheet by `../scripts/brandsheet-icons.py`) into launcher icons |
| `env.sh` | sets `ANDROID_HOME`, picks a Gradle-compatible JDK |
| `android/` | the native project — **committed**, because it carries hand-edited config |
| `www/` | generated; git-ignored |

## Permissions, and why each one

| Permission | Why | When it's asked |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | talk to the backend; distinguish "offline" from "server down" | never prompts |
| `ACCESS_FINE_LOCATION` / `COARSE` | the delivery point | at checkout, on *Set my delivery location* |
| `CAMERA` | reference photo, delivery proof | when attaching a photo |

No **background** location: it's the most scrutinised permission on Play, needs a separate
declaration and video review, and this app has no use for it. No `CALL_PHONE`: the USSD
bridge opens the dialer with the code pre-filled (`ACTION_DIAL`) and the user presses call —
`CALL_PHONE` is restricted on Play and we don't need it.

## Known toolchain notes
- AGP 8.2.1 warns that it doesn't officially support `compileSdk 35`. Builds work. Upgrading
  AGP (and the Gradle wrapper with it) is the clean fix and would also let R8 run.
- R8 minification is **off**: this is a thin WebView shell, so shrinking the Java side saves
  almost nothing, R8 fails outright under AGP 8.2 + compileSdk 35, and over-aggressive
  shrinking causes release-only crashes that never appear in debug.
