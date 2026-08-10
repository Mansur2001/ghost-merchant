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
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }

OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
chk "operator signed in            " "yes" "$([ -n "$OTOK" ] && echo yes || echo no)"

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
chk "operator marks it approved    " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"status":"approved"}' $B/operator/access-requests/$AR_ID/review)"
chk "  ...STILL no driver created  " "$DRV_BEFORE" "$(psql "SELECT count(*) FROM drivers;")"
chk "  ...decision is attributed   " "yes" "$(psql "SELECT reviewed_by FROM access_requests WHERE id=$AR_ID;" | grep -q hodan && echo yes || echo no)"
chk "an unknown status is rejected " 400 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"status":"superuser"}' $B/operator/access-requests/$AR_ID/review)"

echo
echo "── 8. Owner contact is reachable without an account ──"
CONTACT=$(curl -sk $B/signup/contact)
chk "contact endpoint is public    " 200 "$(code $B/signup/contact)"
chk "  ...carries the email        " "yes" "$(echo "$CONTACT" | grep -q 'tukale206@gmail.com' && echo yes || echo no)"
chk "  ...carries the phone        " "yes" "$(echo "$CONTACT" | grep -q '206 687 6538' && echo yes || echo no)"

echo
echo "── 9. Sensing a payment on a US rail, then reconciling it ──"
# Zelle and friends name the payer instead of giving a phone number, so these CANNOT be
# auto-matched — guessing from the amount would credit the wrong customer. They must land in
# the reconcile queue and be bindable by an operator. This path had no coverage and broke
# silently once already.
# Earlier sections deliberately refund the seeded orders, so this one makes its own fixture
# rather than depending on what is left over — a suite whose sections depend on each other's
# leftovers fails for reasons that have nothing to do with the thing under test.
# head -1 because psql appends its "INSERT 0 1" tag after the RETURNING row.
ORDER=$(psql "INSERT INTO orders(user_phone, status, total_amount, items, landmark_text)
              VALUES ('+252612345678','PENDING_PAYMENT', 33.33, '[]'::jsonb, 'reconcile fixture')
              RETURNING id;" | head -1)
AMT="33.33"
SECRET=$(grep -E '^ORACLE_WEBHOOK_SECRET=' .env | cut -d= -f2-)
SMS_BODY="Mansur T sent you \$$AMT with Zelle. Ref VERIFY$$"
PAYLOAD=$(python3 -c "import json,sys;print(json.dumps({'senderId':'Zelle','body':sys.argv[1],'receivedAt':'1'}))" "$SMS_BODY")
SIG=$(python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(),sys.argv[2].encode(),hashlib.sha256).hexdigest())" "$SECRET" "$PAYLOAD")
SENSE=$(curl -sk -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $SIG" -d "$PAYLOAD" $B/webhook)
chk "US-rail message is recognised" "yes" "$(echo "$SENSE" | grep -q '"recognised":true' && echo yes || echo no)"
chk "  ...but NOT auto-matched     " "yes" "$(echo "$SENSE" | grep -q '"matched":false' && echo yes || echo no)"
chk "  ...and flagged for the queue" "yes" "$(echo "$SENSE" | grep -q '"needsReconciliation":true' && echo yes || echo no)"
chk "  ...payer name is kept       " "MansurT" "$(psql "SELECT sender_name FROM transactions WHERE provider='zelle' ORDER BY id DESC LIMIT 1;")"

TXID=$(psql "SELECT id FROM transactions WHERE provider='zelle' AND matched=false ORDER BY id DESC LIMIT 1;")
chk "operator binds it to an order " 200 "$(code -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d "{\"orderId\":\"$ORDER\"}" $B/operator/transactions/$TXID/assign)"
chk "  ...order becomes paid       " "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$ORDER';")"
chk "  ...receipt is bound         " "t" "$(psql "SELECT matched FROM transactions WHERE id=$TXID;")"
chk "  ...audit names the operator " "yes" "$(psql "SELECT actor FROM order_events WHERE order_id='$ORDER' ORDER BY id DESC LIMIT 1;" | grep -q hodan && echo yes || echo no)"

# An ordinary text must not become a payment.
JUNK=$(python3 -c "import json;print(json.dumps({'senderId':'+12065551234','body':'are you open today?','receivedAt':'1'}))")
JSIG=$(python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(),sys.argv[2].encode(),hashlib.sha256).hexdigest())" "$SECRET" "$JUNK")
TX_BEFORE=$(psql "SELECT count(*) FROM transactions;")
curl -sk -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $JSIG" -d "$JUNK" $B/webhook
chk "an ordinary text is ignored   " "$TX_BEFORE" "$(psql "SELECT count(*) FROM transactions;")"

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
chk "applicant attaches their ID   " 201 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document)"
chk "  ...non-image is refused     " 400 "$(code -X POST -H "Authorization: Bearer $UPTOK" -H 'Content-Type: application/pdf' --data-binary @/tmp/verify-id.png $B/signup/id-document)"
chk "  ...no token is refused      " 401 "$(code -X POST -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document)"
chk "  ...a customer token is too  " 401 "$(code -X POST -H "Authorization: Bearer $UPTOK-tampered" -H 'Content-Type: image/png' --data-binary @/tmp/verify-id.png $B/signup/id-document)"

IDREQ=$(psql "SELECT id FROM access_requests WHERE phone='+12065557777' LIMIT 1;")
chk "stored, and only the key      " "yes" "$(psql "SELECT CASE WHEN id_document_key IS NOT NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "only an operator may view it  " 401 "$(code $B/operator/access-requests/$IDREQ/id-document)"
chk "  ...operator can             " 200 "$(code -H "Authorization: Bearer $OTOK" $B/operator/access-requests/$IDREQ/id-document)"
chk "  ...and it is not cached     " "yes" "$(curl -skI -H "Authorization: Bearer $OTOK" $B/operator/access-requests/$IDREQ/id-document | grep -qi 'no-store' && echo yes || echo no)"

# RETENTION — the property that keeps a routine breach from becoming identity theft.
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{"status":"declined"}' $B/operator/access-requests/$IDREQ/review
chk "decision DESTROYS the ID      " "yes" "$(psql "SELECT CASE WHEN id_document_key IS NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "  ...it is gone from storage  " 404 "$(code -H "Authorization: Bearer $OTOK" $B/operator/access-requests/$IDREQ/id-document)"
chk "  ...but we kept the PROOF    " "yes" "$(psql "SELECT CASE WHEN id_document_at IS NOT NULL THEN 'yes' ELSE 'no' END FROM access_requests WHERE id=$IDREQ;")"
chk "  ...and who decided          " "yes" "$(psql "SELECT reviewed_by FROM access_requests WHERE id=$IDREQ;" | grep -qi 'operator' && echo yes || echo no)"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
