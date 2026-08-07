#!/usr/bin/env node
// Reference on-device Oracle for Termux (Android). This is the "Ears" of the system.
// It polls the SMS inbox for telecom receipts, parses amount + sender with regex, and
// fires an HMAC-signed webhook to the backend. Also sends a heartbeat so the operator
// dashboard knows the Oracle is alive.
//
// SETUP (on the dedicated Android phone):
//   1. Install Termux + Termux:API (from F-Droid, not Play Store — Play version is stale).
//   2. pkg install nodejs termux-api
//   3. termux-setup-storage  (grant SMS permission when prompted)
//   4. Disable battery optimization for Termux, and enable "keep awake":
//        termux-wake-lock
//   5. Set env + run:
//        export ORACLE_WEBHOOK_SECRET=<same-as-backend>
//        export BACKEND_URL=https://your-domain
//        node termux-oracle.js
//
// PRODUCTION NOTE: Termux polling is fine for the MVP. For higher reliability, graduate to
// a small foreground-service Android app (BroadcastReceiver on SMS_RECEIVED). The webhook
// contract stays identical, so the backend never changes.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SECRET = process.env.ORACLE_WEBHOOK_SECRET;
const BACKEND = process.env.BACKEND_URL || 'https://localhost';
const SENDERS = (process.env.TELECOM_SENDER_IDS || 'EVCPlus,Somtel').split(',');
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
    return res.ok;
  } catch (e) {
    console.error('post failed', path, e.message);
    return false;
  }
}

// Adjust these regexes to the EXACT wording of Hormuud/Somtel receipts on your SIM.
// Example receipt: "You have received $5.50 from 61XXXXXXX. Ref: ABC123XYZ"
const AMOUNT_RE = /\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/;
const SENDER_RE = /from\s+(\+?\d{6,15})/i;
const REF_RE = /(?:ref|txn|id)[:\s]+([A-Z0-9]{4,})/i;

function parse(sms) {
  const amount = sms.body.match(AMOUNT_RE)?.[1];
  const senderMsisdn = sms.body.match(SENDER_RE)?.[1];
  const receiptId = sms.body.match(REF_RE)?.[1] || `${sms.sender}-${sms.received}`;
  if (!amount || !senderMsisdn) return null;
  return { receiptId, senderMsisdn, amount: Number(amount), rawSms: sms.body };
}

async function pollSms() {
  try {
    const { stdout } = await run('termux-sms-list', ['-l', '20', '-t', 'inbox']);
    const messages = JSON.parse(stdout);
    for (const m of messages) {
      const fromTelecom = SENDERS.some((s) => (m.number || '').includes(s) || (m.sender || '').includes(s));
      if (!fromTelecom) continue;
      const key = `${m.received}-${m.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = parse({ body: m.body, sender: m.number, received: m.received });
      if (parsed) {
        const ok = await post('/webhook', parsed);
        console.log(ok ? '→ webhook sent' : '→ webhook FAILED', parsed.receiptId);
      }
    }
  } catch (e) {
    console.error('poll error', e.message);
  }
}

setInterval(pollSms, POLL_MS);
setInterval(() => post('/heartbeat', { ts: Date.now(), device: 'termux' }), 60000);
post('/heartbeat', { ts: Date.now(), device: 'termux', boot: true });
console.log('Oracle listening. Senders:', SENDERS.join(', '));
