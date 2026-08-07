// CQRS write side for photos. Bytes go to MinIO; a metadata row goes to Postgres. Both
// keyed on a DETERMINISTIC object key per (order, kind) so the operation is idempotent:
// re-uploading a customer's reference photo overwrites the single stored object and upserts
// the single row — no duplicate copies of sensitive images accumulate (per the data rules).
import { query } from '../db/pool.js';
import { putObject } from '../storage/objectStore.js';
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

  const { rows } = await query(
    `INSERT INTO order_photos(order_id, kind, object_key, content_type, uploaded_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (object_key)
       DO UPDATE SET content_type = EXCLUDED.content_type,
                     uploaded_by  = EXCLUDED.uploaded_by,
                     created_at   = now()
     RETURNING *`,
    [orderId, kind, objectKey, contentType || null, uploadedBy || 'user']
  );

  // Drop a system line into the thread so every connected client sees the photo arrive live.
  await postMessage({ orderId, sender: 'system', body: NOTE[kind] });

  return rows[0];
}
