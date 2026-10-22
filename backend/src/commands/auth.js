// CQRS write side for customer authentication (one-time passcode by SMS or by email).
//
// A customer is an account (users.id), reached by proving they hold a phone OR read an inbox.
// This is the gate that turns "something someone typed" into "something they can prove is
// theirs". Every customer-facing read is authorized against the account id minted here.
import { createHash } from 'node:crypto';
import { prisma, withTransaction } from '../db/prisma.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import {
  generateCode,
  hashCode,
  verifyCode,
  cooldownRemainingMs,
  MAX_ATTEMPTS,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  reviewCodeFor,
} from '../domain/otp.js';
import { maskPhone } from '../domain/redact.js';
import { normalizeEmail, maskEmail } from '../domain/email.js';
import { sendOtpSms } from '../notify/smsSender.js';
import { sendOtpEmail, sendEmailLinkCode, emailConfigured } from '../notify/emailSender.js';
import { config } from '../config.js';

export class OtpCooldownError extends Error {
  constructor(retryAfterMs) {
    super('a code was just sent — wait before requesting another');
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
  }
}

// Deliberately one error for every failure mode of verification. Distinguishing "no challenge
// for this number" from "wrong code" would turn the endpoint into a phone-number oracle.
export class OtpInvalidError extends Error {
  constructor() {
    super('invalid or expired code');
    this.status = 401;
  }
}

export class AuthInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Email codes are offered only when SendGrid is set up; a dev box without it uses the log.
export function emailAvailable() {
  return emailConfigured() || config.env !== 'production';
}

// Issue (or re-issue) a passcode for a phone number, by SMS. The UPSERT is conditional on the
// cooldown having elapsed, which makes "one live challenge per number" and the resend throttle
// a single atomic decision — two concurrent requests cannot both win, and the loser learns
// nothing except "wait".
export async function requestOtp(rawPhone) {
  const phone = normalizeMsisdnOrThrow(rawPhone);
  const reviewCode = reviewCodeFor(phone, config.otp.review);
  const code = reviewCode ?? generateCode();
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  await issueChallenge(phone, code);

  // The review number gets no SMS: nobody holds a handset for it. Its transport is not `log`,
  // so the route never echoes the code back either — the reviewer has it from the Console notes.
  if (reviewCode) {
    console.warn(`[OTP] review login challenge issued for ${maskPhone(phone)}`);
    return { phone, transport: 'review', expiresInSeconds: ttlSeconds, code };
  }

  try {
    const { transport } = await sendOtpSms(phone, code);
    return { phone, transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    // Never leave a live challenge the customer was never told about: if the SMS didn't go
    // out, the code doesn't exist. Also lets them retry immediately instead of waiting out a
    // cooldown for a message that never arrived.
    await prisma.otpCode.deleteMany({ where: { phone } });
    throw err;
  }
}

// RAW, and it must stay raw. This is a CONDITIONAL upsert: the update only fires if the
// cooldown has elapsed. Prisma's upsert has no WHERE on its update branch, so the equivalent
// would be read-then-write — and two concurrent requests would both read "the cooldown passed"
// and both send a message, which is a real cost and an SMS-bomb vector.
async function issueChallenge(key, code, { cooldown = true } = {}) {
  const cooldownSeconds = cooldown ? Math.ceil(RESEND_COOLDOWN_MS / 1000) : 0;
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);
  const rows = await prisma.$queryRaw`
    INSERT INTO otp_codes(phone, code_hash, expires_at, attempts, last_sent_at)
    VALUES (${key}, ${hashCode(code)}, now() + (${String(ttlSeconds)} || ' seconds')::interval, 0, now())
    ON CONFLICT (phone) DO UPDATE
      SET code_hash    = EXCLUDED.code_hash,
          expires_at   = EXCLUDED.expires_at,
          attempts     = 0,
          last_sent_at = now()
      WHERE otp_codes.last_sent_at <= now() - (${String(cooldownSeconds)} || ' seconds')::interval
    RETURNING phone
  `;
  if (rows.length === 0) {
    // Conflict + cooldown not elapsed: tell the caller how long to wait, nothing else.
    const existing = await prisma.otpCode.findUnique({ where: { phone: key }, select: { last_sent_at: true } });
    throw new OtpCooldownError(cooldownRemainingMs(existing?.last_sent_at));
  }
}

