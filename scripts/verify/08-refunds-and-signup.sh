#!/bin/bash
# Refund ledger + access requests, against the live stack.
#
# The refund ledger exists because the platform never holds customer money: a refund is an
# operator sending funds back from their own phone. If that debt isn't recorded, a refund that
# never got sent is invisible until the customer complains.
#
# Access requests exist because NOBODY may self-register as staff — an operator account reads
# every customer's address and chat.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"   # provides psql()

OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "operator signed in            " "yes" "$([ -n "$OTOK" ] && echo yes || echo no)"
# Access requests and ID documents are ADMIN-only; hodan dispatches.
ATOK=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me-please-1"}' $B/operator/login |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "admin signed in               " "yes" "$([ -n "$ATOK" ] && echo yes || echo no)"

echo
echo "── 1. Failing a PAID order opens a refund automatically ──"
PAID_ID=$(psql "SELECT id FROM orders WHERE status='PAID_UNASSIGNED' LIMIT 1;")
AMT=$(psql "SELECT total_amount FROM orders WHERE id='$PAID_ID';")
chk "refund the paid order         " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"reason":"shop closed"}' $B/operator/orders/$PAID_ID/refund)"
chk "  ...a refund row was opened  " "1" "$(psql "SELECT count(*) FROM refunds WHERE order_id='$PAID_ID' AND status='owed';")"
chk "  ...for the amount paid      " "$AMT" "$(psql "SELECT amount FROM refunds WHERE order_id='$PAID_ID';")"
chk "  ...attributed to the person " "yes" "$(psql "SELECT created_by FROM refunds WHERE order_id='$PAID_ID';" | grep -q hodan && echo yes || echo no)"

echo
echo "── 2. Failing an UNPAID order owes nothing ──"
PEND_ID=$(psql "SELECT id FROM orders WHERE status='PENDING_PAYMENT' LIMIT 1;")
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' \
  -d '{"reason":"customer cancelled"}' $B/operator/orders/$PEND_ID/refund
chk "no refund row for unpaid order" "0" "$(psql "SELECT count(*) FROM refunds WHERE order_id='$PEND_ID';")"

echo
echo "── 3. The reconciliation queue ──"
QUEUE=$(curl -sk -H "Authorization: Bearer $OTOK" $B/operator/refunds)
chk "queue lists what is owed      " "yes" "$(echo "$QUEUE" | grep -q '"refunds"' && echo yes || echo no)"
chk "  ...with a running total     " "yes" "$(echo "$QUEUE" | grep -q '"total"' && echo yes || echo no)"
chk "unauthenticated is refused    " 401 "$(code $B/operator/refunds)"
RID=$(psql "SELECT id FROM refunds WHERE order_id='$PAID_ID' AND status='owed';")

echo
echo "── 4. Settling requires proof the money moved ──"
chk "settle without a reference    " 400 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{}' $B/operator/refunds/$RID/settle)"
chk "settle WITH a reference       " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"reference":"EVC-RETURN-9911","note":"sent back"}' $B/operator/refunds/$RID/settle)"
chk "  ...status is settled        " "settled" "$(psql "SELECT status FROM refunds WHERE id=$RID;")"
chk "  ...reference stored verbatim" "EVC-RETURN-9911" "$(psql "SELECT settlement_reference FROM refunds WHERE id=$RID;")"
chk "  ...names who settled it     " "yes" "$(psql "SELECT settled_by FROM refunds WHERE id=$RID;" | grep -q hodan && echo yes || echo no)"
chk "settling twice is refused     " 409 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"reference":"EVC-RETURN-9911"}' $B/operator/refunds/$RID/settle)"
chk "  ...and it left the queue    " "0" "$(psql "SELECT count(*) FROM refunds WHERE id=$RID AND status='owed';")"

echo
echo "── 5. Waiving is distinct from settling ──"
# Conflating "we paid this back" with "nothing was owed" would make the ledger useless in the
# argument it exists to settle.
SEED_RID=$(psql "SELECT id FROM refunds WHERE status='owed' LIMIT 1;")
if [ -n "$SEED_RID" ]; then
  chk "waive without a reason       " 400 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{}' $B/operator/refunds/$SEED_RID/waive)"
  chk "waive WITH a reason          " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"note":"customer never paid"}' $B/operator/refunds/$SEED_RID/waive)"
  chk "  ...recorded as waived      " "waived" "$(psql "SELECT status FROM refunds WHERE id=$SEED_RID;")"
  chk "  ...NOT as settled          " "" "$(psql "SELECT settlement_reference FROM refunds WHERE id=$SEED_RID;")"
fi

