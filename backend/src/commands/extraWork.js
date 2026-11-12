// Extra work on a Farsamo visit. The visit fee paid for the technician to come and look; if
// the job needs more (a part, more hours), the technician quotes it IN THE APP and the
// customer pays it like any order — a new prepaid SERVICE order under the visit, which goes
// straight to that technician once paid (commands/dispatch.js). The technician never takes
// cash and never names a price the customer didn't accept by paying.
import { withCriticalTransaction } from '../db/prisma.js';
import { createOrder, postMessage } from './orders.js';
import { audit } from './audit.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { EVENTS } from '../events/bus.js';
import { cleanDetails, toCents, fromCents, PricingError } from '../domain/pricing.js';
import { STATUS } from '../domain/stateMachine.js';

export const EXTRA_MIN = 0.5;
export const EXTRA_MAX = 500;

export async function quoteExtraWork({ orderId, driverId, description, amount }) {
  const text = cleanDetails(description, { what: 'say what the extra work is' });
  const c = toCents(amount);
  if (!Number.isFinite(c) || c < toCents(EXTRA_MIN) || c > toCents(EXTRA_MAX)) {
    throw new PricingError(`the price must be $${EXTRA_MIN.toFixed(2)} to $${EXTRA_MAX}`);
  }
  // Check the visit under a lock: one open quote at a time, and only while on site.
  const parent = await withCriticalTransaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, kind, status, driver_id, user_id, user_phone, lat, lng, landmark_text, trade
        FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row || String(row.driver_id) !== String(driverId)) throw new PricingError('not found', 404);
    if (row.kind !== 'SERVICE') throw new PricingError('extra work is only for a technician\'s visit', 409);
    if (row.status !== STATUS.IN_TRANSIT) throw new PricingError('start the job first', 409);
    const open = await tx.order.count({ where: { parent_order_id: orderId, status: STATUS.PENDING_PAYMENT } });
    if (open) throw new PricingError('the customer has not paid your last quote yet', 409);
    return row;
  });
  const { order } = await createOrder({
    userId: parent.user_id,
    contactPhone: parent.user_phone,
    items: [],
    totalAmount: fromCents(c),
    lat: parent.lat,
    lng: parent.lng,
    landmark: parent.landmark_text,
    kind: 'SERVICE',
    subtotal: '0.00',
    fee: fromCents(c),
    requestedDriverId: driverId,
    trade: parent.trade,
    details: text,
    parentOrderId: orderId,
  });
  await withCriticalTransaction(async (tx) => {
    await postMessage({ orderId, sender: 'system', body: `Your technician quoted extra work: ${text} — $${fromCents(c)}. Pay it on this screen to go ahead.` }, { client: tx });
    await enqueue(tx, EVENTS.EXTRA_WORK_QUOTED, { orderId, extraOrderId: order.id, amount: fromCents(c), status: STATUS.IN_TRANSIT });
    await audit({ actor: `driver:${driverId}`, action: 'order.extra_quoted', subject: `order:${orderId}`, detail: { extraOrderId: order.id, amount: fromCents(c) } }, { client: tx });
  });
  wakeOutbox();
  return order;
}
