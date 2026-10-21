// Sign-in codes by email. The phone is the identity, so an email may only ever receive a code
// for the account it was CONFIRMED on — and asking for one must not reveal whether a number has
// an account or an email at all.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let userRow = null;
let upsertWins = true;
const prisma = {
  $queryRaw: jest.fn(async () => (upsertWins ? [{ phone: '+252612345678' }] : [])),
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

const { requestOtp, requestEmailLink } = await import('../src/commands/auth.js');

beforeEach(() => {
  userRow = null;
  upsertWins = true;
  [sendOtpSms, sendOtpEmail, prisma.otpCode.deleteMany].forEach((f) => f.mockClear());
});

describe('requestOtp by email', () => {
  test('a confirmed email gets the code; no SMS is sent', async () => {
    userRow = { email: 'amina@example.com' };
    const r = await requestOtp('612345678', { channel: 'email' });
    expect(sendOtpEmail).toHaveBeenCalledWith('amina@example.com', expect.stringMatching(/^\d{6}$/));
    expect(sendOtpSms).not.toHaveBeenCalled();
    expect(r.transport).toBe('twilio');
  });

  test('no email on file: nothing is sent, but the answer looks the same', async () => {
    const r = await requestOtp('612345678', { channel: 'email' });
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ phone: '+252612345678', expiresInSeconds: 300 });
    // The challenge row stays, so a second request inside the cooldown is a 429 exactly as it
    // would be for a number that does have an email.
    expect(prisma.otpCode.deleteMany).not.toHaveBeenCalled();
  });

  test('the cooldown answers the same whether or not an email exists', async () => {
    upsertWins = false;
    await expect(requestOtp('612345678', { channel: 'email' })).rejects.toMatchObject({ status: 429 });
    userRow = { email: 'amina@example.com' };
    await expect(requestOtp('612345678', { channel: 'email' })).rejects.toMatchObject({ status: 429 });
  });

  test('sms stays the default', async () => {
    await requestOtp('612345678');
    expect(sendOtpSms).toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  test('an unknown channel is refused', async () => {
    await expect(requestOtp('612345678', { channel: 'pigeon' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('requestEmailLink', () => {
  test('refuses something that is not an email before writing anything', async () => {
    prisma.$queryRaw.mockClear();
    await expect(requestEmailLink('+252612345678', 'not-an-email')).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
