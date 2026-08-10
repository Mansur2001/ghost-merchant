// Redis connections. Three of them, because a connection in subscriber mode cannot run
// ordinary commands — that's a Redis protocol rule, not a library quirk.
//
// Redis is OPTIONAL. With no REDIS_URL the backend runs exactly as before: in-process event
// bus, in-memory rate limiter, one instance. That keeps `docker compose up` and the test
// suite dependency-free. Set REDIS_URL and the same seams become distributed, which is what
// running more than one backend instance requires.
//
// It is deliberately NOT a durability layer. Postgres and the outbox own durability; Redis
// only fans events between instances and holds rate-limit counters. Losing it costs a stale
// client until reload and weaker rate limits — not data.
import Redis from 'ioredis';
import { config } from '../config.js';

let publisher = null;
let subscriber = null;
let commands = null;
let warned = false;

export function isRedisEnabled() {
  return Boolean(config.redis.url);
}

// Shared options. `maxRetriesPerRequest: null` stops ioredis from failing commands while it
// reconnects — we would rather a rate-limit check wait a moment than error the request.
function options(role) {
  return {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectionName: `ghost-${role}`,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    reconnectOnError: () => true,
  };
}

function attachLogging(client, role) {
  client.on('error', (err) => {
    // Reconnection is automatic and noisy; log once per transition rather than per attempt.
    if (!client.__loggedError) {
      client.__loggedError = true;
      console.error(`redis(${role}) error: ${err.message}`);
    }
  });
  client.on('ready', () => {
    client.__loggedError = false;
    console.log(`redis(${role}) connected`);
  });
  return client;
}

function make(role) {
  if (!isRedisEnabled()) return null;
  return attachLogging(new Redis(config.redis.url, options(role)), role);
}

export function getPublisher() {
  if (!publisher) publisher = make('pub');
  return publisher;
}

export function getSubscriber() {
  if (!subscriber) subscriber = make('sub');
  return subscriber;
}

export function getCommands() {
  if (!commands) commands = make('cmd');
  return commands;
}

// Warn once, loudly, at boot. Running two instances without Redis silently halves the
// effective rate limit and leaves each instance's clients missing the other's events —
// failures that look like "the app is flaky", not like a missing config value.
export function warnIfSingleInstance() {
  if (isRedisEnabled() || warned) return;
  warned = true;
  console.warn(
    '[single-instance mode] REDIS_URL is not set: the event bus and rate limiter are ' +
      'in-process. This is fine for ONE backend container. Do NOT scale horizontally ' +
      'without Redis — clients on instance B would miss instance A\'s events.'
  );
}

export async function closeRedis() {
  await Promise.all(
    [publisher, subscriber, commands].filter(Boolean).map((c) => c.quit().catch(() => {}))
  );
  publisher = subscriber = commands = null;
}
