#!/data/data/com.termux/files/usr/bin/bash
# Start the Oracle on the Termux phone.
#
# Why this exists: `export FOO=bar` only lasts for the current Termux session. Close the app,
# or let Android kill it, and the next `node termux-oracle.js` fails with
# "ORACLE_WEBHOOK_SECRET required" — which reads like the script is broken when really the
# variables just went away. Keep the settings here instead and run this.
#
#   chmod +x start-oracle.sh
#   ./start-oracle.sh

# ── EDIT THESE THREE ──────────────────────────────────────────────────────────

# Must match ORACLE_WEBHOOK_SECRET in the backend's .env EXACTLY. If they differ the backend
# rejects every webhook with 401 and payments silently never match — the failure looks like
# "the Oracle isn't seeing my SMS" when actually it is, and the signature is being refused.
export ORACLE_WEBHOOK_SECRET="change_me_long_random_hex"

# Where the backend lives.
#   Testing on your own WiFi : http://<laptop-lan-ip>:8080   (the dev listener)
#   Real deployment          : https://your-domain
export BACKEND_URL="http://172.20.2.34:8080"

# The sender IDs your telecom actually uses. Check a real receipt on this phone and copy the
# sender name verbatim — if it doesn't match, every message is ignored as "not from telecom".
export TELECOM_SENDER_IDS="EVCPlus,Somtel"

# ──────────────────────────────────────────────────────────────────────────────

# Keep the CPU awake. Android aggressively suspends background processes, and a suspended
# Oracle means payments stop being matched with no error anywhere — the operator dashboard's
# heartbeat badge going red is the only signal.
command -v termux-wake-lock >/dev/null && termux-wake-lock

# Fail early with a readable message rather than a stack trace 20 seconds in.
if ! command -v termux-sms-list >/dev/null; then
  echo "termux-sms-list not found."
  echo "  pkg install termux-api"
  echo "AND install the separate Termux:API *app* from F-Droid — the pkg is only the bridge;"
  echo "without the app, every SMS command hangs or returns nothing."
  exit 1
fi

echo "Checking the backend is reachable at $BACKEND_URL ..."
if ! curl -sf -o /dev/null --max-time 5 "$BACKEND_URL/api/health"; then
  echo "Can't reach $BACKEND_URL/api/health from this phone."
  echo "  * Is the phone on the same WiFi as the laptop?"
  echo "  * Is the stack up?  docker compose up -d"
  echo "  * Try opening $BACKEND_URL in the phone's browser first."
  exit 1
fi
echo "Backend OK."

echo "Checking SMS access (grant the permission prompt if it appears) ..."
if ! termux-sms-list -l 1 >/dev/null 2>&1; then
  echo "Can't read SMS. Grant Termux:API the SMS permission:"
  echo "  Android Settings > Apps > Termux:API > Permissions > SMS > Allow"
  exit 1
fi
echo "SMS OK."

exec node termux-oracle.js
