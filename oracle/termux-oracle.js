#!/usr/bin/env node
// On-device Oracle for Termux (Android). The "ears" of the system.
//
// WHAT IT IS: a CONFIRMATION sensor, not a communication device. It watches the merchant
// phone's SMS inbox for messages saying money arrived — from ANY rail that texts the
// recipient: EVC Plus, eDahab, Zelle, Cash App, Venmo — and forwards them to the backend.
// Customer/driver/operator conversation never touches this phone; that is the in-app chat.
//
// IT ALSO SENDS. Customer login codes go out over THIS SIM — that is what makes SMS login
// work in Somalia with no telecom integration. The phone POLLS for messages to send rather
// than the server calling it, because a phone cannot accept inbound connections behind
// carrier NAT. Same tick, same signed channel, no VPN, no port forwarding.
//
// IT DOES NOT PARSE. It forwards the raw message and lets the server decide what it means.
// Telecoms and banks reword their receipts without warning, and fixing a parser must not
// require physical access to a handset that may be in another country.
//
// SETUP (on the dedicated Android phone):
//   1. Install Termux AND Termux:API from F-Droid — NOT the Play Store, and both from the
//      same source. Mixed signing keys make every API call silently return nothing.
//   2. pkg install nodejs termux-api
//   3. Grant SMS access: Android Settings > Apps > Termux:API > Permissions > SMS > Allow.
//      (termux-setup-storage does NOT cover SMS.)
//   4. Edit and run ./start-oracle.sh — it sets the variables, checks the backend is
//      reachable and SMS is readable, and holds a wake lock.
//
// Running WITHOUT an Oracle is supported: an operator reads the merchant phone and taps
// "Mark as paid". This just removes that manual step.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SECRET = process.env.ORACLE_WEBHOOK_SECRET;
const BACKEND = process.env.BACKEND_URL || 'https://localhost';
const POLL_MS = 4000;

if (!SECRET) { console.error('ORACLE_WEBHOOK_SECRET required'); process.exit(1); }

const seen = new Set(); // in-memory dedupe; backend also dedupes via UNIQUE receipt id

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

