#!/usr/bin/env node
// Prove real SMS delivery works BEFORE testing it through the app.
//
// WHY THIS EXISTS: when a login code doesn't arrive there are five candidate causes — wrong
// credentials, an unverified trial destination, a from-number that can't send SMS, a bad
// destination format, or the app never calling the transport at all. Debugging that through
// the sign-in screen means one guess per round trip. This isolates the transport.
//
//   node scripts/sms-preflight.mjs                    check credentials only, sends nothing
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

const sid = env.TWILIO_ACCOUNT_SID;
const token = env.TWILIO_AUTH_TOKEN;
const from = env.TWILIO_FROM;
const service = env.TWILIO_MESSAGING_SERVICE_SID;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log('\nTwilio preflight\n');

let fatal = false;
if (!sid) { bad('TWILIO_ACCOUNT_SID is empty'); fatal = true; }
else if (!sid.startsWith('AC')) { bad(`TWILIO_ACCOUNT_SID should start with "AC" (got "${sid.slice(0, 4)}…")`); fatal = true; }
else ok(`account sid ${sid.slice(0, 6)}…${sid.slice(-4)}`);

if (!token) { bad('TWILIO_AUTH_TOKEN is empty'); fatal = true; }
else ok(`auth token present (${token.length} chars)`);

if (!from && !service) { bad('TWILIO_FROM is empty (or set TWILIO_MESSAGING_SERVICE_SID)'); fatal = true; }
else if (from && !/^\+\d{8,15}$/.test(from)) { bad(`TWILIO_FROM must be E.164 like +12065551234 (got "${from}")`); fatal = true; }
else ok(service ? `messaging service ${service.slice(0, 6)}…` : `from ${from}`);

if (fatal) {
  console.log('\nFill these in .env, then re-run. Setup: docs/LIVE_SMS_SETUP.md\n');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

// 1. Do the credentials work at all? A cheap GET distinguishes "wrong password" from every
//    other failure, which is the ambiguity that wastes the most time.
console.log('\nChecking credentials against Twilio…');
const acct = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
  headers: { Authorization: auth },
});
if (acct.status === 401) {
  bad('Twilio rejected these credentials (401)');
  info('The Auth Token is wrong, or it belongs to a different Account SID.');
  info('Both are on the Console dashboard — the token needs "click to reveal".');
  process.exit(1);
}
if (!acct.ok) {
  bad(`Twilio returned HTTP ${acct.status}`);
  info((await acct.text()).slice(0, 300));
  process.exit(1);
}
const account = await acct.json();
ok(`credentials valid — account "${account.friendly_name}" (${account.status})`);

// 2. Trial accounts only deliver to numbers you have verified. This is the single most common
//    first-run failure, and the error only appears after a send — so surface it beforehand.
const trial = account.type === 'Trial';
if (trial) {
  console.log('\n\x1b[33m!\x1b[0m This is a TRIAL account.');
  info('Trial accounts can only send to numbers verified in the Console:');
  info('Phone Numbers → Manage → Verified Caller IDs.');
  const ver = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/OutgoingCallerIds.json?PageSize=50`,
    { headers: { Authorization: auth } }
  );
  if (ver.ok) {
    const list = (await ver.json()).outgoing_caller_ids || [];
    if (list.length === 0) info('No verified numbers yet — verify your handset first.');
    else list.forEach((v) => info(`verified: ${v.phone_number}`));
  }
} else {
  ok('full account — can send to any number');
}

// 3. Not every Twilio number can send SMS, and a voice-only number fails at send time with an
//    error that reads like a configuration problem somewhere else.
if (from) {
  const nums = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`,
    { headers: { Authorization: auth } }
  );
  if (nums.ok) {
    const list = (await nums.json()).incoming_phone_numbers || [];
    const match = list.find((n) => n.phone_number === from);
    if (!match) bad(`${from} is not a number on this account — sends will fail with 21606`);
    else if (!match.capabilities?.sms) bad(`${from} cannot send SMS (voice-only number)`);
    else ok(`${from} is yours and SMS-capable`);
  }
}

// 4. Optional: the only check that proves the whole path, because it is the whole path.
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
const form = new URLSearchParams({
  To: to,
  Body: 'GuriKaabe preflight: real SMS delivery is working.',
});
if (service) form.set('MessagingServiceSid', service);
else form.set('From', from);

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form,
});
const body = await res.json();

if (res.ok) {
  ok(`accepted by Twilio (sid ${body.sid}, status "${body.status}")`);
  info('"queued" means Twilio took it, not that the handset has it.');
  info('If nothing arrives in ~30s, check the Console → Monitor → Messaging logs.');
  console.log('\nNow set OTP_TRANSPORT=twilio in .env and restart:');
  console.log('  docker compose up -d backend\n');
  process.exit(0);
}

// Twilio's own error text is far more specific than anything we could infer, so surface it
// verbatim and translate only the codes people actually hit first.
bad(`Twilio refused the message (HTTP ${res.status}, code ${body.code})`);
info(body.message || '');
const hints = {
  21608: 'The destination is not verified on this trial account. Console → Verified Caller IDs.',
  21211: `"${to}" is not a valid destination — check the country code.`,
  21606: 'TWILIO_FROM cannot send SMS, or is not a number you own.',
  21610: 'That handset replied STOP to this sender. Un-block it in the Console.',
  20003: 'Authentication failed — wrong Account SID / Auth Token pair.',
};
if (hints[body.code]) info(hints[body.code]);
process.exit(1);
