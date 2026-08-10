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
};

export async function listOperators() {
  return prisma.operator.findMany({
    select: PUBLIC_FIELDS,
    orderBy: [{ active: 'desc' }, { username: 'asc' }],
  });
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
