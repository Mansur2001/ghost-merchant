#!/bin/bash
# P0 auth verification against the live stack. Every check asserts an EXPECTED status code;
# a mismatch prints FAIL. Run against a freshly seeded dev stack.
B="https://localhost/api"
C="curl -sk -o /dev/null -w %{http_code}"
pass=0; fail=0

chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL  $1 — expected $2, got $3"; fail=$((fail+1)); fi
}

# Order ids are UUIDs now. The seed inserts every order in ONE transaction, so created_at is
# identical across them and UUID order is random — resolve by status instead, which the seed
# guarantees is unique (exactly one order per state).
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }
byStatus() { psql "SELECT id FROM orders WHERE status='$1' LIMIT 1;"; }
O1=$(byStatus PENDING_PAYMENT)   # +252612345678
O2=$(byStatus PAID_UNASSIGNED)   # +252651234567, unassigned
O3=$(byStatus DISPATCHED)        # +252771234567, driver 1 (Amina)
O4=$(byStatus IN_TRANSIT)        # +252612345678, driver 1
O5=$(byStatus DELIVERED)         # +252651234567, driver 2 (Bashir)
O6=$(byStatus FAILED_REFUND)     # +252771234567
OIDS=("$O1" "$O2" "$O3" "$O4" "$O5" "$O6")

echo "── 1. Unauthenticated reads of order data (the old IDOR) ──"
chk "GET /orders/1                 " 401 "$($C $B/orders/$O1)"
chk "GET /orders/1/messages        " 401 "$($C $B/orders/$O1/messages)"
chk "GET /orders/1/timeline        " 401 "$($C $B/orders/$O1/timeline)"
chk "GET /orders/1/photos          " 401 "$($C $B/orders/$O1/photos)"
chk "POST /orders/1/messages       " 401 "$($C -X POST -H 'Content-Type: application/json' -d '{"body":"hi"}' $B/orders/$O1/messages)"
chk "POST /orders (create)         " 401 "$($C -X POST -H 'Content-Type: application/json' -d '{"userPhone":"612345678","items":[],"totalAmount":1,"landmark":"x"}' $B/orders)"
chk "GET /orders/by-phone (removed)" 404 "$($C $B/orders/by-phone/%2B252612345678)"
chk "GET /orders/mine              " 401 "$($C $B/orders/mine)"

echo
echo "── 2. OTP login for +252612345678 (owner of orders 1 and 4) ──"
REQ=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"phone":"612345678"}' $B/auth/otp/request)
CODE=$(echo "$REQ" | sed -n 's/.*"devCode":"\([0-9]*\)".*/\1/p')
if [ -n "$CODE" ]; then echo "  PASS  code issued ($CODE)"; pass=$((pass+1)); else echo "  FAIL  no devCode in: $REQ"; fail=$((fail+1)); fi

chk "wrong code rejected           " 401 "$($C -X POST -H 'Content-Type: application/json' -d '{"phone":"612345678","code":"000000"}' $B/auth/otp/verify)"

VER=$(curl -sk -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"612345678","code":"%s"}' "$CODE")" $B/auth/otp/verify)
TOK=$(echo "$VER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOK" ]; then echo "  PASS  token issued"; pass=$((pass+1)); else echo "  FAIL  no token in: $VER"; fail=$((fail+1)); fi
A="-H \"Authorization: Bearer $TOK\""

PAYLOAD=$(printf '{"phone":"612345678","code":"%s"}' "$CODE")
chk "code is single-use (replay)   " 401 "$(curl -sk -o /dev/null -w %{http_code} -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" $B/auth/otp/verify)"

echo
echo "── 3. Authorized access with that session ──"
chk "GET /auth/me                  " 200 "$($C -H "Authorization: Bearer $TOK" $B/auth/me)"
chk "own order   #1                " 200 "$($C -H "Authorization: Bearer $TOK" $B/orders/$O1)"
chk "own order   #4                " 200 "$($C -H "Authorization: Bearer $TOK" $B/orders/$O4)"
chk "GET /orders/mine              " 200 "$($C -H "Authorization: Bearer $TOK" $B/orders/mine)"

echo
echo "── 4. Cross-customer access (orders 2,3,5,6 belong to other numbers) ──"
for id in 2 3 5 6; do
  chk "other customer's order #$id   " 404 "$($C -H "Authorization: Bearer $TOK" $B/orders/${OIDS[$((id-1))]})"
done
chk "other's messages       #2     " 404 "$($C -H "Authorization: Bearer $TOK" $B/orders/$O2/messages)"
chk "other's photos         #5     " 404 "$($C -H "Authorization: Bearer $TOK" $B/orders/$O5/photos)"
chk "post into other's thread #2   " 404 "$($C -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"body":"hi"}' $B/orders/$O2/messages)"

echo
echo "── 5. Tampered / forged tokens ──"
chk "garbage token                 " 401 "$($C -H "Authorization: Bearer not.a.token" $B/orders/$O1)"
chk "empty bearer                  " 401 "$($C -H "Authorization: Bearer " $B/orders/$O1)"
FORGED=$(printf '{"role":"operator","id":"super","exp":9999999999}' | base64 | tr -d '=\n' | tr '/+' '_-')
chk "forged operator payload       " 401 "$($C -H "Authorization: Bearer $FORGED.sig" $B/operator/orders)"

echo
echo "── 6. Driver scope: Amina (driver 1) owns orders 3,4 — not 5 (Bashir's) ──"
DTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"msisdn":"+252619876543","pin":"1234"}' $B/driver/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$DTOK" ]; then echo "  PASS  driver login"; pass=$((pass+1)); else echo "  FAIL  driver login"; fail=$((fail+1)); fi
chk "assigned order   #3           " 200 "$($C -H "Authorization: Bearer $DTOK" $B/driver/orders/$O3)"
chk "other driver's   #5           " 404 "$($C -H "Authorization: Bearer $DTOK" $B/driver/orders/$O5)"
chk "unassigned       #2           " 404 "$($C -H "Authorization: Bearer $DTOK" $B/driver/orders/$O2)"
chk "transition other driver's #5  " 404 "$($C -X POST -H "Authorization: Bearer $DTOK" $B/driver/orders/$O5/delivered)"
chk "customer route with driver tok" 404 "$($C -H "Authorization: Bearer $DTOK" $B/orders/$O1)"
chk "operator route with driver tok" 401 "$($C -H "Authorization: Bearer $DTOK" $B/operator/orders)"
chk "removed self-serve accept     " 404 "$($C -X POST -H "Authorization: Bearer $DTOK" $B/driver/orders/$O2/accept)"

echo
echo "── 7. Operator ──"
OP_PAYLOAD=$(printf '{"username":"%s","password":"%s"}' "${OPERATOR_USERNAME:-hodan}" "$OPERATOR_PASSWORD")
OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d "$OP_PAYLOAD" $B/operator/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$OTOK" ]; then echo "  PASS  operator login"; pass=$((pass+1)); else echo "  FAIL  operator login"; fail=$((fail+1)); fi
chk "operator sees any order  #5   " 200 "$($C -H "Authorization: Bearer $OTOK" $B/orders/$O5)"
chk "wrong password                " 401 "$($C -X POST -H 'Content-Type: application/json' -d '{"username":"hodan","password":"wrong-password-x"}' $B/operator/login)"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
