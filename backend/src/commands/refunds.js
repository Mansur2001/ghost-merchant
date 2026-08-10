// CQRS write side for refunds.
//
// The platform never custodies customer money (invariant 6), so a refund is not a button that
// moves funds — it is an operator sending money back from their own phone over EVC Plus, off
// platform. This ledger is what makes that debt visible and closeable, so "which customers
// are we still out of pocket to?" has an answer that isn't someone's memory.
//
//   order goes FAILED_REFUND  ->  a row with status 'owed'
//   operator sends the money  ->  'settled', with the telecom reference of the RETURN transfer
//   nothing was ever paid     ->  'waived', with a reason
import { prisma, withCriticalTransaction, inTransaction } from '../db/prisma.js';

export class RefundError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Open a refund for an order. Called inside the same transaction as the FAILED_REFUND
// transition, so an order can never end up failed with no record of what is owed.
//
// Only opens one if money actually arrived: an order that failed before payment owes nothing,
// and creating a zero-value debt would bury the real ones in noise.
export async function openRefundIfOwed({ orderId, reason, createdBy }, { client } = {}) {
  return inTransaction(client, async (tx) => {
    const paid = await tx.transaction.aggregate({
      where: { order_id: orderId, matched: true },
      _sum: { amount: true },
    });
    const amount = paid._sum.amount;
    if (!amount || Number(amount) <= 0) return null;

    // A partial unique index enforces one OPEN refund per order; check first so a re-run of
    // the same transition reads as a no-op rather than an error.
    const open = await tx.refund.findFirst({ where: { order_id: orderId, status: 'owed' } });
    if (open) return open;

    return tx.refund.create({
      data: {
        order_id: orderId,
        amount,
        reason: reason || 'order failed after payment',
        status: 'owed',
        created_by: createdBy || 'system',
      },
    });
  });
}

// Everything still owed, oldest first — this is the reconciliation queue.
export async function listOutstandingRefunds() {
  const refunds = await prisma.refund.findMany({
    where: { status: 'owed' },
    orderBy: { created_at: 'asc' },
    include: {
      order: { select: { id: true, user_phone: true, status: true, landmark_text: true } },
    },
  });
  const total = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  return { refunds, count: refunds.length, total: total.toFixed(2) };
}

// Recently closed, for context next to the queue.
export async function listSettledRefunds(limit = 25) {
  return prisma.refund.findMany({
    where: { status: { in: ['settled', 'waived'] } },
    orderBy: { settled_at: 'desc' },
    take: limit,
    include: { order: { select: { id: true, user_phone: true } } },
  });
}

// Record that the money actually went back.
//
// CP path: this is a money record. It is also the one place an operator asserts something we
// cannot verify ourselves — the telecom holds the truth — so the reference is required and
// stored verbatim, giving a dispute something to check against the telecom's own log.
export async function settleRefund({ refundId, reference, note, settledBy }) {
  const ref = String(reference || '').trim();
  if (!ref) {
    throw new RefundError(
      'a telecom reference is required — it is what proves the money went back'
    );
  }

  return withCriticalTransaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: BigInt(refundId) } });
    if (!refund) throw new RefundError('refund not found', 404);
    if (refund.status !== 'owed') {
      throw new RefundError(`this refund is already ${refund.status}`, 409);
    }
    return tx.refund.update({
      where: { id: refund.id },
      data: {
        status: 'settled',
        settled_at: new Date(),
        settled_by: settledBy,
        settlement_reference: ref.slice(0, 120),
        settlement_note: note ? String(note).slice(0, 500) : null,
      },
    });
  });
}

// Close a refund WITHOUT paying it — the customer was never charged, or they declined it.
// Deliberately separate from settle: conflating "we paid this back" with "nothing was owed"
// would make the ledger useless in exactly the argument it exists to settle.
export async function waiveRefund({ refundId, note, settledBy }) {
  const reason = String(note || '').trim();
  if (!reason) throw new RefundError('say why this is being waived — the ledger has to explain itself');

  return withCriticalTransaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: BigInt(refundId) } });
    if (!refund) throw new RefundError('refund not found', 404);
    if (refund.status !== 'owed') {
      throw new RefundError(`this refund is already ${refund.status}`, 409);
    }
    return tx.refund.update({
      where: { id: refund.id },
      data: {
        status: 'waived',
        settled_at: new Date(),
        settled_by: settledBy,
        settlement_note: reason.slice(0, 500),
      },
    });
  });
}
