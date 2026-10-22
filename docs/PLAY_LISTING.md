# GuriKaabe — Play Console submission pack

Everything the Play Console asks for, with the answers pre-drafted. Anything in `[BRACKETS]`
is yours to fill in. **The Data Safety answers must match `PRIVACY.md` and the actual code** —
a mismatch is grounds for removal, and it's the kind of thing that gets checked.

---

## 1. Before you can submit

| | |
|---|---|
| Play Console account | one-off $25 registration |
| Identity verification | required for all developers; personal accounts also need a **D-U-N-S**-free individual verification. Start this early — it can take days |
| Closed testing requirement | **personal (non-organisation) accounts must run a closed test with at least 12 testers opted in for 14 continuous days before applying for production access.** Plan the soft launch around this — it is the single most common surprise |
| Privacy policy URL | `https://<your domain>/privacy.html`, built from `PRIVACY.md` by `scripts/build-privacy.mjs` |
| Backend | live on a real domain with a valid certificate |

---

## 2. Store listing

**App name (30 chars max)**
```
GuriKaabe
```

**Short description (80 chars max)**
```
Order from the market and pay from your own phone. Delivery you can follow live.
```
*(80 characters, the limit)*

**Full description (4000 chars max)** — one line per paragraph, so it pastes cleanly
```
GuriKaabe brings the market to your door.

Tell us what you need in your own words, add the landmark nearest to you, and a driver collects it and brings it to you. You follow every step live — paid, dispatched, on the way, delivered.

PAY FROM YOUR OWN PHONE
Payment goes directly from your phone to the merchant using your mobile money. Tap to pay and your dialer opens with the code already filled in. We never hold your money and we never ask for card or bank details.

BUILT FOR HOW ADDRESSES REALLY WORK
Street addresses are unreliable where we operate, so GuriKaabe is built around landmarks. Describe the nearest landmark — the green house next to the yellow pharmacy — and optionally share your location to help the driver find you faster.

SEE WHAT YOU ORDERED
Attach a photo of what you need so the driver picks the right thing. When it arrives, the driver adds a delivery photo, so there is never a dispute about what turned up.

TALK TO YOUR DRIVER
Every order has its own chat thread. Ask a question, adjust an item, tell the driver where to turn — all inside the app.

LIGHT ON DATA
The app is a small download, made to work on older phones and slow connections.

SOMALI OR ENGLISH
Switch between Af-Soomaali and English with one tap.

WHAT YOU NEED
A phone number or an email. We send you a code to sign in, so there is no password to remember. No bank account and no social media login.
```

**Category:** Shopping (alternative: Food & Drink)
**Tags:** delivery, shopping, groceries
**Contact email:** `gurikaabe@gmail.com` · **Website:** `https://app.gurikaabe.com` · **Privacy policy:** `https://app.gurikaabe.com/privacy.html`

---

## 3. Graphics you still need

All generated from staging seed data by `./scripts/staging.sh shots` into `play-screenshots/`
(git-ignored; re-run after a UI change).

| Console field | File(s) | Spec met |
|---|---|---|
| App icon | `app-icon-512.png` | 512×512 PNG, under 1 MB |
| Feature graphic | `feature-graphic-1024x500.png` | 1024×500 PNG |
| Phone screenshots | `phone/01…08.png` | 8 × 1080×1920 (9:16) — enough for promotion (4+ at ≥1080 px) |
| 7-inch tablet screenshots | `tablet-7in/01…08.png` | 8 × 1206×2144 (9:16) |
| 10-inch tablet screenshots | `tablet-10in/01…08.png` | 8 × 1620×2880 (9:16), each side ≥1080 |
| Desktop screenshots | — | optional; skip (no PC/Chromebook build) |
| Video | — | optional; skip |

The eight screens, in upload order: home, order form, pay with mobile money, live tracking,
chat, delivered with proof photo, sign-in (Phone | Email), and the Somali home screen.

> **Use seeded data only.** Real screenshots would put a real customer's phone number and home
> landmark in a public store listing.

---

## 4. Data Safety form — the answers

**Does your app collect or share any of the required user data types?** → **Yes**

| Data type | Collected | Shared | Purpose | Required? |
|---|---|---|---|---|
| **Phone number** | Yes | No | App functionality, Account management | Required |
| **Approximate location** | Yes | No | App functionality | Optional |
| **Precise location** | Yes | No | App functionality | Optional |
| **Photos** | Yes | No | App functionality | Optional |
| **Other in-app messages** | Yes | No | App functionality | Optional |
| **Purchase history** (order contents/amounts) | Yes | No | App functionality | Required |

**Email address** (Personal info → Email address): collected, **optional**, purpose App
functionality / Account management — only if a customer signs in with one or adds one for sign-in codes, or an admin
enters one for a staff setup code. Not shared.

