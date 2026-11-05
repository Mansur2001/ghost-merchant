#!/bin/bash
# Stand up GuriKaabe on a fresh Ubuntu/Debian VPS, from this Mac.
#
#   ./scripts/new-server.sh env              # 1. write .env.production (fresh secrets)
#   #   ... fill in the Twilio and/or SendGrid lines it names ...
#   ./scripts/new-server.sh setup <SERVER_IP> # 2. install Docker, copy secrets, start, back up
#   ./scripts/new-server.sh check <SERVER_IP> # 3. is it healthy?
#
# DNS first: app.gurikaabe.com must point at SERVER_IP (Cloudflare, grey cloud / DNS only)
# BEFORE `setup`, or Caddy can't get its certificate. Ports 22, 80 and 443 must be open.
#
# Never prints a secret. .env.production is git-ignored, like .env.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
DOMAIN=app.gurikaabe.com
REPO=https://github.com/Mansur2001/ghost-merchant.git
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

rand() { openssl rand -hex "$1"; }
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

cmd_env() {
  if [ -f "$ENV_FILE" ]; then
    echo "$ENV_FILE already exists — not overwriting it (its secrets may already be live)."
    exit 1
  fi
  local pg s3 op
  pg=$(rand 24); s3=$(rand 24); op="Gk-$(rand 9)"
  cat > "$ENV_FILE" <<EOF
# GuriKaabe PRODUCTION settings. Generated $(date +%F) by scripts/new-server.sh.
# Git-ignored. Back it up somewhere that is not this laptop (a password manager).
NODE_ENV=production
PORT=3000
DOMAIN=$DOMAIN
CORS_ORIGINS=https://$DOMAIN,https://localhost,http://localhost,capacitor://localhost
TRUST_PROXY_HOPS=1

DATABASE_URL=postgresql://gurikaabe:$pg@postgres:5432/gurikaabe?schema=public
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=gurikaabe
POSTGRES_USER=gurikaabe
POSTGRES_PASSWORD=$pg

S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=gurikaabe-documents
S3_ACCESS_KEY=gurikaabe_$(rand 6)
S3_SECRET_KEY=$s3
S3_FORCE_PATH_STYLE=true

SESSION_SECRET=$(rand 32)
# First sign-in to the operator console: username "admin" + this. It asks you to change it.
OPERATOR_PASSWORD=$op
REDIS_URL=redis://redis:6379
# Who marks orders paid: operator today; api once a mobile-money provider is connected
# (docs/PAYMENT_API.md). The secret is pre-generated for that day.
PAYMENT_CONFIRMATION=operator
PAYMENT_WEBHOOK_SECRET=$(rand 32)

# ── Login codes. Fill in AT LEAST ONE of the two blocks, or nobody can sign in. ──
OTP_TRANSPORT=twilio
OTP_SEND_TIMEOUT_MS=10000
# Twilio SMS — console.twilio.com (docs/LIVE_SMS_SETUP.md)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_MESSAGING_SERVICE_SID=
TWILIO_FROM=
# Twilio SendGrid email — app.sendgrid.com (a verified sender address)
SENDGRID_API_KEY=
EMAIL_FROM=

# Play review login (both or neither). Not needed for internal testing.
REVIEW_PHONE=
REVIEW_CODE=

OWNER_NAME=GuriKaabe
OWNER_EMAIL=gurikaabe@gmail.com
OWNER_PHONE=+1 206 733 0555

# Wallets: each one appears only when BOTH lines are set (see .env.example). Blank = testers
# use "I've paid" and an operator confirms by hand.
EVC_MERCHANT=
EVC_USSD=
EDAHAB_MERCHANT=
EDAHAB_USSD=
ZAAD_MERCHANT=
ZAAD_USSD=
SAHAL_MERCHANT=
SAHAL_USSD=
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE with fresh secrets."
  echo "Now fill in TWILIO_* (SMS) and/or SENDGRID_API_KEY + EMAIL_FROM (email) in it, then:"
  echo "  ./scripts/new-server.sh setup <SERVER_IP>"
  echo "Your first operator login: admin / the OPERATOR_PASSWORD line in $ENV_FILE."
}

