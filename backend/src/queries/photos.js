// CQRS read side for photos. Metadata only — the bytes are streamed separately.
import { query } from '../db/pool.js';

export async function listPhotos(orderId) {
  const { rows } = await query(
    `SELECT id, order_id, kind, object_key, content_type, uploaded_by, created_at
       FROM order_photos WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rows;
}

export async function getPhoto(photoId) {
  const { rows } = await query(
    `SELECT id, order_id, kind, object_key, content_type FROM order_photos WHERE id = $1`,
    [photoId]
  );
  return rows[0] || null;
}
