// Domain event bus (Observer pattern). Command handlers publish here via the outbox; the
// realtime layer and the oracle monitor subscribe.
//
// TWO MODES, one API:
//   no REDIS_URL  — in-process EventEmitter. One backend instance. What the tests use.
//   REDIS_URL set — publish goes to Redis pub/sub, and EVERY instance (including this one)
//                   receives it back over the subscriber connection and re-emits locally.
//
// The round-trip through Redis for our own events is deliberate: it gives one delivery path
// instead of two, so there is no "works locally, drops across instances" class of bug. The
// cost is a millisecond of loopback latency, which is nothing next to a socket write.
//
// This is NOT durability. The outbox already guarantees an event survives a crash; Redis only
// fans it out. If Redis is down, delivery degrades to local-only and says so in the log.
import { EventEmitter } from 'node:events';
import { getPublisher, getSubscriber, isRedisEnabled } from '../redis/client.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// Domain event names — the vocabulary of the system.
export const EVENTS = {
  ORDER_CREATED: 'order.created',
  ORDER_STATE_CHANGED: 'order.state_changed',
  PAYMENT_RECEIVED: 'payment.received',
  MESSAGE_POSTED: 'message.posted',
  ORACLE_HEARTBEAT: 'oracle.heartbeat',
  ORACLE_DOWN: 'oracle.down',
};

const CHANNEL = 'ghost:events';

// Distinguishes our own messages coming back from Redis — useful in logs when tracing which
// instance originated an event.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
export const instanceId = INSTANCE_ID;

let subscribed = false;

// Start listening for events published by any instance. Idempotent.
export function startBusSubscriber() {
  if (!isRedisEnabled() || subscribed) return;
  subscribed = true;
  const sub = getSubscriber();

  sub.subscribe(CHANNEL, (err) => {
    if (err) console.error('bus: failed to subscribe:', err.message);
    else console.log(`bus: subscribed to ${CHANNEL} (instance ${INSTANCE_ID})`);
  });

  sub.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // never let a malformed message from anywhere take the process down
    }
    if (!msg || typeof msg.event !== 'string') return;
    emitter.emit(msg.event, msg.payload);
  });
}

export function publish(event, payload) {
  if (!isRedisEnabled()) {
    emitter.emit(event, payload);
    return;
  }

  const message = JSON.stringify({ event, payload, from: INSTANCE_ID, at: Date.now() });
  getPublisher()
    .publish(CHANNEL, message)
    .catch((err) => {
      // Degrade rather than drop: this instance's own clients still get the event, and the
      // log says the fan-out failed. Losing a notification is survivable — the database is
      // still correct and clients resync on reload.
      console.error(`bus: redis publish failed (${err.message}) — delivering locally only`);
      emitter.emit(event, payload);
    });
}

export function subscribe(event, handler) {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

// Test hook: drop every listener between cases.
export function resetBus() {
  emitter.removeAllListeners();
}
