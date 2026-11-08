// CQRS write side for proof of delivery (domain/proof.js has the standard itself).
//
// A driver's two steps are no longer bare buttons. Each one writes its evidence row in the
// SAME transaction as the transition it justifies, so an order can never be "delivered" with
// nothing on record to say how anyone knows — which is the whole argument in a dispute.
//
// Failure paths that must persist (a wrong handoff code counts against the 5 tries) RETURN an
// outcome from the transaction, commit, and throw after: a throw inside the transaction would
// roll the attempt count back and make the cap a no-op (CLAUDE.md, Authentication).
import { prisma, withCriticalTransaction, withTransaction } from '../db/prisma.js';
import { transitionOrder, postMessage } from './orders.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { EVENTS } from '../events/bus.js';
import { STATUS } from '../domain/stateMachine.js';
import {
  HANDOFF_MAX_ATTEMPTS,
  DISPUTE_WINDOW_HOURS,
  handoffMatches,
  isHandoffCode,
  parseFix,
  cleanReason,
  buildProof,
} from '../domain/proof.js';

export class ProofError extends Error {
  constructor(message, status = 409, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// RAW: FOR UPDATE, so two taps (or a live tap racing an offline replay) can't both pass the
// checks and write two proofs. The UNIQUE (order_id, step) would catch it; this says why.
async function lockOrder(tx, orderId) {
  const rows = await tx.$queryRaw`
    SELECT id, status, kind, lat, lng, pickup_lat, pickup_lng FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw new ProofError('order not found', 404);
  return rows[0];
}

async function hasPhoto(tx, orderId, kind) {
  return Boolean(await tx.orderPhoto.findFirst({ where: { order_id: orderId, kind }, select: { id: true } }));
}

// The handoff code check, shared by a delivery's door step and a ride's pickup. Returns
// { ok: true } or { fail } — never throws on a wrong code, so the caller can COMMIT the
// attempt count before raising (see the header).
async function checkHandoffCode(tx, orderId, code) {
  const rows = await tx.$queryRaw`
    SELECT code, attempts FROM delivery_handoffs WHERE order_id = ${orderId}::uuid FOR UPDATE
  `;
  const handoff = rows[0];
  if (!handoff) return { fail: 'no_code' };
  if (handoff.attempts >= HANDOFF_MAX_ATTEMPTS) return { fail: 'locked' };
  if (!handoffMatches(handoff.code, String(code))) {
    await tx.deliveryHandoff.update({
      where: { order_id: orderId },
      data: { attempts: { increment: 1 } },
    });
    return { fail: 'wrong', left: HANDOFF_MAX_ATTEMPTS - handoff.attempts - 1 };
  }
  await tx.deliveryHandoff.update({ where: { order_id: orderId }, data: { verified_at: new Date() } });
  return { ok: true };
}

function raiseCodeFailure(outcome, { fallback }) {
  if (outcome.fail === 'wrong') {
    // Say how many are left: a driver who knows they have one try left calls the customer
    // instead of guessing.
    throw new ProofError(
      outcome.left > 0 ? `wrong code — ${outcome.left} tries left` : 'wrong code — no tries left',
      422,
      { triesLeft: outcome.left }
    );
  }
  if (outcome.fail === 'locked') {
    throw new ProofError(`too many wrong codes — ${fallback} instead`, 423, { triesLeft: 0 });
  }
  if (outcome.fail === 'no_code') {
    throw new ProofError(`this order has no code — ${fallback} instead`, 409);
  }
}

// Driver has the goods (a delivery: the pickup photo must be uploaded) or the rider is in
// the car (a ride: the rider's `code`, or a `noCodeReason`, flagged).
export async function confirmPickup({ orderId, actor, fix: rawFix, code, noCodeReason }) {
  const fix = parseFix(rawFix);
  const outcome = await withCriticalTransaction(async (tx) => {
    const row = await lockOrder(tx, orderId);
    if (row.status !== STATUS.DISPATCHED) {
      throw new ProofError(`this order is not waiting for pickup (${row.status})`);
    }
    if (row.kind === 'RIDE') return ridePickup(tx, row, { orderId, actor, fix, code, noCodeReason });
    if (!(await hasPhoto(tx, orderId, 'pickup_proof'))) {
      throw new ProofError('take a photo of the items first', 422);
    }
    const proof = buildProof({ step: 'pickup', method: 'photo', fix, order: row });
    await tx.orderProof.create({ data: { order_id: orderId, actor, ...proof } });
    return { order: await transitionOrder(orderId, STATUS.IN_TRANSIT, actor, 'items secured (photo)', { client: tx }) };
  });
  if (outcome.fail) raiseCodeFailure(outcome, { fallback: 'give a reason' });
  wakeOutbox();
  return outcome.order;
}

async function ridePickup(tx, row, { orderId, actor, fix, code, noCodeReason }) {
  const usingCode = code !== undefined && code !== null && code !== '';
  const reason = usingCode ? null : cleanReason(noCodeReason);
  if (usingCode && !isHandoffCode(String(code))) throw new ProofError('the code is 4 digits', 400);
  if (!usingCode && !reason) throw new ProofError('enter the rider\'s code, or say why you can\'t', 400);
  if (usingCode) {
    const check = await checkHandoffCode(tx, orderId, code);
    if (check.fail) return check;
  }
  const method = usingCode ? 'code' : 'no_code';
  const proof = buildProof({ step: 'pickup', method, fix, order: row, note: reason });
  await tx.orderProof.create({ data: { order_id: orderId, actor, ...proof } });
  const note = usingCode ? 'rider picked up (rider code)' : `rider picked up without code: ${reason}`;
  return { order: await transitionOrder(orderId, STATUS.IN_TRANSIT, actor, note, { client: tx }) };
}

// Driver has handed the goods over. Either `code` (the customer's 4 digits) or `noCodeReason`
// with a delivery photo already uploaded.
export async function confirmDelivery({ orderId, actor, code, noCodeReason, fix: rawFix }) {
  const fix = parseFix(rawFix);
  const usingCode = code !== undefined && code !== null && code !== '';
  const reason = usingCode ? null : cleanReason(noCodeReason);
  if (usingCode && !isHandoffCode(String(code))) throw new ProofError('the code is 4 digits', 400);
  if (!usingCode && !reason) {
    throw new ProofError('enter the customer\'s code, or say why you can\'t', 400);
  }

  const outcome = await withCriticalTransaction(async (tx) => {
    const row = await lockOrder(tx, orderId);
    if (row.status !== STATUS.IN_TRANSIT) {
      throw new ProofError(`this order is not out for delivery (${row.status})`);
    }
    if (row.kind === 'RIDE') throw new ProofError('a ride is finished with "Drop off", not a code', 409);

    let method;
    if (usingCode) {
      const check = await checkHandoffCode(tx, orderId, code);
      if (check.fail) return check;
      method = 'code';
    } else {
      if (!(await hasPhoto(tx, orderId, 'delivery_proof'))) {
        throw new ProofError('take a photo at the door first', 422);
      }
      method = 'photo_no_code';
    }

    const proof = buildProof({ step: 'delivery', method, fix, order: row, note: reason });
    await tx.orderProof.create({ data: { order_id: orderId, actor, ...proof } });
    const order = await transitionOrder(
      orderId,
      STATUS.DELIVERED,
      actor,
      method === 'code' ? 'delivered (customer code)' : `delivered without code: ${reason}`,
      { client: tx }
    );
    return { order };
  });

  if (outcome.fail) raiseCodeFailure(outcome, { fallback: 'deliver with a photo' });
  wakeOutbox();
  return outcome.order;
}

// A ride is over: the rider got out. The drop-off fix is the evidence; far from the
// destination or no fix at all is flagged for the Deliveries review, never refused.
export async function confirmDropoff({ orderId, actor, fix: rawFix, note: rawNote }) {
  const fix = parseFix(rawFix);
  const note = cleanReason(rawNote);
  const order = await withCriticalTransaction(async (tx) => {
    const row = await lockOrder(tx, orderId);
    if (row.kind !== 'RIDE') throw new ProofError('a delivery is finished with the customer\'s code', 409);
    if (row.status !== STATUS.IN_TRANSIT) {
      throw new ProofError(`this ride has not started (${row.status})`);
    }
    const proof = buildProof({ step: 'delivery', method: 'dropoff', fix, order: row, note });
    await tx.orderProof.create({ data: { order_id: orderId, actor, ...proof } });
    return transitionOrder(orderId, STATUS.DELIVERED, actor, note ? `ride finished: ${note}` : 'ride finished', { client: tx });
  });
  wakeOutbox();
  return order;
}

// Operator looked at a flagged proof. Doesn't change the order — it clears the review queue
// and records who vouched for it.
export async function markProofReviewed({ orderId, step = 'delivery', actor }) {
  const res = await prisma.orderProof.updateMany({
    where: { order_id: orderId, step, reviewed_at: null },
    data: { reviewed_by: actor, reviewed_at: new Date() },
  });
  if (res.count === 0) throw new ProofError('nothing to review on this order', 404);
}

// Customer: "I didn't get my order." The other half of the check — a driver who used the
// no-code path, or a code read off a stolen phone, still meets the customer here. It changes
// no status (the order stays DELIVERED; what is owed is the operator's call, via a refund) but
// puts the delivery back in the operator's review queue, even if it had been checked.
export async function disputeDelivery({ orderId, note }) {
  const outcome = await withTransaction(async (tx) => {
    const proof = await tx.orderProof.findUnique({
      where: { order_id_step: { order_id: orderId, step: 'delivery' } },
    });
    if (!proof) throw new ProofError('this order has not been delivered', 409);
    if (Date.now() - proof.created_at.getTime() > DISPUTE_WINDOW_HOURS * 3600 * 1000) {
      throw new ProofError('it is too late to report this order — contact us directly', 409);
    }
    if (proof.flags.includes('customer_disputed')) return { already: true };
    await tx.orderProof.update({
      where: { id: proof.id },
      data: { flags: { push: 'customer_disputed' }, reviewed_at: null, reviewed_by: null },
    });
    const said = cleanReason(note);
    await postMessage(
      { orderId, sender: 'system', body: `Customer says they did not get this order.${said ? ` “${said}”` : ''} An operator will call.` },
      { client: tx }
    );
    await enqueue(tx, EVENTS.DELIVERY_DISPUTED, { orderId });
    return { already: false };
  });
  if (!outcome.already) wakeOutbox();
}
