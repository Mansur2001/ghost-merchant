// Filing and triaging bug reports (domain/bugReport.js has the rules).
import { prisma } from '../db/prisma.js';
import { validateBug, validateTriage, BugError, CLOSED_RETENTION_DAYS } from '../domain/bugReport.js';
import { isUuid } from '../domain/ids.js';
import { audit } from './audit.js';
import { notifyAfter } from './push.js';

// `userId` comes from the session (null when signed out). An `orderId` is kept only if that
// order is the reporter's own — anything else is silently dropped, never revealed.
export async function fileBug({ body, userId = null, userAgent = '' }) {
  const data = validateBug(body);
  let orderId = null;
  if (userId != null && isUuid(body?.orderId)) {
    const o = await prisma.order.findUnique({ where: { id: body.orderId }, select: { user_id: true } });
    if (o && o.user_id === userId) orderId = body.orderId;
  }
  const bug = await prisma.bugReport.create({
    data: {
      ...data,
      user_id: userId,
      order_id: orderId,
      user_agent: String(userAgent || '').slice(0, 200) || null,
    },
  });
  notifyAfter([{ to: { role: 'operator', admins: false }, kind: 'op_bug', url: `/operator/?bug=${bug.id}`, tag: `bug-${bug.id}` }]);
  return { id: bug.id, status: bug.status, createdAt: bug.created_at };
}

export async function triageBug({ id, body, actor }) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new BugError('not found', null, 404);
  const change = validateTriage(body);
  const before = await prisma.bugReport.findUnique({ where: { id: n } });
  if (!before) throw new BugError('not found', null, 404);
  const closing = change.status && ['resolved', 'closed'].includes(change.status);
  const bug = await prisma.bugReport.update({
    where: { id: n },
    data: {
      ...change,
      updated_by: actor,
      updated_at: new Date(),
      ...(change.status ? { closed_at: closing ? (before.closed_at || new Date()) : null } : {}),
    },
  });
  await audit({
    actor, action: 'bug.triaged', subject: `bug:${n}`,
    detail: { from: before.status, to: bug.status, note: change.triage_note !== undefined ? Boolean(change.triage_note) : undefined },
  });
  return bug;
}

// What was typed in a fixed bug isn't kept forever.
export async function sweepClosedBugs(now = Date.now()) {
  const r = await prisma.bugReport.deleteMany({
    where: { status: { in: ['resolved', 'closed'] }, closed_at: { lt: new Date(now - CLOSED_RETENTION_DAYS * 86400000) } },
  });
  return r.count;
}
