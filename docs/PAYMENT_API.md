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

## Not built yet (on purpose)

- **The provider adapter itself.** Receiving Sahal's or Hormuud's own callback format,
  checking it the way they require, and turning it into the call above. Each provider differs
  and needs their merchant agreement.
- **Automatic refunds (B2C payouts).** Refunds stay an admin-recorded ledger until a payout API
  exists. When one does, settle the `refunds` row from its callback the same way.
- **Paying drivers through the platform.** The platform holds no balance, so it can't advance
  cash or pay fees out of customer money. See *Business posture* in CLAUDE.md.
