// Ending customer sessions early (commands/sessions.js) and the guard that enforces it:
//   * a token is live only while its `sv` equals the account's session_version;
//   * tokens from before versions existed (no sv) count as 0 — the deploy signs nobody out;
//   * staff tokens aren't versioned;
//   * requireRole answers 401 to an ended session, and a DB failure is an error, never a pass.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let accounts = {};
const prisma = {
  user: { findUnique: jest.fn(async ({ where }) => (where.id in accounts ? { session_version: accounts[where.id] } : null)) },
};
jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma, withTransaction: async (fn) => fn(prisma) }));

const { sessionIsCurrent, noteSessionVersion, resetSessionCache } = await import('../src/commands/sessions.js');
const { requireRole, signToken } = await import('../src/middleware/auth.js');

beforeEach(() => { accounts = {}; resetSessionCache(); prisma.user.findUnique.mockClear(); });

describe('sessionIsCurrent', () => {
  test('live while the versions match; ended once the account moved on', async () => {
    accounts[7] = 2;
    expect(await sessionIsCurrent({ role: 'customer', uid: 7, sv: 2 })).toBe(true);
    expect(await sessionIsCurrent({ role: 'customer', uid: 7, sv: 1 })).toBe(false);
  });

  test('a token from before versions (no sv) is version 0: live until the first change', async () => {
    accounts[7] = 0;
    expect(await sessionIsCurrent({ role: 'customer', uid: 7 })).toBe(true);
    resetSessionCache();
    accounts[7] = 1;
    expect(await sessionIsCurrent({ role: 'customer', uid: 7 })).toBe(false);
  });

  test('no such account = no session; staff tokens are not versioned', async () => {
    expect(await sessionIsCurrent({ role: 'customer', uid: 99, sv: 0 })).toBe(false);
    expect(await sessionIsCurrent({ role: 'operator', id: 1 })).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  test('cached briefly, and corrected at once when this instance learns of a change', async () => {
    accounts[7] = 0;
    await sessionIsCurrent({ role: 'customer', uid: 7, sv: 0 });
    await sessionIsCurrent({ role: 'customer', uid: 7, sv: 0 });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    noteSessionVersion(7, 1); // what setPassword / the outbox event do
    expect(await sessionIsCurrent({ role: 'customer', uid: 7, sv: 0 })).toBe(false);
  });
});

describe('requireRole', () => {
  const run = async (token) => {
    const req = { get: () => `Bearer ${token}` };
    const out = { status: null, next: null };
    const res = { status: (s) => { out.status = s; return { json: () => out } }, json: () => out };
    await new Promise((resolve) => {
      requireRole('customer')(req, { ...res, status: (s) => { out.status = s; resolve(); return { json: () => out }; } },
        (err) => { out.next = err ?? 'ok'; resolve(); });
    });
    return out;
  };

  test('a live session passes; an ended one is 401, like any bad token', async () => {
    accounts[7] = 3;
    expect((await run(signToken({ role: 'customer', uid: 7, sv: 3 }, 60))).next).toBe('ok');
    expect((await run(signToken({ role: 'customer', uid: 7, sv: 2 }, 60))).status).toBe(401);
  });

  test('a database that cannot answer is an error (503 with a ref), never "signed in"', async () => {
    prisma.user.findUnique.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P1001' }));
    const out = await run(signToken({ role: 'customer', uid: 7, sv: 0 }, 60));
    expect(out.next).toBeInstanceOf(Error);
    expect(out.status).toBeNull();
  });
});
