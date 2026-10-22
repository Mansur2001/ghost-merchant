// One photo per (order, kind): a re-upload in another format must replace the old copy, not
// sit beside it. The object key carries the extension, so the upsert alone can't see it.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let staleRows = [];
const prisma = {
  orderPhoto: {
    upsert: jest.fn(async ({ create }) => ({ id: 9n, ...create })),
    findMany: jest.fn(async () => staleRows),
    delete: jest.fn(async () => ({})),
  },
};
const putObject = jest.fn(async () => {});
const deleteObject = jest.fn(async () => {});

jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma }));
jest.unstable_mockModule('../src/storage/objectStore.js', () => ({ putObject, deleteObject }));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ postMessage: jest.fn(async () => ({})) }));

const { savePhoto } = await import('../src/commands/photos.js');

const ORDER = '11111111-1111-1111-1111-111111111111';
const upload = (contentType) =>
  savePhoto({ orderId: ORDER, kind: 'delivery_proof', bytes: Buffer.from('x'), contentType, uploadedBy: 'driver:1' });

beforeEach(() => {
  staleRows = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  [putObject, deleteObject, prisma.orderPhoto.findMany, prisma.orderPhoto.delete].forEach((f) => f.mockClear());
});

describe('savePhoto', () => {
  test('a PNG replacing a JPEG removes the JPEG object and its row', async () => {
    staleRows = [{ id: 3n, object_key: `orders/${ORDER}/delivery_proof.jpg` }];
    await upload('image/png');
    expect(putObject).toHaveBeenCalledWith(`orders/${ORDER}/delivery_proof.png`, expect.any(Buffer), 'image/png');
    expect(prisma.orderPhoto.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { order_id: ORDER, kind: 'delivery_proof', NOT: { object_key: `orders/${ORDER}/delivery_proof.png` } },
    }));
    expect(deleteObject).toHaveBeenCalledWith(`orders/${ORDER}/delivery_proof.jpg`);
    expect(prisma.orderPhoto.delete).toHaveBeenCalledWith({ where: { id: 3n } });
  });

  test('same format again: nothing to remove', async () => {
    await upload('image/jpeg');
    expect(deleteObject).not.toHaveBeenCalled();
    expect(prisma.orderPhoto.delete).not.toHaveBeenCalled();
  });

  test('if the old object cannot be deleted, its row stays so the next upload retries', async () => {
    staleRows = [{ id: 3n, object_key: `orders/${ORDER}/delivery_proof.jpg` }];
    deleteObject.mockRejectedValueOnce(new Error('minio down'));
    const photo = await upload('image/png');
    expect(photo.object_key).toBe(`orders/${ORDER}/delivery_proof.png`);
    expect(prisma.orderPhoto.delete).not.toHaveBeenCalled();
  });
});
