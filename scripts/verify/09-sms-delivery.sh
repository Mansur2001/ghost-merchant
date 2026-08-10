#!/bin/bash
# The outbound SMS path: how a login code reaches a Somali handset with no telecom contract.
#
# WHY THIS SUITE EXISTS: every other way to send an SMS in Somalia means a commercial A2P
# agreement with a telecom, which needs a registered local company, a Somali bank account and
# a per-message price that only makes sense at volume. This project has none of those. The
# code goes out over the merchant's own SIM instead, from the Oracle phone, at the ordinary
# subscriber rate.
#
# That inverts the connection. A phone cannot accept an inbound request — carrier-grade NAT
# on mobile data, a router on WiFi — so the backend cannot push to it. The phone POLLS. Every
# check here is against that loop, over the real HTTP layer, with real HMAC signatures.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }

SECRET=$(grep -E '^ORACLE_WEBHOOK_SECRET=' .env | cut -d= -f2-)
sign() { python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(),sys.argv[2].encode(),hashlib.sha256).hexdigest())" "$SECRET" "$1"; }
# Post as the Oracle phone would: signed body, no session token — the phone has no login.
oracle() { curl -sk -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $(sign "$2")" -d "$2" "$B$1"; }
oracle_code() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $(sign "$2")" -d "$2" "$B$1"; }

# Start from a clean queue so counts below mean what they say.
psql "DELETE FROM sms_outbox;" >/dev/null

echo
echo "── 1. The queue is the only way in ──"
chk "an unsigned poll is refused   " 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"limit":5}' $B/oracle/sms/pending)"
chk "a wrongly-signed poll too     " 401 "$(code -X POST -H 'Content-Type: application/json' -H 'X-Oracle-Signature: 00' -d '{"limit":5}' $B/oracle/sms/pending)"
chk "an unsigned confirm is refused" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"id":"1","ok":true}' $B/oracle/sms/sent)"
# A stolen bearer token must not become a way to read login codes in flight.
OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "even an operator can't poll   " 401 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"limit":5}' $B/oracle/sms/pending)"

echo
echo "── 2. A login request queues a message for the phone ──"
PHONE="+252613334444"
chk "customer asks for a code      " 200 "$(code -X POST -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}" $B/auth/otp/request)"
# In dev, with no phone ever polling, delivery falls back to the log rather than queuing into
# a black hole. Queue one directly so the rest of the loop is exercised regardless.
docker compose exec -T backend node -e "
  import('./src/notify/smsQueue.js').then(async (m) => {
    await m.queueSms({ to: '$PHONE', body: 'GuriKaabe code: 424242' });
  })" >/dev/null 2>&1
chk "a message is waiting          " "1" "$(psql "SELECT count(*) FROM sms_outbox WHERE \"to\"='$PHONE';")"

echo
echo "── 3. The phone collects it ──"
RESP=$(oracle /oracle/sms/pending '{"limit":5}')
MID=$(echo "$RESP" | python3 -c "import sys,json;m=json.load(sys.stdin)['messages'];print(m[0]['id'] if m else '')")
chk "the poll hands over a message " "yes" "$([ -n "$MID" ] && echo yes || echo no)"
chk "  ...addressed to the customer" "yes" "$(echo "$RESP" | grep -q "$PHONE" && echo yes || echo no)"
chk "  ...and the claim is stamped " "1" "$(psql "SELECT count(*) FROM sms_outbox WHERE id=$MID AND claimed_at IS NOT NULL;")"

# THE RACE THAT MATTERS: two polls in flight (a retry, a second phone, a slow network) must
# not both send. Two DIFFERENT codes arriving for one login is a customer who cannot sign in.
SECOND=$(oracle /oracle/sms/pending '{"limit":5}')
chk "a second poll gets nothing    " "0" "$(echo "$SECOND" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['messages']))")"

echo
echo "── 4. Confirming delivery destroys the plaintext code ──"
# The hashed copy in otp_codes is authoritative. This row exists only to be delivered, and a
# live login code sitting in a table after delivery is a credential we have no reason to hold.
chk "phone reports it sent         " 200 "$(oracle_code /oracle/sms/sent "$(printf '{"id":"%s","ok":true}' "$MID")")"
chk "  ...the row is DELETED       " "0" "$(psql "SELECT count(*) FROM sms_outbox WHERE id=$MID;")"

