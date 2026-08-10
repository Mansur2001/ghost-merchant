#!/bin/bash
# P2b verification: the server side of the offline write queue.
#
# The queue itself is browser code (IndexedDB), and its decision logic is unit-tested in
# backend/tests/syncPolicy.test.js. What has to hold on THIS side is that replaying a queued
# write is safe: a message or an order that already landed must not land twice, and a
# transition that already applied must be recognisable as such rather than looking like a
# conflict.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }

login() {
  local req code
  req=$(curl -sk -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s"}' "$1")" $B/auth/otp/request)
  code=$(echo "$req" | sed -n 's/.*"devCode":"\([0-9]*\)".*/\1/p')
  [ -z "$code" ] && { echo ""; return; }
  curl -sk -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"phone":"%s","code":"%s"}' "$1" "$code")" $B/auth/otp/verify |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

TOK=$(login "612345678")
chk "customer signed in            " "yes" "$([ -n "$TOK" ] && echo yes || echo no)"
OID=$(psql "SELECT id FROM orders WHERE user_phone='+252612345678' AND status='PENDING_PAYMENT' LIMIT 1;")

echo
echo "── 1. A replayed chat message lands exactly once ──"
CID=$(python3 -c "import uuid;print(uuid.uuid4())")
MSG=$(printf '{"body":"queued while offline","clientId":"%s"}' "$CID")
R1=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$MSG" $B/orders/$OID/messages)
R2=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$MSG" $B/orders/$OID/messages)
R3=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$MSG" $B/orders/$OID/messages)
chk "first send accepted           " 201 "$R1"
chk "replay accepted (not an error)" 201 "$R2"
chk "third replay too              " 201 "$R3"
chk "exactly ONE row in the thread " "1" "$(psql "SELECT count(*) FROM messages WHERE client_id='$CID';")"
chk "exactly ONE event enqueued    " "1" "$(psql "SELECT count(*) FROM outbox WHERE event_name='message.posted' AND payload->'message'->>'client_id'='$CID';")"
chk "client_id returned to clients " "yes" "$(curl -sk -H "Authorization: Bearer $TOK" $B/orders/$OID/messages | grep -q "$CID" && echo yes || echo no)"

echo
echo "── 2. Messages without a clientId still work (operator/system paths) ──"
BEFORE=$(psql "SELECT count(*) FROM messages WHERE order_id='$OID';")
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"body":"no key"}' $B/orders/$OID/messages
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"body":"no key"}' $B/orders/$OID/messages
chk "two un-keyed sends = two rows " "$((BEFORE+2))" "$(psql "SELECT count(*) FROM messages WHERE order_id='$OID';")"
chk "a bad clientId is rejected    " 400 "$(code -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"body":"x","clientId":"not-a-uuid"}' $B/orders/$OID/messages)"

echo
echo "── 3. A replayed order creation lands exactly once ──"
NID=$(python3 -c "import uuid;print(uuid.uuid4())")
BODY=$(printf '{"id":"%s","items":[{"text":"offline order"}],"totalAmount":5.00,"landmark":"Queued landmark"}' "$NID")
C1=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$BODY" $B/orders)
C2=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$BODY" $B/orders)
chk "first create                  " 201 "$C1"
chk "replay returns the original   " 200 "$C2"
chk "exactly ONE order row         " "1" "$(psql "SELECT count(*) FROM orders WHERE id='$NID';")"

echo
echo "── 4. A replayed transition is distinguishable from a real conflict ──"
# This is what lets the client tell "my delivery already landed, the response was lost" from
# "the order moved on without me". The server answers 409 either way; the CLIENT then reads
# the order's current status to decide, so that status must be readable.
DTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"msisdn":"+252619876543","pin":"1234"}' $B/driver/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
DID=$(psql "SELECT id FROM orders WHERE status='DISPATCHED' LIMIT 1;")
chk "driver signed in              " "yes" "$([ -n "$DTOK" ] && echo yes || echo no)"
chk "first 'secured' accepted      " 200 "$(code -X POST -H "Authorization: Bearer $DTOK" $B/driver/orders/$DID/secured)"
chk "replay is refused with 409    " 409 "$(code -X POST -H "Authorization: Bearer $DTOK" $B/driver/orders/$DID/secured)"
chk "  ...and the order IS in the target state (so the client treats it as applied)" \
    "IN_TRANSIT" "$(curl -sk -H "Authorization: Bearer $DTOK" $B/driver/orders/$DID | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['status'])")"
# A genuine conflict: the order is terminal, so 'secured' can never apply.
FID=$(psql "SELECT id FROM orders WHERE status='DELIVERED' AND driver_id=(SELECT id FROM drivers WHERE msisdn='+252619876543') LIMIT 1;")
if [ -n "$FID" ]; then
  chk "terminal order refuses too   " 409 "$(code -X POST -H "Authorization: Bearer $DTOK" $B/driver/orders/$FID/secured)"
fi

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
