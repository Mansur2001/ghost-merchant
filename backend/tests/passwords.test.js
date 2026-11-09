// Customer passwords: sign-in that doesn't need an email to arrive, without weakening it.
//   * weak passwords are refused in plain words;
//   * a failed sign-in says nothing about whether the email has an account;
//   * changing a password needs the current one — except in the reset window after a code;
//   * the account's email is told after every change, and that email can never undo one.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let users = [];
const find = ({ where }) => users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) || null;
const prisma = {
  user: {
    findUnique: jest.fn(async (q) => find(q)),
    create: jest.fn(async ({ data }) => {
      if (users.some((u) => u.email === data.email)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const u = { id: users.length + 1, phone_number: null, ...data };
      users.push(u);
      return { id: u.id, phone_number: null, email: u.email };
    }),
    update: jest.fn(async ({ where, data }) => {
      const u = find({ where });
      const { session_version: sv, ...rest } = data;
      if (sv?.increment) u.session_version = (u.session_version || 0) + sv.increment;
      return Object.assign(u, rest);
    }),
  },
  outbox: { create: jest.fn(async () => ({ id: 1 })) },
};
jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma, withTransaction: async (fn) => fn(prisma) }));
const sendPasswordChangedNotice = jest.fn(async () => ({ transport: 'twilio' }));
jest.unstable_mockModule('../src/notify/emailSender.js', () => ({ sendPasswordChangedNotice }));

const { hashSecret } = await import('../src/middleware/auth.js');
const { signUpWithPassword, signInWithPassword, setPassword, PasswordError } = await import('../src/commands/passwords.js');
const { passwordProblem } = await import('../src/domain/customerPassword.js');

beforeEach(() => { users = []; sendPasswordChangedNotice.mockClear(); prisma.outbox.create.mockClear(); });

describe('passwordProblem', () => {
  test('length, not composition rules', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('a long simple phrase')).toBeNull();
  });
  test('the obvious ones are refused', () => {
    for (const p of ['password', '12345678', 'aaaaaaaa', 'Gurikaabe']) expect(passwordProblem(p)).toMatch(/too easy/);
  });
  test('not your email', () => {
    expect(passwordProblem('amina.yusuf99', { email: 'amina.yusuf@example.com' })).toMatch(/email/);
  });
});

