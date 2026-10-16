// CQRS read side for operator accounts. Never selects password_hash — a read model has no
// business carrying a credential, and this is the query the roster UI renders.
import { prisma } from '../db/prisma.js';

const PUBLIC_FIELDS = {
  id: true,
  username: true,
  display_name: true,
  active: true,
  must_change_password: true,
  last_login_at: true,
  created_at: true,
  created_by: true,
  is_admin: true,
};

export async function listOperators() {
  const [operators, invites] = await Promise.all([
    prisma.operator.findMany({
      select: { ...PUBLIC_FIELDS, phone: true },
      orderBy: [{ active: 'desc' }, { username: 'asc' }],
    }),
    prisma.staffInvite.findMany({ where: { role: 'operator' }, select: { account_id: true, expires_at: true } }),
  ]);
  // "Waiting for setup" = a code is out and hasn't been used. An expired one still counts:
  // the person hasn't set a password, and the admin needs to know to re-send.
  const pending = new Set(invites.map((i) => String(i.account_id)));
  return operators.map((o) => ({ ...o, setup_pending: pending.has(String(o.id)) }));
}

export async function getOperatorById(id) {
  let key;
  try {
    key = BigInt(id);
  } catch {
    return null;
  }
  return prisma.operator.findUnique({
    where: { id: key },
    select: { ...PUBLIC_FIELDS, created_by: false },
  });
}
