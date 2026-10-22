# 2026-10-21 — Launch prep: production, Twilio, email sign-in, Play assets

A long working session taking GuriKaabe from local-only to running in production and ready for
a Play Store submission. Commits `8ee89be` … `28727cd` on `main`.

> Public repo: this file holds decisions and state only — no secrets, passwords or customer data.

## What was built

| Commit | Change |
|---|---|
| `8ee89be` | **Wallet picker.** One USSD button per wallet (EVC Plus, eDahab, Zaad, Sahal), each from `<WALLET>_MERCHANT` / `<WALLET>_USSD`. No built-in codes or numbers; half-set or malformed refuses to boot. Customer's own network listed first. `orders.payment_claim_wallet` records which one they used. |
| `1cda820` | Operator login says when the server is unreachable instead of doing nothing. |
| `f188884`, `61e082b` | **Terms of Service** and the SMS consent line at sign-in (10DLC needs it). Privacy and Terms published at `/privacy.html`, `/terms.html`. Contact: gurikaabe@gmail.com. |
| `abfc8a0` | **ClickSend → Twilio** for SMS, **SendGrid** for email codes. `OTP_TRANSPORT` = `twilio` / `auto` / `log`. Email is a second place to get a code, never an identity. Phone flags drawn as SVG. |
| `52a7c32` | **Local staging** (`scripts/staging.sh`, `https://localhost:8444`) and **Playwright** workflows (`e2e/`). The lifecycle test found an operator-dashboard bug: a live redraw wiped a picked driver and a half-typed transaction number. Fixed. `COMMANDS.md` added. |
| `5f54b75` | **Sign in by typing your email.** The Email option used to only relabel the button. Now the Phone/Email switch swaps the box. `users.email` UNIQUE; the cooldown is keyed by the email so it can't reveal who owns an address. **Play graphics** via `staging.sh shots`. Listing text updated. |
| `3b175c9` | **Photo bug:** a re-upload in another format (PNG after JPEG) left two photos. Now replaced. |
| `2a8b91a` | `COMMANDS.md` cut to a short cheat sheet. |
| `dd1ca45`, `28727cd` | **Logo in every header** instead of the grey dot. **Reportable errors:** every error has a `ref`; known failures name a safe cause (`DB-P1001`, `SMS-21408`); apps show "reason … tell us: 503 · DB-P1001 · ref 1a2b3c4d" in EN/SO. |

## Decisions (and why)

- **Hosting: Vultr, Frankfurt, one 4 GB VPS.** DigitalOcean locked the account; Hetzner was ruled out over EUR billing; Cloudflare can't host the stack.
- **`app.gurikaabe.com` stays DNS-only (grey cloud).** The Cloudflare proxy would hide client IPs and break per-IP rate limiting (`TRUST_PROXY_HOPS=1`).
- **Twilio for all SMS, SendGrid for email.** It's the one vendor exception; it carries a code, never money.
- **No fake payment data in production.** A wallet appears only once its real merchant number and verified dial code are set.
- **Sessions: customer 30 days, staff 12 h.** 12 h for customers was considered. Rejected: every re-login costs a real SMS.
- **The server-status dot was tried, then dropped** in favour of the logo (owner's call).
- **Error messages show cause and ref, never internals.** Without a stack, query or host, the ref is what links a user's report to the log line.
- **Play:** internal testing track first. A personal account then needs a closed test with 12+ testers for 14 days before production.

## State at end of session

- Production is up at `https://app.gurikaabe.com`. Health is 200 and admin login works.
- **Commits from `52a7c32` onward are pushed but not deployed.** Deploy with the backup line, then the deploy line in `COMMANDS.md`. Migration `20261021150000_users_email_unique` runs on boot.
- Unit tests: 370. Browser tests (staging): 16.
- Play assets are in `play-screenshots/` (git-ignored; regenerate with `staging.sh shots`):
  - icon 512, feature graphic 1024×500
  - 8 phone screenshots, 8 at 7", 8 at 10"
- Listing text and the Data Safety answers are in `docs/PLAY_LISTING.md`.

## Open threads

1. **Twilio values are in the wrong `.env` slots on the server.**
   - `TWILIO_MESSAGING_SERVICE_SID` holds an API-key SID (`SK…`), not an `MG…`.
   - `TWILIO_FROM` holds the Account SID.
   - Fix: create the Messaging Service and add the number to it. Set the `MG…` SID, and the `+1` number or blank in `TWILIO_FROM`.
   - Enable Somalia in Geo permissions.
   - Then run `sms-preflight.mjs --send … --email …` and recreate the backend.
2. **10DLC registration:** brand OPENARMS ALLIANCE LLC (EIN), use case 2FA, website plus privacy and terms links. Waiting on verification.
3. **Wallets:** real merchant numbers and verified USSD codes are needed for each wallet. EVC `*712*` is not yet validated on a Somali network.
4. **Play review login:** `REVIEW_PHONE` / `REVIEW_CODE` are not set on the server yet.
5. **Not validated yet:** `+252` SMS delivery and `tel:` dialing with `%23` on real Somali handsets.
6. **Ops:** a nightly `pg_dump` cron with an off-box copy, and the root/www → app redirect in Cloudflare.
7. **Known gap:** order and chat routes answer 400 with `err.message` on infrastructure failures, so they skip `describeFailure` (see CLAUDE.md *Known gaps*).
8. Android: rebuild and bump `versionCode` to ship the frontend changes in the app.
