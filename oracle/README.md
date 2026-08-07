# The Android Oracle — setup & validation

The Oracle is the single point of failure and the load-bearing wall of the whole concept.
**Validate it before building anything else on top.**

## Validate the software loop first (no phone needed)

With the stack running (`docker compose up`), simulate a real signed payment webhook:

```bash
cd oracle
# secret must match ORACLE_WEBHOOK_SECRET in your .env
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ORACLE_WEBHOOK_SECRET=<secret> BACKEND_URL=https://localhost \
  node simulate.js payment 61234567 5.50
```

Expected: create an order in the User PWA with phone `61234567` and total `5.50`, then run
the command above — the PWA should flip **PENDING_PAYMENT → PAID_UNASSIGNED** within ~1s
via the WebSocket, with no refresh. Heartbeat test:

```bash
ORACLE_WEBHOOK_SECRET=<secret> node simulate.js heartbeat
```

The operator dashboard's "Oracle" badge should read **healthy**; stop sending heartbeats
past `ORACLE_HEARTBEAT_TIMEOUT_SECONDS` and it should flip to **DOWN**.

## Then validate the two hardware assumptions

These are the assumptions that cannot be proven in code — test them on **real
Hormuud/Somtel SIMs and real target devices**:

1. **`tel:` + USSD `%23` fires.** Put a real order's pay button in front of a real Android
   phone on the target network. Confirm the dialer opens with the full USSD string intact
   (the trailing `#` must survive as `%23`). Note: iOS blocks USSD execution from `tel:`
   for security — if you have iPhone users, they need a fallback (manual code display).

2. **SMS interception + webhook round-trip.** Follow the setup in `termux-oracle.js`, send a
   real P2P transfer, and confirm the parsed receipt reaches `/webhook` and matches the
   order. **Tune the regexes** (`AMOUNT_RE`, `SENDER_RE`, `REF_RE`) to the exact wording of
   real EVC Plus / eDahab receipts — the samples are guesses.

## Operational hardening (from the SRS warnings)

- Dedicated phone, dedicated SIM. No personal use. Treat it as a server-in-a-box.
- Constant power + disable battery optimization for Termux. Run `termux-wake-lock`.
- Keep the raw SMS (`raw_sms` column) for every receipt — your audit trail for disputes.
- The backend enforces anti-double-spend via `UNIQUE(telecom_receipt_id)`, so a duplicated
  or replayed webhook can never credit an order twice.