async function post(path, obj) {
  const body = JSON.stringify(obj);
  try {
    const res = await fetch(`${BACKEND}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Oracle-Signature': sign(body) },
      body,
    });
    if (!res.ok) {
      // 401 here means the shared secret doesn't match the backend's — the single most
      // common misconfiguration, and it looks like "the Oracle isn't seeing my SMS".
      console.error(`post ${path} -> HTTP ${res.status}${res.status === 401 ? ' (check ORACLE_WEBHOOK_SECRET matches the backend)' : ''}`);
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error('post failed', path, e.message);
    return null;
  }
}

// Which senders are worth forwarding at all. Deliberately broad: forwarding a message that
// turns out not to be a receipt costs one ignored request, while missing one costs a customer
// standing at a door with an order that says unpaid. The server decides what is a receipt.
//
// Add whatever your rails actually use — check a real message on this phone and copy the
// sender verbatim.
const SENDERS = (process.env.TELECOM_SENDER_IDS ||
  'EVCPlus,EVC,Hormuud,eDahab,Somtel,Zelle,CashApp,Venmo,Chase,BofA'
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Repeated identical failures are logged ONCE with a diagnosis, not every four seconds.
// A poll loop that prints the same stack trace forever buries the one line that tells you
// what is actually wrong.
let lastFault = null;
function fault(kind, detail) {
  if (lastFault === kind) return;
  lastFault = kind;
  console.error(`\n✗ ${detail}\n  (this message won't repeat until something changes)\n`);
}

async function pollSms() {
  let stdout = '';
  try {
    ({ stdout } = await run('termux-sms-list', ['-l', '25', '-t', 'inbox']));
  } catch (e) {
    return fault(
      'exec',
      `Could not run termux-sms-list: ${e.message}\n` +
        '  Install the bridge:  pkg install termux-api\n' +
        '  AND the separate Termux:API *app* from F-Droid — the pkg alone is not enough.'
    );
  }

  const text = String(stdout).trim();

  // The usual failure: the command exists and exits 0, but prints nothing because the
  // Termux:API app is missing or the SMS permission was never granted. That looks like
  // success to the shell and like a JSON parse error here.
  if (!text) {
    return fault(
      'empty',
      'termux-sms-list returned NOTHING.\n' +
        '  * Is the Termux:API *app* installed (separate from the termux-api package)?\n' +
        '  * Settings > Apps > Termux:API > Permissions > SMS > Allow\n' +
        '  * Both Termux and Termux:API must come from the SAME source (F-Droid).'
    );
  }

  let messages;
  try {
    messages = JSON.parse(text);
  } catch {
    // Show what actually came back — usually a permission prompt or an error line, and
    // seeing it is the whole diagnosis.
    return fault('json', `termux-sms-list did not return JSON. It said:\n  ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(messages)) {
    return fault('shape', `Expected a list of messages, got: ${text.slice(0, 200)}`);
  }

  // Recovered.
  if (lastFault) {
    console.log('✓ SMS access is working again.');
    lastFault = null;
  }

  for (const m of messages) {
    const from = String(m.number || m.sender || '');
    if (!SENDERS.some((s) => from.toLowerCase().includes(s))) continue;

    // Dedupe locally so polling every few seconds doesn't re-send the same message. The
    // backend also dedupes on a UNIQUE receipt id, so this is politeness, not correctness.
    const key = `${m.received}-${m.body}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Forward RAW. No parsing here — see the header.
    const res = await post('/webhook', {
      senderId: from,
      body: m.body,
      receivedAt: m.received,
    });

    if (!res) console.log('→ FAILED to reach backend');
    else if (res.recognised === false) console.log(`· ignored (not a receipt) from ${from}`);
    else if (res.duplicate) console.log(`· already seen (${res.provider})`);
    else if (res.matched) console.log(`✓ payment matched (${res.provider})`);
    else console.log(`! payment recorded but NOT matched (${res.provider}) — operator must reconcile`);
  }
}

// ── Outbound: send login codes over this SIM ──
//
// A code is only useful for five minutes, so this runs on the same fast tick as the inbox
// poll. Failures are reported back so the server can retry rather than silently dropping a
// customer's ability to sign in.
async function pollOutbound() {
  const res = await post('/oracle/sms/pending', { limit: 5 });
  if (!res || !Array.isArray(res.messages) || res.messages.length === 0) return;

  for (const m of res.messages) {
    try {
      // termux-sms-send takes the recipient with -n and the text as the trailing argument.
      await run('termux-sms-send', ['-n', m.to, m.body]);
      await post('/oracle/sms/sent', { id: m.id, ok: true });
      // Never log the body — it contains a live login code.
      console.log(`✉ sent a code to ${m.to.replace(/\d(?=\d{3})/g, '•')}`);
    } catch (e) {
      await post('/oracle/sms/sent', { id: m.id, ok: false, error: e.message });
      console.error(`✗ could not send to ${m.to.replace(/\d(?=\d{3})/g, '•')}: ${e.message}`);
      // SEND permission is separate from READ. Say so once rather than per message.
      if (/permission/i.test(e.message)) {
        fault('sendperm', 'Termux:API needs the SMS *send* permission as well as read.');
      }
    }
  }
}

setInterval(pollSms, POLL_MS);
setInterval(pollOutbound, POLL_MS);
setInterval(() => post('/heartbeat', { ts: Date.now(), device: 'termux' }), 60000);
post('/heartbeat', { ts: Date.now(), device: 'termux', boot: true });
console.log('Oracle listening (receiving receipts + sending login codes).');
console.log('Forwarding messages from:', SENDERS.join(', '));
console.log('Backend:', BACKEND);
