// CQRS write side for customer authentication (phone number + one-time passcode).
//
// The customer's phone number IS their identity (invariant 4), so this is the gate that turns
// "a number someone typed" into "a number someone can prove they hold". Every customer-facing
// read is authorized against the phone claim minted here.
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

// The cooldown for email sign-in is keyed by the EMAIL, never by the account it belongs to, so
// the answer (cooldown included) depends only on what was typed. Keying it by the account's
// phone would let someone who knows a number text it a code, then try emails until one is
// "wait 60s" — learning whose email that is. The row holds an unusable random code.
const emailCooldownKey = (email) => `email:${createHash('sha256').update(email).digest('hex')}`;

// Sign in by email: the customer types the email they confirmed while signed in, and the code
// for THEIR phone goes there. The phone is still the identity (invariant 4); the email only
// finds it. With no account behind the email nothing is sent, and the answer is the same.
export async function requestOtpByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthInputError('that does not look like an email address');
  if (!emailAvailable()) throw new AuthInputError('email codes are not available');
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  await issueChallenge(emailCooldownKey(email), generateCode());

  const user = await prisma.user.findUnique({ where: { email }, select: { phone_number: true } });
  if (!user) return { transport: 'none', expiresInSeconds: ttlSeconds };

  // The email's own cooldown above already throttles this, so the phone's challenge is
  // replaced outright — the newest code wins, exactly as a resend does.
  const phone = user.phone_number;
  const code = generateCode();
  await issueChallenge(phone, code, { cooldown: false });
  try {
    const { transport } = await sendOtpEmail(email, code);
    return { transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    await prisma.otpCode.deleteMany({ where: { phone } });
    console.error(`[OTP] sign-in email to ${maskEmail(email)} failed: ${err.message}`);
    throw err;
  }
}

// Verify a code that was sent by email. The email resolves to its phone, and from there it is
// the ordinary phone verification — same attempt cap, same single use, same one generic error
// (an unknown email fails exactly like a wrong code).
export async function verifyOtpByEmail(rawEmail, submittedCode) {
  const email = normalizeEmail(rawEmail);
  const user = email && await prisma.user.findUnique({ where: { email }, select: { phone_number: true } });
  if (!user) throw new OtpInvalidError();
  return verifyOtp(user.phone_number, submittedCode);
}

