# Turning on real SMS login codes

Right now a login code is printed to the server log (`OTP_TRANSPORT` falls back to `log` in
development). To sign in on your own US handset you need a real message, which means a
provider. **You have to create the account and paste in the credentials yourself** — I can't
sign up on your behalf, and you shouldn't want me handling a token that can send messages
billed to you.

Fifteen minutes, most of it waiting for a verification text.

---

## Why a provider at all, when the whole point is no vendors

CLAUDE.md says to reject dependencies that add a monthly cost or a vendor relationship, and
that still holds **for the Somali market**: `+252` numbers keep going through the Oracle
phone, which is a SIM you own and costs whatever the telecom charges for an SMS.

The exception is narrow and deliberate:

| Number | Channel | Why |
|---|---|---|
| `+252…` | Oracle phone | The real market. No vendor, no per-message platform fee. |
| everything else | Twilio | Your US test handset, and a Play reviewer who has to receive a code to get past the first screen. |

A Somali SIM sending internationally is slow, expensive, and often silently dropped — which
the person on the other end experiences as "the app is broken". And if Twilio is unconfigured
or its account lapses, **Somali logins are unaffected**. The business does not depend on it.

That routing is `OTP_TRANSPORT=auto`, which is already set in your `.env`.

### How the Somali half works without any provider

This is the part that sounds impossible, so it's worth being concrete. There is no Golis or
Hormuud integration, and there is no plan to get one — a commercial A2P agreement needs a
registered local company, a Somali bank account, and per-message pricing that only makes
sense at volume you don't have yet.

Instead the login code goes out from **your own SIM**, on the Oracle phone, as an ordinary
text. To the telecom it is a person sending a message.

```
customer taps "send me a code"
  → backend writes the code (hashed) and queues the message
  → Oracle phone asks "anything to send?"   POST /api/oracle/sms/pending
  → termux-sms-send  →  the customer's handset
  → phone reports back                      POST /api/oracle/sms/sent   → the plaintext row is deleted
```

**The phone asks; the backend never pushes.** That isn't a style choice — a phone can't accept
inbound connections. On mobile data it's behind carrier-grade NAT, on WiFi behind a router, so
there is no address to send to without a VPN or tunnel. Polling works from any network with
nothing configured, and the phone is already polling for incoming receipts anyway.

Signed with `ORACLE_WEBHOOK_SECRET`, the same key as the inbound webhook — an unsigned request
gets a 401, and so does an operator's token. Nobody reads codes in flight.

**Where this stops working.** A subscriber SIM sending hundreds of near-identical texts a day
looks like spam, and telecoms rate-limit or block it. At soft-launch volume — a few logins a
day — it looks like normal use and is fine. If GuriKaabe gets busy enough for that to break,
that is the point at which a commercial agreement becomes worth its cost, and the only thing
that changes is one transport module.

`GET /api/operator/sms-queue` shows the backlog. If `pending` is climbing, the phone has
stopped polling, and customers are experiencing that as "the app won't let me in".

---

## Setup

### 1. Create a Twilio account
<https://www.twilio.com/try-twilio> — free trial, no card required to start. Verify your own
mobile number when it asks; on a trial account **Twilio will only send to numbers you have
verified**, so this step is not optional.

### 2. Get a phone number
Console → **Phone Numbers → Manage → Buy a number**. Pick any US number with SMS enabled. The
trial credit covers it.

### 3. Copy three values into `.env`
From the Console dashboard:

```bash
TWILIO_ACCOUNT_SID=AC...        # "Account SID" on the dashboard
TWILIO_AUTH_TOKEN=...           # "Auth Token" — click to reveal
TWILIO_FROM=+1XXXXXXXXXX        # the number you just bought, E.164
```

`TWILIO_AUTH_TOKEN` can send messages billed to your account. It belongs in `.env` (git-ignored)
and nowhere else — not in a screenshot, not in a commit, not in a demo video.

### 4. Prove it works before touching the app
```bash
node scripts/sms-preflight.mjs                      # credentials only — sends nothing
node scripts/sms-preflight.mjs --send +12066876538  # a real text to your handset
```

"No code arrived" has five plausible causes — bad credentials, an unverified trial
destination, a from-number that can't send SMS, a malformed destination, or the app never
reaching the transport. Debugging that through the sign-in screen gives you one guess per
round trip. The preflight separates them, and translates Twilio's error codes.

### 5. Switch the transport on and restart
```bash
# .env
OTP_TRANSPORT=twilio
```
```bash
docker compose up -d --build backend   # --build: the image COPYs src/
```

**A transport you name explicitly never falls back to the dev log.** With `auto`, an
unconfigured Twilio quietly becomes `log` and the code comes back in the HTTP response — so
you would believe you were testing real delivery while testing nothing. Naming `twilio` means
you meant it: it sends, or it 502s and the backend log names the missing variable.

Running the verification suites does not require changing this back. Four of them read the
passcode out of the response, so `run-all.sh` forces `OTP_TRANSPORT=log` for its own stack
through a Compose override.

### 5. Sign in with your real number
Open the app, choose **I'm a customer**, and enter your number **with the country code**:
`+1 206 687 6538`. A bare 10-digit number is rejected on purpose — see the note at the bottom.

The code arrives by SMS. It is no longer shown on screen: the on-screen code only ever appears
with the `log` transport in development.

---

## When it doesn't work

| What you see | What it means |
|---|---|
| `twilio send failed: ... (code 21608)` | The destination number isn't verified on your trial account. Console → Phone Numbers → Verified Caller IDs. This is the most common first-run failure. |
| `twilio send failed: ... (code 21211)` | Twilio rejected the `To` number — check it's full E.164 (`+1206…`). |
| `twilio send failed: ... (code 21606)` | Your `TWILIO_FROM` can't send SMS, or isn't a number you own. |
| `transport "twilio" is not configured` | One of the three values is missing. In development this falls back to the log rather than blocking sign-in — check the backend logs for the code. |
| `HTTP 401` from Twilio | Wrong Account SID or Auth Token. |

The backend logs the provider's own error text and code rather than a generic failure,
because the API has already told us exactly what's wrong.

---

## Before you ship this

- [ ] `OTP_TRANSPORT=auto` (or `oracle` for a Somalia-only deployment)
- [ ] `NODE_ENV=production` — the backend **refuses to boot** on the `log` transport, so a
      production box cannot silently print login codes into its logs
- [ ] The Oracle SMS path validated on a real Somali SIM — the send loop is built and tested
      against the live stack (`scripts/verify/09-sms-delivery.sh`), but it has never run on a
      Somali network. Still the P4 blocker; Twilio does not solve it, it only covers `+1`.
- [ ] Twilio account upgraded off trial if you want to reach *unverified* numbers
- [ ] Cost sanity check: SMS is a few US cents each. A login costs one message; a customer
      logging in monthly is negligible, but an SMS-bomb against your endpoint would not be.
      The per-phone and per-IP rate limits plus the 60-second resend cooldown are what stand
      between you and that bill — don't loosen them.

## A note on the country code

`+1 206 687 6538` works. A bare `2066876538` is rejected, deliberately: without the `+1`, a
Somali customer typing one digit too many (`6123456789`) would become a valid US number and
create an account under an identity that isn't theirs, whose payments could never match. The
inconvenience is one plus sign; the alternative is a class of bug that only shows up in the
market this is actually for.
