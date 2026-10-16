// CQRS write side for staff onboarding: an ADMIN creates a driver or operator account, the
// person gets a one-time setup code by SMS, and chooses their own PIN/password with it.
// Rules and reasoning: domain/staffInvite.js.
//
// Creating the account is a deliberate, separate act from approving a request — approving
// records a decision; this mints a credential. Both are admin-only (routes/operator.js).
import { prisma, withTransaction } from '../db/prisma.js';
import { hashSecret, verifySecret } from '../middleware/auth.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import { validateUsername, validatePassword } from '../domain/operator.js';
import {
  generateSetupCode,
  unclaimableSecret,
  validateDriverPin,
  SETUP_TTL_MS,
  SETUP_MAX_ATTEMPTS,
} from '../domain/staffInvite.js';
import { maskPhone } from '../domain/redact.js';
import { sendSetupSms } from '../notify/smsSender.js';

export class StaffError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// One answer for every way a claim can fail (no code, wrong code, expired, used up). Telling
// them apart would let anyone probe which phone numbers belong to staff.
export class SetupInvalidError extends Error {
  constructor() {
    super('invalid or expired setup code');
    this.status = 401;
  }
}

const ROLES = new Set(['driver', 'operator']);

function phoneOrThrow(raw) {
  try {
    return normalizeMsisdnOrThrow(raw);
  } catch (err) {
    throw new StaffError(err.message);
  }
}

// Replace any live code for this account with a fresh one. Upsert on (role, account_id), so a
// re-send kills the code in the earlier text rather than leaving two valid at once.
async function issueCode(tx, { role, accountId, phone, createdBy }) {
  const code = generateSetupCode();
  const data = {
    phone,
    code_hash: hashSecret(code),
    expires_at: new Date(Date.now() + SETUP_TTL_MS),
    attempts: 0,
    created_by: createdBy || null,
    created_at: new Date(),
  };
  await tx.staffInvite.upsert({
    where: { role_account_id: { role, account_id: BigInt(accountId) } },
    update: data,
    create: { role, account_id: BigInt(accountId), ...data },
  });
  return code;
}

// Text the code AFTER the transaction commits: an SMS can't be rolled back, so it must never
// go out for an account that then fails to exist. If it fails, the account and code still
// exist and "Send setup code" retries — reported, never swallowed.
async function textCode(phone, role, code) {
  try {
    const { transport } = await sendSetupSms(phone, role, code);
    return { transport, smsError: null };
  } catch (err) {
    console.error(`[staff] setup SMS to ${maskPhone(phone)} failed: ${err.message}`);
    return { transport: null, smsError: 'the setup code could not be texted — use "Send setup code" to retry' };
  }
}

// Create a driver or operator account and text them a setup code.
//   requestId — optional: create it FROM an approved access request (name/phone/role come
//               from the request, and the request is marked as having produced an account).
export async function createStaffAccount({ role, name, phone, username, createdBy, requestId }) {
  const result = await withTransaction(async (tx) => {
    let r = { role, name, phone };

    if (requestId != null) {
      let id;
      try { id = BigInt(requestId); } catch { throw new StaffError('request not found', 404); }
      // RAW: FOR UPDATE, so two admins clicking "Create account" at once can't make two.
      const rows = await tx.$queryRaw`
        SELECT id, role, name, phone, status, account_created_at
          FROM access_requests WHERE id = ${id} FOR UPDATE
      `;
      const req = rows[0];
      if (!req) throw new StaffError('request not found', 404);
      if (req.status !== 'approved') throw new StaffError('approve the request first', 409);
      if (req.account_created_at) throw new StaffError('an account was already created for this request', 409);
      r = { role: req.role, name: req.name, phone: req.phone };
    }

    if (!ROLES.has(r.role)) throw new StaffError('role must be driver or operator');
    const cleanName = String(r.name || '').trim();
    if (cleanName.length < 2 || cleanName.length > 80) throw new StaffError('name must be 2-80 characters');
    const e164 = phoneOrThrow(r.phone);

    let account;
    if (r.role === 'driver') {
      // Never upsert: an existing driver's PIN being silently replaced by whoever types their
      // number into a form is an account takeover. Existing driver -> say so; reset is separate.
      if (await tx.driver.findUnique({ where: { msisdn: e164 } })) {
        throw new StaffError('a driver with this number already exists — use "Send setup code" on them instead', 409);
      }
      account = await tx.driver.create({
        data: { name: cleanName, msisdn: e164, pin_hash: hashSecret(unclaimableSecret()), pin_set_at: null },
        select: { id: true, name: true, msisdn: true },
      });
    } else {
      const u = validateUsername(username);
      if (!u.valid) throw new StaffError(u.reason);
      try {
        account = await tx.operator.create({
          data: {
            username: u.username,
            display_name: cleanName,
            password_hash: hashSecret(unclaimableSecret()),
            phone: e164,
            created_by: createdBy || null,
          },
          select: { id: true, username: true, display_name: true },
        });
      } catch (err) {
        if (err.code === 'P2002') throw new StaffError('that username is already taken', 409);
        throw err;
      }
    }

    const code = await issueCode(tx, { role: r.role, accountId: account.id, phone: e164, createdBy });

    if (requestId != null) {
      await tx.accessRequest.update({
        where: { id: BigInt(requestId) },
        data: { account_created_at: new Date(), account_ref: `${r.role}:${account.id}` },
      });
    }
    return { role: r.role, account, phone: e164, code };
  });

  const sms = await textCode(result.phone, result.role, result.code);
  return { ...result, ...sms };
}

