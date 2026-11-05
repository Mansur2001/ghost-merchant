// Make one named person the ONLY admin: rename the existing admin account to them and remove
// admin rights from everyone else. Run on the server; it changes no password.
//
//   docker compose exec backend node scripts/set-owner.mjs \
//     --name "Abdideq Firin" --username abdideq --phone "+12067330555" --email owner@example.com
//
// Why a script and not a screen: who the owner is should be a deliberate, logged act by the
// person with the server, never a button an admin session (stolen or not) can press.
import { PrismaClient } from '@prisma/client';
import { validateUsername } from '../src/domain/operator.js';
import { parsePhone } from '../src/domain/phone.js';
import { normalizeEmail } from '../src/domain/email.js';

const prisma = new PrismaClient();
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };

const name = String(arg('name') || '').trim();
const u = validateUsername(arg('username'));
const phone = parsePhone(arg('phone'));
const email = normalizeEmail(arg('email'));
if (name.length < 2 || !u.valid || !phone.valid || !email) {
  console.error('usage: --name "Full Name" --username abc --phone +1XXXXXXXXXX --email you@example.com');
  if (!u.valid) console.error(`username: ${u.reason}`);
  if (!phone.valid) console.error('phone: not a valid number');
  process.exit(1);
}

const admins = await prisma.operator.findMany({ where: { is_admin: true, active: true }, orderBy: { id: 'asc' } });
if (!admins.length) { console.error('No active admin to make the owner.'); process.exit(1); }
// The account to keep: one already using the username, else the oldest admin (the bootstrap one).
const owner = admins.find((a) => a.username === u.username) || admins[0];
const clash = await prisma.operator.findUnique({ where: { username: u.username } });
if (clash && clash.id !== owner.id) { console.error(`username "${u.username}" belongs to another account.`); process.exit(1); }

await prisma.$transaction(async (tx) => {
  await tx.operator.update({
    where: { id: owner.id },
    data: { username: u.username, display_name: name, phone: phone.e164, email, is_admin: true },
  });
  const demoted = await tx.operator.updateMany({ where: { is_admin: true, NOT: { id: owner.id } }, data: { is_admin: false } });
  await tx.auditLog.create({
    data: {
      actor: 'system:set-owner', action: 'staff.owner_set', subject: `operator:${owner.id}`,
      detail: { from: owner.username, to: u.username, name, otherAdminsRemoved: demoted.count },
    },
  });
  console.log(`✓ ${name} (@${u.username}) is now the only admin. Other admins removed: ${demoted.count}.`);
  console.log(`  Sign in as "${u.username}" with the same password as before.`);
});
await prisma.$disconnect();
