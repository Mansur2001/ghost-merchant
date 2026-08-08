// Security response headers for the API.
//
// Caddy sets the equivalent (plus a real CSP) on the static PWA responses — see the Caddyfile.
// These cover the API surface, which is what an attacker reaches directly: a JSON endpoint
// that can be framed, sniffed as HTML, or cached by an intermediary is a real problem even
// though nobody "browses" it.
import { config } from '../config.js';

export function securityHeaders(req, res, next) {
  // API responses are never a document; lock the sniffer down and forbid framing entirely.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  // Order data, photos and chat must never sit in a shared/proxy cache.
  res.set('Cache-Control', 'no-store');

  // HSTS only over a real HTTPS connection. Sending it in dev would pin `localhost` to HTTPS
  // in the developer's browser for a year — a genuinely annoying, hard-to-undo footgun.
  if (config.env === 'production' && (req.secure || req.get('X-Forwarded-Proto') === 'https')) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