// Verify a submitted code. On success the challenge is consumed (single-use) and the customer
// row is created if this is their first order — the phone becomes a real identity here.
export async function verifyOtp(rawPhone, submittedCode) {
  const phone = normalizeMsisdnOrThrow(rawPhone);

  // Failures RETURN from the transaction instead of throwing inside it. A throw rolls the
  // transaction back — including the attempts++ and the burn below — which silently turned
  // the 5-attempt cap into no cap at all. The error is raised only after the count commits.
  const outcome = await withTransaction(async (tx) => {
    // RAW, and it must stay raw: FOR UPDATE. Without the lock, concurrent guesses both read
    // attempts=4 and are each granted a "last" try — turning a 5-attempt cap into as many
    // tries as the attacker can run in parallel.
    const rows = await tx.$queryRaw`
      SELECT phone, code_hash, expires_at, attempts FROM otp_codes
       WHERE phone = ${phone} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) return { ok: false };

    const expired = new Date(challenge.expires_at).getTime() <= Date.now();
    if (expired || challenge.attempts >= MAX_ATTEMPTS) {
      await tx.otpCode.deleteMany({ where: { phone } });
      return { ok: false };
    }

    if (!verifyCode(String(submittedCode ?? ''), challenge.code_hash)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Burn the challenge — a fresh code (and a fresh cooldown) is now required.
        await tx.otpCode.deleteMany({ where: { phone } });
      } else {
        await tx.otpCode.update({ where: { phone }, data: { attempts } });
      }
      return { ok: false };
    }

    // Success: single-use, so the code dies with this transaction.
    await tx.otpCode.deleteMany({ where: { phone } });
    await tx.user.upsert({
      where: { phone_number: phone },
      update: {},
      create: { phone_number: phone },
    });
    return { ok: true };
  });

  if (!outcome.ok) throw new OtpInvalidError();
  return { phone };
}

// ── Linking an email (signed-in customers only) ──
// The phone was already proven by the session; this proves the email. Only after both does an
// email become a place sign-in codes may go.

// Send a confirmation code to the email the customer typed. Same atomic cooldown as login codes.
export async function requestEmailLink(phone, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthInputError('that does not look like an email address');
  if (!emailAvailable()) throw new AuthInputError('email codes are not available');
  const code = generateCode();
  const cooldownSeconds = Math.ceil(RESEND_COOLDOWN_MS / 1000);
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  // RAW for the same reason as requestOtp: a conditional upsert is the only atomic cooldown.
  const rows = await prisma.$queryRaw`
    INSERT INTO email_challenges(phone, email, code_hash, expires_at, attempts, last_sent_at)
    VALUES (${phone}, ${email}, ${hashCode(code)}, now() + (${String(ttlSeconds)} || ' seconds')::interval, 0, now())
    ON CONFLICT (phone) DO UPDATE
      SET email        = EXCLUDED.email,
          code_hash    = EXCLUDED.code_hash,
          expires_at   = EXCLUDED.expires_at,
          attempts     = 0,
          last_sent_at = now()
      WHERE email_challenges.last_sent_at <= now() - (${String(cooldownSeconds)} || ' seconds')::interval
    RETURNING phone
  `;
  if (rows.length === 0) {
    const existing = await prisma.emailChallenge.findUnique({ where: { phone }, select: { last_sent_at: true } });
    throw new OtpCooldownError(cooldownRemainingMs(existing?.last_sent_at));
  }

  try {
    const { transport } = await sendEmailLinkCode(email, code);
    return { email, transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    await prisma.emailChallenge.deleteMany({ where: { phone } });
    console.error(`[OTP] email link to ${maskEmail(email)} failed: ${err.message}`);
    throw err;
  }
}

// Confirm the code and store the email. Failures return from the transaction and throw after,
// so the attempt count commits (see verifyOtp).
export async function verifyEmailLink(phone, submittedCode) {
  const outcome = await withTransaction(async (tx) => {
    // RAW: FOR UPDATE, so parallel guesses can't each get the "last" attempt.
    const rows = await tx.$queryRaw`
      SELECT phone, email, code_hash, expires_at, attempts FROM email_challenges
       WHERE phone = ${phone} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) return { ok: false };
    if (new Date(challenge.expires_at).getTime() <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
      await tx.emailChallenge.deleteMany({ where: { phone } });
      return { ok: false };
    }
    if (!verifyCode(String(submittedCode ?? ''), challenge.code_hash)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await tx.emailChallenge.deleteMany({ where: { phone } });
      else await tx.emailChallenge.update({ where: { phone }, data: { attempts } });
      return { ok: false };
    }
    await tx.emailChallenge.deleteMany({ where: { phone } });
    // One email, one account (users.email is UNIQUE): whoever just proved they read this inbox
    // takes it, and an older account that had it stops getting codes there.
    await tx.user.updateMany({ where: { email: challenge.email, NOT: { phone_number: phone } }, data: { email: null } });
    await tx.user.update({ where: { phone_number: phone }, data: { email: challenge.email } });
    return { ok: true, email: challenge.email };
  });
  if (!outcome.ok) throw new OtpInvalidError();
  return { email: outcome.email };
}

export async function removeEmail(phone) {
  await withTransaction(async (tx) => {
    await tx.emailChallenge.deleteMany({ where: { phone } });
    await tx.user.update({ where: { phone_number: phone }, data: { email: null } });
  });
}

export async function getCustomerEmail(phone) {
  const user = await prisma.user.findUnique({ where: { phone_number: phone }, select: { email: true } });
  return user?.email ?? null;
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
