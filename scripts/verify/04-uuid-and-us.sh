#!/bin/bash
# P1 #7 (UUID order ids) + US number support, against the live stack.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }

login() { # login <phone> -> token
  local req code
  req=$(curl -sk -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s"}' "$1")" $B/auth/otp/request)
  code=$(echo "$req" | sed -n 's/.*"devCode":"\([0-9]*\)".*/\1/p')
  [ -z "$code" ] && { echo ""; return; }
  curl -sk -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"phone":"%s","code":"%s"}' "$1" "$code")" $B/auth/otp/verify |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

echo "── 1. Order ids are UUIDs, and non-UUIDs never reach Postgres ──"
SO_TOK=$(login "612345678")
chk "somali customer signed in    " "yes" "$([ -n "$SO_TOK" ] && echo yes || echo no)"
MINE=$(curl -sk -H "Authorization: Bearer $SO_TOK" $B/orders/mine)
OID=$(echo "$MINE" | python3 -c "import sys,json;o=json.load(sys.stdin)['orders'];print(o[0]['id'] if o else '')")
chk "order id is a UUID           " "yes" "$(echo "$OID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' && echo yes || echo no)"
chk "own order readable           " 200 "$(code -H "Authorization: Bearer $SO_TOK" $B/orders/$OID)"
for bad in 1 0 -1 abc "1;DROP TABLE orders" "%27" "00000000-0000-0000-0000-000000000000"; do
  chk "malformed id -> 404 [$bad]" 404 "$(code -H "Authorization: Bearer $SO_TOK" "$B/orders/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$bad")")"
done
# Traversal-shaped input never reaches the API: Caddy normalizes the path, it stops matching
# /api/*, and the SPA fallback serves the app shell. Assert the thing that matters — no file
# disclosure — rather than a status code that belongs to the static handler.
for trav in "/api/orders/../../../etc/passwd" "/api/orders/..%2F..%2Fetc%2Fpasswd" "/etc/passwd"; do
  chk "no file disclosure [$trav]" "0" "$(curl -sk "https://localhost$trav" | grep -c 'root:')"
done
chk "enumeration by id impossible " 404 "$(code -H "Authorization: Bearer $SO_TOK" $B/orders/00000000-0000-4000-8000-000000000001)"

echo
echo "── 2. Client-minted ids make order creation idempotent ──"
NEWID=$(python3 -c "import uuid;print(uuid.uuid4())")
BODY=$(printf '{"id":"%s","items":[{"text":"idempotency test"}],"totalAmount":3.50,"landmark":"Test landmark"}' "$NEWID")
R1=$(curl -sk -w '\n%{http_code}' -X POST -H "Authorization: Bearer $SO_TOK" -H 'Content-Type: application/json' -d "$BODY" $B/orders)
R2=$(curl -sk -w '\n%{http_code}' -X POST -H "Authorization: Bearer $SO_TOK" -H 'Content-Type: application/json' -d "$BODY" $B/orders)
chk "first create -> 201          " 201 "$(echo "$R1" | tail -1)"
chk "retry -> 200, not a new order" 200 "$(echo "$R2" | tail -1)"
chk "retry returns the same order " "$NEWID" "$(echo "$R2" | head -1 | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['id'])")"
chk "only ONE row in the database " "1" "$(psql "SELECT count(*) FROM orders WHERE id='$NEWID';")"
chk "only ONE created event       " "1" "$(psql "SELECT count(*) FROM outbox WHERE event_name='order.created' AND payload->>'orderId'='$NEWID';")"
chk "server rejects a non-UUID id " 400 "$(code -X POST -H "Authorization: Bearer $SO_TOK" -H 'Content-Type: application/json' -d '{"id":"not-a-uuid","items":[],"totalAmount":1,"landmark":"x"}' $B/orders)"

