// CQRS write side for customer authentication (phone number + one-time passcode).
//
// The customer's phone number IS their identity (invariant 4), so this is the gate that turns
// "a number someone typed" into "a number someone can prove they hold". Every customer-facing
// read is authorized against the phone claim minted here.
import { query, withTransaction } from '../db/pool.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import {
  generateCode,
  hashCode,
  verifyCode,
  cooldownRemainingMs,
  MAX_ATTEMPTS,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
} from '../domain/otp.js';
import { sendOtpSms } from '../notify/smsSender.js';

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

// Issue (or re-issue) a passcode for a phone number.
// The UPSERT is conditional on the cooldown having elapsed, which makes "one live challenge
// per number" and the resend throttle a single atomic decision — two concurrent requests
// cannot both win, and the loser learns nothing except "wait".
export async function requestOtp(rawPhone) {
  const phone = normalizeMsisdnOrThrow(rawPhone);
  const code = generateCode();
  const cooldownSeconds = Math.ceil(RESEND_COOLDOWN_MS / 1000);
  const ttlSeconds = Math.ceil(OTP_TTL_MS / 1000);

  const { rows } = await query(
    `INSERT INTO otp_codes(phone, code_hash, expires_at, attempts, last_sent_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval, 0, now())
     ON CONFLICT (phone) DO UPDATE
       SET code_hash    = EXCLUDED.code_hash,
           expires_at   = EXCLUDED.expires_at,
           attempts     = 0,
           last_sent_at = now()
       WHERE otp_codes.last_sent_at <= now() - ($4 || ' seconds')::interval
     RETURNING phone`,
    [phone, hashCode(code), String(ttlSeconds), String(cooldownSeconds)]
  );

  if (rows.length === 0) {
    // Conflict + cooldown not elapsed: tell the caller how long to wait, nothing else.
    const { rows: existing } = await query(
      'SELECT last_sent_at FROM otp_codes WHERE phone = $1',
      [phone]
    );
    throw new OtpCooldownError(cooldownRemainingMs(existing[0]?.last_sent_at));
  }

  try {
    const { transport } = await sendOtpSms(phone, code);
    return { phone, transport, expiresInSeconds: ttlSeconds, code };
  } catch (err) {
    // Never leave a live challenge the customer was never told about: if the SMS didn't go
    // out, the code doesn't exist. Also lets them retry immediately instead of waiting out a
    // cooldown for a message that never arrived.
    await query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    throw err;
  }
}

// Verify a submitted code. On success the challenge is consumed (single-use) and the customer
// row is created if this is their first order — the phone becomes a real identity here.
export async function verifyOtp(rawPhone, submittedCode) {
  const phone = normalizeMsisdnOrThrow(rawPhone);

  return withTransaction(async (client) => {
    // Lock the challenge row so concurrent guesses can't both read attempts=4 and each be
    // granted a "last" try.
    const { rows } = await client.query(
      'SELECT * FROM otp_codes WHERE phone = $1 FOR UPDATE',
      [phone]
    );
    const challenge = rows[0];
    if (!challenge) throw new OtpInvalidError();

    const expired = new Date(challenge.expires_at).getTime() <= Date.now();
    if (expired || challenge.attempts >= MAX_ATTEMPTS) {
      await client.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
      throw new OtpInvalidError();
    }

    if (!verifyCode(String(submittedCode ?? ''), challenge.code_hash)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Burn the challenge — a fresh code (and a fresh cooldown) is now required.
        await client.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
      } else {
        await client.query('UPDATE otp_codes SET attempts = $1 WHERE phone = $2', [attempts, phone]);
      }
      throw new OtpInvalidError();
    }

    // Success: single-use, so the code dies with this transaction.
    await client.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    await client.query(
      'INSERT INTO users(phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING',
      [phone]
    );
    return { phone };
  });
}

// Housekeeping: expired challenges are dead weight (and PII-adjacent). Cheap indexed delete.
export async function sweepExpiredOtps() {
  const { rowCount } = await query('DELETE FROM otp_codes WHERE expires_at < now()');
  return rowCount;
}
