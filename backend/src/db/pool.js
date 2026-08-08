import pg from 'pg';
import { config } from '../config.js';

// Single shared connection pool for the whole process.
export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

export const query = (text, params) => pool.query(text, params);

// Run a set of statements inside a single transaction. `fn` receives a client.
// Run `fn` inside the caller's transaction if there is one, otherwise open a new one.
// Lets a command be composed into a bigger transaction (payment record + state transition +
// outbox rows must commit together) without duplicating it into two near-identical functions.
export function inTransaction(client, fn) {
  return client ? fn(client) : withTransaction(fn);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
