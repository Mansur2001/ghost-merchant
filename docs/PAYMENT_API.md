# Connecting a mobile-money API (Sahal, EVC Plus, ZAAD, a gateway)

Today an operator confirms each payment by checking the merchant phone and typing the
transaction number. Once a provider API is connected, **nobody** confirms payments by hand.
The provider's callback is the only way an order becomes paid. This page is the contract for
whoever builds that connection.

## What stays the same

- **The platform never holds money.** The customer pays the business's merchant wallet. The
  callback only tells us that money arrived; we record it and move the order on.
- One payment confirms one order: `transactions.telecom_receipt_id` is UNIQUE.
- The amount must equal the order total, to the cent.

## Switching it on

```bash
# .env on the server
PAYMENT_CONFIRMATION=api
PAYMENT_WEBHOOK_SECRET=<at least 32 random characters, e.g. openssl rand -hex 32>
```
Then recreate the backend container. The backend **refuses to boot** with `api` and a missing or
short secret. In `api` mode:

- the operator's *Confirm payment* control disappears;
- `POST /api/operator/orders/:id/mark-paid` answers **403** for everyone, admins included.

## The callback

Your adapter receives the provider's notification, then calls:

```
POST https://app.gurikaabe.com/api/payments/webhook
Content-Type: application/json
X-GK-Timestamp: 1793916000                 # unix seconds, now
X-GK-Signature: <hex HMAC-SHA256>          # see below

{"orderId":"9110aafa-fd8f-4469-8592-4d5f944952e3","reference":"EVC123456789","amount":"7.50","payer":"+252612345678"}
```

- `orderId`: the GuriKaabe order id. Send it to the provider as the payment's reference or
  description when you request the payment (push-USSD / request-to-pay), so it comes back.
- `reference`: the telecom's transaction id.
- `amount`: what was paid, as a decimal string.
- `payer`: optional; it's stored for refunds.

**Signature:** `HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, "<X-GK-Timestamp>.<exact raw body>")`, in hex.
The timestamp must be within 5 minutes of the server's clock.

```js
import { createHmac } from 'node:crypto';
const ts = Math.floor(Date.now() / 1000);
const body = JSON.stringify(payload);
const sig = createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
```

## Answers

| Status | Meaning | What your adapter does |
|---|---|---|
| 200 `{ok:true,status}` | Paid; dispatched if a driver is free | Done |
| 200 `{ok:true,duplicate:true}` | We already applied this reference to this order | Done (retries are safe) |
| 401 | Bad or old signature | Fix the clock or the secret; never retry blindly |
| 400 | Missing `orderId`, `reference` or `amount` | Fix the payload |
| 404 | No such order | Money arrived for nothing: it goes in the audit log as `payment.unmatched` |
| 409 | Wrong amount, already paid, or the reference was used for another order | Same: `payment.unmatched`. An admin refunds it. Nobody can force it through. |

## WaafiPay: in-app payments (EVC Plus, Zaad, Sahal) — built, waiting for keys

WaafiPay is the gateway for Hormuud (EVC Plus), Telesom (Zaad) and Golis (Sahal); there is no
public direct Sahal API, so Sahal goes through it. The adapter is `domain/waafipay.js` (wire
format) and `commands/providerPayments.js` (one attempt's lifecycle). Set the three
`WAAFIPAY_*` values in `.env` and recreate the backend: customers then see "Pay $X with Sahal".

1. The customer taps it and types the wallet number. We send `API_PURCHASE` (referenceId = our
   attempt id, invoiceId = the order id, amount = the order total from the database).
2. WaafiPay pushes a prompt to that phone; the customer approves with their PIN.
3. The same call returns `APPROVED` with a `transactionId`. `confirmPayment` records it (the
   transaction id is the UNIQUE reference) and dispatches, in one transaction with the attempt.

Rules: one pending prompt per order (partial UNIQUE index); `5xxx` = declined, try again;
anything unreadable or a timeout = **unknown**, no new prompt for 10 minutes (the customer
may have been charged) and the operator checks the merchant account, as with "I've paid".
Money that can't be applied (order cancelled meanwhile, amount differs) is audited as
`payment.unmatched` for a refund. This works in either `PAYMENT_CONFIRMATION` mode.

**Before switching it on:** check the field names against the documentation that comes with
the merchant account (they follow WaafiPay's published `API_PURCHASE` format), and run one
real $0.10 payment per wallet. Staging uses a simulator (`scripts/waafipay-mock.mjs`;
payer ending 0000 = declined, 9999 = unreadable).

## Not built yet (on purpose)

- **Callback adapters for other gateways.** WaafiPay answers synchronously (above). A gateway
  that calls back instead needs a small adapter that checks its signature and makes the
  signed call above.
- **Automatic refunds (B2C payouts).** Refunds stay an admin-recorded ledger until a payout API
  exists. When one does, settle the `refunds` row from its callback the same way.
- **Paying drivers through the platform.** The platform holds no balance, so it can't advance
  cash or pay fees out of customer money. See *Business posture* in CLAUDE.md.
