// Customer accounts with a password, alongside email codes (CLAUDE.md, Authentication).
//
//   signUpWithPassword — email + password; the account works at once. The email is NOT yet
//                        proven: the first code sign-in proves it (commands/auth.js), and that
//                        same moment removes a password a squatter may have set.
//   signInWithPassword — email + password. One generic error for every failure, and the same
//                        work done whether or not the account exists, so neither the answer
//                        nor its timing says which emails have accounts.
//   setPassword        — signed in: change it (needs the current one) or, within 15 minutes of
//                        a code sign-in, set a new one without it (the "forgot password" path).
//                        Either way every other device is signed out (the caller gets a new
//                        token for this one) and the account's email is told afterwards.
import { prisma, withTransaction } from '../db/prisma.js';
import { wakeOutbox } from '../events/outbox.js';
import { endSessions, noteSessionVersion } from './sessions.js';
import { hashSecret, verifySecret } from '../middleware/auth.js';
import { normalizeEmail } from '../domain/email.js';
import { passwordProblem } from '../domain/customerPassword.js';
import { maskEmail } from '../domain/email.js';
import { sendPasswordChangedNotice } from '../notify/emailSender.js';

export class PasswordError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// session_version goes into the token (commands/sessions.js).
const ACCOUNT = { id: true, phone_number: true, email: true, session_version: true };
// Checked against when the account doesn't exist, so a miss costs the same scrypt as a hit.
const DUMMY_HASH = hashSecret('timing-equaliser-not-a-password');

export async function signUpWithPassword({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new PasswordError('that does not look like an email address');
  const problem = passwordProblem(password, { email });
  if (problem) throw new PasswordError(problem);
  try {
    return await prisma.user.create({ data: { email, password_hash: hashSecret(password) }, select: ACCOUNT });
  } catch (err) {
    // Telling a sign-up "this email has an account" is unavoidable for a usable form; the
    // route rate-limits it so it can't be used to sweep a list of addresses.
    if (err.code === 'P2002') throw new PasswordError('an account with this email already exists — sign in instead', 409);
    throw err;
  }
}

export async function signInWithPassword({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  const user = email
    ? await prisma.user.findUnique({ where: { email }, select: { ...ACCOUNT, password_hash: true } })
    : null;
  const ok = verifySecret(String(password ?? ''), user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) throw new PasswordError('wrong email or password', 401);
  const { password_hash: _drop, ...account } = user;
  return account;
}

export async function setPassword({ userId, currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, password_hash: true, password_reset_until: true },
  });
  if (!user) throw new PasswordError('unauthorized', 401);
  if (!user.email) throw new PasswordError('add an email to your account first — you sign in with it');
  const inResetWindow = user.password_reset_until && user.password_reset_until.getTime() > Date.now();
  if (user.password_hash && !inResetWindow && !verifySecret(String(currentPassword ?? ''), user.password_hash)) {
    throw new PasswordError('your current password is wrong', 403);
  }
  const problem = passwordProblem(newPassword, { email: user.email });
  if (problem) throw new PasswordError(problem);
  const first = !user.password_hash; // read before the write: "set" vs "changed" in the notice
  // The new password and the end of every older session commit together: there is no moment
  // where the password changed but a stolen session still works.
  const sv = await withTransaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      // The reset window is single-use: once a password is set, the next change needs it.
      data: { password_hash: hashSecret(newPassword), password_reset_until: null },
    });
    return endSessions(tx, userId);
  });
  noteSessionVersion(userId, sv);
  wakeOutbox();
  // Tell the owner, after the change is saved. Best effort, like a push: a slow or failed email
  // must not fail (or slow) a change that already happened — it is logged and dropped.
  sendPasswordChangedNotice(user.email, { first })
    .catch((err) => console.warn(`[password] changed-notice to ${maskEmail(user.email)} not sent: ${err.message}`));
  return { sv };
}

// For "Account": does this account have a password, and may it set one without the old one now?
export async function passwordState(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { password_hash: true, password_reset_until: true, email_verified_at: true },
  });
  return {
    hasPassword: Boolean(u?.password_hash),
    canResetWithoutCurrent: Boolean(u?.password_reset_until && u.password_reset_until.getTime() > Date.now()),
    emailVerified: Boolean(u?.email_verified_at),
  };
}
