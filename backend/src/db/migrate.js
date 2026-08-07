// Minimal, dependency-free migration runner. Applies every *.sql file in migrations/
// in filename order, exactly once, tracked in the schema_migrations table.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (rowCount > 0) {
      console.log(`↳ skip   ${file}`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ apply  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ FAILED ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log('Migrations complete.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
