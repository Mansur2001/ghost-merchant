#!/bin/bash
# P1 #6 verification: transactional outbox + atomic payment matching, against the live stack.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"   # provides psql()

# Order ids are UUIDs; the seed guarantees exactly one order per status, so resolve by that.
byStatus() { psql "SELECT id FROM orders WHERE status='$1' LIMIT 1;"; }
O_PENDING=$(byStatus PENDING_PAYMENT)
O_PAID=$(byStatus PAID_UNASSIGNED)
O_DISPATCHED=$(byStatus DISPATCHED)
O_FAILED=$(byStatus FAILED_REFUND)

OTOK=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hodan","password":"seeded-operator-pw-1"}' $B/operator/login |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

echo "── 1. Events are written in the same transaction as the state change ──"
BEFORE=$(psql "SELECT count(*) FROM outbox;")
curl -sk -o /dev/null -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' \
  -d '{}' $B/operator/orders/$O_PENDING/mark-paid
sleep 1
AFTER=$(psql "SELECT count(*) FROM outbox;")
chk "outbox grew on a transition   " "yes" "$([ "$AFTER" -gt "$BEFORE" ] && echo yes || echo no)"
chk "state change + event committed" "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$O_PENDING';")"
chk "event recorded for that order " "1" "$(psql "SELECT count(*) FROM outbox WHERE event_name='order.state_changed' AND payload->>'orderId'='$O_PENDING';")"

echo
echo "── 2. The relay delivers and marks rows ──"
chk "nothing left pending          " "0" "$(psql "SELECT count(*) FROM outbox WHERE published_at IS NULL AND NOT failed;")"
chk "nothing parked                " "0" "$(psql "SELECT count(*) FROM outbox WHERE failed;")"
chk "delivered rows are stamped    " "yes" "$([ "$(psql "SELECT count(*) FROM outbox WHERE published_at IS NOT NULL;")" -gt 0 ] && echo yes || echo no)"

echo
echo "── 3. Health endpoint reflects the queue ──"
HEALTH=$(curl -sk -H "Authorization: Bearer $OTOK" $B/operator/outbox)
chk "reports zero backlog          " "yes" "$(echo "$HEALTH" | grep -q '"pending":0' && echo yes || echo no)"
chk "unauthenticated is refused    " 401 "$(curl -sk -o /dev/null -w '%{http_code}' $B/operator/outbox)"

echo
echo "── 4. CRASH SAFETY: an event committed while the relay is dead is still delivered ──"
# Simulate the exact gap the outbox exists to close: stop the process, write a state change
# directly (as a command's transaction would), then restart and confirm it goes out.
docker compose stop backend >/dev/null 2>&1
psql "INSERT INTO outbox(event_name, payload) VALUES ('order.state_changed', '{\"orderId\":3,\"from\":\"DISPATCHED\",\"to\":\"IN_TRANSIT\",\"actor\":\"crash-test\"}'::jsonb);" >/dev/null
STRANDED=$(psql "SELECT count(*) FROM outbox WHERE published_at IS NULL;")
chk "event stranded while down     " "1" "$STRANDED"
docker compose start backend >/dev/null 2>&1
sleep 8
chk "relayed on restart            " "0" "$(psql "SELECT count(*) FROM outbox WHERE published_at IS NULL AND NOT failed;")"
chk "  ...and marked delivered     " "1" "$(psql "SELECT count(*) FROM outbox WHERE payload->>'actor'='crash-test' AND published_at IS NOT NULL;")"

echo
echo "── 5. Confirming a payment is ONE transaction ──"
# No device reads receipts: the operator confirms. Payment row + status change + event must
# commit together, or a refund later wouldn't know the order was ever paid.
psql "UPDATE orders SET status='PENDING_PAYMENT' WHERE id='$O_PAID';" >/dev/null
psql "DELETE FROM transactions WHERE order_id='$O_PAID';" >/dev/null
REF="VERIFY$$"
chk "operator confirms with a ref  " 200 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d "{\"reference\":\"$REF\"}" $B/operator/orders/$O_PAID/mark-paid)"
sleep 2
chk "order advanced to paid        " "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$O_PAID';")"
chk "payment recorded with its ref " "$REF" "$(psql "SELECT telecom_receipt_id FROM transactions WHERE order_id='$O_PAID' ORDER BY id DESC LIMIT 1;")"
chk "payment event enqueued        " "yes" "$([ "$(psql "SELECT count(*) FROM outbox WHERE event_name='payment.received' AND payload->>'orderId'='$O_PAID';")" -ge 1 ] && echo yes || echo no)"
chk "all payment events delivered  " "0" "$(psql "SELECT count(*) FROM outbox WHERE published_at IS NULL AND NOT failed;")"

echo
echo "── 6. One payment can't confirm two orders (invariant #2) ──"
psql "UPDATE orders SET status='PENDING_PAYMENT' WHERE id='$O_FAILED';" >/dev/null
TXN_BEFORE=$(psql "SELECT count(*) FROM transactions;")
OUT_BEFORE=$(psql "SELECT count(*) FROM outbox;")
# Same reference, different spacing/case: normalized, so it still collides.
REUSE=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d "{\"reference\":\" $(echo $REF | tr A-Z a-z) \"}" $B/operator/orders/$O_FAILED/mark-paid)
chk "reused reference refused      " 409 "$REUSE"
chk "  ...order still unpaid       " "PENDING_PAYMENT" "$(psql "SELECT status FROM orders WHERE id='$O_FAILED';")"
chk "  ...no extra payment rows    " "$TXN_BEFORE" "$(psql "SELECT count(*) FROM transactions;")"
chk "  ...no extra events          " "$OUT_BEFORE" "$(psql "SELECT count(*) FROM outbox;")"
chk "confirming twice is refused   " 409 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $OTOK" -H 'Content-Type: application/json' -d '{}' $B/operator/orders/$O_PAID/mark-paid)"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
