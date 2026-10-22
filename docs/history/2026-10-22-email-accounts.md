# 2026-10-22: Email sign-in on its own; production server deleted

> Public repo: this file records decisions and state only. It contains no secrets, passwords or customer data.

## What happened

- **Email codes "not working" in production.** SendGrid was set up correctly: a direct send was accepted with HTTP 202. Production had no accounts, though, and at that point email sign-in only reached an account whose email had been confirmed while signed in by phone. Nothing was sent, by design. New customers had to start with SMS.
- **SMS to US numbers was blocked.** The app needs no Twilio API key (it uses the Account SID and Auth Token). `TWILIO_FROM` was fixed to the account's +1 number, after which Twilio accepted the texts, but US carriers rejected them with **30034**: the number isn't registered for 10DLC. No code change can fix that.
- **Owner's decision:** email must be an *alternative* to SMS, not a supplement. Chosen design: email-only accounts, with the phone asked for at checkout. The other option, email plus an unproven phone at sign-up, was rejected.
- **The Vultr server was deleted** by the owner to save money until the app is ready. There is no production right now.

## What was built

- **Customer = account.**
  - `users.id` is the primary key. `phone_number` and `email` are each optional and UNIQUE, with a CHECK that at least one is set.
  - Tokens carry `{role:'customer', uid}`. Ownership is `orders.user_id`.
  - `orders.user_phone` is now only the driver's contact number.
- **Email sign-in and sign-up.** The challenge lives in `otp_codes` under the key `email:<sha256>`, with the same cooldown, attempt cap, single use and generic error as SMS. The account is created on verify.
- **Linking an email to a phone account** still works. It refuses (409) to take an email from an account that signs in only with that email, and an email-only account can't remove its email.
- **Old phone-only tokens** are refused (`hasIdentity`). Otherwise an undefined `uid` would reach Prisma as "no filter".
- **Checkout** has a "Phone for the driver" field, filled with the last number used or the sign-in phone. SW caches: user v33, driver v27, operator v32.
- **Tests:** 378 unit tests and 16 Playwright tests. The new browser test covers signing up by email alone and placing an order.

## Open threads

1. **Hosting:** a new server is needed when the app is ready to launch. Steps are in `COMMANDS.md`, which now uses `SERVER_IP`.
2. **10DLC approval** for US SMS. Until then, US numbers sign in by email. Somalia needs Geo permissions turned on.
3. **SendGrid domain authentication** for `gurikaabe.com`. Sending from `@gmail.com` through SendGrid tends to land in spam.
4. **Carried over from 2026-10-21:** wallets, the review login, real-handset tests in Somalia, backups, the Android rebuild, and the catch-all 400s on order and chat routes.
