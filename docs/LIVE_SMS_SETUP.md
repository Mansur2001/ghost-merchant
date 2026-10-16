# Real SMS: login codes and staff setup codes

Every text GuriKaabe sends goes through **ClickSend**:
- customer login codes, for `+252` and `+1` numbers alike;
- the one-time setup codes new drivers and operators receive.

ClickSend is pay-as-you-go, with no monthly fee. **You create the account and paste in the
credentials yourself.** A key that can send messages billed to you should never pass through
anyone else.

---

## Why a provider, when the rule is "no vendors"

CLAUDE.md says to reject dependencies that add a monthly cost or a vendor relationship.
ClickSend is the deliberate, bounded exception:

- **It's outside the money path.** It carries a login code, never a payment, so invariant 6 is
  untouched.
- **The alternative was hardware in another country.** Sending from a phone's own SIM would
  make every login depend on a handset staying charged and online, and on a subscriber SIM not
  being rate-limited for sending near-identical texts.
- **No commitment.** Credit is prepaid, and nothing renews.

---

## Setup

### 1. Create a ClickSend account
Sign up at <https://dashboard.clicksend.com> and add a little credit. A few dollars covers
hundreds of codes.

### 2. Get a sender for US numbers: a TOLL-FREE number
US carriers filter texts from unregistered senders. Texts from a personal number or ClickSend's
shared pool may arrive late, or not at all.

**Buy a toll-free number in ClickSend and complete toll-free verification.** Until that's done,
your own number works for testing, but texts are slow. `+252` delivery doesn't depend on this.

### 3. Copy three values into `.env`
```bash
CLICKSEND_USERNAME=you@example.com   # the username you log in with
CLICKSEND_API_KEY=...                # Dashboard → Developers → API Credentials
CLICKSEND_FROM=+18XXXXXXXXX          # your toll-free number (blank = shared sender)
```
`CLICKSEND_API_KEY` can send messages billed to you. It belongs in `.env` (git-ignored) and
nowhere else: not in a screenshot, a commit, or a demo video.

### 4. Prove it works before touching the app
```bash
node scripts/sms-preflight.mjs                      # credentials + balance; sends nothing
node scripts/sms-preflight.mjs --send +12066876538  # one real text to your handset
```
When a code doesn't arrive, the cause could be bad credentials, no credit, a sender that
carriers filter, a malformed number, or the app never reaching ClickSend at all. The preflight
tells these apart and explains ClickSend's status codes.

### 5. Choose the transport and restart
```bash
# .env
OTP_TRANSPORT=clicksend      # production: every number, no fallback
# OTP_TRANSPORT=auto         # dev: same, but shows the code on screen when keys are missing
```
```bash
docker compose up -d --no-deps --force-recreate backend   # reloads .env
```

A transport named explicitly never falls back to showing the code on screen. With
`clicksend`, either the text is sent, or the request fails and the backend log says why.

---

## Development safety: `DEV_SMS_ALLOWLIST`

Outside production, real texts go **only** to the numbers on `DEV_SMS_ALLOWLIST`
(comma-separated). Every other number gets the code on screen instead. Production ignores the
allowlist.

This matters because the seed data's customer and driver numbers are valid Somali numbers that
may belong to real people. With live keys, a dev login as "612345678" would text a stranger.

```bash
DEV_SMS_ALLOWLIST=+12066876538
```

The verification suites force `OTP_TRANSPORT=log` for their own stack
(`scripts/verify/run-all.sh`), so running them never spends credit.

---

## When it doesn't work

| What you see | What it means |
|---|---|
| `clicksend send failed: UNAUTHORIZED` | Wrong username / API key pair. |
| `clicksend send failed: INSUFFICIENT_CREDIT` | Top up the account. |
| `clicksend send failed: INVALID_RECIPIENT` | The number isn't valid: check the country code. |
| `clicksend send failed: COUNTRY_NOT_ENABLED` | Enable the destination country in ClickSend's settings. |
| `clicksend send failed: INVALID_SENDER_ID` | `CLICKSEND_FROM` isn't a number you own or have verified. |
| Accepted, but nothing arrives on a US phone | An unregistered sender is being filtered. Use a verified toll-free number. |
| `transport "clicksend" is not configured` | The keys are missing. In dev with `auto`, the code shows on screen instead. |
| `not on DEV_SMS_ALLOWLIST` in the dev log | Working as intended: dev won't text that number. |

ClickSend answers HTTP 200 for a whole batch even when the one message inside it was refused.
The backend checks each message's own status, so a refused message is reported as a failure,
never as sent.

---

## Before you ship

- [ ] `OTP_TRANSPORT=clicksend` and `NODE_ENV=production`. The backend refuses to boot on the
      `log` transport in production.
- [ ] Toll-free number bought **and verified**, and set as `CLICKSEND_FROM`.
- [ ] A real code received from the deployed server on a US handset **and** on a Somali handset.
- [ ] Credit topped up, with a low-balance alert set in ClickSend.
- [ ] Rate limits left as they are. The per-phone and per-IP limits plus the 60-second resend
      cooldown are what stand between an SMS-bomb and your bill.

## Phone numbers: the country switch

Every phone field has a **🇸🇴 +252 / 🇺🇸 +1** switch. The switch decides the country, and
within that country people type the number any way they like:
- Somalia: `61 234 5678`, `0612345678`, `252612345678`
- US: `206 687 6538`, `(206) 687-6538`, `1 206 687 6538`

A number typed with `+` carries its own country code and flips the switch to match.

The server never guesses. A number without a country code is Somali, and the app always sends
the full international number. This matters because the guess is where the damage would be:
a Somali number with one digit too many (`6123456789`) is also a valid US number. Read as US,
it would create an account under an identity that isn't theirs, whose payments could never
match.
