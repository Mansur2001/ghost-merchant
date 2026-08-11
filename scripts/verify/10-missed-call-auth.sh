#!/bin/bash
# Missed-call verification against the live stack.
#
# WHY THIS EXISTS: sending an SMS is what makes phone verification an infrastructure problem —
# an A2P agreement we can't get in Somalia, or a SIM that eventually looks like spam. This
# path removes the sending entirely: the customer calls a number we own from the phone they're
# registering and hangs up, and the caller ID IS the proof.
#
# Because nothing is in flight, the security argument moves. With a passcode, an attacker who
# opens a challenge for someone else's number gets nothing — the code goes to the victim's
# handset. Here the attacker is waiting for A CALL FROM THAT NUMBER, which the victim may make
# for their own reasons. So the question is who receives the session when it lands, and most
# of the checks below are about exactly that.
B="https://localhost/api"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL  $1 — expected [$2], got [$3]"; fail=$((fail+1)); fi; }
code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }
psql() { docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "$1" | tr -d ' '; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1','') if d.get('$1') is not None else '')"; }

SECRET=$(grep -E '^ORACLE_WEBHOOK_SECRET=' .env | cut -d= -f2-)
sign() { python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(),sys.argv[2].encode(),hashlib.sha256).hexdigest())" "$SECRET" "$1"; }
# Report an inbound call exactly as the Oracle device would: HMAC-signed, no session token.
ring() { curl -sk -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $(sign "$1")" -d "$1" "$B/oracle/calls"; }
ring_code() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "X-Oracle-Signature: $(sign "$1")" -d "$1" "$B/oracle/calls"; }
start() { curl -sk -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s"}' "$1")" $B/auth/call/start; }
start_code() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s"}' "$1")" $B/auth/call/start; }
status() { curl -sk -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s","ticket":"%s"}' "$1" "$2")" $B/auth/call/status; }
status_code() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s","ticket":"%s"}' "$1" "$2")" $B/auth/call/status; }
ring_json() { printf '{"calls":[{"from":"%s"}]}' "$1"; }

VICTIM="+252615550001"
OTHER="+252615550002"
psql "DELETE FROM call_challenges;" >/dev/null
# Rate-limit state lives in Redis and survives a backend restart by design, so a standalone
# re-run of this suite would otherwise trip the per-phone open limit partway through and look
# like a security property failing. run-all.sh does the same between suites.
docker compose exec -T redis sh -c \
  'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null 2>&1 || true

echo
echo "── 1. The flow the customer actually walks ──"
chk "the deployment advertises calling" "true" "$(curl -sk $B/auth/methods | python3 -c "import sys,json;print(str(json.load(sys.stdin)['call']).lower())")"
S1=$(start "$VICTIM")
T1=$(echo "$S1" | jget ticket)
chk "starting gives a claim ticket    " "yes" "$([ -n "$T1" ] && echo yes || echo no)"
chk "  ...and a number to call        " "yes" "$(echo "$S1" | jget callNumber | grep -q '^+' && echo yes || echo no)"
chk "before the call: still pending   " "pending" "$(status "$VICTIM" "$T1" | jget status)"
chk "the phone reports the call       " 200 "$(ring_code "$(ring_json "$VICTIM")")"
V=$(status "$VICTIM" "$T1")
chk "  ...now verified                " "verified" "$(echo "$V" | jget status)"
chk "  ...and a session is issued     " "yes" "$([ -n "$(echo "$V" | jget token)" ] && echo yes || echo no)"
TOKEN=$(echo "$V" | jget token)
chk "the token really works           " 200 "$(code -H "Authorization: Bearer $TOKEN" $B/orders/mine)"
chk "  ...as the right customer       " "$VICTIM" "$(curl -sk -H "Authorization: Bearer $TOKEN" $B/auth/me | jget phone)"
chk "the customer identity now exists " "1" "$(psql "SELECT count(*) FROM users WHERE phone_number='$VICTIM';")"

echo
echo "── 2. Verification is single-use ──"
# A leaked ticket must not be replayable into a second session.
chk "the challenge is consumed        " "0" "$(psql "SELECT count(*) FROM call_challenges WHERE phone='$VICTIM';")"
chk "  ...replaying the ticket fails  " 401 "$(status_code "$VICTIM" "$T1")"

echo
echo "── 3. THE HIJACK: only the client that opened the challenge gets the session ──"
# Without the ticket check this scheme is broken outright — anyone knowing a phone number
# could poll it and collect the session its owner just earned by calling in.
psql "DELETE FROM call_challenges;" >/dev/null
S2=$(start "$VICTIM"); T2=$(echo "$S2" | jget ticket)
ring "$(ring_json "$VICTIM")" >/dev/null
FORGED=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
chk "a guessed ticket is refused      " 401 "$(status_code "$VICTIM" "$FORGED")"
chk "  ...an empty ticket too         " 401 "$(status_code "$VICTIM" "")"
chk "  ...and no ticket at all        " 401 "$(code -X POST -H 'Content-Type: application/json' -d "$(printf '{"phone":"%s"}' "$VICTIM")" $B/auth/call/status)"
chk "  ...another challenge's ticket  " 401 "$(status_code "$OTHER" "$T2")"
chk "the real ticket still works      " "verified" "$(status "$VICTIM" "$T2" | jget status)"

