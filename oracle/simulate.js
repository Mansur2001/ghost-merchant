#!/usr/bin/env node
// Oracle SIMULATOR — validates the full payment loop without any phone.
// Signs a webhook exactly like the real Android Oracle would and POSTs it to the backend.
//
// Usage:
//   ORACLE_WEBHOOK_SECRET=<secret> node simulate.js payment <senderMsisdn> <amount> [receiptId]
//   ORACLE_WEBHOOK_SECRET=<secret> node simulate.js heartbeat
//   BACKEND_URL=https://localhost node simulate.js payment 61234567 5.50
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
} else if (cmd === 'heartbeat') {
  await post('/heartbeat', { ts: Date.now(), device: 'simulator' });
} else {
  console.error('Commands: payment | heartbeat');
  process.exit(1);
}