// Email sign-in challenges live in otp_codes beside the phone ones, keyed by a hash of the
// email: the key can never collide with an E.164 phone, and no address sits in the table.
const emailKey = (email) => `email:${createHash('sha256').update(email).digest('hex')}`;

// Sign in (or sign up) by email: the code goes to the email typed, and proving you read that
// inbox is enough — exactly as proving you hold a phone is. The account is created on verify,
// so the answer is the same whether or not one exists yet.
export async function requestOtpByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthInputError('that does not look like an email address');
  if (!emailAvailable()) throw new AuthInputError('email codes are not available');
  const key = emailKey(email);
  const code = generateCode();
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  await issueChallenge(key, code);
  try {
    const { transport } = await sendOtpEmail(email, code);
    return { transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    // As with SMS: a code that never went out must not exist.
    await prisma.otpCode.deleteMany({ where: { phone: key } });
    console.error(`[OTP] sign-in email to ${maskEmail(email)} failed: ${err.message}`);
    throw err;
  }
}

const ACCOUNT = { id: true, phone_number: true, email: true };

// Verify a code sent by SMS. On success the account behind the phone is found or created.
export async function verifyOtp(rawPhone, submittedCode) {
  const phone = normalizeMsisdnOrThrow(rawPhone);
  return consumeChallenge(phone, submittedCode, (tx) =>
    tx.user.upsert({ where: { phone_number: phone }, update: {}, create: { phone_number: phone }, select: ACCOUNT }));
}

// Verify a code sent by email. On success the account behind the email is found or created.
// Same attempt cap, single use and one generic error as the phone.
export async function verifyOtpByEmail(rawEmail, submittedCode) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new OtpInvalidError();
  return consumeChallenge(emailKey(email), submittedCode, (tx) =>
    tx.user.upsert({ where: { email }, update: {}, create: { email }, select: ACCOUNT }));
}