preflight() {
  [ -f "$ENV_FILE" ] || { echo "No $ENV_FILE. Run: ./scripts/new-server.sh env"; exit 1; }
  [ -f minio.license ] || { echo "No ./minio.license — MinIO AIStor won't start without it."; exit 1; }
  local sms=0 mail=0
  [ -n "$(val TWILIO_ACCOUNT_SID)" ] && [ -n "$(val TWILIO_AUTH_TOKEN)" ] && sms=1
  [ -n "$(val SENDGRID_API_KEY)" ] && [ -n "$(val EMAIL_FROM)" ] && mail=1
  if [ $sms = 0 ] && [ $mail = 0 ]; then
    echo "Refusing: $ENV_FILE has no Twilio and no SendGrid keys, so no login code could be sent"
    echo "and nobody could sign in. Fill in at least one block."
    exit 1
  fi
  echo "Code delivery: SMS $([ $sms = 1 ] && echo on || echo OFF) · email $([ $mail = 1 ] && echo on || echo OFF)"
  local ip_dns
  ip_dns=$(dig +short "$DOMAIN" | tail -1)
  if [ "$ip_dns" != "$1" ]; then
    echo "⚠  $DOMAIN points at '${ip_dns:-nothing}', not $1. Caddy can't get a certificate until"
    echo "   it does. Fix the A record in Cloudflare (DNS only), wait a minute, run setup again."
    exit 1
  fi
}

cmd_setup() {
  local ip="$1"
  preflight "$ip"
  echo "── installing Docker, firewall and backups on $ip ──"
  ssh "${SSH_OPTS[@]}" "root@$ip" bash -s <<REMOTE
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y -qq git ufw >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
[ -d /root/gurikaabe/.git ] || git clone -q $REPO /root/gurikaabe
cd /root/gurikaabe && git pull -q
mkdir -p /root/backups
# Nightly database dump at 03:15, two weeks kept. Copy them off the box too (COMMANDS.md).
cat > /etc/cron.d/gurikaabe-backup <<'CRON'
15 3 * * * root cd /root/gurikaabe && docker compose exec -T postgres sh -c 'pg_dump -U "\$POSTGRES_USER" "\$POSTGRES_DB"' | gzip > /root/backups/db-\$(date +\%F).sql.gz && find /root/backups -name 'db-*.sql.gz' -mtime +14 -delete
CRON
REMOTE
  echo "── copying secrets (never through git) ──"
  scp "${SSH_OPTS[@]}" -q "$ENV_FILE" "root@$ip:/root/gurikaabe/.env"
  scp "${SSH_OPTS[@]}" -q minio.license "root@$ip:/root/gurikaabe/minio.license"
  ssh "${SSH_OPTS[@]}" "root@$ip" 'chmod 600 /root/gurikaabe/.env /root/gurikaabe/minio.license'
  echo "── starting the stack ──"
  ssh "${SSH_OPTS[@]}" "root@$ip" 'cd /root/gurikaabe && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build'
  cmd_check "$ip"
}

cmd_check() {
  local ip="$1"
  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/api/health")" = 200 ]; then
      echo "✓ https://$DOMAIN is up."
      return 0
    fi
    sleep 5
  done
  echo "✗ https://$DOMAIN/api/health is not answering. Why:"
  ssh "${SSH_OPTS[@]}" "root@$ip" 'cd /root/gurikaabe && docker compose logs backend --tail 40 | grep -E "FATAL|Error" || docker compose ps'
  exit 1
}

case "${1:-}" in
  env) cmd_env ;;
  setup) [ -n "${2:-}" ] || { echo "usage: $0 setup <SERVER_IP>"; exit 1; }; cmd_setup "$2" ;;
  check) [ -n "${2:-}" ] || { echo "usage: $0 check <SERVER_IP>"; exit 1; }; cmd_check "$2" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
