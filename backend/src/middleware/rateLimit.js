// Sliding-window rate limiter.
//
// TWO MODES, one API (same seam as events/bus.js):
//   no REDIS_URL  — in-process Map. One backend instance.
//   REDIS_URL set — a sorted set per key, shared by every instance.
//
// The Redis path runs as a Lua script because the window check is read-then-write: two
// requests arriving together would both read "9 hits, room for one more" and both be allowed.
// Redis runs a script atomically, so the count and the insert cannot be interleaved.
//
// FAILURE POLICY: if Redis is unreachable we fall back to the in-process limiter rather than
// failing the request. Failing closed would take down login for everyone during a Redis blip —
// a worse outcome than a temporarily weaker limit (which is still N x max, not unlimited).
// The fallback is logged, because "rate limiting quietly got weaker" must not be silent.
import { getCommands, isRedisEnabled } from '../redis/client.js';

const buckets = new Map(); // key -> number[] (ms timestamps of hits inside the window)
let fallbackWarned = false;

// ── In-process implementation (also the fallback) ──

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

// Synchronous core. Kept exported: it's what the unit tests exercise, and what the fallback
// path uses. Returns { allowed, remaining, retryAfterMs }.
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

// ── Redis implementation ──
//
// ZSET scored by timestamp:
//   1. drop everything older than the window
//   2. count what's left
//   3. if under the limit, add this hit
//   4. expire the key so idle buckets clean themselves up
// Returns {allowed, remaining, retryAfterMs}; retryAfterMs is derived from the OLDEST hit,
// which is the moment a slot frees up.
const SLIDING_WINDOW_LUA = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max      = tonumber(ARGV[3])
local member   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)

if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest[2] then
    retry = math.ceil(tonumber(oldest[2]) + windowMs - now)
    if retry < 0 then retry = 0 end
  end
  return {0, 0, retry}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return {1, max - count - 1, 0}
`;

let scriptLoaded = false;
function ensureScript(client) {
  if (scriptLoaded) return;
  client.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
  scriptLoaded = true;
}

// Async core used by the middleware and the WebSocket handshake.
export async function consumeAsync(key, { windowMs, max, now = Date.now() }) {
  if (!isRedisEnabled()) return consume(key, { windowMs, max, now });

  try {
    const client = getCommands();
    ensureScript(client);
    // The member must be unique per hit or ZADD would overwrite a same-millisecond entry and
    // undercount bursts — which is exactly the traffic a limiter exists to catch.
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, remaining, retryAfterMs] = await client.slidingWindow(
      `rl:${key}`,
      String(now),
      String(windowMs),
      String(max),
      member
    );
    return { allowed: allowed === 1, remaining, retryAfterMs };
  } catch (err) {
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.error(
        `rateLimit: Redis unavailable (${err.message}) — falling back to per-instance limits. ` +
          'Limits are now N x max across instances until Redis returns.'
      );
    }
    return consume(key, { windowMs, max, now });
  }
}

// Express middleware factory. `key` maps a request to a bucket (default: client IP).
// `message` is what the client sees — keep it non-committal; never leak whether an
// identity exists ("too many attempts", not "too many attempts for that account").
export function rateLimit({ windowMs, max, key, message = 'too many requests' }) {
  const keyFn = key || ((req) => req.ip || 'unknown');
  return async (req, res, next) => {
    const bucketKey = `${req.method}:${req.baseUrl}${req.path}:${keyFn(req)}`;
    try {
      const { allowed, remaining, retryAfterMs } = await consumeAsync(bucketKey, { windowMs, max });
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));
      if (!allowed) {
        const retryAfter = Math.ceil(retryAfterMs / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: message, retryAfter });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Test/ops hook: wipe the in-process counters.
export function resetRateLimits() {
  buckets.clear();
  fallbackWarned = false;
}
