# Verifying a phone number without sending anything

**Status: design sketch. Not built.**

## Why replace the passcode

An SMS passcode makes phone verification an *infrastructure* problem: something has to put a
message onto a carrier's network, which in Somalia means either an A2P agreement we can't get
or a SIM we own sending texts that eventually look like spam. Every failure mode in that path
— a phone that stopped polling, a swept queue, a telecom throttling the SIM — reaches the
customer as "the app won't let me in", with no explanation and nothing they can do.

Missed-call verification removes the sending entirely.

> The customer calls a number we own, from the phone they're registering, and hangs up.
> The device sees the caller ID. That *is* the proof.

Nothing is sent, so there is nothing to be throttled, nothing to expire unsent, no per-message
cost, and no queue that can silently back up. The customer's own network does the work.

This is not novel — it is how a large part of India onboarded onto mobile services for a
decade ("give us a missed call on…"). It suits markets where calls are cheap or free,
prepaid balances are thin, and SMS delivery is unreliable. That is this market.

## The flow

```
  customer                        app / backend                    Oracle device
     │                                  │                                │
     │  "my number is +252 61 333 4444" │                                │
     ├─────────────────────────────────►│                                │
     │                                  │  open a challenge for that     │
     │                                  │  number, mint a claim ticket   │
     │   { callNumber, ticket, 5 min }  │                                │
     │◄─────────────────────────────────┤                                │
     │                                  │                                │
     │  taps "Call to verify"  →  tel: link opens the dialer, pre-filled  │
     ├───────────────────────────────────────────── rings ──────────────►│
     │                                  │                                │
     │  hangs up (or we reject on the first ring — free either way)      │
     │                                  │                                │
     │                                  │   "inbound call from           │
     │                                  │    +252613334444 at 10:04"     │
     │                                  │◄───────────────────────────────┤
     │                                  │       (HMAC-signed)            │
     │                                  │                                │
     │       app polls with its ticket  │  caller ID matches a live      │
     ├─────────────────────────────────►│  challenge → verified          │
     │        { status, sessionToken }  │                                │
     │◄─────────────────────────────────┤                                │
```

The customer never types a code. There is no code.

## What this reuses

Almost everything. This is a smaller change than the SMS queue was.

| Piece | Reuse |
|---|---|
| `tel:` URI building + Android `ACTION_DIAL` | Already built for USSD payment. Same permission-free dialer launch, one tap. |
| Oracle poll loop + HMAC auth | Same tick that collects receipts also reports inbound calls. |
| One-live-challenge-per-number, TTL, rate limits | The `otp_codes` rules transfer directly. |
| Session token minting | Unchanged — only how we decide "this person holds this number" changes. |

**It also works where the payment flow doesn't.** iOS blocks USSD from a `tel:` link, which is
why iPhone users have to copy the dial string by hand; a plain voice call from a `tel:` link
works fine on iOS. Verification would be the *more* portable half of the app.

## Data model

A new table rather than bending `otp_codes`, because the shapes genuinely differ: there is no
secret sent to the user, and the thing held by the client is a claim ticket, not an answer.

```prisma
model CallChallenge {
  id          String    @id @default(uuid()) @db.Uuid
  phone       String    // E.164, the number being proven
  ticket_hash String    // scrypt. The client's claim on this challenge — see below.
  verified_at DateTime? @db.Timestamptz(6)
  expires_at  DateTime  @db.Timestamptz(6)
  created_at  DateTime  @default(now()) @db.Timestamptz(6)

  @@unique([phone])     // one live challenge per number — same rule as otp_codes
  @@map("call_challenges")
}
```

The ticket is hashed at rest for the same reason a passcode is: the table should not contain
anything that grants a session if it leaks.

## The security argument

**The ticket is what stops a hijack, and it is the part worth getting right.**

