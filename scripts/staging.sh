#!/bin/bash
# Local staging: the whole stack built from your working tree, with its own throwaway data, at
# https://localhost:8444. See your changes and click through every workflow without pushing to
# the VPS. The Playwright suite (e2e/) runs against it.
#
#   ./scripts/staging.sh up        build from the working tree and start (seeds a fresh stack)
#   ./scripts/staging.sh open      open the three apps in your browser
#   ./scripts/staging.sh test      run the Playwright workflows (args pass through to Playwright)
#   ./scripts/staging.sh seed      reset staging data to the seed
#   ./scripts/staging.sh shots     Play Store screenshots + feature graphic -> play-screenshots/
#   ./scripts/staging.sh logs      follow the backend log (login codes appear here too)
#   ./scripts/staging.sh status    what's running
#   ./scripts/staging.sh psql "SQL"  one query against the staging database
#   ./scripts/staging.sh down      stop (keeps data)
#   ./scripts/staging.sh reset     stop and DELETE staging data, then start fresh
#
# Separate Compose project from the dev stack (gurikaabe-staging), so both can run at once and
# neither can touch the other's data. Codes are never really sent: OTP_TRANSPORT=log, and the
# app shows them on screen.
set -euo pipefail
cd "$(dirname "$0")/.."

URL=https://localhost:8444
ENV_FILE=.env.staging
dc() {
  docker compose -p gurikaabe-staging --env-file "$ENV_FILE" \
    -f docker-compose.yml -f docker-compose.staging.yml "$@"
}

# First run: write .env.staging from the template with throwaway values. Git-ignored like .env;
# nothing in it is a real credential, and it never holds Twilio keys, so staging can't text anyone.
ensure_env() {
  [ -f "$ENV_FILE" ] && return
  echo "── creating $ENV_FILE (throwaway staging values) ──"
  local pg s3 ss
  pg=$(openssl rand -hex 16); s3=$(openssl rand -hex 16); ss=$(openssl rand -hex 32)
  sed \
    -e "s|change_me_strong_password|$pg|g" \
    -e "s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=$s3|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$ss|" \
    -e "s|^NODE_ENV=.*|NODE_ENV=development|" \
    -e "s|^OTP_TRANSPORT=.*|OTP_TRANSPORT=log|" \
    -e "s|^CORS_ORIGINS=.*|CORS_ORIGINS=$URL,http://localhost:8081,https://localhost,http://localhost,capacitor://localhost|" \
    -e "s|^OPERATOR_PASSWORD=.*|OPERATOR_PASSWORD=staging-bootstrap-$(openssl rand -hex 4)|" \
    -e "s|^EVC_MERCHANT=.*|EVC_MERCHANT=612345678|" \
    -e "s|^EVC_USSD=.*|EVC_USSD=*712*{NUM}*{AMT}%23|" \
    .env.example > "$ENV_FILE"
  {
    echo
    echo "# STAGING ONLY. The EVC wallet above is a test number so the pay buttons render;"
    echo "# staging is bound to 127.0.0.1, so no phone can open it and dial."
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

wait_healthy() {
  printf 'waiting for %s ' "$URL"
  for _ in $(seq 1 90); do
    if [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "$URL/api/health")" = "200" ]; then
      echo ' up'; return 0
    fi
    printf '.'; sleep 2
  done
  echo; echo "staging didn't come up — ./scripts/staging.sh logs"; exit 1
}

# Wipes every domain table (staging is throwaway; that's the point) and loads the fixed seed.
seed() {
  dc exec -T -e SEED_CONFIRM=wipe-local-data backend npm run seed >/dev/null
  echo "seeded: operators admin / change-me-please-1, hodan / seeded-operator-pw-1;"
  echo "        drivers 619876543 / 1234 (Amina), 651112223 / 5678 (Bashir)"
}

psql_staging() {
  local user db
  user=$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2-)
  db=$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2-)
  dc exec -T postgres psql -U "$user" -d "$db" -tAc "$1"
}

up() {
  ensure_env
  [ -f minio.license ] || { echo "minio.license is missing (MinIO won't start without it)"; exit 1; }
  dc up -d --build
  wait_healthy
  # Seed a brand-new stack only, so an `up` after a code change keeps what you were testing.
  if [ "$(psql_staging 'SELECT count(*) FROM operators;' | tr -d ' ')" -le 1 ]; then seed; fi
  cat <<EOF

Staging is up (built from your working tree):
  Customer  $URL/
  Driver    $URL/driver/
  Operator  $URL/operator/
Your browser warns once about the local certificate — accept it.
Login codes appear on screen. Re-run "up" after a change; frontend-only edits just need a reload.
EOF
}

case "${1:-}" in
  up) up ;;
  down) dc down ;;
  reset) dc down -v; up ;;
  seed) seed ;;
  logs) dc logs -f backend ;;
  status) dc ps ;;
  psql) psql_staging "${2:?usage: staging.sh psql \"SELECT ...\"}" ;;
  open) open "$URL/"; open "$URL/operator/"; open "$URL/driver/" ;;
  test)
    shift
    wait_healthy
    # Rate limits live in Redis and are per IP: every test run comes from 127.0.0.1, so clear
    # them first or the third run in an hour fails on "too many code requests".
    dc exec -T redis sh -c 'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null || true
    cd e2e
    [ -d node_modules ] || { npm install; npx playwright install chromium; }
    STAGING_URL="$URL" npx playwright test "$@"
    ;;
  shots)
    # Store graphics from the seed only (never real customers): reseed so they're reproducible.
    wait_healthy
    seed
    dc exec -T redis sh -c 'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null || true
    cd e2e
    [ -d node_modules ] || { npm install; npx playwright install chromium; }
    STAGING_URL="$URL" node play-assets.mjs
    ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
