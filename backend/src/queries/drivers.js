// CQRS read side for drivers. Powers the operator's assignment picker + driver stats panel.
import { query } from '../db/pool.js';

// All drivers with their current workload (active = dispatched or in-transit).
export async function getDriversWithStats() {
  const { rows } = await query(
    `SELECT d.id, d.name, d.msisdn, d.active,
            count(o.id) FILTER (WHERE o.status IN ('DISPATCHED', 'IN_TRANSIT')) AS active_orders,
            count(o.id) FILTER (WHERE o.status = 'DELIVERED')                   AS delivered_orders
       FROM drivers d
       LEFT JOIN orders o ON o.driver_id = d.id
      GROUP BY d.id
      ORDER BY d.name ASC`
  );
  return rows;
}

export async function getDriverById(id) {
  const { rows } = await query(
    'SELECT id, name, msisdn, active FROM drivers WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}
