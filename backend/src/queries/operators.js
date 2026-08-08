// CQRS read side for operator accounts. Never selects password_hash — a read model has no
// business carrying a credential, and this is the query the roster UI renders.
import { query } from '../db/pool.js';

export async function listOperators() {
  const { rows } = await query(
    `SELECT id, username, display_name, active, must_change_password, last_login_at,
            created_at, created_by
       FROM operators
      ORDER BY active DESC, username ASC`
  );
  return rows;
}

export async function getOperatorById(id) {
  const { rows } = await query(
    `SELECT id, username, display_name, active, must_change_password, last_login_at
       FROM operators WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}
