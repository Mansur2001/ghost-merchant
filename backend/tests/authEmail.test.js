// Sign-in codes by email. The phone is the identity, so an email may only ever receive a code
// for the account it was CONFIRMED on — and asking for one must not reveal whether a number has
// an account or an email at all.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let userRow = null;
let upsertWins = true;
const prisma = {
  $queryRaw: jest.fn(async () => (upsertWins ? [{ phone: 'x' }] : [])),
  user: { findUnique: jest.fn(async () => userRow) },
  otpCode: { findUnique: jest.fn(async () => ({ last_sent_at: new Date() })), deleteMany: jest.fn() },
  emailChallenge: { deleteMany: jest.fn() },
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

const { requestOtp, requestOtpByEmail, verifyOtpByEmail, requestEmailLink } = await import('../src/commands/auth.js');

// The key each conditional upsert wrote (first value interpolated into the tagged template).
const upsertKeys = () => prisma.$queryRaw.mock.calls.map((c) => c[1]);

beforeEach(() => {
  userRow = null;
  upsertWins = true;
  [sendOtpSms, sendOtpEmail, prisma.otpCode.deleteMany, prisma.$queryRaw, prisma.user.findUnique].forEach((f) => f.mockClear());
});

describe('requestOtpByEmail', () => {
  test('a confirmed email gets the code for its account; no SMS is sent', async () => {
    userRow = { phone_number: '+252612345678' };
    const r = await requestOtpByEmail('  Amina@Example.com ');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'amina@example.com' } }));
    expect(sendOtpEmail).toHaveBeenCalledWith('amina@example.com', expect.stringMatching(/^\d{6}$/));
    expect(sendOtpSms).not.toHaveBeenCalled();
    // The challenge lands on the phone: that is what verification checks.
    expect(upsertKeys()).toContain('+252612345678');
    expect(r).not.toHaveProperty('phone');
  });

  test('no account has this email: nothing is sent, and the answer looks the same', async () => {
    const r = await requestOtpByEmail('nobody@example.com');
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ expiresInSeconds: 300 });
    expect(r).not.toHaveProperty('phone');
  });

  test('the cooldown is keyed by the email, and checked before the account is looked up', async () => {
    upsertWins = false;
    await expect(requestOtpByEmail('amina@example.com')).rejects.toMatchObject({ status: 429 });
    userRow = { phone_number: '+252612345678' };
    await expect(requestOtpByEmail('amina@example.com')).rejects.toMatchObject({ status: 429 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(upsertKeys().every((k) => /^email:[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  test('refuses something that is not an email before writing anything', async () => {
    await expect(requestOtpByEmail('not-an-email')).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('a failed send leaves no live code behind', async () => {
    userRow = { phone_number: '+252612345678' };
    sendOtpEmail.mockRejectedValueOnce(new Error('sendgrid 401'));
    await expect(requestOtpByEmail('amina@example.com')).rejects.toThrow('sendgrid 401');
    expect(prisma.otpCode.deleteMany).toHaveBeenCalledWith({ where: { phone: '+252612345678' } });
  });
});

describe('verifyOtpByEmail', () => {
  test('an email with no account fails with the same error as a wrong code', async () => {
    await expect(verifyOtpByEmail('nobody@example.com', '123456')).rejects.toMatchObject({
      status: 401, message: 'invalid or expired code',
    });
  });
});

describe('requestOtp', () => {
  test('sends by SMS', async () => {
    await requestOtp('612345678');
    expect(sendOtpSms).toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});

describe('requestEmailLink', () => {
  test('refuses something that is not an email before writing anything', async () => {
    prisma.$queryRaw.mockClear();
    await expect(requestEmailLink('+252612345678', 'not-an-email')).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
