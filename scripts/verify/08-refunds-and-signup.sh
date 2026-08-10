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
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
