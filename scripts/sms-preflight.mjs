#!/usr/bin/env node
// Prove real SMS and email delivery work BEFORE testing them through the app.
//
// WHY THIS EXISTS: when a login code doesn't arrive there are several candidate causes — wrong
// credentials, no balance, a sender US carriers won't accept, a country not enabled, a bad
// destination format, or the app never calling the transport at all. Debugging that through the
// sign-in screen means one guess per round trip. This isolates the transport.
//
//   node scripts/sms-preflight.mjs                          check credentials only, sends nothing
//   node scripts/sms-preflight.mjs --send +12066876538      also send a test SMS
//   node scripts/sms-preflight.mjs --email you@example.com  also send a test email
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
const service = env.TWILIO_MESSAGING_SERVICE_SID;
const from = env.TWILIO_FROM;
const sgKey = env.SENDGRID_API_KEY;
const emailFrom = env.EMAIL_FROM;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);
const arg = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv[i + 1] || ''; };

console.log('\nTwilio SMS preflight\n');

let fatal = false;
if (!sid || !/^AC[0-9a-f]{32}$/i.test(sid)) { bad('TWILIO_ACCOUNT_SID is empty or not an AC… SID'); fatal = true; }
else ok(`account ${sid.slice(0, 6)}…`);
if (!token) { bad('TWILIO_AUTH_TOKEN is empty'); fatal = true; }
else ok(`auth token present (${token.length} chars)`);
if (service && !/^MG[0-9a-f]{32}$/i.test(service)) { bad('TWILIO_MESSAGING_SERVICE_SID must start with MG'); fatal = true; }
else if (!service && !/^\+\d{8,15}$/.test(from || '')) {
  bad('set TWILIO_MESSAGING_SERVICE_SID (preferred, MG…) or TWILIO_FROM (+1XXXXXXXXXX)');
  fatal = true;
} else ok(service ? `messaging service ${service.slice(0, 6)}…` : `from ${from}`);

if (fatal) {
  console.log('\nFill these in .env, then re-run. Setup: docs/LIVE_SMS_SETUP.md\n');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const twilio = (url, init = {}) => fetch(url, { ...init, headers: { Authorization: auth, ...(init.headers || {}) } });

// 1. Do the credentials work at all? A cheap GET separates "wrong token" from every other failure.
console.log('\nChecking credentials against Twilio…');
const acct = await twilio(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`);
if (acct.status === 401) {
  bad('Twilio rejected these credentials (401)');
  info('Both values are on the Twilio Console home page under "Account Info".');
  process.exit(1);
}
if (!acct.ok) {
  bad(`Twilio returned HTTP ${acct.status}`);
  info((await acct.text()).slice(0, 300));
  process.exit(1);
}
const account = await acct.json();
if (account.status !== 'active') bad(`account status is "${account.status}" — sends will fail until it is active`);
else ok(`credentials valid — ${account.friendly_name || 'account'} (${account.type || 'active'})`);
const bal = await twilio(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`);
if (bal.ok) {
  const { balance, currency } = await bal.json();
  if (Number(balance) <= 0) bad(`balance ${balance} ${currency} — top up or every send fails`);
  else ok(`balance ${balance} ${currency}`);
}
if (service) {
  const svc = await twilio(`https://messaging.twilio.com/v1/Services/${service}`);
  if (svc.ok) ok(`messaging service found: ${(await svc.json()).friendly_name}`);
  else bad(`messaging service ${service} not found on this account (HTTP ${svc.status})`);
}

// 2. Optional: the only check that proves the whole path, because it is the whole path.
const to = arg('--send');
if (to !== null) {
  if (!/^\+\d{8,15}$/.test(to)) {
    bad('--send needs a number in E.164 form, e.g. --send +12066876538');
    process.exit(1);
  }
  console.log(`\nSending a test SMS to ${to}…`);
  const form = new URLSearchParams({ To: to, Body: 'GuriKaabe preflight: real SMS delivery is working.' });
  if (service) form.set('MessagingServiceSid', service); else form.set('From', from);
  const res = await twilio(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.sid) {
    ok(`accepted by Twilio (${body.status}, ${body.sid})`);
    info('Accepted means queued, not delivered. If nothing arrives in ~30s, check');
    info('Console → Monitor → Logs → Messaging for the delivery report and error code.');
  } else {
    // Twilio's own code is far more specific than anything we could infer: surface it, and
    // translate only the ones people actually hit first.
    bad(`Twilio refused the message (HTTP ${res.status}, ${body.code || 'no code'})`);
    if (body.message) info(body.message);
    const hints = {
      21408: 'Sending to this country is off — Console → Messaging → Settings → Geo permissions (enable Somalia).',
      21211: `"${to}" is not a valid destination — check the country code.`,
      21606: 'TWILIO_FROM is not an SMS-capable number on this account.',
      21610: 'This number replied STOP. It must text START to the sender before it can receive codes.',
      30034: 'The sender is not on an approved 10DLC campaign yet.',
    };
    if (hints[body.code]) info(hints[body.code]);
    fatal = true;
  }
}

// 3. Email (Twilio SendGrid), if configured or asked for.
const emailTo = arg('--email');
if (sgKey || emailFrom || emailTo !== null) {
  console.log('\nSendGrid email preflight\n');
  if (!sgKey) { bad('SENDGRID_API_KEY is empty'); fatal = true; }
  if (!emailFrom) { bad('EMAIL_FROM is empty (a sender you verified in SendGrid)'); fatal = true; }
  if (sgKey && emailFrom) {
    const scopes = await fetch('https://api.sendgrid.com/v3/scopes', { headers: { Authorization: `Bearer ${sgKey}` } });
    if (scopes.status === 401 || scopes.status === 403) { bad('SendGrid rejected this API key'); fatal = true; }
    else if (scopes.ok) {
      const list = (await scopes.json()).scopes || [];
      if (list.includes('mail.send')) ok('API key valid, has Mail Send permission');
      else { bad('API key works but lacks the Mail Send permission'); fatal = true; }
    }
    if (emailTo) {
      console.log(`\nSending a test email to ${emailTo}…`);
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: emailTo }] }],
          from: { email: emailFrom, name: 'GuriKaabe' },
          subject: 'GuriKaabe preflight',
          content: [{ type: 'text/plain', value: 'GuriKaabe preflight: real email delivery is working.' }],
        }),
      });
      if (res.status === 202) ok('accepted by SendGrid — check the inbox (and spam)');
      else {
        const body = await res.json().catch(() => ({}));
        bad(`SendGrid refused it (HTTP ${res.status}): ${body.errors?.[0]?.message || ''}`);
        fatal = true;
      }
    }
  }
}

if (fatal) process.exit(1);
console.log('\nLooks good. Set OTP_TRANSPORT=twilio in .env and rebuild the backend.\n');