describe('sign up and sign in', () => {
  test('sign up works at once; the email starts unverified; the password is hashed', async () => {
    const acct = await signUpWithPassword({ email: 'New@Example.com', password: 'market day 2026' });
    expect(acct.email).toBe('new@example.com');
    expect(users[0].password_hash).not.toContain('market');
    expect(users[0].email_verified_at).toBeUndefined();
  });

  test('a second sign-up with the same email is told to sign in', async () => {
    await signUpWithPassword({ email: 'a@example.com', password: 'market day 2026' });
    await expect(signUpWithPassword({ email: 'a@example.com', password: 'another one 99' }))
      .rejects.toMatchObject({ status: 409 });
  });

  test('right password signs in; wrong password, unknown email and code-only accounts all get the SAME error', async () => {
    await signUpWithPassword({ email: 'a@example.com', password: 'market day 2026' });
    users.push({ id: 9, email: 'codeonly@example.com', password_hash: null, phone_number: null });
    expect((await signInWithPassword({ email: 'A@example.com', password: 'market day 2026' })).id).toBe(1);
    const errs = await Promise.all([
      signInWithPassword({ email: 'a@example.com', password: 'wrong guess 1' }).catch((e) => e),
      signInWithPassword({ email: 'nobody@example.com', password: 'market day 2026' }).catch((e) => e),
      signInWithPassword({ email: 'codeonly@example.com', password: 'market day 2026' }).catch((e) => e),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(PasswordError);
      expect(e).toMatchObject({ status: 401, message: 'wrong email or password' });
    }
  });
});

describe('setPassword', () => {
  const base = (extra) => ({ id: 1, email: 'a@example.com', phone_number: null, ...extra });

  test('changing needs the current password', async () => {
    users.push(base({ password_hash: hashSecret('old pass phrase') }));
    await expect(setPassword({ userId: 1, currentPassword: 'nope nope', newPassword: 'new pass phrase' }))
      .rejects.toMatchObject({ status: 403 });
    await setPassword({ userId: 1, currentPassword: 'old pass phrase', newPassword: 'new pass phrase' });
    expect((await signInWithPassword({ email: 'a@example.com', password: 'new pass phrase' })).id).toBe(1);
  });

  test('forgot password: inside the reset window after a code, no current password — once', async () => {
    users.push(base({ password_hash: hashSecret('forgotten one'), password_reset_until: new Date(Date.now() + 60_000) }));
    await setPassword({ userId: 1, newPassword: 'brand new phrase' });
    expect(users[0].password_reset_until).toBeNull();
    await expect(setPassword({ userId: 1, newPassword: 'and another one' })).rejects.toMatchObject({ status: 403 });
  });

  test('an expired window is no window', async () => {
    users.push(base({ password_hash: hashSecret('forgotten one'), password_reset_until: new Date(Date.now() - 1) }));
    await expect(setPassword({ userId: 1, newPassword: 'brand new phrase' })).rejects.toMatchObject({ status: 403 });
  });

  test('a code-only account sets its first password without a current one', async () => {
    users.push(base({ password_hash: null }));
    await setPassword({ userId: 1, newPassword: 'first ever phrase' });
    expect(users[0].password_hash).toBeTruthy();
  });

  test('the owner is emailed after a change ("changed") and after a first password ("set")', async () => {
    users.push(base({ password_hash: hashSecret('old pass phrase') }));
    await setPassword({ userId: 1, currentPassword: 'old pass phrase', newPassword: 'new pass phrase' });
    expect(sendPasswordChangedNotice).toHaveBeenCalledWith('a@example.com', { first: false });
    users = [base({ password_hash: null })];
    await setPassword({ userId: 1, newPassword: 'first ever phrase' });
    expect(sendPasswordChangedNotice).toHaveBeenLastCalledWith('a@example.com', { first: true });
  });

  test('a change signs out every other device: the version goes up, with its event, and is returned', async () => {
    users.push(base({ password_hash: hashSecret('old pass phrase'), session_version: 3 }));
    const { sv } = await setPassword({ userId: 1, currentPassword: 'old pass phrase', newPassword: 'new pass phrase' });
    expect(sv).toBe(4);
    expect(users[0].session_version).toBe(4);
    expect(prisma.outbox.create).toHaveBeenCalledWith({
      data: { event_name: 'customer.sessions_ended', payload: { uid: 1, sv: 4 } }, select: { id: true },
    });
  });

  test('a refused change sends no notice', async () => {
    users.push(base({ password_hash: hashSecret('old pass phrase') }));
    await expect(setPassword({ userId: 1, currentPassword: 'nope nope', newPassword: 'new pass phrase' })).rejects.toThrow();
    expect(sendPasswordChangedNotice).not.toHaveBeenCalled();
    expect(prisma.outbox.create).not.toHaveBeenCalled(); // and nobody is signed out
  });

  test('a failed notice email never fails (or undoes) the change', async () => {
    users.push(base({ password_hash: hashSecret('old pass phrase') }));
    sendPasswordChangedNotice.mockRejectedValueOnce(new Error('sendgrid down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(setPassword({ userId: 1, currentPassword: 'old pass phrase', newPassword: 'new pass phrase' })).resolves.toEqual({ sv: 1 });
    await new Promise((r) => setImmediate(r));
    expect((await signInWithPassword({ email: 'a@example.com', password: 'new pass phrase' })).id).toBe(1);
    expect(warn.mock.calls.join(' ')).toMatch(/a••|not sent/);
    warn.mockRestore();
  });

  test('a phone-only account has no email to sign in with', async () => {
    users.push({ id: 1, email: null, phone_number: '+252612345678', password_hash: null });
    await expect(setPassword({ userId: 1, newPassword: 'first ever phrase' })).rejects.toThrow(/add an email/);
  });
});
