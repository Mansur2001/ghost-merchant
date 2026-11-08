// Locked out of a staff account — including the only admin — and nobody left to press
// "Re-send setup code"? Run this ON THE SERVER. It issues the normal one-time setup code (8
// digits, 24 h, 5 tries; the old password keeps working until a new one is chosen) and emails
// it like the dashboard would. --print also shows it here, for when email doesn't arrive: the
// person running this already has root on the server, so it reveals nothing they couldn't reach.
//
//   docker compose exec backend node scripts/reset-staff-access.mjs --username abdideq --print
//   docker compose exec backend node scripts/reset-staff-access.mjs --driver +252619876543
//
// Then: /operator/ (or the driver app) → "Set up account" → phone on file + code + new secret.
// Recorded in the audit log, like every staff change.
import { prisma } from '../src/db/prisma.js';
import { resendSetupCode } from '../src/commands/staffAccounts.js';
import { parsePhone } from '../src/domain/phone.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const print = process.argv.includes('--print');
const username = String(arg('username') || '').trim().toLowerCase();
const driverPhone = arg('driver') ? parsePhone(arg('driver')).e164 : null;

let role;
let account;
if (username) {
  role = 'operator';
  account = await prisma.operator.findUnique({ where: { username } });
} else if (driverPhone) {
  role = 'driver';
  account = await prisma.driver.findUnique({ where: { msisdn: driverPhone } });
} else {
  console.error('usage: --username <operator> | --driver <phone>   [--print]');
  process.exit(1);
}
if (!account) { console.error('No such account.'); process.exit(1); }

try {
  const r = await resendSetupCode({ role, accountId: account.id, createdBy: 'system:reset-staff-access' });
  await prisma.auditLog.create({
    data: {
      actor: 'system:reset-staff-access', action: 'staff.access_reset', subject: `${role}:${account.id}`,
      detail: { printed: print, sentVia: r.sentVia || null },
    },
  });
  const where = r.sentVia === 'email' ? 'emailed' : r.sentVia === 'sms' ? 'texted' : 'issued (not sent)';
  console.log(`✓ Setup code ${where} for ${role} ${username || driverPhone}.`);
  console.log(`  Phone on file (use it on the "Set up account" screen): ${r.phone}`);
  if (print) console.log(`  Code: ${r.code}   (valid 24 hours, 5 tries)`);
  if (r.smsError) console.log(`  Sending failed: ${r.smsError}${print ? '' : ' — run again with --print'}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
await prisma.$disconnect();