echo
echo "── 6. Access requests grant NOTHING ──"
OPS_BEFORE=$(psql "SELECT count(*) FROM operators;")
DRV_BEFORE=$(psql "SELECT count(*) FROM drivers;")
REQ=$(printf '{"role":"driver","name":"Test Applicant","phone":"+12065551234","message":"I have a motorbike"}')
chk "anyone may apply (no auth)    " 201 "$(code -X POST -H 'Content-Type: application/json' -d "$REQ" $B/signup)"
chk "  ...NO operator was created  " "$OPS_BEFORE" "$(psql "SELECT count(*) FROM operators;")"
chk "  ...NO driver was created    " "$DRV_BEFORE" "$(psql "SELECT count(*) FROM drivers;")"
chk "  ...the request was recorded " "1" "$(psql "SELECT count(*) FROM access_requests WHERE phone='+12065551234' AND status IN ('new','contacted');")"
chk "re-applying does not stack    " 201 "$(code -X POST -H 'Content-Type: application/json' -d "$REQ" $B/signup)"
chk "  ...still one open request   " "1" "$(psql "SELECT count(*) FROM access_requests WHERE phone='+12065551234' AND status IN ('new','contacted');")"
chk "a bad role is rejected        " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"admin","name":"X","phone":"+12065551234"}' $B/signup)"
chk "a bad phone is rejected       " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"driver","name":"X","phone":"nope"}' $B/signup)"
chk "a missing name is rejected    " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"driver","name":"","phone":"+12065551234"}' $B/signup)"

echo
echo "── 7. Reviewing a request is operator-only, and still creates nothing ──"
AR_ID=$(psql "SELECT id FROM access_requests WHERE phone='+12065551234' LIMIT 1;")
chk "unauthenticated review        " 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"status":"approved"}' $B/operator/access-requests/$AR_ID/review)"
chk "non-admin cannot review       " 403 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"status":"approved"}' $B/operator/access-requests/$AR_ID/review)"
chk "admin marks it approved       " 200 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"status":"approved"}' $B/operator/access-requests/$AR_ID/review)"
chk "  ...STILL no driver created  " "$DRV_BEFORE" "$(psql "SELECT count(*) FROM drivers;")"
chk "  ...decision is attributed   " "yes" "$(psql "SELECT reviewed_by FROM access_requests WHERE id=$AR_ID;" | grep -q admin && echo yes || echo no)"
chk "an unknown status is rejected " 400 "$(code -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"status":"superuser"}' $B/operator/access-requests/$AR_ID/review)"

echo
echo "── 8. Owner contact is reachable without an account ──"
CONTACT=$(curl -sk $B/signup/contact)
chk "contact endpoint is public    " 200 "$(code $B/signup/contact)"
# Whatever the owner contact is in .env — the suite checks it is served, not what it says.
# Strip quotes and surrounding spaces, as the backend does.
envval() { grep -E "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d "\"'" | sed 's/^ *//;s/ *$//'; }
OWNER_EMAIL=$(envval OWNER_EMAIL)
OWNER_PHONE=$(envval OWNER_PHONE)
chk "  ...carries the email        " "yes" "$(echo "$CONTACT" | grep -qF "$OWNER_EMAIL" && echo yes || echo no)"
chk "  ...carries the phone        " "yes" "$(echo "$CONTACT" | grep -qF "$OWNER_PHONE" && echo yes || echo no)"

echo
echo "── 9. \"I've paid\" -> operator confirms -> a later failure still owes the money ──"
# No device reads receipts. The customer's claim only tells the operator where to look; the
# operator's confirmation records the payment, so failing the order later opens a refund.
# Its own fixture, so it doesn't depend on what earlier sections left behind.
ORDER=$(psql "INSERT INTO orders(user_phone, status, total_amount, items, landmark_text)
              VALUES ('+252612345678','PENDING_PAYMENT', 33.33, '[]'::jsonb, 'claim fixture')
              RETURNING id;" | head -1)
DEVCODE=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"phone":"+252612345678"}' $B/auth/otp/request |
  python3 -c "import sys,json;print(json.load(sys.stdin).get('devCode',''))")
CTOK=$(curl -sk -X POST -H 'Content-Type: application/json' -d "{\"phone\":\"+252612345678\",\"code\":\"$DEVCODE\"}" $B/auth/otp/verify |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "customer says \"I've paid\"     " 200 "$(code -X POST -H "Authorization: Bearer $CTOK" -H 'Content-Type: application/json' -d '{"reference":"evc 7788"}' $B/orders/$ORDER/paid)"
chk "  ...claim recorded, normalized" "EVC7788" "$(psql "SELECT payment_claim_ref FROM orders WHERE id='$ORDER';")"
chk "  ...a wallet we don't offer   " 400 "$(code -X POST -H "Authorization: Bearer $CTOK" -H 'Content-Type: application/json' -d '{"wallet":"not-a-wallet"}' $B/orders/$ORDER/paid)"
chk "  ...but the order is NOT paid " "PENDING_PAYMENT" "$(psql "SELECT status FROM orders WHERE id='$ORDER';")"
chk "  ...and no payment recorded   " "0" "$(psql "SELECT count(*) FROM transactions WHERE order_id='$ORDER';")"
DEV2=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"phone":"+252651234567"}' $B/auth/otp/request |
  python3 -c "import sys,json;print(json.load(sys.stdin).get('devCode',''))")
