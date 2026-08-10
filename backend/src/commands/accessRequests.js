// Requests to be given an operator or driver account.
//
// THE SECURITY POINT, stated once so nobody 'improves' it later: submitting this form creates
// NOTHING. It records that a person asked. An existing operator reviews it and, if they know
// who this is, creates the account — which is a separate, authenticated action.
//
// Self-serve registration would be a catastrophe here: an operator account reads every
// customer's phone number, home landmark, chat and delivery photos, and a driver account
// takes real money and goods. The gate has to be a human who recognises the applicant.
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import { putObject, deleteObject } from '../storage/objectStore.js';

export class AccessRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ROLES = new Set(['driver', 'operator']);

// Submit a request. Public endpoint — treat every field as hostile.
export async function submitAccessRequest({ role, name, phone, message }) {
  if (!ROLES.has(role)) throw new AccessRequestError('choose driver or operator');

  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) throw new AccessRequestError('please give your name');
  if (cleanName.length > 80) throw new AccessRequestError('that name is too long');

  // Same validation as everywhere else: the number is how we call you back, so it has to be
  // a real one. Throws with a readable reason for an unusable number.
  let e164;
  try {
    e164 = normalizeMsisdnOrThrow(phone);
  } catch (err) {
    throw new AccessRequestError(err.message);
  }

  const cleanMessage = message ? String(message).trim().slice(0, 1000) : null;

  // One open request per person per role. Re-submitting updates the message rather than
  // stacking duplicates in the reviewer's queue — someone who fills the form twice because
  // they weren't sure it worked shouldn't look like two applicants.
  const existing = await prisma.accessRequest.findFirst({
    where: { phone: e164, role, status: { in: ['new', 'contacted'] } },
  });
  if (existing) {
    await prisma.accessRequest.update({
      where: { id: existing.id },
      data: { name: cleanName, message: cleanMessage },
    });
    return { id: existing.id, resubmitted: true };
  }

  const created = await prisma.accessRequest.create({
    data: { role, name: cleanName, phone: e164, message: cleanMessage },
    select: { id: true },
  });
  return { id: created.id, resubmitted: false };
}

// Attach the ID document for a request.
//
// The bytes go to object storage and only the key is kept in the row. The key includes a
// random component so it is not guessable from the request id — object storage is not the
// authorization boundary, but a guessable key is one accident away from being one.
const ID_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
const MAX_ID_BYTES = 6 * 1024 * 1024;

export async function attachIdDocument({ requestId, bytes, contentType }) {
  if (!bytes || !bytes.length) throw new AccessRequestError('no image received');
  if (bytes.length > MAX_ID_BYTES) throw new AccessRequestError('image is too large (max 6MB)');
  const ext = ID_MIME[String(contentType || '').toLowerCase()];
  // An allow-list, not a block-list: this is an image, and accepting arbitrary content types
  // means accepting whatever an attacker names it.
  if (!ext) throw new AccessRequestError('send a JPEG, PNG, WebP or HEIC image');

  const request = await prisma.accessRequest.findUnique({ where: { id: BigInt(requestId) } });
  if (!request) throw new AccessRequestError('request not found', 404);
  if (['approved', 'declined'].includes(request.status)) {
    throw new AccessRequestError('this request has already been decided', 409);
  }

  const key = `id-documents/${requestId}-${crypto.randomUUID()}.${ext}`;
  await putObject(key, bytes, contentType);

  // Replacing an earlier upload destroys the old object rather than orphaning it — copies of
  // someone's passport accumulating in a bucket is exactly the liability we are avoiding.
  if (request.id_document_key) {
    await deleteObject(request.id_document_key).catch(() => {});
  }

  await prisma.accessRequest.update({
    where: { id: request.id },
    data: { id_document_key: key, id_document_at: new Date() },
  });
  return { ok: true };
}

// The reviewer's queue: open requests, oldest first.
export async function listAccessRequests({ includeClosed = false } = {}) {
  return prisma.accessRequest.findMany({
    where: includeClosed ? {} : { status: { in: ['new', 'contacted'] } },
    orderBy: { created_at: 'asc' },
    take: 200,
  });
}

export async function countOpenAccessRequests() {
  return prisma.accessRequest.count({ where: { status: 'new' } });
}

// Record the outcome of a review. Does NOT create an account — the operator does that
// explicitly through the existing "add driver" / "add operator" forms, because creating a
// credential should be a deliberate act with a password typed for it, not a side effect of
// clicking Approve on a list.
export async function reviewAccessRequest({ requestId, status, note, reviewedBy }) {
  if (!['contacted', 'approved', 'declined'].includes(status)) {
    throw new AccessRequestError('unknown review status');
  }
  try {
    const existing = await prisma.accessRequest.findUnique({ where: { id: BigInt(requestId) } });

    const updated = await prisma.accessRequest.update({
      where: { id: BigInt(requestId) },
      data: {
        status,
        reviewed_at: new Date(),
        reviewed_by: reviewedBy,
        review_note: note ? String(note).slice(0, 500) : null,
      },
    });

    // RETENTION: the ID existed to support THIS decision. Once it is made, destroy it.
    // Holding someone's government ID indefinitely serves no purpose and turns a routine
    // breach into identity theft. The row keeps `id_document_at` as proof it was checked.
    if (['approved', 'declined'].includes(status) && existing?.id_document_key) {
      await deleteObject(existing.id_document_key).catch((err) =>
        console.error('failed to delete ID document:', err.message)
      );
      await prisma.accessRequest.update({
        where: { id: updated.id },
        data: { id_document_key: null },
      });
    }

    return updated;
  } catch (err) {
    if (err.code === 'P2025') throw new AccessRequestError('request not found', 404);
    throw err;
  }
}
