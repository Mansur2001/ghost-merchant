// Sliding-window rate limiter, dependency-free and in-process.
//
// SCOPE WARNING: state lives in this process's memory, so with N backend instances the
// effective limit is N x max. That is acceptable while we run a single container, and it is
// deliberately the SAME seam as events/bus.js — when the bus moves to Redis (P2), this moves
// with it. Until then, do not scale the backend horizontally and assume login is protected.
//
// Why hand-rolled: the whole point of a limiter is that it still works when the box is under
// load. Fewer moving parts, no vendor, no monthly cost — consistent with the sovereignty rule.

const buckets = new Map(); // key -> number[] (ms timestamps of hits inside the window)

// Drop timestamps that have aged out; delete the bucket entirely when it empties so a flood
// of one-off keys (every IP on the internet) can't grow the map without bound.
function prune(key, windowMs, now) {
  const hits = buckets.get(key);
  if (!hits) return [];
  const cutoff = now - windowMs;
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i += 1;
  const live = i > 0 ? hits.slice(i) : hits;
  if (live.length === 0) buckets.delete(key);
  else buckets.set(key, live);
  return live;
}

// Core primitive, usable outside Express (e.g. the WebSocket handshake).
// Returns { allowed, remaining, retryAfterMs }.
export function consume(key, { windowMs, max, now = Date.now() }) {
  const live = prune(key, windowMs, now);
  if (live.length >= max) {
    const retryAfterMs = Math.max(0, live[0] + windowMs - now);
    return { allowed: false, remaining: 0, retryAfterMs };
  }
  live.push(now);
  buckets.set(key, live);
  return { allowed: true, remaining: max - live.length, retryAfterMs: 0 };
}

// Express middleware factory. `key` maps a request to a bucket (default: client IP).
// `message` is what the client sees — keep it non-committal; never leak whether an
// identity exists ("too many attempts", not "too many attempts for that account").
export function rateLimit({ windowMs, max, key, message = 'too many requests' }) {
  const keyFn = key || ((req) => req.ip || 'unknown');
  return (req, res, next) => {
    const bucketKey = `${req.method}:${req.baseUrl}${req.path}:${keyFn(req)}`;
    const { allowed, remaining, retryAfterMs } = consume(bucketKey, { windowMs, max });
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      const retryAfter = Math.ceil(retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, retryAfter });
    }
    next();
  };
}

// Test/ops hook: wipe all counters.
export function resetRateLimits() {
  buckets.clear();
}