**Not collected:** name, address book, financial/payment info, health, browsing
history, app activity, device IDs, advertising ID, crash logs, diagnostics.

**Staff only:** drivers and operators also give a **name** (Personal info → Name). Customers
never do.

**Shared? No, for every type.** Twilio delivers login codes (SMS, and email through SendGrid),
so it receives the phone number or email and the message text. Google's definition doesn't
count a service provider processing data on your behalf as "sharing". `PRIVACY.md` still names
Twilio, because the policy must be accurate even where the form doesn't ask.

**Payment info deserves a note:** the answer is genuinely *not collected*. Money moves phone
to phone over the telecom's own rails. The app records only that the payment arrived (amount,
and the transaction number if the customer or operator enters one), once an operator confirms it.
The app does **not** request `READ_SMS` or any SMS permission.

**Security practices**
- Data encrypted in transit: **Yes** (HTTPS/TLS)
- Users can request deletion: **Yes** — via the contact email in the privacy policy
- Committed to Play Families Policy: **No** (not a children's app)
- Independent security review: **No**

---

## 5. Permissions declarations

| Permission | Play declaration needed | Justification |
|---|---|---|
| `ACCESS_FINE_LOCATION` | Prominent disclosure in-app | Capturing the delivery point at checkout. Foreground only, requested at the moment of use. |
| `CAMERA` | — | Reference photo at checkout; delivery-proof photo. |
| `INTERNET`, `ACCESS_NETWORK_STATE` | — | Core functionality. |

**No background location**, so no background-location declaration or video review.
**No `CALL_PHONE`**, so no Call Log/Phone permissions declaration — the USSD bridge uses
`ACTION_DIAL` and the user presses call themselves.

### Prominent disclosure (must appear before the location prompt)
> GuriKaabe collects your location to set your delivery point so a driver can find you. Your
> location is used only for the order you are placing and is never collected in the
> background or when the app is closed.

---

## 6. Content rating questionnaire

Answer **No** to: violence, sexual content, profanity, controlled substances, gambling,
user-generated content shared publicly.

⚠️ **In-app chat:** the questionnaire asks whether users can interact or share content. The
honest answer is **yes — but privately**, between a customer and the driver/operator on their
own order only. There is no public feed, no user-to-user discovery, and no way to message a
stranger. Say so in the free-text box. Expect **PEGI 3 / Everyone**.

---

## 7. The one thing that will get this rejected

Google reviews the app against what you declared. The realistic risks here:

1. **The reviewer can't sign in.** The app's whole entry point is an SMS code, and reviewers
   don't receive texts at your numbers. Set `REVIEW_PHONE` / `REVIEW_CODE` on the server
   (`PLAY_RELEASE.md` §3) and give both in the notes below. **This is the top risk.**
2. **Backend down or unreachable during review** — same outcome. Review can happen days after
   submission; the server has to stay up.
3. **Location without prominent disclosure** — use the wording above.
4. **Privacy policy that doesn't match the Data Safety form** — fill in `PRIVACY.md` properly.

**Reviewer notes — put this in the Console's "App access" section:**
```
GuriKaabe requires a phone number and an SMS code to sign in. For review, please use:
  1. Tap "I'm a customer".
  2. Keep "Phone" selected, tap the 🇺🇸 +1 switch, then enter: [REVIEW_PHONE without +1]
  3. Tap "Text me a code", then enter: [REVIEW_CODE]
No text message is sent to this number; the code above always works for it.
Language: the SO / EN button in the top bar switches between Somali and English.

The app coordinates deliveries in Somalia. Payment is peer-to-peer over the customer's own
mobile-money account (EVC Plus, eDahab, Zaad or Sahal) using the phone's dialer — the app never processes
or holds money. Customer, driver and operator sign-in are all reachable from the home screen.
```

---

## 8. Release checklist

- [ ] Backend on a real domain, valid certificate, `NODE_ENV=production`
- [ ] `OTP_TRANSPORT=twilio`; a real code received on a US **and** a Somali handset, and by email
- [ ] `REVIEW_PHONE` / `REVIEW_CODE` set; review login tested with the +1 switch
- [ ] Deployed with `docker-compose.prod.yml` (no `:8080` listener, no published DB port)
- [ ] `CORS_ORIGINS` = your domain + `https://localhost`
- [ ] Database backups running (`pg_dump`, off the box)
- [ ] `GM_API_BASE=https://your-domain npm run build` — **never** an http:// base
- [ ] `versionCode` bumped
- [ ] Signed AAB from `./gradlew bundleRelease`
- [ ] Keystore backed up somewhere that is not the build laptop
- [ ] Privacy policy placeholders filled, `node scripts/build-privacy.mjs` run, page live
- [ ] Data Safety form matches this document
- [ ] Closed test: 12+ testers, 14 continuous days (personal accounts)