Consider: an attacker starts a challenge for a victim's number. With SMS this is harmless —
the code goes to the victim's handset and the attacker can't read it. With missed-call, the
attacker isn't waiting on a secret; they're waiting for *a call from that number to arrive
from anywhere*. So the question is who receives the session when it does.

Three rules close it:

1. **The session goes only to the holder of the ticket.** Verification does not "log in the
   phone number" — it resolves one specific challenge, and only a client presenting that
   challenge's ticket gets a token. An attacker's challenge cannot hand a token to a browser
   that never started it.
2. **Latest request wins.** `@@unique([phone])` plus upsert means a victim starting their own
   verification *replaces* the attacker's challenge and invalidates its ticket. The only way
   an attacker's ticket survives to be resolved is if the victim calls the number without
   having requested verification — and the number is only ever shown inside that flow.
3. **A call with no live challenge is discarded**, not remembered. No pool of "verified
   numbers" accumulates for a later challenge to draw on.

**Caller ID is spoofable, and that is the honest limit.** Mobile-originated calls inside a
Somali carrier's network are hard to forge; VoIP gateways are the practical attack. This is
the same class of weakness SMS OTP has (spoofable sender IDs, SIM swap) rather than a worse
one — but it should be written down, not glossed. Two things reduce it: prefer on-net calls,
and keep the operator-vouch path for anything that looks wrong.

**What it removes** is worth counting too. No plaintext credential is ever stored (the SMS
queue holds live codes until delivery). Nothing is transmitted that can be intercepted or
shoulder-surfed. And it kills OTP phishing outright: there is no code, so "read me the code
you just got" is not a sentence that can work on a GuriKaabe customer.

## Device: this is a better argument for a modem than a phone

Android is a poor fit here. Termux can read the call log (`termux-telephony-calllog`), but a
call only lands in the log once it has finished ringing out — roughly 20–30 seconds of the
customer staring at a screen. Termux also cannot reject an incoming call without being the
default dialer.

A **USB GSM modem** does this properly. With caller ID enabled (`AT+CLIP=1`) the modem reports
the number on the *first ring*, and `ATH` hangs up immediately:

```
RING
+CLIP: "+252613334444",145
> ATH        ← rejected in under a second
```

Sub-second verification, and the call never connects so it cannot cost the customer anything.
If missed-call becomes the primary path, the modem stops being an upgrade and becomes the
right hardware.

## Open questions — these need a real SIM, not more design

1. **Does a call ring at zero balance?** Prepaid customers run flat constantly. Call *setup*
   normally works with no credit and billing only starts on answer — but "normally" is not
   good enough for the only door into the app. If it fails, these customers cannot sign up at
   all, and it will look like the app rejecting them.
2. **On-net vs off-net.** A Hormuud customer calling a Somtel number is a different path, a
   different cost, and sometimes a different reliability story. This may mean one Oracle SIM
   per major network, which is cheap but is real operational surface.
3. **Latency end to end**, including the report to the backend.
4. **Does the carrier notice?** A number receiving many short inbound calls is a less unusual
   pattern than a SIM sending many texts, but it is not nothing.

## Rollout

Both mechanisms can run at once — they answer the same question and mint the same token, so
this needs no big-bang switch.

- `+252` → missed call, with the SMS queue as the fallback if no call arrives within a minute
- everything else → SMS (Twilio), unchanged; a US customer should not be calling Somalia
- operator-vouch stays as the backstop for both

The FAQ has to carry this. "Call this number and hang up" is unfamiliar enough that customers
will assume it's broken or that it will charge them. Draft copy:

> **Why am I calling instead of getting a code?**
> Because it is faster and it costs you nothing. Your call proves you're holding the phone
> you're signing up with — that's all a code was ever doing. Hang up as soon as it rings; we
> never answer, so you are never charged. **We will never call you and ask for a code or a
> PIN.**

That last line is the point. Once there are no codes in the system, that warning is
unconditionally true, and it stays true for every customer we ever onboard.
