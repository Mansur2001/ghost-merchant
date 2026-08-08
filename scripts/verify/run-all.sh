#!/bin/bash
# Live end-to-end verification against a running stack (P1 #8).
#
# These exercise the real HTTP and WebSocket layers — authorization, OTP, rate limits, the
# outbox, UUID handling, US numbers — which the Jest suites deliberately don't touch (they
# cover pure domain logic with no DB). Run this after any change to routes, middleware or
# the schema, and before any release.
#
#   ./scripts/verify/run-all.sh
#
# The stack is RESET first (restart + reseed) because two of the things under test are
# stateful by design: the in-memory rate limiter, and account rows the suites create. A suite
# that only passes on a fresh database is a suite people quietly stop running.
set -u
cd "$(dirname "$0")/../.."

if ! curl -sk -o /dev/null --max-time 3 https://localhost/api/health; then
  echo "Stack is not up. Run: docker compose up -d --build"
  exit 1
fi

reset_stack() {
  echo "── resetting stack (clears the in-memory rate limiter + reseeds) ──"
  docker compose restart backend >/dev/null 2>&1
  for _ in $(seq 1 30); do
    curl -sk -o /dev/null --max-time 2 https://localhost/api/health && break
    sleep 1
  done
  docker compose exec -T backend npm run seed >/dev/null 2>&1
}

export OPERATOR_USERNAME=${OPERATOR_USERNAME:-hodan}
export OPERATOR_PASSWORD=${OPERATOR_PASSWORD:-seeded-operator-pw-1}
export ORACLE_WEBHOOK_SECRET=${ORACLE_WEBHOOK_SECRET:-$(grep -E '^ORACLE_WEBHOOK_SECRET=' .env | cut -d= -f2-)}

total_fail=0
for suite in scripts/verify/0*.sh; do
  [ "$(basename "$suite")" = "run-all.sh" ] && continue
  reset_stack
  echo
  echo "═══ $(basename "$suite") ═══"
  bash "$suite" || total_fail=$((total_fail + 1))
done

# The socket suite is Node (needs `ws` from backend/node_modules).
reset_stack
echo
echo "═══ 05-websocket.mjs ═══"
cp scripts/verify/05-websocket.mjs backend/.verify-ws.mjs
(cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node .verify-ws.mjs) || total_fail=$((total_fail + 1))
rm -f backend/.verify-ws.mjs

echo
if [ "$total_fail" -eq 0 ]; then
  echo "✅ all live suites passed"
else
  echo "❌ $total_fail suite(s) failed"
fi
exit "$total_fail"
