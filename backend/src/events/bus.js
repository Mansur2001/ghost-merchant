// In-process pub/sub event bus (Observer pattern). Command handlers publish domain
// events here; the realtime layer, notifications, and auto-responder subscribe.
//
// The seam is deliberate: swap this file for Redis pub/sub or NATS later and every
// module that was split into a microservice keeps working unchanged.
import { EventEmitter } from 'node:events';

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

export function publish(event, payload) {
  emitter.emit(event, payload);
}

export function subscribe(event, handler) {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}
