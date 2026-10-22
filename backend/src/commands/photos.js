// CQRS write side for photos. Bytes go to MinIO; a metadata row goes to Postgres. Both
// keyed on a DETERMINISTIC object key per (order, kind) so the operation is idempotent:
// re-uploading a customer's reference photo overwrites the single stored object and upserts
// the single row — no duplicate copies of sensitive images accumulate (per the data rules).
import { prisma } from '../db/prisma.js';
import { putObject, deleteObject } from '../storage/objectStore.js';
import { postMessage } from './orders.js';

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
};

const NOTE = {
  order_ref: '📷 Customer added a reference photo.',
  delivery_proof: '📦 Driver added a delivery-proof photo.',
};

// Store (or replace) a photo for an order. `bytes` is a Buffer, `contentType` an image/* MIME.
export async function savePhoto({ orderId, kind, bytes, contentType, uploadedBy }) {
  if (!['order_ref', 'delivery_proof'].includes(kind)) throw new Error(`bad photo kind: ${kind}`);
  if (!bytes || !bytes.length) throw new Error('empty photo body');
  const ext = EXT[contentType] || 'bin';
  // One logical photo per (order, kind) → deterministic key → idempotent overwrite.
  const objectKey = `orders/${orderId}/${kind}.${ext}`;

  await putObject(objectKey, bytes, contentType || 'application/octet-stream');

  // object_key is a plain UNIQUE (not partial), so Prisma's upsert expresses this directly.
  const photo = await prisma.orderPhoto.upsert({
    where: { object_key: objectKey },
    update: {
      content_type: contentType || null,
      uploaded_by: uploadedBy || 'user',
      created_at: new Date(),
    },
    create: {
      order_id: orderId,
      kind,
      object_key: objectKey,
      content_type: contentType || null,
      uploaded_by: uploadedBy || 'user',
    },
  });

  // The key carries the extension, so a re-upload in another format (a JPEG replacing a PNG)
  // lands on a NEW key and the upsert can't see the old one. Remove those copies here, or the
  // order shows two photos and a stale image of someone's doorstep stays in storage. A row is
  // dropped only once its object is gone, so a failed delete stays on record and is retried
  // by the next upload instead of leaking an untracked object.
  const stale = await prisma.orderPhoto.findMany({
    where: { order_id: orderId, kind, NOT: { object_key: objectKey } },
    select: { id: true, object_key: true },
  });
  for (const old of stale) {
    try {
      await deleteObject(old.object_key);
      await prisma.orderPhoto.delete({ where: { id: old.id } });
    } catch (err) {
      console.error(`[photos] could not remove replaced ${kind} for order ${orderId}: ${err.message}`);
    }
  }

  // Drop a system line into the thread so every connected client sees the photo arrive live.
  await postMessage({ orderId, sender: 'system', body: NOTE[kind] });

  return photo;
}