echo
echo "── 4. LATEST OPEN WINS — a victim's own attempt kills an attacker's challenge ──"
# This is what stops an attacker's challenge sitting alongside the victim's, both waiting on
# the same call. It is a security property, not a convenience.
psql "DELETE FROM call_challenges;" >/dev/null
ATTACKER_T=$(start "$VICTIM" | jget ticket)
sleep 6   # clear the short open-cooldown; the point here is the replacement, not the throttle
VICTIM_T=$(start "$VICTIM" | jget ticket)
chk "the victim's re-open succeeded   " "yes" "$([ -n "$VICTIM_T" ] && echo yes || echo no)"
chk "  ...issuing a DIFFERENT ticket  " "yes" "$([ -n "$VICTIM_T" ] && [ "$ATTACKER_T" != "$VICTIM_T" ] && echo yes || echo no)"
chk "  ...only ONE challenge exists   " "1" "$(psql "SELECT count(*) FROM call_challenges WHERE phone='$VICTIM';")"
ring "$(ring_json "$VICTIM")" >/dev/null
chk "the attacker's ticket is DEAD    " 401 "$(status_code "$VICTIM" "$ATTACKER_T")"
chk "  ...the victim's is the live one" "verified" "$(status "$VICTIM" "$VICTIM_T" | jget status)"

echo
echo "── 5. A call with no live challenge is DISCARDED, never banked ──"
# If calls were remembered, an attacker could open a challenge for a number that happened to
# ring us at some point and have it resolve instantly.
psql "DELETE FROM call_challenges;" >/dev/null
chk "an unexpected call is ignored    " "false" "$(ring "$(ring_json "$OTHER")" | python3 -c "import sys,json;print(str(json.load(sys.stdin)['results'][0]['matched']).lower())")"
chk "  ...nothing was recorded        " "0" "$(psql "SELECT count(*) FROM call_challenges WHERE phone='$OTHER';")"
LATE_T=$(start "$OTHER" | jget ticket)
chk "a challenge opened AFTER it      " "pending" "$(status "$OTHER" "$LATE_T" | jget status)"

echo
echo "── 6. Only the Oracle may report calls ──"
psql "DELETE FROM call_challenges;" >/dev/null
T3=$(start "$VICTIM" | jget ticket)
chk "an unsigned report is refused    " 401 "$(code -X POST -H 'Content-Type: application/json' -d "$(ring_json "$VICTIM")" $B/oracle/calls)"
chk "a wrongly-signed one too         " 401 "$(code -X POST -H 'Content-Type: application/json' -H 'X-Oracle-Signature: 00' -d "$(ring_json "$VICTIM")" $B/oracle/calls)"
chk "  ...so it is still unverified   " "pending" "$(status "$VICTIM" "$T3" | jget status)"

echo
echo "── 7. Junk in the caller ID doesn't verify anyone ──"
chk "a withheld number is ignored     " "false" "$(ring '{"calls":[{"from":"unknown"}]}' | python3 -c "import sys,json;print(str(json.load(sys.stdin)['results'][0]['matched']).lower())")"
chk "  ...as is an empty one          " "false" "$(ring '{"calls":[{"from":""}]}' | python3 -c "import sys,json;print(str(json.load(sys.stdin)['results'][0]['matched']).lower())")"
chk "  ...and a malformed number      " "false" "$(ring '{"calls":[{"from":"12"}]}' | python3 -c "import sys,json;print(str(json.load(sys.stdin)['results'][0]['matched']).lower())")"
chk "an invalid phone is rejected     " 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"phone":"123"}' $B/auth/call/start)"
chk "the real challenge survives junk " "pending" "$(status "$VICTIM" "$T3" | jget status)"

echo
echo "── 8. Expiry ──"
psql "UPDATE call_challenges SET expires_at = now() - interval '1 minute' WHERE phone='$VICTIM';" >/dev/null
chk "an expired challenge won't poll  " 401 "$(status_code "$VICTIM" "$T3")"
chk "  ...and a call can't revive it  " "false" "$(ring "$(ring_json "$VICTIM")" | python3 -c "import sys,json;print(str(json.load(sys.stdin)['results'][0]['matched']).lower())")"

echo
echo "── 9. The open endpoint is throttled ──"
# Cheap, but not free to spin: an unthrottled endpoint is a way to keep a number permanently
# un-verifiable by replacing its challenge on a loop.
psql "DELETE FROM call_challenges;" >/dev/null
start "+252615550009" >/dev/null
chk "an immediate re-open is refused  " 429 "$(start_code "+252615550009")"

psql "DELETE FROM call_challenges;" >/dev/null

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
