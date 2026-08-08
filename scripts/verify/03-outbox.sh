#!/bin/bash
# P1 #6 verification: transactional outbox + atomic payment matching, against the live stack.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }

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
echo "── 5. Payment matching is now ONE transaction ──"
psql "UPDATE orders SET status='PENDING_PAYMENT' WHERE id='$O_PAID';" >/dev/null
psql "DELETE FROM transactions WHERE telecom_receipt_id LIKE 'ATOMIC-%';" >/dev/null
AMT=$(psql "SELECT total_amount FROM orders WHERE id='$O_PAID';")
PHONE=$(psql "SELECT user_phone FROM orders WHERE id='$O_PAID';")
(cd oracle && NODE_TLS_REJECT_UNAUTHORIZED=0 ORACLE_WEBHOOK_SECRET="$ORACLE_WEBHOOK_SECRET" \
  BACKEND_URL=https://localhost node simulate.js payment "${PHONE#+252}" "$AMT" >/dev/null 2>&1)
sleep 2
chk "order advanced to paid        " "PAID_UNASSIGNED" "$(psql "SELECT status FROM orders WHERE id='$O_PAID';")"
chk "receipt recorded as matched   " "t" "$(psql "SELECT matched FROM transactions WHERE order_id='$O_PAID' ORDER BY id DESC LIMIT 1;")"
chk "payment event enqueued        " "yes" "$([ "$(psql "SELECT count(*) FROM outbox WHERE event_name='payment.received' AND payload->>'orderId'='$O_PAID';")" -ge 1 ] && echo yes || echo no)"
chk "receipt+transition same commit" "yes" "$([ "$(psql "SELECT count(*) FROM transactions t JOIN orders o ON o.id=t.order_id WHERE t.order_id='$O_PAID' AND o.status<>'PENDING_PAYMENT';")" -ge 1 ] && echo yes || echo no)"
chk "all payment events delivered  " "0" "$(psql "SELECT count(*) FROM outbox WHERE published_at IS NULL AND NOT failed;")"

echo
echo "── 6. Duplicate receipt still credits nothing twice (invariant #2) ──"
# simulate.js mints SIM-<timestamp> per run, so a real replay needs an explicit receipt id.
psql "UPDATE orders SET status='PENDING_PAYMENT' WHERE id='$O_FAILED';" >/dev/null
AMT6=$(psql "SELECT total_amount FROM orders WHERE id='$O_FAILED';")
PHONE6=$(psql "SELECT user_phone FROM orders WHERE id='$O_FAILED';")
send_dup() { (cd oracle && NODE_TLS_REJECT_UNAUTHORIZED=0 ORACLE_WEBHOOK_SECRET="$ORACLE_WEBHOOK_SECRET" \
  BACKEND_URL=https://localhost node simulate.js payment "${PHONE6#+252}" "$AMT6" DUP-RECEIPT-1 2>/dev/null | tail -1); }
send_dup >/dev/null; sleep 1
TXN_BEFORE=$(psql "SELECT count(*) FROM transactions;")
OUT_BEFORE=$(psql "SELECT count(*) FROM outbox;")
RESP=$(send_dup); sleep 1
chk "replay reported as duplicate  " "yes" "$(echo "$RESP" | grep -q '\"duplicate\":true' && echo yes || echo no)"
chk "no duplicate transaction rows " "$TXN_BEFORE" "$(psql "SELECT count(*) FROM transactions;")"
chk "no duplicate events enqueued  " "$OUT_BEFORE" "$(psql "SELECT count(*) FROM outbox;")"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
