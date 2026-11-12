// Domain events -> push notifications. Subscribes to the bus like the socket layer, but only
// the instance that RELAYS the outbox sends: with Redis every instance hears every event, and
// four instances would buzz a phone four times. (A rare duplicate across a leadership handover
// is collapsed on the device by the notification's tag.)
import { EVENTS, subscribe } from '../events/bus.js';
import { isRelayLeader } from '../events/outbox.js';
import { targetsFor } from '../domain/push.js';
import { prisma } from '../db/prisma.js';
import { notify } from '../commands/push.js';
import { config } from '../config.js';

const ORDER_EVENTS = [
  EVENTS.ORDER_STATE_CHANGED, EVENTS.MESSAGE_POSTED, EVENTS.PAYMENT_CLAIMED,
  EVENTS.PAYMENT_ATTEMPT, EVENTS.DELIVERY_DISPUTED, EVENTS.DRIVER_OFFERED, EVENTS.EXTRA_WORK_QUOTED,
];

export function startPushBridge() {
  if (!(config.push.webpush.enabled || config.push.fcm.enabled)) return false;
  for (const name of ORDER_EVENTS) {
    subscribe(name, (payload) => {
      if (!isRelayLeader()) return;
      handle(name, payload).catch((err) => console.warn(`[push] ${name}: ${err.message}`));
    });
  }
  return true;
}

async function handle(name, payload) {
  const orderId = payload?.orderId;
  const order = orderId
    ? await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, user_id: true, driver_id: true, kind: true, status: true },
    })
    : null;
  const targets = targetsFor({ name, payload }, order);
  if (targets.length) await notify(targets);
}
