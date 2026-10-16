// The seed TRUNCATEs every domain table, and its credentials are public. These rules are what
// keep either from reaching a real deployment.
import { describe, test, expect } from '@jest/globals';
import { seedRefusal, liveSeedCredentials, SEED_CONFIRM_VALUE } from '../src/db/seedSafety.js';
import { SEED_OPERATORS, SEED_DRIVERS } from '../src/db/seedFixtures.js';
import { hashSecret } from '../src/middleware/auth.js';

const empty = { customers: 0, operators: 0, drivers: 0, 'access requests': 0 };

describe('seedRefusal', () => {
  test('runs on a dev database holding only seed data', () => {
    expect(seedRefusal({ nodeEnv: 'development', nonSeedRows: empty })).toBeNull();
    expect(seedRefusal({ nodeEnv: 'test', nonSeedRows: empty })).toBeNull();
  });

  test('refuses production, with no override', () => {
    expect(seedRefusal({ nodeEnv: 'production', nonSeedRows: empty, confirm: SEED_CONFIRM_VALUE }))
      .toMatch(/NODE_ENV/);
  });

  test('refuses an UNSET NODE_ENV — the case a "not production" check lets through', () => {
    // config.js treats unset as development; a VPS that forgot to set it is still a VPS.
    expect(seedRefusal({ nodeEnv: undefined, nonSeedRows: empty })).toMatch(/unset/);
    expect(seedRefusal({ nodeEnv: 'staging', nonSeedRows: empty })).toMatch(/NODE_ENV/);
  });

  test('refuses to wipe data it did not create, and says what it found', () => {
    const r = seedRefusal({ nodeEnv: 'development', nonSeedRows: { ...empty, customers: 2 } });
    expect(r).toMatch(/2 customers/);
    expect(r).toMatch(/SEED_CONFIRM=wipe-local-data/);
  });

  test('wipes it only with the exact confirmation', () => {
    const rows = { ...empty, customers: 2 };
    expect(seedRefusal({ nodeEnv: 'development', nonSeedRows: rows, confirm: 'yes' })).not.toBeNull();
    expect(seedRefusal({ nodeEnv: 'development', nonSeedRows: rows, confirm: SEED_CONFIRM_VALUE })).toBeNull();
  });
});

describe('liveSeedCredentials', () => {
  const op = (username, password, active = true) => ({ username, password_hash: hashSecret(password), active });
  const drv = (msisdn, pin, active = true) => ({ msisdn, pin_hash: hashSecret(pin), active });

  test('flags every seeded operator and driver whose public secret still works', () => {
    const live = liveSeedCredentials(
      SEED_OPERATORS.map((o) => op(o.username, o.password)),
      SEED_DRIVERS.map((d) => drv(d.msisdn, d.pin))
    );
    expect(live).toHaveLength(SEED_OPERATORS.length + SEED_DRIVERS.length);
  });

  test('a same-named account with a REAL password is a person, not a leak', () => {
    expect(liveSeedCredentials([op('hodan', 'a-real-long-password-9')], [])).toEqual([]);
    expect(liveSeedCredentials([], [drv(SEED_DRIVERS[0].msisdn, '9182')])).toEqual([]);
  });

  test('deactivated seed accounts do not count — they cannot log in', () => {
    const o = SEED_OPERATORS[1];
    const d = SEED_DRIVERS[0];
    expect(liveSeedCredentials([op(o.username, o.password, false)], [drv(d.msisdn, d.pin, false)])).toEqual([]);
  });
});
