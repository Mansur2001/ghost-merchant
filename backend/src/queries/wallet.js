// Read side for the customer wallet (commands/wallet.js writes it).
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';

const dollars = (c) => (Number(c) / 100).toFixed(2);

// The customer's own wallet: balance, recent movements, any open withdrawal, the last top-up.
export async function getWallet(userId, settings = config.wallet) {
  if (!Number.isInteger(userId)) throw new Error('userId required');
  const [acct, entries, withdrawals, topup] = await Promise.all([
    prisma.walletAccount.findUnique({ where: { user_id: userId } }),
    prisma.walletEntry.findMany({ where: { user_id: userId }, orderBy: { id: 'desc' }, take: 30 }),
    prisma.walletWithdrawal.findMany({ where: { user_id: userId }, orderBy: { id: 'desc' }, take: 5 }),
    prisma.paymentAttempt.findFirst({ where: { user_id: userId, purpose: 'topup' }, orderBy: { created_at: 'desc' } }),
  ]);
  return {
    enabled: settings.enabled,
    balance: dollars(acct?.balance_cents ?? 0),
    limits: {
      maxBalance: dollars(settings.maxBalanceCents),
      topupMin: dollars(settings.topupMinCents),
      topupMax: dollars(settings.topupMaxCents),
    },
    entries: entries.map((e) => ({
      id: String(e.id), kind: e.kind, amount: dollars(e.amount_cents), balance_after: dollars(e.balance_after_cents),
      order_id: e.order_id, created_at: e.created_at,
    })),
    withdrawals: withdrawals.map((w) => ({
      id: String(w.id), amount: dollars(w.amount_cents), status: w.status, note: w.note, created_at: w.created_at,
    })),
    lastTopup: topup ? { id: topup.id, status: topup.status, amount: String(topup.amount), wallet: topup.wallet, created_at: topup.created_at } : null,
  };
}

// Admin: withdrawals waiting to be paid, oldest first, with where to send the money.
export async function listWithdrawals() {
  const rows = await prisma.walletWithdrawal.findMany({
    where: { status: 'requested' }, orderBy: { created_at: 'asc' }, take: 200,
    include: { user: { select: { email: true, phone_number: true } } },
  });
  const recent = await prisma.walletWithdrawal.findMany({
    where: { status: { in: ['paid', 'rejected'] } }, orderBy: { decided_at: 'desc' }, take: 20,
  });
  const shape = (w) => ({
    id: String(w.id), amount: dollars(w.amount_cents), payout_phone: w.payout_phone, status: w.status,
    reference: w.reference, note: w.note, decided_by: w.decided_by, decided_at: w.decided_at, created_at: w.created_at,
    account: w.user ? (w.user.email || w.user.phone_number) : undefined,
  });
  return { open: rows.map(shape), recent: recent.map(shape) };
}
