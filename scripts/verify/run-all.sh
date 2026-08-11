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

if [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 https://localhost/api/health)" != "200" ]; then
  echo "Stack is not up (or still booting). Run: docker compose up -d --build"
  exit 1
fi

reset_stack() {
  echo "── resetting stack (clears rate-limit counters + reseeds) ──"
  # Rate-limit counters live in Redis when it's configured, so they now SURVIVE a backend
  # restart — which is the whole point of sharing them across instances, and exactly why the
  # old "just restart the backend" reset silently stopped working. Clear the keys directly.
  # Scoped to rl:* so nothing else in Redis is touched.
  docker compose exec -T redis sh -c \
    'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null 2>&1 || true
  docker compose restart backend >/dev/null 2>&1
  # Wait for a real 200. `curl` exits 0 on a 502 too — Caddy answers even while the backend is
  # still starting — so testing the exit code alone lets the suite race a booting backend and
  # report a wall of false failures. Boot now includes `prisma migrate deploy`, so this got
  # slower and the bug became visible.
  for _ in $(seq 1 60); do
    [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 https://localhost/api/health)" = "200" ] && break
    sleep 1
  done
  docker compose exec -T backend npm run seed >/dev/null 2>&1
}

export OPERATOR_USERNAME=${OPERATOR_USERNAME:-hodan}
export OPERATOR_PASSWORD=${OPERATOR_PASSWORD:-seeded-operator-pw-1}
export ORACLE_WEBHOOK_SECRET=${ORACLE_WEBHOOK_SECRET:-$(grep -E '^ORACLE_WEBHOOK_SECRET=' .env | cut -d= -f2-)}

total_fail=0
# [0-9]* rather than 0* — a tenth suite must not silently stop being run.
for suite in scripts/verify/[0-9]*.sh; do
  [ "$(basename "$suite")" = "run-all.sh" ] && continue
  reset_stack
  echo
  echo "═══ $(basename "$suite") ═══"
  bash "$suite" || total_fail=$((total_fail + 1))
done

# Node suites run from backend/ so `ws` resolves from backend/node_modules.
run_node_suite() {
  local suite="$1"
  reset_stack
  echo
  echo "═══ $(basename "$suite") ═══"
  cp "$suite" backend/.verify-tmp.mjs
  (cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node .verify-tmp.mjs) || total_fail=$((total_fail + 1))
  rm -f backend/.verify-tmp.mjs
}

run_node_suite scripts/verify/05-websocket.mjs

# The multi-instance suite only means anything with the stack scaled up, and scaling is a
# deliberate act — skip it rather than reporting a failure that is really "not configured".
instances=$(docker compose ps backend --format '{{.Name}}' | wc -l | tr -d ' ')
if [ "$instances" -ge 2 ]; then
  run_node_suite scripts/verify/06-multi-instance.mjs
else
  echo
  echo "═══ 06-multi-instance.mjs ═══"
  echo "  SKIP  only $instances backend instance running."
  echo "        Run: docker compose up -d --scale backend=2  (then re-run this script)"
fi

echo
if [ "$total_fail" -eq 0 ]; then
  echo "✅ all live suites passed"
else
  echo "❌ $total_fail suite(s) failed"
fi
exit "$total_fail"
