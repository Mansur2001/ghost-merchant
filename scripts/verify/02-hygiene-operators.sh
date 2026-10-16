#!/bin/bash
# P0 #4 (prod hygiene) + #5 (named operator accounts) verification against the live stack.
# Assumes a freshly seeded dev stack: operators admin/change-me-please-1, hodan/seeded-operator-pw-1.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"   # provides psql()

# Make the suite re-runnable: drop the account it creates, so a second run isn't a cascade of
# 409s. (A test that only passes on a fresh database hides regressions behind noise.)
psql "DELETE FROM operators WHERE username IN ('testop','testop2');" >/dev/null 2>&1
hdr()  { curl -skI "$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }

echo "── P0 #4a. Security headers on API responses ──"
H=$(curl -skI $B/health | tr -d '\r')
chk "X-Content-Type-Options       " "nosniff" "$(echo "$H" | grep -i '^x-content-type-options:' | cut -d' ' -f2-)"
chk "X-Frame-Options              " "DENY" "$(echo "$H" | grep -i '^x-frame-options:' | cut -d' ' -f2-)"
chk "Cache-Control                " "no-store" "$(echo "$H" | grep -i '^cache-control:' | cut -d' ' -f2-)"
chk "Referrer-Policy              " "no-referrer" "$(echo "$H" | grep -i '^referrer-policy:' | cut -d' ' -f2-)"
chk "x-powered-by removed         " "" "$(echo "$H" | grep -i '^x-powered-by:' | cut -d' ' -f2-)"
chk "X-Request-Id present         " "yes" "$([ -n "$(echo "$H" | grep -i '^x-request-id:')" ] && echo yes || echo no)"
chk "HSTS absent in dev           " "" "$(echo "$H" | grep -i '^strict-transport-security:' | cut -d' ' -f2-)"

echo
echo "── P0 #4b. Static PWA headers (Caddy) ──"
CSP=$(hdr https://localhost/ content-security-policy)
chk "CSP present on the PWA       " "yes" "$([ -n "$CSP" ] && echo yes || echo no)"
chk "CSP blocks inline script     " "yes" "$(echo "$CSP" | grep -q "script-src 'self'" && echo yes || echo no)"
chk "CSP forbids framing          " "yes" "$(echo "$CSP" | grep -q "frame-ancestors 'none'" && echo yes || echo no)"
chk "Permissions-Policy present   " "yes" "$([ -n "$(hdr https://localhost/ permissions-policy)" ] && echo yes || echo no)"
chk "no inline <script> in shell  " "0" "$(curl -sk https://localhost/ | grep -c '<script>')"

echo
echo "── P0 #4c. Error handling ──"
chk "unknown API route -> 404     " 404 "$(code $B/does/not/exist)"
chk "  ...and JSON, not HTML      " "yes" "$(curl -sk $B/does/not/exist | grep -q '"error"' && echo yes || echo no)"
chk "malformed JSON -> 400        " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{oops' $B/operator/login)"
BADJSON=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{oops' $B/operator/login)
chk "  ...no stack trace leaked   " "yes" "$(echo "$BADJSON" | grep -q ' at ' && echo no || echo yes)"
chk "  ...carries a requestId     " "yes" "$(echo "$BADJSON" | grep -q requestId && echo yes || echo no)"
chk "oversized JSON body -> 413   " 413 "$(python3 -c "print('{\"a\":\"'+'x'*40000+'\"}')" | curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- $B/orders)"

echo
echo "── P0 #5a. Named operator login ──"
chk "old password-only login fails" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"password":"seeded-operator-pw-1"}' $B/operator/login)"
LOGIN=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login)
TOK=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "username+password login      " "yes" "$([ -n "$TOK" ] && echo yes || echo no)"
chk "username is case-insensitive " 200 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"  HODAN ","password":"seeded-operator-pw-1"}' $B/operator/login)"
# A username the seed deliberately never creates: the point is that "no such account" and
# "wrong password" answer identically, so the difference can't enumerate the staff roster.
NOUSER=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"no-such-operator","password":"seeded-operator-pw-1"}' $B/operator/login)
BADPW=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"hodan","password":"wrong-password-here"}' $B/operator/login)
chk "no-such-user == wrong-pw     " "$NOUSER" "$BADPW"
chk "GET /operator/me             " 200 "$(code -H "Authorization: Bearer $TOK" $B/operator/me)"
chk "  ...never returns the hash  " "yes" "$(curl -sk -H "Authorization: Bearer $TOK" $B/operator/me | grep -q password_hash && echo no || echo yes)"
# Staff management is ADMIN-only; hodan dispatches. The seeded admin manages the roster.
ATOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"change-me-please-1"}' $B/operator/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "roster is admin-only         " 403 "$(code -H "Authorization: Bearer $TOK" $B/operator/operators)"
chk "roster excludes hashes       " "yes" "$(curl -sk -H "Authorization: Bearer $ATOK" $B/operator/operators | grep -q password_hash && echo no || echo yes)"

