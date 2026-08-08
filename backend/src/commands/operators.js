// CQRS write side for operator accounts.
import { query, withTransaction } from '../db/pool.js';
import { hashSecret, verifySecret } from '../middleware/auth.js';
import { normalizeUsername, validateUsername, validatePassword } from '../domain/operator.js';
import { config } from '../config.js';

export class OperatorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Create an account. `createdBy` is the actor label of whoever is doing it, so the roster
// itself carries a provenance trail.
export async function createOperator({ username, displayName, password, createdBy }) {
  const u = validateUsername(username);
  if (!u.valid) throw new OperatorError(u.reason);
  const p = validatePassword(password, { username: u.username });
  if (!p.valid) throw new OperatorError(p.reason);

  try {
    const { rows } = await query(
      `INSERT INTO operators(username, display_name, password_hash, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, active, created_at`,
      [u.username, String(displayName || u.username).slice(0, 80), hashSecret(p.password), createdBy || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new OperatorError('that username is already taken', 409);
    throw err;
  }
}

// Verify a login. Returns the operator row on success, null on ANY failure — the caller must
// not be able to tell "no such user" from "wrong password" (that difference enumerates the
// staff roster, which is exactly what an attacker wants before a phishing attempt).
export async function verifyOperatorLogin(username, password) {
  const name = normalizeUsername(username);
  const { rows } = await query(
    'SELECT * FROM operators WHERE username = $1 AND active = true',
    [name]
  );
  const operator = rows[0];

  if (!operator) {
    // Spend comparable time on the miss so response timing doesn't leak account existence.
    verifySecret(String(password ?? ''), hashSecret('timing-equalizer'));
    return null;
  }
  if (!verifySecret(String(password ?? ''), operator.password_hash)) return null;

  await query('UPDATE operators SET last_login_at = now() WHERE id = $1', [operator.id]);
  return operator;
}

// Change your own password. Requires the current one, so a walked-away unlocked session
// can't be used to lock the real operator out of their own account.
export async function changeOwnPassword({ operatorId, currentPassword, newPassword }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM operators WHERE id = $1 FOR UPDATE', [
      operatorId,
    ]);
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
    await client.query(
      'UPDATE operators SET password_hash = $1, must_change_password = false WHERE id = $2',
      [hashSecret(p.password), operatorId]
    );
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
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM operators WHERE active = true AND id <> $1',
      [operatorId]
    );
    if (rows[0].n === 0) throw new OperatorError('cannot deactivate the last active operator', 409);
  }
  const { rows } = await query(
    `UPDATE operators SET active = $1 WHERE id = $2
     RETURNING id, username, display_name, active`,
    [active, operatorId]
  );
  if (!rows[0]) throw new OperatorError('account not found', 404);
  return rows[0];
}

// First-boot bootstrap: if the roster is empty, seed one account from the environment so a
// fresh deployment is reachable at all. Flagged must_change_password — the env value is in
// .env, shell history and possibly a screenshot, so it is a delivery mechanism, not a secret.
export async function ensureBootstrapOperator() {
  const { rows } = await query('SELECT count(*)::int AS n FROM operators');
  if (rows[0].n > 0) return null;

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

  const { rows: created } = await query(
    `INSERT INTO operators(username, display_name, password_hash, must_change_password, created_by)
     VALUES ($1, $2, $3, true, 'system:bootstrap')
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username`,
    [username, 'Bootstrap operator', hashSecret(p.password)]
  );
  if (created[0]) {
    console.warn(
      `[bootstrap] created operator "${username}" from OPERATOR_PASSWORD. ` +
        'Sign in and change this password — it is flagged must_change_password.'
    );
  }
  return created[0] || null;
}
