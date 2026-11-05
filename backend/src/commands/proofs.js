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
import { wakeOutbox } from '../events/outbox.js';
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
    SELECT id, status, lat, lng FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw new ProofError('order not found', 404);
  return rows[0];
}

async function hasPhoto(tx, orderId, kind) {
  return Boolean(await tx.orderPhoto.findFirst({ where: { order_id: orderId, kind }, select: { id: true } }));
}

// Driver has the goods. Needs the pickup photo already uploaded.
export async function confirmPickup({ orderId, actor, fix: rawFix }) {
  const fix = parseFix(rawFix);
  const order = await withCriticalTransaction(async (tx) => {
    const row = await lockOrder(tx, orderId);
    if (row.status !== STATUS.DISPATCHED) {
      throw new ProofError(`this order is not waiting for pickup (${row.status})`);
    }
    if (!(await hasPhoto(tx, orderId, 'pickup_proof'))) {
      throw new ProofError('take a photo of the items first', 422);
    }
    const proof = buildProof({ step: 'pickup', method: 'photo', fix, order: row });
    await tx.orderProof.create({ data: { order_id: orderId, actor, ...proof } });
    return transitionOrder(orderId, STATUS.IN_TRANSIT, actor, 'items secured (photo)', { client: tx });
  });
  wakeOutbox();
  return order;
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

    let method;
    if (usingCode) {
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
    throw new ProofError('too many wrong codes — deliver with a photo instead', 423, { triesLeft: 0 });
  }
  if (outcome.fail === 'no_code') {
    throw new ProofError('this order has no delivery code — deliver with a photo instead', 409);
  }
  wakeOutbox();
  return outcome.order;
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
    return { already: false };
  });
  if (!outcome.already) wakeOutbox();
}
