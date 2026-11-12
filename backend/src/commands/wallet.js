// The customer wallet: a balance topped up through the gateway (WaafiPay) — or, until the
// gateway has keys, over USSD and confirmed by an operator with the telecom reference — and
// spent on orders. ON by default since 2026-11-11: the owner holds the licence stored value
// needs. WALLET_ENABLED=false still switches it off.
//
// Rules, each enforced in the database as well as here:
//   * the LEDGER is the truth (wallet_entries, append-only); every row records the balance it
//     left, and wallet_accounts.balance_cents moves only with a ledger row, under a row lock;
//   * a balance never goes below zero (CHECK) and never above WALLET_MAX_BALANCE;
//   * money comes IN only through the gateway, or an operator-confirmed USSD top-up with its
//     telecom reference (operator mode only) — either way the reference is UNIQUE in
//     `transactions`, like any payment — or as a refund of a wallet-paid order. No operator, no
//     admin, no route can credit a balance without a telecom reference;
//   * money goes OUT only to pay an order (once per order: partial UNIQUE index) or as a
//     withdrawal an admin pays from the business wallet and records with its reference.
import { prisma, withCriticalTransaction, withTransaction } from '../db/prisma.js';
import { config } from '../config.js';
import { newOrderId } from '../domain/ids.js';
import { parsePhone } from '../domain/phone.js';
import { payerAccountNo } from '../domain/waafipay.js';
import { normalizeReference } from '../domain/paymentRef.js';
import { STATUS } from '../domain/stateMachine.js';
import { confirmPayment, PaymentError } from './payments.js';
import { audit, auditAfter } from './audit.js';
import { wakeOutbox } from '../events/outbox.js';
import { parseWalletSettings } from '../domain/walletSettings.js';
import { notifyAfter } from './push.js';

export class WalletError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export { parseWalletSettings };
const cents = (v) => Math.round(Number(v) * 100);
const dollars = (c) => (Number(c) / 100).toFixed(2);

function requireOn(settings) {
  if (!settings.enabled) throw new WalletError('the wallet is not available', 404);
}

