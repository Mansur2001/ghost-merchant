// Sign-in codes by email. An email is a way in on its own, exactly like a phone: proving you
// read the inbox signs you in, and signs you up the first time. The account, not the email or
// the phone, is who you are.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { hashCode } from '../src/domain/otp.js';

let challenge = null; // what SELECT ... FOR UPDATE finds
let upsertWins = true; // whether the conditional cooldown upsert fires
let owner = null; // the account that already has an email
let account = null; // the account removeEmail looks at
const prisma = {
  $queryRaw: jest.fn(async (sql) => (sql.join('').includes('SELECT') ? (challenge ? [challenge] : []) : (upsertWins ? [{ k: 1 }] : []))),
  user: {
    findUnique: jest.fn(async ({ where }) => (where.email ? owner : account)),
    upsert: jest.fn(async ({ create }) => ({ id: 41, phone_number: null, email: null, ...create })),
    update: jest.fn(async () => ({})),
  },
  otpCode: { findUnique: jest.fn(async () => ({ last_sent_at: new Date() })), deleteMany: jest.fn(), update: jest.fn() },
  emailChallenge: { deleteMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
};
const sendOtpSms = jest.fn(async () => ({ transport: 'twilio' }));
const sendOtpEmail = jest.fn(async () => ({ transport: 'twilio' }));

jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma, withTransaction: async (fn) => fn(prisma) }));
jest.unstable_mockModule('../src/notify/smsSender.js', () => ({ sendOtpSms }));
jest.unstable_mockModule('../src/notify/emailSender.js', () => ({
  sendOtpEmail,
  sendEmailLinkCode: jest.fn(async () => ({ transport: 'twilio' })),
  emailConfigured: () => true,
}));

const {
  requestOtp, requestOtpByEmail, verifyOtpByEmail, verifyOtp, requestEmailLink, verifyEmailLink, removeEmail,
} = await import('../src/commands/auth.js');

// The key each raw call used (first value interpolated into the tagged template).
const rawKeys = () => prisma.$queryRaw.mock.calls.map((c) => c[1]);
const live = (code) => ({ code_hash: hashCode(code), expires_at: new Date(Date.now() + 60000), attempts: 0, email: 'amina@example.com' });

beforeEach(() => {
  challenge = null; upsertWins = true; owner = null; account = null;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  [sendOtpSms, sendOtpEmail, prisma.$queryRaw, prisma.otpCode.deleteMany, prisma.user.upsert, prisma.user.update]
    .forEach((f) => f.mockClear());
});

describe('requestOtpByEmail', () => {
  test('any email gets a code — new customers too — and no SMS is sent', async () => {
    const r = await requestOtpByEmail('  Amina@Example.com ');
    expect(sendOtpEmail).toHaveBeenCalledWith('amina@example.com', expect.stringMatching(/^\d{6}$/));
    expect(sendOtpSms).not.toHaveBeenCalled();
    expect(r).toMatchObject({ expiresInSeconds: 300 });
  });

  test('the challenge is keyed by a hash of the email: no address stored, no clash with a phone', async () => {
    await requestOtpByEmail('amina@example.com');
    expect(rawKeys()).toEqual([expect.stringMatching(/^email:[0-9a-f]{64}$/)]);
  });

  test('inside the cooldown: 429 and nothing sent', async () => {
    upsertWins = false;
    await expect(requestOtpByEmail('amina@example.com')).rejects.toMatchObject({ status: 429 });
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  test('refuses something that is not an email before writing anything', async () => {
    await expect(requestOtpByEmail('not-an-email')).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('a failed send leaves no live code behind', async () => {
    sendOtpEmail.mockRejectedValueOnce(new Error('sendgrid 401'));
    await expect(requestOtpByEmail('amina@example.com')).rejects.toThrow('sendgrid 401');
    expect(prisma.otpCode.deleteMany).toHaveBeenCalledWith({ where: { phone: rawKeys()[0] } });
  });
});

describe('verifyOtpByEmail', () => {
  test('the right code signs in to the account behind the email, creating it the first time', async () => {
    challenge = live('123456');
    const user = await verifyOtpByEmail('Amina@Example.com', '123456');
    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'amina@example.com' }, create: { email: 'amina@example.com' },
    }));
    expect(user).toMatchObject({ id: 41, email: 'amina@example.com', phone_number: null });
    expect(rawKeys()[0]).toMatch(/^email:[0-9a-f]{64}$/);
  });

  test('a wrong code is the one generic error, and no account is touched', async () => {
    challenge = live('123456');
    await expect(verifyOtpByEmail('amina@example.com', '654321')).rejects.toMatchObject({ status: 401, message: 'invalid or expired code' });
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  test('no code was ever sent: the same error', async () => {
    await expect(verifyOtpByEmail('nobody@example.com', '123456')).rejects.toMatchObject({ status: 401 });
  });
});

describe('verifyOtp (SMS)', () => {
  test('signs in to the account behind the phone', async () => {
    challenge = live('123456');
    const user = await verifyOtp('612345678', '123456');
    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { phone_number: '+252612345678' } }));
    expect(user.id).toBe(41);
  });
});

describe('requestOtp', () => {
  test('sends by SMS', async () => {
    await requestOtp('612345678');
    expect(sendOtpSms).toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});

describe('adding an email to a phone account', () => {
  test('refuses something that is not an email before writing anything', async () => {
    await expect(requestEmailLink(7, 'not-an-email')).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('an email that is its own account (no phone) is never taken from it', async () => {
    challenge = live('123456');
    owner = { id: 9, phone_number: null, email: 'amina@example.com' };
    await expect(verifyEmailLink(7, '123456')).rejects.toMatchObject({ status: 409 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('an older phone account gives the email up: it can still sign in by SMS', async () => {
    challenge = live('123456');
    owner = { id: 9, phone_number: '+252651234567', email: 'amina@example.com' };
    await expect(verifyEmailLink(7, '123456')).resolves.toEqual({ email: 'amina@example.com' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { email: null } });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { email: 'amina@example.com' } });
  });

  test("an email-only account can't remove its only way in", async () => {
    account = { id: 9, phone_number: null, email: 'amina@example.com' };
    await expect(removeEmail(9)).rejects.toMatchObject({ status: 400 });
  });
});
