// Public route: ask to be given a driver or operator account.
//
// PUBLIC AND UNAUTHENTICATED, so it is treated as hostile input and rate-limited hard. It
// creates no account and grants nothing — see commands/accessRequests.js.
//
// It also answers identically whether or not this person has applied before. A form that says
// "you already applied" is a way to test whether a given phone number is known to us, and the
// applicant list includes people who work here.
import { Router } from 'express';
import { submitAccessRequest, AccessRequestError } from '../commands/accessRequests.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePhone } from '../domain/phone.js';
import { config } from '../config.js';

export const signupRouter = Router();

const phoneKey = (req) => {
  const parsed = parsePhone(req.body?.phone);
  return parsed.valid ? parsed.e164 : `raw:${String(req.body?.phone || '').slice(0, 24)}`;
};

const HOUR = 60 * 60 * 1000;

// GET /api/signup/contact — who to reach out to. Public because the whole point is that
// someone who can't or won't use the form has a person to call.
signupRouter.get('/signup/contact', (req, res) => {
  res.json({ contact: config.owner });
});

// POST /api/signup { role, name, phone, message }
signupRouter.post(
  '/signup',
  rateLimit({ windowMs: HOUR, max: 10, message: 'too many requests — try again later' }),
  rateLimit({ windowMs: 24 * HOUR, max: 5, key: phoneKey, message: 'too many requests — try again later' }),
  async (req, res, next) => {
    try {
      const { role, name, phone, message } = req.body || {};
      await submitAccessRequest({ role, name, phone, message });
      // Deliberately the same response for a new request and a re-submission.
      res.status(201).json({
        received: true,
        message:
          'Thanks — your request is with the team. Someone will contact you on this number.',
        contact: config.owner,
      });
    } catch (err) {
      if (err instanceof AccessRequestError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);
