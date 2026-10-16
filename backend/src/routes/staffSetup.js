// Public route: a new driver or operator claims the account an admin created for them, using
// the setup code that was texted to them, and chooses their own PIN/password.
//
// PUBLIC AND UNAUTHENTICATED — the code is the credential. Rate-limited per IP and per phone,
// and every failure gets the same answer so it can't be used to learn who is on staff.
import { Router } from 'express';
import { claimSetup, StaffError, SetupInvalidError } from '../commands/staffAccounts.js';
import { isWellFormedSetupCode } from '../domain/staffInvite.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePhone } from '../domain/phone.js';

export const staffSetupRouter = Router();

const phoneKey = (req) => {
  const parsed = parsePhone(req.body?.phone);
  return parsed.valid ? parsed.e164 : `raw:${String(req.body?.phone || '').slice(0, 24)}`;
};

// POST /api/staff/setup { role, phone, code, secret } -> { role, name, username? }
staffSetupRouter.post(
  '/staff/setup',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'too many attempts' }),
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: phoneKey, message: 'too many attempts' }),
  async (req, res, next) => {
    const { role, phone, code, secret } = req.body || {};
    // Same generic answer as a wrong code, so "well-formed" isn't itself a signal.
    if (!isWellFormedSetupCode(String(code ?? ''))) {
      return res.status(401).json({ error: 'invalid or expired setup code' });
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await claimSetup({ role, phone, code: String(code), secret }));
    } catch (err) {
      if (err instanceof SetupInvalidError) return res.status(401).json({ error: err.message });
      if (err instanceof StaffError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);
