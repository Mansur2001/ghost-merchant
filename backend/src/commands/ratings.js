// A customer rates a finished job: 1–5 stars and an optional line. One per order, only by its
// customer (the route is customerOnly + requireOrderAccess), only once it is DELIVERED and had
// a driver. Audited, because a rating is what the next customer chooses a driver by.
import { prisma } from '../db/prisma.js';
import { audit } from './audit.js';

export class RatingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const RATE_WINDOW_DAYS = 14;

export async function rateOrder({ orderId, userId, stars, comment }) {
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new RatingError('choose 1 to 5 stars');
  const text = typeof comment === 'string' ? comment.trim().slice(0, 300) : '';
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, driver_id: true, updated_at: true, user_id: true } });
  if (!order || order.user_id !== userId) throw new RatingError('not found', 404);
  if (order.status !== 'DELIVERED' || order.driver_id == null) throw new RatingError('you can rate a job once it is finished', 409);
  if (Date.now() - order.updated_at.getTime() > RATE_WINDOW_DAYS * 86400 * 1000) {
    throw new RatingError('it is too late to rate this job', 409);
  }
  try {
    const row = await prisma.rating.create({
      data: { order_id: orderId, user_id: userId, driver_id: order.driver_id, stars: n, comment: text || null },
    });
    await audit({ actor: `customer:${userId}`, action: 'order.rated', subject: `order:${orderId}`, detail: { driverId: String(order.driver_id), stars: n } });
    return row;
  } catch (err) {
    if (err?.code === 'P2002') throw new RatingError('you already rated this job', 409);
    throw err;
  }
}