echo
echo "── 3. A client cannot hijack someone else's order id ──"
US_TOK=$(login "+12065551234")
chk "US customer signed in        " "yes" "$([ -n "$US_TOK" ] && echo yes || echo no)"
# Same id, different owner: must be refused, not silently returned.
HIJACK=$(curl -sk -w '\n%{http_code}' -X POST -H "Authorization: Bearer $US_TOK" -H 'Content-Type: application/json' -d "$BODY" $B/orders)
chk "reusing another's id -> 400  " 400 "$(echo "$HIJACK" | tail -1)"
chk "  ...and leaks nothing       " "yes" "$(echo "$HIJACK" | head -1 | grep -q 'landmark' && echo no || echo yes)"

echo
echo "── 4. US numbers: full identity, no USSD ──"
US_BODY='{"items":[{"text":"US test order"}],"totalAmount":9.99,"landmark":"Seattle test landmark"}'
US_CREATE=$(curl -sk -X POST -H "Authorization: Bearer $US_TOK" -H 'Content-Type: application/json' -d "$US_BODY" $B/orders)
US_OID=$(echo "$US_CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['id'])")
chk "US customer can create order " "yes" "$([ -n "$US_OID" ] && echo yes || echo no)"
chk "stored as +1 E.164           " "+12065551234" "$(psql "SELECT user_phone FROM orders WHERE id='$US_OID';")"
chk "paymentMethod is manual      " "manual" "$(echo "$US_CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['paymentMethod'])")"
chk "no dead USSD link offered    " "None" "$(echo "$US_CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['ussdUri'])")"
chk "  ...explains why            " "yes" "$(echo "$US_CREATE" | grep -qi 'somali numbers' && echo yes || echo no)"
SO_CREATE=$(curl -sk -X POST -H "Authorization: Bearer $SO_TOK" -H 'Content-Type: application/json' -d '{"items":[],"totalAmount":4.00,"landmark":"Mogadishu test"}' $B/orders)
chk "somali order still gets USSD " "ussd" "$(echo "$SO_CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['paymentMethod'])")"
chk "  ...with %23-encoded hash   " "yes" "$(echo "$SO_CREATE" | grep -q '%23' && echo yes || echo no)"

echo
echo "── 5. US customer gets the full feature set ──"
chk "chat works                   " 201 "$(code -X POST -H "Authorization: Bearer $US_TOK" -H 'Content-Type: application/json' -d '{"body":"hello from the US"}' $B/orders/$US_OID/messages)"
chk "timeline works               " 200 "$(code -H "Authorization: Bearer $US_TOK" $B/orders/$US_OID/timeline)"
chk "photos list works            " 200 "$(code -H "Authorization: Bearer $US_TOK" $B/orders/$US_OID/photos)"
chk "resume list works            " 200 "$(code -H "Authorization: Bearer $US_TOK" $B/orders/mine)"
chk "still cannot see SO order    " 404 "$(code -H "Authorization: Bearer $US_TOK" $B/orders/$OID)"
chk "SO cannot see the US order   " 404 "$(code -H "Authorization: Bearer $SO_TOK" $B/orders/$US_OID)"

echo
echo "── 6. Operator can mark a US order paid (the manual rail) ──"
OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "mark-paid on the US order    " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{}' $B/operator/orders/$US_OID/mark-paid)"
chk "  ...order advanced          " "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$US_OID';")"
chk "  ...attributed to a person  " "yes" "$(psql "SELECT actor FROM order_events WHERE order_id='$US_OID' ORDER BY id DESC LIMIT 1;" | grep -q 'hodan' && echo yes || echo no)"

echo
echo "── 7. Bare 10-digit input is still rejected (Somali typo protection) ──"
chk "bare US number refused       " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"phone":"2065551234"}' $B/auth/otp/request)"
chk "somali typo refused          " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"phone":"6123456789"}' $B/auth/otp/request)"
chk "validate endpoint agrees     " "false" "$(curl -sk $B/phone/validate/2065551234 | python3 -c "import sys,json;print(str(json.load(sys.stdin)['valid']).lower())")"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