OTHER=$(curl -sk -X POST -H 'Content-Type: application/json' -d "{\"phone\":\"+252651234567\",\"code\":\"$DEV2\"}" $B/auth/otp/verify |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "another customer can't claim it" 404 "$(code -X POST -H 'Content-Type: application/json' -d '{}' -H "Authorization: Bearer $OTHER" $B/orders/$ORDER/paid)"

chk "operator confirms the payment  " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"reference":"EVC7788"}' $B/operator/orders/$ORDER/mark-paid)"
chk "  ...order becomes paid        " "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$ORDER';")"
chk "  ...payment recorded          " "33.33" "$(psql "SELECT amount FROM transactions WHERE order_id='$ORDER' AND matched;")"
chk "  ...audit names the operator  " "yes" "$(psql "SELECT actor FROM order_events WHERE order_id='$ORDER' ORDER BY id DESC LIMIT 1;" | grep -q hodan && echo yes || echo no)"
chk "claiming a paid order -> 409   " 409 "$(code -X POST -H "Authorization: Bearer $CTOK" -H 'Content-Type: application/json' -d '{}' $B/orders/$ORDER/paid)"

curl -sk -o /dev/null -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"reason":"shop closed"}' $B/operator/orders/$ORDER/refund
chk "failing it opens a refund      " "33.33" "$(psql "SELECT amount FROM refunds WHERE order_id='$ORDER' AND status='owed';")"

echo
echo "── 10. ID verification: the most sensitive data in the system ──"
# A leaked government ID is identity theft, not an inconvenience. Three properties must hold:
# only an operator can see it, only the applicant can attach one, and it is DESTROYED once
# the decision it supports has been made.
python3 -c "
import struct,zlib
def chunk(t,d):
    c=t+d; return struct.pack('>I',len(d))+c+struct.pack('>I',zlib.crc32(c)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00'+b'\xd4\xaf\x37'*8))+chunk(b'IEND',b'')
open('/tmp/verify-id.png','wb').write(png)"

SUB=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"role":"driver","name":"ID Test","phone":"+12065557777","message":"x"}' $B/signup)
UPTOK=$(echo "$SUB" | python3 -c "import sys,json;print(json.load(sys.stdin).get('uploadToken',''))")
chk "submit returns an upload token" "yes" "$([ -n "$UPTOK" ] && echo yes || echo no)"
chk "  ...but NOT the request id   " "yes" "$(echo "$SUB" | grep -q '\"id\"' && echo no || echo yes)"
chk "applicant attaches their ID   " 201 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document/front)"
chk "  ...non-image is refused     " 400 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: application/pdf' --data-binary @/tmp/verify-id.png $B/signup/id-document/front)"
chk "  ...no token is refused      " 401 "$(code -X POST -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document/front)"
chk "  ...a customer token is too  " 401 "$(code -X POST -H "Authorization: Bearer $UPTOK-tampered" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document/front)"

IDREQ=$(psql "SELECT id FROM access_requests WHERE phone='+12065557777' LIMIT 1;")
chk "front stored                  " "yes" "$(psql "SELECT CASE WHEN id_front_key IS NOT NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "back can be attached too      " 201 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document/back)"
chk "  ...and stored separately    " "yes" "$(psql "SELECT CASE WHEN id_back_key IS NOT NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "an invalid side is refused    " 400 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document/sideways)"
chk "only an operator may view it  " 401 "$(code $B/operator/access-requests/$IDREQ/id-document/front)"
chk "  ...an admin can             " 200 "$(code -H "Authorization: Bearer $ATOK" $B/operator/access-requests/$IDREQ/id-document/front)"
chk "  ...and it is not cached     " "yes" "$(curl -skI -H "Authorization: Bearer $ATOK" $B/operator/access-requests/$IDREQ/id-document/front | grep -qi 'no-store' && echo yes || echo no)"

# RETENTION — the property that keeps a routine breach from becoming identity theft.
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' -d '{"status":"declined"}' $B/operator/access-requests/$IDREQ/review
chk "decision DESTROYS BOTH sides  " "yes" "$(psql "SELECT CASE WHEN id_front_key IS NULL AND id_back_key IS NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "  ...it is gone from storage  " 404 "$(code -H "Authorization: Bearer $ATOK" $B/operator/access-requests/$IDREQ/id-document/front)"
chk "  ...but we kept the PROOF    " "yes" "$(psql "SELECT CASE WHEN id_document_at IS NOT NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "  ...and who decided          " "yes" "$(psql "SELECT reviewed_by FROM access_requests WHERE id=$IDREQ;" | grep -qi 'operator' && echo yes || echo no)"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
