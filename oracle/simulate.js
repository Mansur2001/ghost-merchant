#!/usr/bin/env node
// Oracle SIMULATOR — validates the full payment loop without any phone.
// Signs a webhook exactly like the real Android Oracle would and POSTs it to the backend.
//
// Usage:
//   node simulate.js payment  <senderMsisdn> <amount> [receiptId]   — Somali rail, auto-matches
//   node simulate.js sms      <provider> <amount> [name]            — RAW message, any rail
//   node simulate.js call     <callerMsisdn>                       — missed-call verification
//   node simulate.js heartbeat
//
// `sms` is the realistic one: it sends the raw text the merchant phone would actually receive
// and lets the SERVER parse it, which is how the real Oracle now works. Use it to test a US
// rail without a SIM:
//   node simulate.js sms zelle 25.00 "John Smith"
//
// (For self-signed localhost certs, prefix with NODE_TLS_REJECT_UNAUTHORIZED=0.)
import crypto from 'node:crypto';

const secret = process.env.ORACLE_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set ORACLE_WEBHOOK_SECRET (must match the backend .env).');
  process.exit(1);
}
const base = process.env.BACKEND_URL || 'https://localhost';
const [, , cmd, sender, amount, receiptId] = process.argv;

function sign(body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function post(path, obj) {
  const body = JSON.stringify(obj);
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Oracle-Signature': sign(body) },
    body,
  });
  console.log(res.status, await res.text());
}

if (cmd === 'payment') {
  if (!sender || !amount) {
    console.error('Usage: simulate.js payment <senderMsisdn> <amount> [receiptId]');
    process.exit(1);
  }
  await post('/webhook', {
    receiptId: receiptId || `SIM-${Date.now()}`,
    senderMsisdn: sender,
    amount: Number(amount),
    rawSms: `You have received $${amount} from ${sender}. (simulated)`,
  });
} else if (cmd === 'sms') {
  // Raw-message mode: exactly what the phone forwards. `sender` here is the provider id.
  const provider = (sender || '').toLowerCase();
  const amt = amount || '25.00';
  const who = receiptId || 'John Smith'; // 4th arg doubles as the payer name
  const ref = `SIM${Date.now().toString().slice(-6)}`;

  const TEMPLATES = {
    evcplus: ['EVCPlus', `You have received $${amt} from 612345678. Ref: ${ref}`],
    edahab:  ['eDahab',  `You have received $${amt} from 652345678. Ref: ${ref}`],
    zelle:   ['Zelle',   `${who} sent you $${amt} with Zelle. Ref ${ref}`],
    cashapp: ['CashApp', `${who} sent you $${amt} on Cash App. #${ref}`],
    venmo:   ['Venmo',   `${who} paid you $${amt} - Venmo. ID: ${ref}`],
    junk:    ['+12065551234', 'are you open today?'],
  };

  const t = TEMPLATES[provider];
  if (!t) {
    console.error(`Unknown provider "${provider}". One of: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(1);
  }
  console.log(`SMS from ${t[0]}: ${t[1]}`);
  await post('/webhook', { senderId: t[0], body: t[1], receivedAt: String(Date.now()) });
} else if (cmd === 'call') {
  // Missed-call verification without a phone: pretend someone rang the Oracle. The customer
  // must already have tapped "Verify by calling" in the app — a call matching no live
  // challenge is discarded on purpose, so ringing first does nothing.
  if (!sender) {
    console.error('Usage: node simulate.js call <callerMsisdn>   e.g. call +12065551234');
    process.exit(1);
  }
  console.log(`Incoming call from ${sender}`);
  await post('/oracle/calls', { calls: [{ from: sender, at: new Date().toISOString() }] });
} else if (cmd === 'heartbeat') {
  await post('/heartbeat', { ts: Date.now(), device: 'simulator' });
} else {
  console.error('Commands: payment | sms | call | heartbeat');
  process.exit(1);
}
