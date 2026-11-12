// The customer's notifications inbox (the bell). DERIVED from what already happened — order
// status changes, wallet movements, suggestion decisions — so there is no second copy of
// anyone's history to keep in step or to leak. The only thing stored is "read up to"
// (users.notifications_seen_at). Text is the app's job: this returns what happened, in codes.
import { prisma } from '../db/prisma.js';

const DAYS = 30;
const LIMIT = 40;

export async function getInbox(userId) {
  if (!Number.isInteger(userId)) throw new Error('userId required');
  const since = new Date(Date.now() - DAYS * 86400 * 1000);
  const [user, events, entries, subs] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { notifications_seen_at: true } }),
    prisma.orderEvent.findMany({
      where: { created_at: { gte: since }, order: { user_id: userId }, to_status: { not: 'PENDING_PAYMENT' } },
      orderBy: { created_at: 'desc' }, take: LIMIT,
      select: { id: true, to_status: true, from_status: true, created_at: true, order: { select: { id: true, kind: true, total_amount: true, parent_order_id: true } } },
    }),
    prisma.walletEntry.findMany({
      where: { user_id: userId, created_at: { gte: since } }, orderBy: { id: 'desc' }, take: LIMIT,
      select: { id: true, kind: true, amount_cents: true, order_id: true, created_at: true },
    }),
    prisma.catalogSubmission.findMany({
      where: { user_id: userId, status: { in: ['published', 'rejected'] }, reviewed_at: { gte: since } },
      orderBy: { reviewed_at: 'desc' }, take: 10,
      select: { id: true, name: true, status: true, reviewed_at: true, published_at: true },
    }),
  ]);
  // Extra-work quotes: a visit's child order waiting for payment is something to act on.
  const quotes = await prisma.order.findMany({
    where: { user_id: userId, parent_order_id: { not: null }, created_at: { gte: since } },
    orderBy: { created_at: 'desc' }, take: 10,
    select: { id: true, parent_order_id: true, total_amount: true, created_at: true, status: true },
  });
  const items = [
    ...events.map((e) => ({
      id: `e${e.id}`, at: e.created_at, type: 'order', status: e.to_status, from: e.from_status,
      order_id: e.order.id, order_kind: e.order.kind, amount: String(e.order.total_amount),
    })),
    ...entries.map((w) => ({
      id: `w${w.id}`, at: w.created_at, type: 'wallet', kind: w.kind,
      amount: (Number(w.amount_cents) / 100).toFixed(2), order_id: w.order_id,
    })),
    ...subs.map((s) => ({ id: `s${s.id}`, at: s.published_at || s.reviewed_at, type: 'submission', status: s.status, name: s.name })),
    ...quotes.map((q) => ({ id: `q${q.id}`, at: q.created_at, type: 'quote', order_id: q.parent_order_id, extra_id: q.id, amount: String(q.total_amount), status: q.status })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, LIMIT);
  const seen = user?.notifications_seen_at ? user.notifications_seen_at.getTime() : 0;
  return { items, unread: items.filter((i) => new Date(i.at).getTime() > seen).length, seen_at: user?.notifications_seen_at ?? null };
}

export async function markInboxSeen(userId) {
  await prisma.user.update({ where: { id: userId }, data: { notifications_seen_at: new Date() } });
}
