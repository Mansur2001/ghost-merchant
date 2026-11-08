// Push notification registration. The device is registered to whoever is signed in — the
// token decides the owner, never the body (CLAUDE.md, "The client never chooses its own identity").
import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { saveSubscription, removeSubscription, PushError } from '../commands/push.js';

export const pushRouter = Router();

const subjectOf = (auth) => (auth.role === 'customer' ? auth.uid : auth.id);
const pushError = (err, res, next) => (err instanceof PushError ? res.status(err.status).json({ error: err.message }) : next(err));

// GET /api/push/config — what this server can send. Public: the VAPID key is public by design.
pushRouter.get('/push/config', (req, res) => {
  res.json({
    webPush: config.push.webpush.enabled ? config.push.webpush.publicKey : null,
    fcm: config.push.fcm.enabled,
  });
});

// POST /api/push/subscriptions { subscription } | { token }, lang
pushRouter.post(
  '/push/subscriptions',
  requireAuth,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const r = await saveSubscription({
        role: req.auth.role, subjectId: subjectOf(req.auth),
        sub: req.body?.subscription, token: req.body?.token, lang: req.body?.lang,
      });
      res.status(201).json(r);
    } catch (err) {
      pushError(err, res, next);
    }
  }
);

// DELETE /api/push/subscriptions { endpoint } — "turn off", or signing out on this device.
pushRouter.delete('/push/subscriptions', requireAuth, async (req, res, next) => {
  try {
    res.json({ removed: await removeSubscription({ role: req.auth.role, subjectId: subjectOf(req.auth), endpoint: req.body?.endpoint }) });
  } catch (err) {
    pushError(err, res, next);
  }
});
