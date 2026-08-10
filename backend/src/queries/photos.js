// CQRS read side for photos. Metadata only — the bytes are streamed separately.
import { prisma } from '../db/prisma.js';

export async function listPhotos(orderId) {
  return prisma.orderPhoto.findMany({
    where: { order_id: orderId },
    select: {
      id: true, order_id: true, kind: true, object_key: true,
      content_type: true, uploaded_by: true, created_at: true,
    },
    orderBy: { created_at: 'asc' },
  });
}

export async function getPhoto(photoId) {
  // The id comes off the URL, so it is untrusted text against a BIGINT column.
  let key;
  try {
    key = BigInt(photoId);
  } catch {
    return null; // malformed id reads the same as "no such photo"
  }
  return prisma.orderPhoto.findUnique({
    where: { id: key },
    select: { id: true, order_id: true, kind: true, object_key: true, content_type: true },
  });
}
