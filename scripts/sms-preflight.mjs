#!/usr/bin/env node
// Prove real SMS delivery works BEFORE testing it through the app.
//
// WHY THIS EXISTS: when a login code doesn't arrive there are several candidate causes — wrong
// credentials, no credit, a sender US carriers won't accept, a bad destination format, or the
// app never calling the transport at all. Debugging that through the sign-in screen means one
// guess per round trip. This isolates the transport.
//
//   node scripts/sms-preflight.mjs                       check credentials only, sends nothing
//   node scripts/sms-preflight.mjs --send +12066876538   actually send a test message
//
// Reads .env directly, so it checks the same values the backend will use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const username = env.CLICKSEND_USERNAME;
const apiKey = env.CLICKSEND_API_KEY;
const from = env.CLICKSEND_FROM;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log('\nClickSend preflight\n');

let fatal = false;
if (!username) { bad('CLICKSEND_USERNAME is empty'); fatal = true; }
else ok(`username ${username.slice(0, 3)}…`);

if (!apiKey) { bad('CLICKSEND_API_KEY is empty'); fatal = true; }
else ok(`api key present (${apiKey.length} chars)`);

if (from && !/^\+\d{8,15}$/.test(from) && !/^[A-Za-z0-9 ]{1,11}$/.test(from)) {
  bad(`CLICKSEND_FROM must be E.164 like +18885550100 or an 11-char sender name (got "${from}")`);
  fatal = true;
} else ok(from ? `from ${from}` : 'from: ClickSend shared sender');

if (fatal) {
  console.log('\nFill these in .env, then re-run. Setup: docs/LIVE_SMS_SETUP.md\n');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${username}:${apiKey}`).toString('base64');

// 1. Do the credentials work at all? A cheap GET separates "wrong key" from every other failure.
console.log('\nChecking credentials against ClickSend…');
const acct = await fetch('https://rest.clicksend.com/v3/account', { headers: { Authorization: auth } });
if (acct.status === 401) {
  bad('ClickSend rejected these credentials (401)');
  info('Username is your login (usually your email); the key is under Developers → API Credentials.');
  process.exit(1);
}
if (!acct.ok) {
  bad(`ClickSend returned HTTP ${acct.status}`);
  info((await acct.text()).slice(0, 300));
  process.exit(1);
}
const account = (await acct.json()).data || {};
ok(`credentials valid — account ${account.username || username}`);
if (account.balance !== undefined) {
  const bal = Number(account.balance);
  if (bal <= 0) bad(`balance ${account.balance} — top up or every send fails with INSUFFICIENT_CREDIT`);
  else ok(`balance ${account.balance}`);
}

if (from && /^\+1\d{10}$/.test(from) && !/^\+18(00|33|44|55|66|77|88)/.test(from)) {
  console.log('\n\x1b[33m!\x1b[0m CLICKSEND_FROM is not a toll-free number.');
  info('US carriers filter A2P traffic from unregistered numbers; messages may be dropped');
  info('silently. Fine for a first test — switch to a verified toll-free number before launch.');
}

// 2. Optional: the only check that proves the whole path, because it is the whole path.
const sendIdx = process.argv.indexOf('--send');
if (sendIdx === -1) {
  console.log('\nCredentials look good. To send a real test message:');
  console.log('  node scripts/sms-preflight.mjs --send +12066876538\n');
  process.exit(0);
}

const to = process.argv[sendIdx + 1];
if (!to || !/^\+\d{8,15}$/.test(to)) {
  bad('--send needs a number in E.164 form, e.g. --send +12066876538');
  process.exit(1);
}

console.log(`\nSending a test message to ${to}…`);
const message = { source: 'gurikaabe-preflight', to, body: 'GuriKaabe preflight: real SMS delivery is working.' };
if (from) message.from = from;

const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [message] }),
});
const body = await res.json().catch(() => ({}));
const status = body?.data?.messages?.[0]?.status;

if (res.ok && status === 'SUCCESS') {
  ok('accepted by ClickSend');
  info('Accepted means queued, not delivered. If nothing arrives in ~30s, check');
  info('Dashboard → SMS → History for the delivery report.');
  console.log('\nNow set OTP_TRANSPORT=auto in .env and rebuild:');
  console.log('  docker compose up -d --build backend\n');
  process.exit(0);
}

// ClickSend's own status is far more specific than anything we could infer, so surface it
// verbatim and translate only the ones people actually hit first.
bad(`ClickSend refused the message (HTTP ${res.status}, ${status || body.response_code || 'no status'})`);
if (body.response_msg) info(body.response_msg);
const hints = {
  INSUFFICIENT_CREDIT: 'Top up the account (Dashboard → Billing).',
  INVALID_RECIPIENT: `"${to}" is not a valid destination — check the country code.`,
  COUNTRY_NOT_ENABLED: 'Sending to this country is disabled — Dashboard → Settings → Countries.',
  INVALID_SENDER_ID: 'CLICKSEND_FROM is not a number/sender ID you own or have verified.',
  UNAUTHORIZED: 'Wrong username / API key pair.',
};
if (hints[status || body.response_code]) info(hints[status || body.response_code]);
process.exit(1);
