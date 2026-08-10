// Public route: ask to be given a driver or operator account.
//
// PUBLIC AND UNAUTHENTICATED, so it is treated as hostile input and rate-limited hard. It
// creates no account and grants nothing — see commands/accessRequests.js.
//
// It also answers identically whether or not this person has applied before. A form that says
// "you already applied" is a way to test whether a given phone number is known to us, and the
// applicant list includes people who work here.
import { Router, raw } from 'express';
import {
  submitAccessRequest,
  attachIdDocument,
  AccessRequestError,
} from '../commands/accessRequests.js';
import { signToken, verifyToken } from '../middleware/auth.js';
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
      const { id } = await submitAccessRequest({ role, name, phone, message });

      // A short-lived token scoped to THIS request, so the applicant can attach their ID
      // without the request id ever being exposed. Without it the upload endpoint would
      // either be open (anyone could attach an image to anyone's application) or would need
      // the id in the response, which is an identifier worth not handing out.
      const uploadToken = signToken({ role: 'signup_upload', requestId: String(id) }, 15 * 60);

      // Deliberately the same response for a new request and a re-submission.
      res.status(201).json({
        received: true,
        message:
          'Thanks — your request is with the team. Someone will contact you on this number.',
        uploadToken,
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

// POST /api/signup/id-document/:side — attach the front or back of an ID.
//
// Both sides: the back carries the machine-readable zone, expiry and issuing details, and a
// front-only photo is trivially a picture of somebody else's card.
//
// Raw image bytes, authorised by the short-lived token from the submit response. The token
// carries the request id, so an applicant can only ever attach to their own application and
// only within a few minutes of submitting.
//
// This is the most sensitive data the system handles. It is streamed to object storage, never
// logged, only ever shown to an authenticated operator, and DESTROYED when the decision is
// made.
signupRouter.post(
  '/signup/id-document/:side',
  rateLimit({ windowMs: HOUR, max: 20, message: 'too many uploads — try again later' }),
  raw({ type: () => true, limit: '6mb' }),
  async (req, res, next) => {
    try {
      const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const payload = verifyToken(token);
      if (!payload || payload.role !== 'signup_upload' || !payload.requestId) {
        // Generic: distinguishing "expired" from "wrong" tells a prober how the token works.
        return res.status(401).json({ error: 'upload link expired — please submit the form again' });
      }
      const result = await attachIdDocument({
        requestId: payload.requestId,
        side: req.params.side,
        bytes: req.body,
        contentType: req.get('Content-Type'),
      });
      res.status(201).json({ received: true, ...result });
    } catch (err) {
      if (err instanceof AccessRequestError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);