// Post one ledger row inside the caller's transaction. Positive = credit, negative = debit.
// RAW: FOR UPDATE on the account row, so two payments at once can't both see the same balance.
export async function postEntry(tx, { userId, amountCents, kind, orderId = null, reference = null, actor, maxCents = null }) {
  await tx.$executeRaw`INSERT INTO wallet_accounts (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
  const rows = await tx.$queryRaw`SELECT balance_cents FROM wallet_accounts WHERE user_id = ${userId} FOR UPDATE`;
  const before = BigInt(rows[0].balance_cents);
  const after = before + BigInt(amountCents);
  if (after < 0n) throw new WalletError(`not enough in your wallet (you have $${dollars(before)})`, 409);
  if (maxCents != null && amountCents > 0 && after > BigInt(maxCents)) {
    throw new WalletError(`a wallet can hold at most $${dollars(maxCents)}`, 409);
  }
  await tx.$executeRaw`UPDATE wallet_accounts SET balance_cents = ${after}, updated_at = now() WHERE user_id = ${userId}`;
  return tx.walletEntry.create({
    data: {
      user_id: userId, amount_cents: BigInt(amountCents), balance_after_cents: after,
      kind, order_id: orderId, reference, actor,
    },
  });
}

// ── Top-up: a WaafiPay prompt for an amount, credited when approved ──
export async function startTopup({ userId, amount, wallet, phone, settings = config.wallet, gateway = config.waafipay, run }) {
  requireOn(settings);
  if (!gateway.enabled) throw new WalletError('topping up is not available yet', 404);
  if (!gateway.wallets.includes(wallet)) throw new WalletError('choose EVC Plus, Zaad or Sahal');
  const accountNo = payerAccountNo(phone);
  if (!accountNo) throw new WalletError('enter the Somali number of the wallet that pays');
  const c = cents(amount);
  if (!Number.isFinite(c) || c < settings.topupMinCents || c > settings.topupMaxCents) {
    throw new WalletError(`top up between $${dollars(settings.topupMinCents)} and $${dollars(settings.topupMaxCents)}`);
  }

  const result = await withTransaction(async (tx) => {
    const acct = await tx.walletAccount.findUnique({ where: { user_id: userId } });
    if (BigInt(acct?.balance_cents ?? 0) + BigInt(c) > BigInt(settings.maxBalanceCents)) {
      throw new WalletError(`a wallet can hold at most $${dollars(settings.maxBalanceCents)}`, 409);
    }
    const pending = await tx.paymentAttempt.findFirst({ where: { user_id: userId, purpose: 'topup', status: 'pending' } });
    if (pending) return { attempt: pending, created: false };
    const unclear = await tx.paymentAttempt.findFirst({
      where: { user_id: userId, purpose: 'topup', status: 'unknown', updated_at: { gt: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    if (unclear) throw new WalletError('we could not tell if your last top-up went through. Wait a few minutes before trying again', 409);
    const attempt = await tx.paymentAttempt.create({
      data: {
        id: newOrderId(), order_id: null, user_id: userId, purpose: 'topup', provider: 'waafipay',
        wallet, payer: `+${accountNo}`, amount: dollars(c),
      },
    });
    return { attempt, created: true };
  });

  if (result.created && run) {
    run(result.attempt, accountNo).catch((err) => console.error(`[wallet] top-up ${result.attempt.id}: ${err.message}`));
  }
  return result.attempt;
}

// The gateway approved a top-up: record the payment (UNIQUE reference) and credit the ledger,
// in one transaction with the attempt. Anything that doesn't fit is audited, never forced.
export async function applyTopupOutcome(attempt, outcome, settings = config.wallet) {
  if (outcome.status !== 'approved') {
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'pending' },
      data: { status: outcome.status, detail: String(outcome.detail || '').slice(0, 200), updated_at: new Date() },
    });
    return outcome.status;
  }
  const reference = normalizeReference(outcome.reference);
  const paidCents = cents(outcome.amount ?? attempt.amount);
  try {
    if (!reference) throw new WalletError('unreadable transaction id');
    if (paidCents !== cents(attempt.amount)) throw new WalletError(`paid ${dollars(paidCents)}, asked ${attempt.amount}`);
    await withCriticalTransaction(async (tx) => {
      const used = await tx.transaction.findUnique({ where: { telecom_receipt_id: reference } });
      if (used) throw new WalletError(`reference ${reference} already used`);
      await tx.transaction.create({
        data: {
          order_id: null, telecom_receipt_id: reference, sender_msisdn: attempt.payer,
          amount: attempt.amount, matched: true, provider: 'waafipay', sender_name: `wallet-topup:${attempt.user_id}`,
        },
      });
      // A top-up never exceeds the cap it was checked against at start; credits from refunds may.
      await postEntry(tx, {
        userId: attempt.user_id, amountCents: paidCents, kind: 'topup', reference, actor: 'system:waafipay',
        maxCents: settings.maxBalanceCents,
      });
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'approved', reference, updated_at: new Date() } });
      await audit({ actor: 'system:waafipay', action: 'wallet.topup', subject: `user:${attempt.user_id}`, detail: { reference, amount: attempt.amount } }, { client: tx });
    });
    notifyAfter([{ to: { role: 'customer', id: attempt.user_id }, kind: 'topup_ok', url: '/?wallet=1', tag: `wallet-${attempt.id}` }]);
    return 'approved';
  } catch (err) {
    if (!(err instanceof WalletError)) throw err;
    auditAfter({
      actor: 'system:waafipay', action: 'payment.unmatched', subject: `user:${attempt.user_id}`,
      detail: { purpose: 'topup', reference, amount: dollars(paidCents), payer: attempt.payer, reason: err.message },
    });
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'pending' },
      data: { status: 'approved', reference, detail: `not credited: ${err.message}`.slice(0, 200), updated_at: new Date() },
    });
    return 'unmatched';
  }
}

// ── Pay an order from the balance ──
// Through confirmPayment, like every payment: same status check, same audit, same dispatch, and
// the debit in the SAME transaction (withinTx). Not enough money rolls the whole thing back.
export async function payOrderFromWallet({ orderId, userId, settings = config.wallet }) {
  requireOn(settings);
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, total_amount: true } });
  if (!order) throw new WalletError('not found', 404);
  if (order.status !== STATUS.PENDING_PAYMENT) throw new WalletError('this order is already paid', 409);
  const total = cents(order.total_amount);
  const reference = `W.${newOrderId().replace(/-/g, '')}`.toUpperCase();
  try {
    const result = await confirmPayment({
      orderId, reference, amount: order.total_amount, actor: `customer:${userId}`, provider: 'wallet',
      withinTx: (tx) => postEntry(tx, { userId, amountCents: -total, kind: 'order_payment', orderId, reference, actor: `customer:${userId}` }),
    });
    wakeOutbox();
    return result;
  } catch (err) {
    if (err instanceof PaymentError) throw new WalletError(err.message, err.status);
    // The UNIQUE (order, order_payment) index: a double tap that raced past the status check.
    if (err?.code === 'P2002') throw new WalletError('this order is already paid', 409);
    throw err;
  }
}

// A wallet-paid order failed: the money goes straight back to the wallet, recorded as a refund
// SETTLED by the system — in the caller's transaction (refunds.js openRefundIfOwed).
export async function refundToWallet(tx, { orderId, userId, amountCents, reason }) {
  const entry = await postEntry(tx, {
    userId, amountCents, kind: 'refund', orderId, reference: `REFUND.${orderId}`.slice(0, 40), actor: 'system:wallet',
  });
  return tx.refund.create({
    data: {
      order_id: orderId, amount: dollars(amountCents), reason: reason || 'order failed after payment',
      status: 'settled', settled_at: new Date(), settled_by: 'system:wallet',
      settlement_reference: `wallet entry ${entry.id}`, settlement_note: 'credited back to the customer wallet', created_by: 'system:wallet',
    },
  });
}

// ── Withdrawals: taken from the balance now, paid by an admin, or rejected and returned ──
export async function requestWithdrawal({ userId, amount, phone, settings = config.wallet }) {
  requireOn(settings);
  const c = cents(amount);
  if (!Number.isFinite(c) || c < 100) throw new WalletError('withdraw at least $1.00');
  const p = parsePhone(phone);
  if (!p.valid || p.country !== 'SO') throw new WalletError('enter the Somali number to send the money to');
  return withCriticalTransaction(async (tx) => {
    const open = await tx.walletWithdrawal.count({ where: { user_id: userId, status: 'requested' } });
    if (open) throw new WalletError('you already have a withdrawal waiting', 409);
    const w = await tx.walletWithdrawal.create({ data: { user_id: userId, amount_cents: BigInt(c), payout_phone: p.e164 } });
    await postEntry(tx, { userId, amountCents: -c, kind: 'withdrawal', reference: `WD.${w.id}`, actor: `customer:${userId}` });
    await audit({ actor: `customer:${userId}`, action: 'wallet.withdrawal.requested', subject: `withdrawal:${w.id}`, detail: { amount: dollars(c) } }, { client: tx });
    return w;
  }).then((w) => {
    notifyAfter([{ to: { role: 'operator', admins: true }, kind: 'op_withdrawal', url: '/operator/', tag: `wd-${w.id}` }]);
    return w;
  });
}

async function lockWithdrawal(tx, id) {
  let key;
  try { key = BigInt(id); } catch { throw new WalletError('not found', 404); }
  const rows = await tx.$queryRaw`SELECT id, user_id, amount_cents, status FROM wallet_withdrawals WHERE id = ${key} FOR UPDATE`;
  if (!rows[0]) throw new WalletError('not found', 404);
  if (rows[0].status !== 'requested') throw new WalletError(`this withdrawal is already ${rows[0].status}`, 409);
  return rows[0];
}

// Admin: the money was sent from the business wallet. The reference is required — it is the
// one claim we can't verify ourselves, so it must be checkable against the telecom's log.
export async function markWithdrawalPaid({ id, reference, actor }) {
  const ref = String(reference || '').trim();
  if (!ref) throw new WalletError('the transaction reference of the payout is required');
  return withCriticalTransaction(async (tx) => {
    const w = await lockWithdrawal(tx, id);
    const done = await tx.walletWithdrawal.update({
      where: { id: w.id }, data: { status: 'paid', reference: ref.slice(0, 120), decided_by: actor, decided_at: new Date() },
    });
    await audit({ actor, action: 'wallet.withdrawal.paid', subject: `withdrawal:${w.id}`, detail: { reference: ref, amount: dollars(w.amount_cents) } }, { client: tx });
    return done;
  }).then((done) => {
    notifyAfter([{ to: { role: 'customer', id: done.user_id }, kind: 'withdrawal_paid', url: '/?wallet=1', tag: `wd-${done.id}` }]);
    return done;
  });
}

export async function rejectWithdrawal({ id, note, actor }) {
  const why = String(note || '').trim();
  if (!why) throw new WalletError('say why — the customer is told');
  return withCriticalTransaction(async (tx) => {
    const w = await lockWithdrawal(tx, id);
    await postEntry(tx, { userId: w.user_id, amountCents: Number(w.amount_cents), kind: 'withdrawal_reversal', reference: `WD.${w.id}`, actor });
    const done = await tx.walletWithdrawal.update({
      where: { id: w.id }, data: { status: 'rejected', note: why.slice(0, 300), decided_by: actor, decided_at: new Date() },
    });
    await audit({ actor, action: 'wallet.withdrawal.rejected', subject: `withdrawal:${w.id}`, detail: { note: why } }, { client: tx });
    return done;
  }).then((done) => {
    notifyAfter([{ to: { role: 'customer', id: done.user_id }, kind: 'withdrawal_rejected', url: '/?wallet=1', tag: `wd-${done.id}` }]);
    return done;
  });
}


// ── Manual top-up (no gateway yet): pay the merchant over USSD, then claim it ──
// The same trust model as an order payment in operator mode (invariant 3): the customer's
// claim is a hint; an OPERATOR confirms it against the merchant phone with the telecom
// reference, which is UNIQUE in `transactions` like every payment. In api mode only the
// gateway credits a balance, so this path is closed there.
export async function claimTopup({ userId, amount, wallet, reference, settings = config.wallet, wallets = config.payment.wallets, mode = config.paymentConfirmation }) {
  requireOn(settings);
  if (mode !== 'operator') throw new WalletError('top up in the app instead', 404);
  const c = cents(amount);
  if (!Number.isFinite(c) || c < settings.topupMinCents || c > settings.topupMaxCents) {
    throw new WalletError(`top up between $${dollars(settings.topupMinCents)} and $${dollars(settings.topupMaxCents)}`);
  }
  const w = (wallets || []).find((x) => x.id === wallet);
  if (!w) throw new WalletError('choose the wallet you paid with');
  const ref = normalizeReference(reference);
  if (!ref) throw new WalletError('enter the transaction number from your payment message');
  const acct = await prisma.walletAccount.findUnique({ where: { user_id: userId } });
  if (BigInt(acct?.balance_cents ?? 0) + BigInt(c) > BigInt(settings.maxBalanceCents)) {
    throw new WalletError(`a wallet can hold at most $${dollars(settings.maxBalanceCents)}`, 409);
  }
  try {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        id: newOrderId(), order_id: null, user_id: userId, purpose: 'topup', provider: 'manual',
        wallet: w.id, payer: '', amount: dollars(c), status: 'claimed', claim_ref: ref,
      },
    });
    notifyAfter([{ to: { role: 'operator' }, kind: 'op_topup', url: '/operator/', tag: `topup-${attempt.id}` }]);
    return attempt;
  } catch (err) {
    if (err?.code === 'P2002') throw new WalletError('you already have a top-up waiting to be checked', 409);
    throw err;
  }
}

async function lockClaim(tx, id) {
  const rows = await tx.$queryRaw`
    SELECT id, user_id, amount, status, wallet, claim_ref FROM payment_attempts
     WHERE id = ${String(id)}::uuid AND purpose = 'topup' AND provider = 'manual' FOR UPDATE
  `;
  if (!rows[0]) throw new WalletError('not found', 404);
  if (rows[0].status !== 'claimed') throw new WalletError(`this top-up is already ${rows[0].status}`, 409);
  return rows[0];
}

// Operator: the money is on the merchant phone. Reference REQUIRED, amount as claimed.
export async function confirmTopup({ id, reference, actor, settings = config.wallet, mode = config.paymentConfirmation }) {
  if (mode !== 'operator') throw new WalletError('top-ups are confirmed by the payment provider', 403);
  const ref = normalizeReference(reference);
  if (!ref) throw new WalletError('enter the transaction number you see on the merchant phone');
  const done = await withCriticalTransaction(async (tx) => {
    const a = await lockClaim(tx, id);
    const used = await tx.transaction.findUnique({ where: { telecom_receipt_id: ref }, select: { order_id: true } });
    if (used) throw new WalletError(`reference ${ref} was already used`, 409);
    await tx.transaction.create({
      data: {
        order_id: null, telecom_receipt_id: ref, sender_msisdn: '', amount: a.amount, matched: true,
        provider: 'manual', sender_name: `wallet-topup:${a.user_id}:${actor}`,
      },
    });
    await postEntry(tx, {
      userId: a.user_id, amountCents: cents(a.amount), kind: 'topup', reference: ref, actor, maxCents: settings.maxBalanceCents,
    });
    await tx.paymentAttempt.update({ where: { id: a.id }, data: { status: 'approved', reference: ref, updated_at: new Date() } });
    await audit({ actor, action: 'wallet.topup', subject: `user:${a.user_id}`, detail: { reference: ref, amount: String(a.amount), claimed: a.claim_ref } }, { client: tx });
    return a;
  });
  notifyAfter([{ to: { role: 'customer', id: done.user_id }, kind: 'topup_ok', url: '/?wallet=1', tag: `wallet-${done.id}` }]);
  return { ok: true };
}

export async function rejectTopup({ id, note, actor }) {
  const why = String(note || '').trim();
  if (!why) throw new WalletError('say why — the customer is told');
  const done = await withCriticalTransaction(async (tx) => {
    const a = await lockClaim(tx, id);
    await tx.paymentAttempt.update({ where: { id: a.id }, data: { status: 'rejected', detail: why.slice(0, 200), updated_at: new Date() } });
    await audit({ actor, action: 'wallet.topup.rejected', subject: `user:${a.user_id}`, detail: { note: why, claimed: a.claim_ref } }, { client: tx });
    return a;
  });
  notifyAfter([{ to: { role: 'customer', id: done.user_id }, kind: 'topup_rejected', url: '/?wallet=1', tag: `wallet-${done.id}` }]);
  return { ok: true };
}

export async function listTopupClaims() {
  const rows = await prisma.paymentAttempt.findMany({
    where: { purpose: 'topup', provider: 'manual', OR: [{ status: 'claimed' }, { updated_at: { gte: new Date(Date.now() - 3 * 86400 * 1000) } }] },
    orderBy: { created_at: 'asc' }, take: 200,
    include: { user: { select: { email: true, phone_number: true } } },
  });
  return rows.map((a) => ({
    id: a.id, amount: String(a.amount), wallet: a.wallet, claim_ref: a.claim_ref, status: a.status,
    reference: a.reference, detail: a.detail, created_at: a.created_at, updated_at: a.updated_at,
    account: a.user ? (a.user.email || a.user.phone_number) : null,
  }));
}
