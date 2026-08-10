# The Android Oracle — setup & validation

## What it is

A dedicated Android phone that **confirms payments**. When someone pays the merchant, the
rail texts the merchant's phone; the Oracle forwards that message to the backend, which
matches it to an order and marks it paid.

It is a **sensor, not a communication device**. Customer/driver/operator conversation goes
over the in-app chat and never touches this phone.

**It does not parse.** It forwards the raw SMS and lets the server decide what it means
(`backend/src/domain/receipts.js`). Rails reword their receipts without warning, and a parser
fix must not require physical access to a handset that may be in another country. *(This
changed — earlier versions parsed on the device with regexes you had to tune by hand. Those
are gone; there is nothing to tune here any more.)*

## Rails it senses

| Rail | Country | Auto-matches? |
|---|---|---|
| EVC Plus, eDahab | SO | **Yes** — the receipt carries the payer's phone number |
| Zelle, Cash App, Venmo | US | **No** — see below |

US rails identify the payer by *display name* ("John Smith sent you $25.00"). There is no safe
way to turn a name into an order: with a fixed delivery fee, two customers owing the same
amount is the normal case, so matching on amount alone would mark the **wrong** person's order
paid. Those receipts are recorded with the payer's name and land in the operator's
**reconcile queue**, where a human binds them to an order in one click.

Adding a rail = adding an entry to `PROVIDERS` in `backend/src/domain/receipts.js`, plus a
test. Nothing on the phone changes.

## You do not need an Oracle to run

At low volume an operator reads the merchant phone and taps **Mark as paid**. That path is
fully supported, and the dashboard shows **"Payments: manual"** rather than an alarm — the
dead-man's switch only arms once an Oracle has actually reported. The Oracle removes a manual
step; it is not load-bearing for correctness.

---

## Validate the software loop first (no phone, no SIM)

With the stack running (`docker compose up -d`):

```bash
cd oracle
export $(grep -E '^ORACLE_WEBHOOK_SECRET=' ../.env | xargs)
export NODE_TLS_REJECT_UNAUTHORIZED=0 BACKEND_URL=https://localhost

# Send the RAW message a phone would actually receive:
node simulate.js sms evcplus 7.25            # Somali rail  -> auto-matches
node simulate.js sms zelle 25.00 "John Smith" # US rail      -> queues for reconciliation
node simulate.js sms junk                     # ordinary text -> ignored
node simulate.js heartbeat                    # badge goes green
```

For `evcplus`, create an order in the customer app for phone `612345678` at that exact total
first — the PWA should flip **PENDING_PAYMENT → PAID_UNASSIGNED** within ~1s over the
WebSocket, with no refresh.

For `zelle`, the payment appears in the operator's **Unmatched receipts** panel; pick the
order from the dropdown and it goes paid, with your operator name in the audit trail.

`simulate.js payment <msisdn> <amount>` still exists for the pre-parsed webhook shape.

---

## Put it on the phone

On the **laptop**, serve this folder over your LAN:

```bash
cd oracle && python3 -m http.server 8000
```

On the **phone**, in Termux:

```bash
pkg install -y nodejs termux-api curl
cd ~
curl -O http://<laptop-lan-ip>:8000/termux-oracle.js
curl -O http://<laptop-lan-ip>:8000/start-oracle.sh
chmod +x start-oracle.sh
nano start-oracle.sh     # set the secret and BACKEND_URL
./start-oracle.sh
```

Stop the laptop's file server (Ctrl-C) once the files are across.

### The gotcha that stops most people
`pkg install termux-api` installs only the **bridge**. You also need the separate
**Termux:API app**, and *both* it and Termux must come from **F-Droid** — mixed sources have
different signing keys and every SMS command silently returns nothing.

Then grant SMS access explicitly: **Settings → Apps → Termux:API → Permissions → SMS → Allow**.
`termux-setup-storage` does *not* cover SMS. `start-oracle.sh` checks both before starting.

---

## Still unvalidated on real hardware (P4)

These cannot be proven in code:

1. **`tel:` + USSD `%23` fires.** Put a real order's pay button in front of a phone on a
   Hormuud/Somtel SIM and confirm the dialer opens with the dial string intact — the trailing
   `#` must survive as `%23`. (iOS blocks USSD from `tel:` entirely; iPhone users need the
   code displayed to copy.)

2. **Receipt wording.** The parsers are written from documented formats, not from messages off
   a live SIM. When a real payment arrives, check the backend log: if it says
   `ignored (not a receipt)`, paste the real text (amount and number changed) and adjust
   `PROVIDERS` — a server-side change, no phone access needed.

3. **Outbound SMS for login codes.** Built, and it is the same script — `pollOutbound()` in
   `termux-oracle.js`. This is how a Somali customer receives a login code with no telecom
   contract: the code goes out over your own SIM at the ordinary subscriber rate.

   **The phone is never listened to.** An earlier design had the backend POST to a listener on
   this device; that cannot work. On mobile data the phone sits behind carrier-grade NAT and on
   WiFi behind a router, so nothing on the internet can open a connection to it — you would
   need a VPN or a tunnel, which is one more dependency to keep alive. So the direction is
   inverted: the backend queues the message, and **this phone asks for it** on the same tick it
   already uses to check for receipts.

   ```
   backend queues → POST /api/oracle/sms/pending (signed) → termux-sms-send → POST /api/oracle/sms/sent
   ```

   A collected message is *claimed*, so two polls in flight can't send two different codes for
   one login; a failure is reported and retried; a confirmed send **deletes** the row, because
   until then it holds a login code in plaintext. Anything undelivered after 10 minutes is
   swept — the code expired at 5, so it is a credential with no remaining purpose.

   What still needs a real Somali SIM: that send latency stays under the 5-minute code TTL, and
   that the telecom doesn't rate-limit automated sends from a subscriber SIM. At soft-launch
   volume this is a handful of texts a day and looks like ordinary use; at scale it is a real
   constraint, and the honest answer then is a commercial A2P agreement. US numbers don't touch
   this path at all — they go through Twilio (`docs/LIVE_SMS_SETUP.md`).

## Operational hardening

- Dedicated phone, dedicated SIM. No personal use. Treat it as a server-in-a-box.
- Constant power, battery optimisation disabled for Termux. `start-oracle.sh` takes a wake
  lock — Android suspending the process means payments silently stop being matched, and the
  heartbeat badge going red is the only signal.
- The raw SMS is stored on every receipt (`transactions.raw_sms`) — your evidence in a dispute.
- `UNIQUE(telecom_receipt_id)` means a duplicated or replayed webhook can never credit twice.
- **A receipt is evidence, not proof.** Sender IDs are spoofable. What protects you is the
  narrow match (phone number + exact amount + an order actually waiting), the reconcile queue
  for anything ambiguous, and that unique constraint. On a named-payer rail *you* are the
  verification step — check your banking app before binding a large payment.
- If `ORACLE_WEBHOOK_SECRET` leaks, payments can be forged. Rotate it on the server and in
  `start-oracle.sh` together, then reconcile every transaction since the leak by hand.
