// CQRS write side for operator accounts.
import { prisma, withTransaction } from '../db/prisma.js';
import { hashSecret, verifySecret } from '../middleware/auth.js';
import { normalizeUsername, validateUsername, validatePassword } from '../domain/operator.js';
import { config } from '../config.js';

export class OperatorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Verify a login. Returns the operator row on success, null on ANY failure — the caller must
// not be able to tell "no such user" from "wrong password" (that difference enumerates the
// staff roster, which is exactly what an attacker wants before a phishing attempt).
export async function verifyOperatorLogin(username, password) {
  const name = normalizeUsername(username);
  const operator = await prisma.operator.findFirst({ where: { username: name, active: true } });

  if (!operator) {
    // Spend comparable time on the miss so response timing doesn't leak account existence.
    verifySecret(String(password ?? ''), hashSecret('timing-equalizer'));
    return null;
  }
  if (!verifySecret(String(password ?? ''), operator.password_hash)) return null;

  await prisma.operator.update({ where: { id: operator.id }, data: { last_login_at: new Date() } });
  return operator;
}

// Change your own password. Requires the current one, so a walked-away unlocked session
// can't be used to lock the real operator out of their own account.
export async function changeOwnPassword({ operatorId, currentPassword, newPassword }) {
  const id = BigInt(operatorId);
  return withTransaction(async (tx) => {
    // RAW, and it must stay raw: FOR UPDATE. Two concurrent changes would otherwise both
    // verify against the OLD hash and the second would silently overwrite the first.
    const rows = await tx.$queryRaw`
      SELECT id, username, password_hash FROM operators WHERE id = ${id} FOR UPDATE
    `;
    const operator = rows[0];
    if (!operator) throw new OperatorError('account not found', 404);
    if (!verifySecret(String(currentPassword ?? ''), operator.password_hash)) {
      throw new OperatorError('current password is incorrect', 401);
    }
    const p = validatePassword(newPassword, { username: operator.username });
    if (!p.valid) throw new OperatorError(p.reason);
    if (verifySecret(p.password, operator.password_hash)) {
      throw new OperatorError('new password must be different from the current one');
    }
    await tx.operator.update({
      where: { id },
      data: { password_hash: hashSecret(p.password), must_change_password: false },
    });
    return { ok: true };
  });
}

// Deactivate (never delete): the audit trail references this operator by id, and a deleted
// row would orphan every action they ever took.
export async function setOperatorActive(operatorId, active, actingOperatorId) {
  if (!active && String(operatorId) === String(actingOperatorId)) {
    throw new OperatorError('you cannot deactivate your own account', 400);
  }
  if (!active) {
    // Refuse to remove the last way in. Locking every operator out of a running delivery
    // business is a worse outage than any account we might want disabled.
    const others = await prisma.operator.count({
      where: { active: true, id: { not: BigInt(operatorId) } },
    });
    if (others === 0) throw new OperatorError('cannot deactivate the last active operator', 409);
    await assertAnotherAdmin(operatorId);
  }
  try {
    return await prisma.operator.update({
      where: { id: BigInt(operatorId) },
      data: { active },
      select: { id: true, username: true, display_name: true, active: true, is_admin: true },
    });
  } catch (err) {
    if (err.code === 'P2025') throw new OperatorError('account not found', 404);
    throw err;
  }
}

// Grant or remove admin. Admins create and disable staff accounts; with none left, nobody
// could ever add a driver again, so the last active admin can't be demoted.
export async function setOperatorAdmin(operatorId, admin) {
  if (!admin) await assertAnotherAdmin(operatorId);
  try {
    return await prisma.operator.update({
      where: { id: BigInt(operatorId) },
      data: { is_admin: Boolean(admin) },
      select: { id: true, username: true, display_name: true, active: true, is_admin: true },
    });
  } catch (err) {
    if (err.code === 'P2025') throw new OperatorError('account not found', 404);
    throw err;
  }
}

// Throws unless some OTHER active admin would remain after `operatorId` loses admin rights.
async function assertAnotherAdmin(operatorId) {
  const target = await prisma.operator.findUnique({
    where: { id: BigInt(operatorId) },
    select: { is_admin: true, active: true },
  });
  if (!target?.is_admin || !target.active) return; // not an active admin: nothing to protect
  const otherAdmins = await prisma.operator.count({
    where: { active: true, is_admin: true, id: { not: BigInt(operatorId) } },
  });
  if (otherAdmins === 0) throw new OperatorError('cannot remove the last active admin', 409);
}

// First-boot bootstrap: if the roster is empty, seed one account from the environment so a
// fresh deployment is reachable at all. Flagged must_change_password — the env value is in
// .env, shell history and possibly a screenshot, so it is a delivery mechanism, not a secret.
export async function ensureBootstrapOperator() {
  if ((await prisma.operator.count()) > 0) return null;

  const username = config.bootstrapOperator.username;
  const password = config.operatorPassword;
  const p = validatePassword(password, { username });
  if (!p.valid) {
    console.error(
      `FATAL: cannot bootstrap the first operator — OPERATOR_PASSWORD ${p.reason}. ` +
        'Set a strong OPERATOR_PASSWORD and restart.'
    );
    throw new OperatorError(`bootstrap operator: ${p.reason}`);
  }

  let created = null;
  try {
    created = await prisma.operator.create({
      data: {
        username,
        display_name: 'Bootstrap operator',
        password_hash: hashSecret(p.password),
        must_change_password: true,
        is_admin: true,
        created_by: 'system:bootstrap',
      },
      select: { id: true, username: true },
    });
  } catch (err) {
    // Another instance won the race to bootstrap; that's a success, not an error.
    if (err.code !== 'P2002') throw err;
  }
  if (created) {
    console.warn(
      `[bootstrap] created operator "${username}" from OPERATOR_PASSWORD. ` +
        'Sign in and change this password — it is flagged must_change_password.'
    );
  }
  return created;
}