echo
echo "── 5. A failed send is retried, not lost ──"
docker compose exec -T backend node -e "
  import('./src/notify/smsQueue.js').then(async (m) => {
    await m.queueSms({ to: '$PHONE', body: 'GuriKaabe code: 515151' });
  })" >/dev/null 2>&1
R2=$(oracle /oracle/sms/pending '{"limit":5}')
MID2=$(echo "$R2" | python3 -c "import sys,json;m=json.load(sys.stdin)['messages'];print(m[0]['id'] if m else '')")
chk "phone reports a failure       " 200 "$(oracle_code /oracle/sms/sent "$(printf '{"id":"%s","ok":false,"error":"no service"}' "$MID2")")"
chk "  ...it stays queued          " "1" "$(psql "SELECT count(*) FROM sms_outbox WHERE id=$MID2 AND status='pending';")"
chk "  ...the claim is released    " "1" "$(psql "SELECT count(*) FROM sms_outbox WHERE id=$MID2 AND claimed_at IS NULL;")"
chk "  ...the reason is recorded   " "yes" "$(psql "SELECT last_error FROM sms_outbox WHERE id=$MID2;" | grep -q 'noservice' && echo yes || echo no)"
chk "  ...and it is offered again  " "$MID2" "$(oracle /oracle/sms/pending '{"limit":5}' | python3 -c "import sys,json;m=json.load(sys.stdin)['messages'];print(m[0]['id'] if m else '')")"

echo
echo "── 6. A claimed message isn't handed out twice while the phone is working on it ──"
# The message from check 5 is claimed and fresh, so it is invisible to further polls. This is
# what stops a slow network from turning one code into two.
chk "a fresh claim is not re-served" "0" "$(oracle /oracle/sms/pending '{"limit":5}' | python3 -c "import sys,json;print(len(json.load(sys.stdin)['messages']))")"
# ...but a phone that dies mid-send must not strand it forever. Age the claim past the 60s
# timeout rather than sleeping through it: the rule is what's under test, not the clock.
psql "UPDATE sms_outbox SET claimed_at = now() - interval '5 minutes' WHERE id=$MID2;" >/dev/null
chk "a STALE claim is recovered    " "$MID2" "$(oracle /oracle/sms/pending '{"limit":5}' | python3 -c "import sys,json;m=json.load(sys.stdin)['messages'];print(m[0]['id'] if m else '')")"

echo
echo "── 7. A phone that never comes back doesn't leave codes lying around ──"
# A code is dead after its 5-minute TTL, so a message that still hasn't gone out is not
# something to keep retrying — it is a plaintext credential with no remaining purpose.
psql "UPDATE sms_outbox SET attempts = 3, claimed_at = NULL WHERE id=$MID2;" >/dev/null
chk "an exhausted message is unserved" "0" "$(oracle /oracle/sms/pending '{"limit":5}' | python3 -c "import sys,json;print(len(json.load(sys.stdin)['messages']))")"
docker compose exec -T backend node -e "
  import('./src/notify/smsQueue.js').then((m) => m.sweepSmsQueue())" >/dev/null 2>&1
chk "  ...and the sweep destroys it" "0" "$(psql "SELECT count(*) FROM sms_outbox WHERE id=$MID2;")"
# The other half of the sweep: still-pending but older than any usable code.
docker compose exec -T backend node -e "
  import('./src/notify/smsQueue.js').then((m) => m.queueSms({ to: '$PHONE', body: 'stale' }))" >/dev/null 2>&1
psql "UPDATE sms_outbox SET created_at = now() - interval '1 hour' WHERE \"to\"='$PHONE';" >/dev/null
docker compose exec -T backend node -e "
  import('./src/notify/smsQueue.js').then((m) => m.sweepSmsQueue())" >/dev/null 2>&1
chk "an expired code is swept too  " "0" "$(psql "SELECT count(*) FROM sms_outbox WHERE \"to\"='$PHONE';")"

echo
echo "── 8. The operator can see the queue backing up ──"
# A stalled queue looks exactly like "the app won't let me log in" and is otherwise silent.
chk "health is visible to operator " 200 "$(code -H "Authorization: Bearer $OTOK" $B/operator/sms-queue)"
chk "  ...but not to the public    " 401 "$(code $B/operator/sms-queue)"

psql "DELETE FROM sms_outbox;" >/dev/null

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
