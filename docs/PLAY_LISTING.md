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
| Privacy policy URL | `PRIVACY.md`, published publicly |
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
*(79 characters)*

**Full description (4000 chars max)**
```
GuriKaabe brings the market to your door.

Tell us what you need in your own words, add the landmark nearest to you, and a driver
collects it and brings it to you. You follow every step live — paid, dispatched, on the way,
delivered.

PAY FROM YOUR OWN PHONE
Payment goes directly from your phone to the merchant using EVC Plus or eDahab. Tap to pay
and your dialer opens with the code already filled in. We never hold your money and we never
ask for card or bank details.

BUILT FOR HOW ADDRESSES REALLY WORK
Street addresses are unreliable where we operate, so GuriKaabe is built around landmarks.
Describe the nearest landmark — the green house next to the yellow pharmacy — and optionally
share your location to help the driver find you faster.

SEE WHAT YOU ORDERED
Attach a photo of what you need so the driver picks the right thing. When it arrives, the
driver adds a delivery photo, so there is never a dispute about what turned up.

TALK TO YOUR DRIVER
Every order has its own chat thread. Ask a question, adjust an item, tell the driver where to
turn — all inside the app.

LIGHT ON DATA
The whole app is under 4 MB and designed to work on older phones and slow connections.

WHAT YOU NEED
A phone number. That is your account — we send you a code to confirm it. No bank account, no
email address, no social media login.
```

**Category:** Shopping (alternative: Food & Drink)
**Tags:** delivery, shopping, groceries
**Contact email:** `[YOUR EMAIL]` · **Website:** `[YOUR SITE]` · **Privacy policy:** `[URL]`

---

## 3. Graphics you still need

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG | ✅ `mobile/resources/play-store-icon-512.png` |
| Feature graphic | 1024×500 PNG/JPG | ❌ **you must make this** |
| Phone screenshots | 2–8, min 320px, 16:9 or 9:16 | ❌ capture on your device |
| Tablet screenshots | optional | — |

**Screenshots — capture these five**, from the seeded demo data only:
1. The landing/role picker
2. The order form with a landmark filled in
3. The order view with the live progress timeline
4. The chat thread
5. The delivered state with the proof photo

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

**Not collected:** name, email, address book, financial/payment info, health, browsing
history, app activity, device IDs, advertising ID, crash logs, diagnostics.

**Payment info deserves a note:** the answer is genuinely *not collected*. Money moves phone
to phone over the telecom's own rails; the app records only the confirmation reference the
telecom sends.

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

1. **Login codes reach nobody.** The app's whole entry point is an SMS code. If the Oracle SMS
   path isn't working on real hardware, a reviewer cannot get past the first screen and the
   app is rejected as broken. **This is the top risk — validate it before you submit.**
   Consider a documented test account for the reviewer.
2. **Backend down or unreachable during review** — same outcome. Review can happen days after
   submission; the server has to stay up.
3. **Location without prominent disclosure** — use the wording above.
4. **Privacy policy that doesn't match the Data Safety form** — fill in `PRIVACY.md` properly.

**Reviewer notes — put this in the Console's "App access" section:**
```
GuriKaabe requires a phone number and an SMS code to sign in. For review, please use:
  Phone: [A NUMBER YOU CONTROL]
  Code:  [DESCRIBE HOW THE REVIEWER OBTAINS IT]

The app coordinates deliveries in Somalia. Payment is peer-to-peer over the customer's own
mobile-money account (EVC Plus / eDahab) using the phone's dialer — the app never processes
or holds money. Customer, driver and operator sign-in are all reachable from the home screen.
```

---

## 8. Release checklist

- [ ] Backend on a real domain, valid certificate, `NODE_ENV=production`
- [ ] `OTP_TRANSPORT=oracle`, SMS send path validated **on real hardware**
- [ ] Dev `:8080` cleartext listener removed from the Caddyfile and docker-compose
- [ ] `CORS_ORIGINS` = your domain + `https://localhost`
- [ ] Database backups running (`pg_dump`, off the box)
- [ ] `GM_API_BASE=https://your-domain npm run build` — **never** an http:// base
- [ ] `versionCode` bumped
- [ ] Signed AAB from `./gradlew bundleRelease`
- [ ] Keystore backed up somewhere that is not the build laptop
- [ ] Privacy policy live at a public URL
- [ ] Data Safety form matches this document
- [ ] Closed test: 12+ testers, 14 continuous days (personal accounts)