// Check a submitted code against the challenge under `key`. On success the challenge is
// consumed (single-use) and `account(tx)` finds or creates the account, in the same transaction.
async function consumeChallenge(key, submittedCode, account) {
  // Failures RETURN from the transaction instead of throwing inside it. A throw rolls the
  // transaction back — including the attempts++ and the burn below — which silently turned
  // the 5-attempt cap into no cap at all. The error is raised only after the count commits.
  const outcome = await withTransaction(async (tx) => {
    // RAW, and it must stay raw: FOR UPDATE. Without the lock, concurrent guesses both read
    // attempts=4 and are each granted a "last" try — turning a 5-attempt cap into as many
    // tries as the attacker can run in parallel.
    const rows = await tx.$queryRaw`
      SELECT phone, code_hash, expires_at, attempts FROM otp_codes
       WHERE phone = ${key} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) return { ok: false };

    const expired = new Date(challenge.expires_at).getTime() <= Date.now();
    if (expired || challenge.attempts >= MAX_ATTEMPTS) {
      await tx.otpCode.deleteMany({ where: { phone: key } });
      return { ok: false };
    }

    if (!verifyCode(String(submittedCode ?? ''), challenge.code_hash)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Burn the challenge — a fresh code (and a fresh cooldown) is now required.
        await tx.otpCode.deleteMany({ where: { phone: key } });
      } else {
        await tx.otpCode.update({ where: { phone: key }, data: { attempts } });
      }
      return { ok: false };
    }

    // Success: single-use, so the code dies with this transaction.
    await tx.otpCode.deleteMany({ where: { phone: key } });
    return { ok: true, user: await account(tx) };
  });

  if (!outcome.ok) throw new OtpInvalidError();
  return outcome.user;
}

// ── Adding an email to a phone account (signed-in customers only) ──
// The session proves the account; this proves the email. After both, signing in with that
// email reaches this account.

export class EmailTakenError extends Error {
  constructor() {
    super('this email already has its own account');
    this.status = 409;
  }
}

// Send a confirmation code to the email the customer typed. Same atomic cooldown as login codes.
export async function requestEmailLink(userId, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthInputError('that does not look like an email address');
  if (!emailAvailable()) throw new AuthInputError('email codes are not available');
  const code = generateCode();
  const cooldownSeconds = Math.ceil(RESEND_COOLDOWN_MS / 1000);
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  // RAW for the same reason as requestOtp: a conditional upsert is the only atomic cooldown.
  const rows = await prisma.$queryRaw`
    INSERT INTO email_challenges(user_id, email, code_hash, expires_at, attempts, last_sent_at)
    VALUES (${userId}, ${email}, ${hashCode(code)}, now() + (${String(ttlSeconds)} || ' seconds')::interval, 0, now())
    ON CONFLICT (user_id) DO UPDATE
      SET email        = EXCLUDED.email,
          code_hash    = EXCLUDED.code_hash,
          expires_at   = EXCLUDED.expires_at,
          attempts     = 0,
          last_sent_at = now()
      WHERE email_challenges.last_sent_at <= now() - (${String(cooldownSeconds)} || ' seconds')::interval
    RETURNING user_id
  `;
  if (rows.length === 0) {
    const existing = await prisma.emailChallenge.findUnique({ where: { user_id: userId }, select: { last_sent_at: true } });
    throw new OtpCooldownError(cooldownRemainingMs(existing?.last_sent_at));
  }

  try {
    const { transport } = await sendEmailLinkCode(email, code);
    return { email, transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    await prisma.emailChallenge.deleteMany({ where: { user_id: userId } });
    console.error(`[OTP] email link to ${maskEmail(email)} failed: ${err.message}`);
    throw err;
  }
}

// Confirm the code and store the email. Failures return from the transaction and throw after,
// so the attempt count commits (see consumeChallenge).
export async function verifyEmailLink(userId, submittedCode) {
  const outcome = await withTransaction(async (tx) => {
    // RAW: FOR UPDATE, so parallel guesses can't each get the "last" attempt.
    const rows = await tx.$queryRaw`
      SELECT user_id, email, code_hash, expires_at, attempts FROM email_challenges
       WHERE user_id = ${userId} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) return { ok: false };
    if (new Date(challenge.expires_at).getTime() <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
      await tx.emailChallenge.deleteMany({ where: { user_id: userId } });
      return { ok: false };
    }
    if (!verifyCode(String(submittedCode ?? ''), challenge.code_hash)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await tx.emailChallenge.deleteMany({ where: { user_id: userId } });
      else await tx.emailChallenge.update({ where: { user_id: userId }, data: { attempts } });
      return { ok: false };
    }
    await tx.emailChallenge.deleteMany({ where: { user_id: userId } });
    // One email, one account (users.email is UNIQUE). An older account with a phone gives it
    // up — it can still sign in by SMS. An account that signs in ONLY with this email keeps
    // it: taking it would lock that account, and its orders, away from everyone.
    const owner = await tx.user.findUnique({ where: { email: challenge.email }, select: ACCOUNT });
    if (owner && owner.id !== userId) {
      if (!owner.phone_number) return { ok: false, taken: true };
      await tx.user.update({ where: { id: owner.id }, data: { email: null } });
    }
    await tx.user.update({ where: { id: userId }, data: { email: challenge.email } });
    return { ok: true, email: challenge.email };
  });
  // Said only AFTER the code proved this person reads that inbox, so it reveals nothing.
  if (outcome.taken) throw new EmailTakenError();
  if (!outcome.ok) throw new OtpInvalidError();
  return { email: outcome.email };
}

// Stop signing in with the email. Refused when it's the account's only way in.
export async function removeEmail(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT });
  if (!user?.phone_number) throw new AuthInputError('this email is how you sign in');
  await withTransaction(async (tx) => {
    await tx.emailChallenge.deleteMany({ where: { user_id: userId } });
    await tx.user.update({ where: { id: userId }, data: { email: null } });
  });
}

export async function getCustomer(userId) {
  return prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT });
}

// Housekeeping: expired challenges are dead weight (and PII-adjacent). Cheap indexed delete.
export async function sweepExpiredOtps() {
  const now = new Date();
  const [codes, links] = await Promise.all([
    prisma.otpCode.deleteMany({ where: { expires_at: { lt: now } } }),
    prisma.emailChallenge.deleteMany({ where: { expires_at: { lt: now } } }),
  ]);
  return codes.count + links.count;
}
