// Customer suggestions for the catalog (CLAUDE.md, Catalog): a customer sends the name and a
// photo of something they want to buy; an OPERATOR reviews it (forward to the admins, or
// reject); an ADMIN prices and publishes it as a catalog item with that photo. Prices stay an
// admin decision, audited like every catalog edit.
//
// A rejected suggestion loses its photo at once: a picture we won't use is only something to
// leak. The row stays (name, decision, who) as the record of the decision.
import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { putObject, deleteObject } from '../storage/objectStore.js';
import { checkPublicImage } from '../domain/images.js';
import { audit } from './audit.js';
import { createEntry, CatalogError } from './catalog.js';
import { notifyAfter } from './push.js';

export class SubmissionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const SERVICES = ['food', 'grocery', 'pharmacy', 'water', 'shop'];
export const MAX_OPEN_PER_CUSTOMER = 5;

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function createSubmission({ userId, name, note, service }) {
  const n = clean(name, 80);
  if (n.length < 2) throw new SubmissionError('name the item');
  const svc = SERVICES.includes(service) ? service : null;
  const open = await prisma.catalogSubmission.count({ where: { user_id: userId, status: { in: ['new', 'forwarded'] } } });
  if (open >= MAX_OPEN_PER_CUSTOMER) throw new SubmissionError('you have 5 suggestions waiting — wait for those first', 429);
  const row = await prisma.catalogSubmission.create({
    data: { user_id: userId, name: n, note: clean(note, 300) || null, service: svc },
  });
  return shapeForCustomer(row);
}

// The photo, while the suggestion is still new. The key has a random part: guessing one
// can't fetch anyone's picture, and a re-upload replaces the old object.
export async function attachSubmissionPhoto({ id, userId, bytes }) {
  const kind = checkPublicImage(bytes);
  if (kind.error) throw new SubmissionError(kind.error);
  const row = await prisma.catalogSubmission.findUnique({ where: { id: Number(id) || 0 } });
  if (!row || row.user_id !== userId) throw new SubmissionError('not found', 404);
  if (row.status !== 'new') throw new SubmissionError('this suggestion has already been reviewed', 409);
  const key = `submissions/${row.id}/${randomBytes(8).toString('hex')}.${kind.ext}`;
  await putObject(key, bytes, kind.type);
  await prisma.catalogSubmission.update({ where: { id: row.id }, data: { photo_key: key } });
  if (row.photo_key) deleteObject(row.photo_key).catch((err) => console.warn(`[submissions] old photo ${row.id}: ${err.message}`));
  if (!row.photo_key) {
    notifyAfter([{ to: { role: 'operator' }, kind: 'op_submission', url: '/operator/', tag: `sub-${row.id}` }]);
  }
  return { ok: true };
}

export function shapeForCustomer(r) {
  return {
    id: r.id, name: r.name, note: r.note, service: r.service, has_photo: Boolean(r.photo_key),
    status: r.status, review_note: r.status === 'rejected' ? r.review_note : null,
    published_item_id: r.published_item_id, created_at: r.created_at,
  };
}

export async function mySubmissions(userId) {
  const rows = await prisma.catalogSubmission.findMany({ where: { user_id: userId }, orderBy: { id: 'desc' }, take: 20 });
  return rows.map(shapeForCustomer);
}

// Operators: the queue. No customer contact details — the suggestion is about an item.
export async function listSubmissions() {
  const rows = await prisma.catalogSubmission.findMany({
    where: { OR: [{ status: { in: ['new', 'forwarded'] } }, { reviewed_at: { gte: new Date(Date.now() - 14 * 86400 * 1000) } }] },
    orderBy: [{ created_at: 'asc' }], take: 200,
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, note: r.note, service: r.service, has_photo: Boolean(r.photo_key), status: r.status,
    review_note: r.review_note, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at,
    published_item_id: r.published_item_id, published_by: r.published_by, created_at: r.created_at,
  }));
}

export async function submissionPhotoKey(id) {
  const row = await prisma.catalogSubmission.findUnique({ where: { id: Number(id) || 0 }, select: { photo_key: true } });
  return row?.photo_key || null;
}

async function lockOpen(tx, id) {
  const rows = await tx.$queryRaw`SELECT * FROM catalog_submissions WHERE id = ${Number(id) || 0} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new SubmissionError('not found', 404);
  if (!['new', 'forwarded'].includes(row.status)) throw new SubmissionError(`already ${row.status}`, 409);
  return row;
}

// Operator: forward to the admins, or reject (with a reason the customer is shown).
export async function reviewSubmission({ id, decision, note, actor }) {
  if (!['forward', 'reject'].includes(decision)) throw new SubmissionError('forward or reject');
  const why = clean(note, 300);
  if (decision === 'reject' && !why) throw new SubmissionError('say why — the customer is told');
  const row = await prisma.$transaction(async (tx) => {
    const sub = await lockOpen(tx, id);
    if (decision === 'forward' && sub.status === 'forwarded') throw new SubmissionError('already forwarded', 409);
    const done = await tx.catalogSubmission.update({
      where: { id: sub.id },
      data: {
        status: decision === 'forward' ? 'forwarded' : 'rejected',
        review_note: why || null, reviewed_by: actor, reviewed_at: new Date(),
        ...(decision === 'reject' ? { photo_key: null } : {}),
      },
    });
    await audit({ actor, action: `catalog.submission.${decision === 'forward' ? 'forwarded' : 'rejected'}`, subject: `submission:${sub.id}`, detail: { name: sub.name, note: why || null } }, { client: tx });
    return { done, oldKey: sub.photo_key };
  });
  if (decision === 'reject' && row.oldKey) {
    deleteObject(row.oldKey).catch((err) => console.warn(`[submissions] delete ${id}: ${err.message}`));
  }
  if (decision === 'forward') {
    notifyAfter([{ to: { role: 'operator', admins: true }, kind: 'op_submission', url: '/operator/', tag: `sub-${id}` }]);
  } else {
    notifyAfter([{ to: { role: 'customer', id: row.done.user_id }, kind: 'submission_rejected', url: '/?inbox=1', tag: `sub-${id}` }]);
  }
  return row.done;
}

// Admin: price it and put it in the catalog with the customer's photo.
export async function publishSubmission({ id, item, actor }) {
  const sub = await prisma.catalogSubmission.findUnique({ where: { id: Number(id) || 0 } });
  if (!sub) throw new SubmissionError('not found', 404);
  if (!['new', 'forwarded'].includes(sub.status)) throw new SubmissionError(`already ${sub.status}`, 409);
  if (!sub.photo_key) throw new SubmissionError('this suggestion has no photo');
  let created;
  try {
    created = await createEntry('item', { ...item, image: `obj/${sub.photo_key}` }, actor, { allowObjectImage: true });
  } catch (err) {
    if (err instanceof CatalogError) throw new SubmissionError(err.message, err.status);
    throw err;
  }
  const res = await prisma.catalogSubmission.updateMany({
    where: { id: sub.id, status: { in: ['new', 'forwarded'] } },
    data: { status: 'published', published_item_id: created.id, published_by: actor, published_at: new Date(), reviewed_by: sub.reviewed_by || actor, reviewed_at: sub.reviewed_at || new Date() },
  });
  if (!res.count) throw new SubmissionError('decided by someone else meanwhile', 409);
  await audit({ actor, action: 'catalog.submission.published', subject: `submission:${sub.id}`, detail: { itemId: created.id } });
  notifyAfter([{ to: { role: 'customer', id: sub.user_id }, kind: 'submission_live', url: '/?inbox=1', tag: `sub-${sub.id}` }]);
  return created;
}
