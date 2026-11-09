// Read side for bug reports (operator console).
import { prisma } from '../db/prisma.js';
import { STATUSES } from '../domain/bugReport.js';

export async function listBugs({ status, order = 'desc' } = {}) {
  const where = STATUSES.includes(status) ? { status } : {};
  const rows = await prisma.bugReport.findMany({
    where, orderBy: { created_at: order === 'asc' ? 'asc' : 'desc' }, take: 200,
    select: { id: true, title: true, status: true, app: true, created_at: true, updated_at: true, user_id: true, reporter_email: true },
  });
  const counts = await prisma.bugReport.groupBy({ by: ['status'], _count: { _all: true } });
  return { bugs: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

export async function getBug(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return prisma.bugReport.findUnique({ where: { id: n } });
}
