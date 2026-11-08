// Read side for wallet payments (commands/providerPayments.js writes them).
import { prisma } from '../db/prisma.js';
import { isUuid } from '../domain/ids.js';
import { snapshot } from '../commands/providerPayments.js';

// The latest wallet prompt on an order, so the pay screen can pick up where it was after a reload.
export async function latestAttempt(orderId) {
  if (!isUuid(orderId)) return null;
  const a = await prisma.paymentAttempt.findFirst({ where: { order_id: orderId }, orderBy: { created_at: 'desc' } });
  return a ? snapshot(a) : null;
}
