# Real SMS and email: login codes and staff setup codes

Every code GuriKaabe sends goes through **Twilio**:
- customer login codes by **SMS**, for `+252` and `+1` numbers alike;
- customer login codes by **email** (Twilio SendGrid), for customers who added and confirmed one;
- the one-time setup codes new drivers and operators receive, by text or, if the admin gave an
  email, by email.

Twilio is pay-as-you-go. **You create the accounts and paste in the credentials yourself.** A key
that can send messages billed to you should never pass through anyone else.

---

## Why a provider, when the rule is "no vendors"

CLAUDE.md says to reject dependencies that add a monthly cost or a vendor relationship.
Twilio is the deliberate, bounded exception:

- **It's outside the money path.** It carries a login code, never a payment, so invariant 6 is
  untouched.
- **The alternative was hardware in another country.** Sending from a phone's own SIM would
  make every login depend on a handset staying charged and online, and on a subscriber SIM not
  being rate-limited for sending near-identical texts.
- **No SDK.** One HTTPS call per message, so there is no extra dependency in the image.

---

## Setup: SMS

### 1. Twilio account and a 10DLC sender
In the Twilio Console, put your US number in a **Messaging Service** and attach it to your
approved **10DLC campaign**. US carriers filter texts from unregistered senders: until the
campaign is approved, US texts may be late or dropped. `+252` delivery doesn't depend on 10DLC.

### 2. Allow Somalia
Console → Messaging → Settings → **Geo permissions** → enable **Somalia**. Without it every
`+252` code fails with error 21408.

### 3. Copy the values into `.env`
```bash
TWILIO_ACCOUNT_SID=AC...             # Console home → Account Info
TWILIO_AUTH_TOKEN=...                # Console home → Account Info
TWILIO_MESSAGING_SERVICE_SID=MG...   # Messaging → Services → your 10DLC service
# TWILIO_FROM=+1XXXXXXXXXX           # only if you have no Messaging Service
```
`TWILIO_AUTH_TOKEN` can send messages billed to you. It belongs in `.env` (git-ignored) and
nowhere else: not in a screenshot, a commit, or a demo video.

## Setup: email (optional)

Blank = the app simply doesn't offer email, and everyone uses SMS.

1. In SendGrid: **Settings → Sender Authentication**, verify the address you'll send from
   (or authenticate your domain).
2. **Settings → API Keys** → create a key with **Mail Send** permission. It's the same kind of
   key SendGrid's SMTP relay uses; the app talks to SendGrid's HTTPS API with it.
3. `.env`:
```bash
SENDGRID_API_KEY=SG....
EMAIL_FROM=codes@yourdomain.com      # the verified sender
```

## Prove it works before touching the app
```bash
node scripts/sms-preflight.mjs                          # credentials, balance, service; sends nothing
node scripts/sms-preflight.mjs --send +12066876538      # one real text to your handset
node scripts/sms-preflight.mjs --email you@example.com  # one real email
```
When a code doesn't arrive, the cause could be bad credentials, no balance, a sender carriers
filter, a country not enabled, or the app never reaching Twilio at all. The preflight tells
these apart and explains Twilio's error codes.

## Choose the transport and restart
```bash
# .env
OTP_TRANSPORT=twilio      # production: every number, no fallback
# OTP_TRANSPORT=auto      # dev: same, but shows the code on screen when keys are missing
```
```bash
docker compose up -d --no-deps --force-recreate backend   # reloads .env
```

A transport named explicitly never falls back to showing the code on screen. With `twilio`,
either the message is sent, or the request fails and the backend log says why.

---

## How email sign-in stays safe

A customer is still their phone number. Email only receives a code for an email the customer
**confirmed while signed in** (the session proves the phone; a code proves the email). Asking
for "Email me a code" answers the same whether or not that number has an email, so it can't be
used to look people up.

---

## Development safety: the allowlists

Outside production, real texts go **only** to numbers on `DEV_SMS_ALLOWLIST`, and real email
only to addresses on `DEV_EMAIL_ALLOWLIST` (comma-separated). Everything else gets the code on
screen instead. Production ignores both.

This matters because the seed data's customer and driver numbers are valid Somali numbers that
may belong to real people. With live keys, a dev login as "612345678" would text a stranger.

```bash
DEV_SMS_ALLOWLIST=+12066876538
DEV_EMAIL_ALLOWLIST=you@example.com
```

The verification suites force `OTP_TRANSPORT=log` for their own stack
(`scripts/verify/run-all.sh`), so running them never spends credit.

---

## When it doesn't work

| What you see | What it means |
|---|---|
| `twilio send failed: HTTP 401` | Wrong Account SID / Auth Token pair. |
| `twilio send failed: 21408: …` | The destination country isn't enabled: Geo permissions. |
| `twilio send failed: 21211: …` | The number isn't valid: check the country code. |
| `twilio send failed: 21610: …` | That number replied STOP. It must text START to your number first. |
| `twilio send failed: 21606: …` | `TWILIO_FROM` isn't an SMS-capable number on this account. |
| Accepted, but nothing arrives on a US phone | The sender isn't on an approved 10DLC campaign yet (Console → Monitor → Logs shows 30034). |
| `transport "twilio" is not configured` | Keys are missing. In dev with `auto`, the code shows on screen instead. |
| `sendgrid send failed: … verified Sender Identity` | `EMAIL_FROM` isn't verified in SendGrid. |
| `sendgrid send failed: HTTP 401/403` | The API key is wrong or lacks Mail Send. |
| `not on DEV_SMS_ALLOWLIST` / `DEV_EMAIL_ALLOWLIST` in the dev log | Working as intended. |
| `FATAL: OTP_TRANSPORT must be twilio, auto or log` | An old value such as `clicksend` is still in `.env`. |

---

## Before you ship

- [ ] `OTP_TRANSPORT=twilio` and `NODE_ENV=production`. The backend refuses to boot on the
      `log` transport in production.
- [ ] 10DLC campaign approved, and its Messaging Service set as `TWILIO_MESSAGING_SERVICE_SID`.
- [ ] Somalia enabled in Geo permissions.
- [ ] A real code received from the deployed server on a US handset **and** on a Somali handset,
      and one by email.
- [ ] Balance topped up, with a low-balance alert set in Twilio.
- [ ] Rate limits left as they are. The per-phone and per-IP limits plus the 60-second resend
      cooldown are what stand between an SMS-bomb and your bill.

## Phone numbers: the country switch

Every phone field has a **Somalia +252 / US +1** switch, with each country's flag. The switch
decides the country, and within that country people type the number any way they like:
- Somalia: `61 234 5678`, `0612345678`, `252612345678`
- US: `206 687 6538`, `(206) 687-6538`, `1 206 687 6538`

A number typed with `+` carries its own country code and flips the switch to match.

The server never guesses. A number without a country code is Somali, and the app always sends
the full international number. This matters because the guess is where the damage would be:
a Somali number with one digit too many (`6123456789`) is also a valid US number. Read as US,
it would create an account under an identity that isn't theirs, whose payments could never
match.