echo
echo "── P0 #5b. Account creation: admin creates, the person sets their own password ──"
# Nobody types another person's password. The admin creates the account; a one-time setup code
# goes to the person's phone (the log transport here, so the code comes back as devCode).
mk() { curl -sk -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2" $B/operator/operators; }
mkc() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2" $B/operator/operators; }
CREATED=$(mk "$ATOK" '{"username":"testop","displayName":"Test Op","phone":"+12065550142"}')
SETUP=$(echo "$CREATED" | python3 -c "import sys,json;print(json.load(sys.stdin).get('devCode',''))")
chk "admin creates by invite      " "yes" "$([ -n "$SETUP" ] && echo yes || echo no)"
chk "non-admin cannot create      " 403 "$(mkc "$TOK" '{"username":"sneaky","displayName":"X","phone":"+12065550143"}')"
chk "unauthenticated create -> 401" 401 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"username":"sneaky","displayName":"X","phone":"+12065550143"}' $B/operator/operators)"
chk "duplicate username -> 409    " 409 "$(mkc "$ATOK" '{"username":"testop","displayName":"Dup","phone":"+12065550144"}')"
chk "duplicate is case-insensitive" 409 "$(mkc "$ATOK" '{"username":"TESTOP","displayName":"Dup","phone":"+12065550144"}')"
chk "bad username chars -> 400    " 400 "$(mkc "$ATOK" '{"username":"bad user!","displayName":"X","phone":"+12065550145"}')"
chk "no usable password yet       " 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login)"
claim() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"role\":\"operator\",\"phone\":\"+12065550142\",\"code\":\"$SETUP\",\"secret\":\"$1\"}" $B/staff/setup; }
chk "short password -> 400        " 400 "$(claim short)"
chk "password contains username   " 400 "$(claim testop-testop-x)"
chk "person sets own password     " 200 "$(claim a-good-long-password)"
chk "setup code is single-use     " 401 "$(claim another-good-password)"
chk "they can log in              " 200 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login)"

echo
echo "── P0 #5c. Deactivation guards ──"
# pg returns BIGINT as a JSON string, so the id may or may not be quoted.
ME_ID=$(curl -sk -H "Authorization: Bearer $TOK" $B/operator/me | python3 -c "import sys,json;print(json.load(sys.stdin)['operator']['id'])")
ADMIN_ID=$(curl -sk -H "Authorization: Bearer $ATOK" $B/operator/me | python3 -c "import sys,json;print(json.load(sys.stdin)['operator']['id'])")
chk "cannot deactivate yourself   " 400 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"active":false}' $B/operator/operators/$ADMIN_ID/active)"
chk "last admin cannot be demoted " 409 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"admin":false}' $B/operator/operators/$ADMIN_ID/admin)"
TEST_ID=$(curl -sk -H "Authorization: Bearer $ATOK" $B/operator/operators | python3 -c "import sys,json;print([o['id'] for o in json.load(sys.stdin)['operators'] if o['username']=='testop'][0])")
chk "deactivate another operator  " 200 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"active":false}' $B/operator/operators/$TEST_ID/active)"
chk "deactivated cannot log in    " 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login)"
chk "reactivate                   " 200 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"active":true}' $B/operator/operators/$TEST_ID/active)"
chk "reactivated can log in again " 200 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login)"

echo
echo "── P0 #5d. Password change ──"
TTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
pw() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TTOK" -H 'Content-Type: application/json' -d "$1" $B/operator/me/password; }
chk "wrong current password -> 401" 401 "$(pw '{"currentPassword":"nope-nope-nope","newPassword":"another-long-password"}')"
chk "reusing the same password    " 400 "$(pw '{"currentPassword":"a-good-long-password","newPassword":"a-good-long-password"}')"
chk "too-short new password       " 400 "$(pw '{"currentPassword":"a-good-long-password","newPassword":"short"}')"
chk "change succeeds              " 200 "$(pw '{"currentPassword":"a-good-long-password","newPassword":"another-long-password"}')"
chk "old password now rejected    " 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"a-good-long-password"}' $B/operator/login)"
chk "new password works           " 200 "$(code -X POST -H 'Content-Type: application/json' -d '{"username":"testop","password":"another-long-password"}' $B/operator/login)"

echo
echo "── P0 #5e. Audit trail names the person ──"
# Order ids are UUIDs; resolve the pending order by status (the seed makes it unique).
PENDING_ID=$(psql "SELECT id FROM orders WHERE status='PENDING_PAYMENT' LIMIT 1;")
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}' $B/operator/orders/$PENDING_ID/mark-paid
ACTOR=$(psql "SELECT actor FROM order_events WHERE order_id='$PENDING_ID' ORDER BY id DESC LIMIT 1;")
chk "mark-paid attributed to hodan" "operator:$ME_ID:hodan" "$ACTOR"
chk "  ...not the old shared actor" "yes" "$([ "$ACTOR" = "operator:super" ] && echo no || echo yes)"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