// Send a fresh setup code to an existing account. Covers both "the first text never came /
// expired" and "I forgot my PIN": the current secret keeps working until a new one is chosen,
// so a reset can't be used to lock someone out.
export async function resendSetupCode({ role, accountId, createdBy }) {
  if (!ROLES.has(role)) throw new StaffError('role must be driver or operator');
  let id;
  try { id = BigInt(accountId); } catch { throw new StaffError('account not found', 404); }

  const result = await withTransaction(async (tx) => {
    const account = role === 'driver'
      ? await tx.driver.findUnique({ where: { id }, select: { id: true, msisdn: true, active: true } })
      : await tx.operator.findUnique({ where: { id }, select: { id: true, phone: true, active: true } });
    if (!account) throw new StaffError('account not found', 404);
    if (!account.active) throw new StaffError('reactivate this account first', 409);
    const phone = role === 'driver' ? account.msisdn : account.phone;
    if (!phone) throw new StaffError('no phone number on file for this operator', 409);
    const code = await issueCode(tx, { role, accountId: id, phone, createdBy });
    return { role, phone, code };
  });

  const sms = await textCode(result.phone, role, result.code);
  return { ...result, ...sms };
}

// The public step: prove you hold the phone (the code) and choose your own secret.
// Returns { role, name, username? } so the client can sign straight in.
export async function claimSetup({ role, phone, code, secret }) {
  if (!ROLES.has(role)) throw new StaffError('role must be driver or operator');
  const e164 = phoneOrThrow(phone);

  // Shape-check the new secret BEFORE looking at the code: rejecting a weak PIN only after a
  // correct code would tell a guesser their code was right.
  if (role === 'driver') {
    const p = validateDriverPin(secret);
    if (!p.valid) throw new StaffError(p.reason);
  } else {
    const p = validatePassword(secret);
    if (!p.valid) throw new StaffError(p.reason);
  }

  // Failures RETURN rather than throw inside the transaction: a throw would roll back the
  // attempts++ along with everything else, and the attempt cap would never bite.
  const outcome = await withTransaction(async (tx) => {
    // RAW: FOR UPDATE, so parallel guesses can't each be granted the "last" attempt.
    const rows = await tx.$queryRaw`
      SELECT id, account_id, code_hash, expires_at, attempts FROM staff_invites
       WHERE role = ${role} AND phone = ${e164}
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE
    `;
    const invite = rows[0];
    if (!invite) return { invalid: true };

    if (new Date(invite.expires_at).getTime() <= Date.now() || invite.attempts >= SETUP_MAX_ATTEMPTS) {
      await tx.staffInvite.delete({ where: { id: invite.id } });
      return { invalid: true };
    }

    if (!verifySecret(String(code ?? ''), invite.code_hash)) {
      const attempts = invite.attempts + 1;
      if (attempts >= SETUP_MAX_ATTEMPTS) await tx.staffInvite.delete({ where: { id: invite.id } });
      else await tx.staffInvite.update({ where: { id: invite.id }, data: { attempts } });
      return { invalid: true };
    }

    let out;
    if (role === 'driver') {
      const driver = await tx.driver.findUnique({ where: { id: invite.account_id } });
      if (!driver || !driver.active) return { invalid: true };
      await tx.driver.update({
        where: { id: driver.id },
        data: { pin_hash: hashSecret(String(secret)), pin_set_at: new Date() },
      });
      out = { role, name: driver.name };
    } else {
      const op = await tx.operator.findUnique({ where: { id: invite.account_id } });
      if (!op || !op.active) return { invalid: true };
      // Only now can this check run — it needs the username. The code was right, so saying
      // why reveals nothing a guesser could use. Nothing has been written yet, so the code
      // survives for a second try with a better password.
      const p = validatePassword(secret, { username: op.username });
      if (!p.valid) return { weak: p.reason };
      await tx.operator.update({
        where: { id: op.id },
        data: { password_hash: hashSecret(p.password), must_change_password: false },
      });
      out = { role, name: op.display_name, username: op.username };
    }

    // Single use: the code dies with this transaction.
    await tx.staffInvite.delete({ where: { id: invite.id } });
    return { out };
  });

  if (outcome.invalid) throw new SetupInvalidError();
  if (outcome.weak) throw new StaffError(outcome.weak);
  return outcome.out;
}

// Housekeeping: expired codes are dead weight.
export async function sweepExpiredSetupCodes() {
  const { count } = await prisma.staffInvite.deleteMany({ where: { expires_at: { lt: new Date() } } });
  return count;
}
