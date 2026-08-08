// Structured request logging + a request id for correlation.
//
// Purpose is operational, not analytic: when a customer says "my payment didn't show up",
// we need to find the exact requests involved and who made them. That means every line
// carries an actor and an id we can hand back to the user, and NO line carries a secret or a
// full phone number (see domain/redact.js — the log must not undo the API's privacy).
import crypto from 'node:crypto';
import { actorLabel, maskPhone } from '../domain/redact.js';

// Phone numbers ride in the URL on /phone/validate/:phone, so the path itself is PII.
// Mask any run of 7+ digits (with optional +) before it reaches a log line.
export function maskPathPii(path) {
  return String(path || '').replace(/\+?\d{7,}/g, (m) => maskPhone(m));
}

// Health checks fire constantly and say nothing; logging them buries the real traffic.
const SKIP = new Set(['/api/health']);

export function requestLog(req, res, next) {
  req.id = crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    if (SKIP.has(req.path) && res.statusCode < 400) return;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = {
      t: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      id: req.id,
      method: req.method,
      path: maskPathPii(req.originalUrl.split('?')[0]),
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip: req.ip,
      // req.auth is populated by the auth middleware, which runs after this — but `finish`
      // fires at the end of the response, so by then it's there.
      actor: actorLabel(req.auth),
    };
    // One JSON object per line: greppable by hand, parseable by anything later.
    console.log(JSON.stringify(line));
  });

  next();
}
