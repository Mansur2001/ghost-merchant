// The rules that keep seed data and production apart. Pure functions: callers fetch the rows,
// these decide — so the decisions are unit-tested without a database.
import { verifySecret } from '../middleware/auth.js';
import { SEED_OPERATORS, SEED_DRIVERS } from './seedFixtures.js';

export const SEED_CONFIRM_VALUE = 'wipe-local-data';

// Why the seed must not run, or null if it may.
//
// NODE_ENV must be EXPLICITLY development or test. "Not production" is not enough: config.js
// treats an unset NODE_ENV as development, so a VPS that merely forgot to set it would pass a
// `!== 'production'` check — and the seed TRUNCATEs every domain table. There is deliberately
// no override for this one.
//
// Beyond that, any row the seed did not create means someone's data is in this database. On a
// laptop that is usually your own test login; it still takes an explicit confirmation, because
// the same command against the wrong database is unrecoverable.
export function seedRefusal({ nodeEnv, nonSeedRows, confirm }) {
  if (!['development', 'test'].includes(nodeEnv)) {
    return `NODE_ENV is "${nodeEnv ?? 'unset'}" — the seed only runs with NODE_ENV=development or test.`;
  }
  const found = Object.entries(nonSeedRows || {}).filter(([, n]) => n > 0);
  if (found.length && confirm !== SEED_CONFIRM_VALUE) {
    const list = found.map(([table, n]) => `${n} ${table}`).join(', ');
    return (
      `this database holds data the seed did not create (${list}). ` +
      `If it is your local dev database, re-run with SEED_CONFIRM=${SEED_CONFIRM_VALUE}.`
    );
  }
  return null;
}

// Which publicly-known seed credentials still log in, given the live operator and driver rows.
// Matched on identity AND a working secret: an operator called "hodan" with a real password
// is a person, not a leak.
export function liveSeedCredentials(operators, drivers) {
  const live = [];
  for (const s of SEED_OPERATORS) {
    const row = operators.find((o) => o.username === s.username && o.active !== false);
    if (row && verifySecret(s.password, row.password_hash)) live.push(`operator "${s.username}"`);
  }
  for (const s of SEED_DRIVERS) {
    const row = drivers.find((d) => d.msisdn === s.msisdn && d.active !== false);
    if (row && verifySecret(s.pin, row.pin_hash)) live.push(`driver ${s.name} (${s.msisdn})`);
  }
  return live;
}
