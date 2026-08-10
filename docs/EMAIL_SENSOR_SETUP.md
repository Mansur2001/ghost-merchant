# Confirming payments without the phone

The Oracle phone reads payment texts. Getting that working on Android needs three manual
steps on the device — install Termux, install the *separate* Termux:API app from the same
source, grant the SMS permission — and if any one is off, every command silently returns
nothing.

**Every US rail emails you the same notification it texts you.** So the server can read your
inbox directly and skip the phone entirely.

| | Phone (Oracle) | Email sensor |
|---|---|---|
| EVC Plus / eDahab | ✅ | ❌ (they text, they don't email) |
| Zelle / Cash App / Venmo | ✅ | ✅ |
| Needs an Android device | yes | **no** |
| Needs permissions granted by hand | yes | **no** |

Everything downstream is identical — same parsers, same matching rules, same reconcile queue,
same protection against counting a payment twice. Only the transport differs.

**You can run both.** If the same payment arrives as a text *and* an email, the second one
dedupes against the first: they produce the same receipt id, so one payment can never credit
two orders.

---

## Setup (about five minutes)

### 1. Turn on 2-Step Verification
<https://myaccount.google.com/security> — Google won't issue an app password without it.

### 2. Create an App Password
<https://myaccount.google.com/apppasswords> → name it `GuriKaabe` → copy the 16-character
code.

**This is not your Gmail password.** Google rejects a normal password over IMAP outright, and
the error just says "invalid credentials", which sends people re-checking a password they
typed correctly.

An app password grants **full mailbox access**. Treat it like any other credential: it lives
in `.env` (git-ignored) and nowhere else. You can revoke it from that same page at any time
without changing your Google password.

### 3. Add it to `.env`

```bash
IMAP_HOST=imap.gmail.com
IMAP_USER=tukale206@gmail.com
IMAP_PASSWORD=abcdefghijklmnop      # the 16-char app password, no spaces
```

### 4. Restart

```bash
docker compose up -d backend
docker compose logs -f backend | grep "email sensor"
```

You should see:

```
email sensor: watching tukale206@gmail.com for payment notifications (every 30s)
```

### 5. Test it with real money

Send yourself **$1** on Zelle, Cash App or Venmo. Within 30 seconds:

```
email sensor: zelle $1.00 from John Smith — recorded, needs reconciliation
```

Then open the operator dashboard → **Unmatched receipts** → pick the order it paid for.

"Needs reconciliation" is correct, not a failure. US rails name the payer instead of giving a
phone number, and with a fixed delivery fee two customers owing the same amount is the normal
case — so matching on amount alone would mark the **wrong** person's order paid. You confirm.

---

## What it reads, and what it doesn't

- Only **unseen** mail, only from the last 24 hours (`IMAP_LOOKBACK_HOURS`), so switching it
  on doesn't replay a year of old notifications into your reconcile queue.
- It marks messages **seen** as it goes — including ones that aren't payments, or it would
  re-read your whole inbox every 30 seconds. If you rely on unread state in that mailbox,
  point it at a dedicated address or a filtered folder (`IMAP_MAILBOX`).
- IMAP logging is off deliberately: its debug output includes full message bodies, which is
  customer data.

## Things it deliberately refuses

- **Payment requests.** "John Smith requests $25.00 from you" is the same sender, same brand,
  same amount as a real receipt — and booking it would let someone mark an order paid by
  *asking* for money instead of sending it.
- Marketing mail from the same sender, declined/cancelled/refunded notices, and anything
  merely mentioning a dollar amount.

## Honest limits

An email `From:` header is as forgeable as an SMS sender ID, so **a receipt is evidence, not
proof.** What protects you is unchanged: a payment only auto-confirms on phone number + exact
amount + an order actually waiting; everything else waits for you; and a replayed message
can't credit twice.

On a named-payer rail **you are the verification step.** Check your banking app before binding
a large payment — clicking through the dropdown without looking defeats the point of the queue.

## If it doesn't connect

| Log line | Meaning |
|---|---|
| `login refused ... requires an APP PASSWORD` | Using your normal Gmail password. See step 2. |
| `email sensor:` never appears | `IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD` not all set — the sensor stays off. |
| Connects, but nothing recognised | Check the mail actually landed in `INBOX` and isn't filtered to another folder. Set `IMAP_MAILBOX`. |

If a real notification is missed, forward it to yourself and paste the text here (amount and
name changed) — the parsers are written from documented formats, and the wording may differ.
