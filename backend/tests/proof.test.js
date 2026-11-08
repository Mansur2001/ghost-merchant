// Proof of delivery: a driver's steps need evidence the server checks, not a button.
//   * pickup needs the photo of the items;
//   * delivery needs the customer's code, or a door photo + reason (flagged for review);
//   * a wrong code counts — and the count must COMMIT, or "5 tries" means unlimited tries;
//   * the evidence row is written with the transition, never without it.
// The DB transaction and downstream modules are mocked so these branches run without Postgres.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const transitionOrder = jest.fn(async (id, to) => ({ id, status: to }));
const wakeOutbox = jest.fn();

let orderRow = null;
let handoff = null;
let photos = [];
let deliveryProof = null;
// A real transaction would roll these back on a throw; record what was written only when the
// callback RETURNS, to model commit-on-return.
let committed = [];
const tx = {
  $queryRaw: jest.fn(async (strings) =>
    strings.join('').includes('delivery_handoffs') ? (handoff ? [handoff] : []) : orderRow ? [orderRow] : []),
  orderPhoto: { findFirst: jest.fn(async ({ where }) => (photos.includes(where.kind) ? { id: 1n } : null)) },
  orderProof: {
    findUnique: jest.fn(async () => deliveryProof),
    update: jest.fn(async ({ data }) => data),
    create: jest.fn(async ({ data }) => data),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  deliveryHandoff: { update: jest.fn(async ({ data }) => data) },
};
const runTx = async (fn) => {
  const pending = [];
  const track = (f) => async (...a) => { pending.push([f, a]); return f(...a); };
  const scoped = {
    ...tx,
    orderProof: { ...tx.orderProof, create: track(tx.orderProof.create) },
    deliveryHandoff: { update: track(tx.deliveryHandoff.update) },
  };
  const out = await fn(scoped); // a throw here discards `pending`, like ROLLBACK
  committed.push(...pending);
  return out;
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: tx,
  withTransaction: runTx,
  withCriticalTransaction: runTx,
}));
const postMessage = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ transitionOrder, postMessage }));
const enqueue = jest.fn();
jest.unstable_mockModule('../src/events/outbox.js', () => ({ wakeOutbox, enqueue }));

const { confirmPickup, confirmDelivery, disputeDelivery, ProofError } = await import('../src/commands/proofs.js');
const proof = await import('../src/domain/proof.js');

const ORDER = '9110aafa-fd8f-4469-8592-4d5f944952e3';
const PIN = { lat: 2.0469, lng: 45.3182 };
const AT_DOOR = { lat: 2.0471, lng: 45.3183, accuracy: 12 };
const actor = 'driver:1';

beforeEach(() => {
  orderRow = { id: ORDER, status: 'DISPATCHED', ...PIN };
  handoff = { code: '4821', attempts: 0 };
  photos = [];
  deliveryProof = null;
  committed = [];
  tx.orderProof.update.mockClear();
  postMessage.mockClear();
  [transitionOrder, wakeOutbox, tx.$queryRaw, tx.orderProof.create, tx.deliveryHandoff.update].forEach((f) => f.mockClear());
});

const writes = (mock) => committed.filter(([f]) => f === mock).map(([, a]) => a[0].data);

describe('domain/proof', () => {
  test('handoff codes are 4 digits, zero-padded, and vary', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      const c = proof.newHandoffCode();
      expect(c).toMatch(/^\d{4}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(250);
  });

  test('handoffMatches only on the exact 4 digits', () => {
    expect(proof.handoffMatches('0042', '0042')).toBe(true);
    expect(proof.handoffMatches('0042', '42')).toBe(false);
    expect(proof.handoffMatches('0042', '0043')).toBe(false);
    expect(proof.handoffMatches('0042', undefined)).toBe(false);
  });

  test('a malformed GPS fix is dropped, not trusted', () => {
    expect(proof.parseFix({ lat: 'x', lng: 1 })).toBeNull();
    expect(proof.parseFix({ lat: 91, lng: 1 })).toBeNull();
    expect(proof.parseFix(null)).toBeNull();
    expect(proof.parseFix({ lat: '2.04', lng: '45.3', accuracy: -1 })).toEqual({ lat: 2.04, lng: 45.3, accuracy: null });
  });

  test('distance is right at city scale', () => {
    // ~111 m per 0.001° of latitude.
    expect(proof.distanceMeters({ lat: 2, lng: 45 }, { lat: 2.001, lng: 45 })).toBeGreaterThan(105);
    expect(proof.distanceMeters({ lat: 2, lng: 45 }, { lat: 2.001, lng: 45 })).toBeLessThan(117);
  });

  test('a code delivery at the door needs no review', () => {
    const p = proof.buildProof({ step: 'delivery', method: 'code', fix: AT_DOOR, order: PIN });
    expect(p.flags).toEqual([]);
    expect(p.distance_m).toBeLessThan(50);
  });

  test('no code, no GPS, or far from the pin: flagged for an operator', () => {
    expect(proof.buildProof({ step: 'delivery', method: 'photo_no_code', fix: AT_DOOR, order: PIN }).flags)
      .toEqual(['no_code']);
    expect(proof.buildProof({ step: 'delivery', method: 'code', fix: null, order: PIN }).flags)
      .toEqual(['no_gps']);
    const far = { lat: PIN.lat + 0.01, lng: PIN.lng, accuracy: 10 };
    expect(proof.buildProof({ step: 'delivery', method: 'code', fix: far, order: PIN }).flags)
      .toEqual(['far_from_pin']);
  });

  test('no pin on the order: distance is unknown, not a flag', () => {
    const p = proof.buildProof({ step: 'delivery', method: 'code', fix: AT_DOOR, order: { lat: null, lng: null } });
    expect(p.distance_m).toBeNull();
    expect(p.flags).toEqual([]);
  });
});

describe('confirmPickup', () => {
  test('refused without the photo of the items — and nothing is written', async () => {
    await expect(confirmPickup({ orderId: ORDER, actor })).rejects.toThrow('photo of the items');
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  test('with the photo: proof row and transition, together', async () => {
    photos = ['pickup_proof'];
    await confirmPickup({ orderId: ORDER, actor, fix: AT_DOOR });
    expect(writes(tx.orderProof.create)[0]).toMatchObject({ step: 'pickup', method: 'photo', actor });
    expect(transitionOrder).toHaveBeenCalledWith(ORDER, 'IN_TRANSIT', actor, expect.any(String), expect.objectContaining({ client: expect.anything() }));
    expect(wakeOutbox).toHaveBeenCalled();
  });

  test('only from DISPATCHED', async () => {
    photos = ['pickup_proof'];
    orderRow.status = 'IN_TRANSIT';
    await expect(confirmPickup({ orderId: ORDER, actor })).rejects.toBeInstanceOf(ProofError);
  });
});

describe('confirmDelivery', () => {
  beforeEach(() => { orderRow.status = 'IN_TRANSIT'; });

  test('the right code delivers it, marks the code used, and records the proof', async () => {
    await confirmDelivery({ orderId: ORDER, actor, code: '4821', fix: AT_DOOR });
    expect(writes(tx.deliveryHandoff.update)[0]).toHaveProperty('verified_at');
    expect(writes(tx.orderProof.create)[0]).toMatchObject({ step: 'delivery', method: 'code', flags: [] });
    expect(transitionOrder).toHaveBeenCalledWith(ORDER, 'DELIVERED', actor, expect.any(String), expect.anything());
  });

  test('a wrong code is refused, says what is left, and the attempt COMMITS', async () => {
    const err = await confirmDelivery({ orderId: ORDER, actor, code: '1111' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProofError);
    expect(err.extra.triesLeft).toBe(4);
    expect(writes(tx.deliveryHandoff.update)[0]).toEqual({ attempts: { increment: 1 } });
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(writes(tx.orderProof.create)).toEqual([]);
  });

  test('after 5 wrong codes even the right one is refused: use the photo path', async () => {
    handoff.attempts = proof.HANDOFF_MAX_ATTEMPTS;
    const err = await confirmDelivery({ orderId: ORDER, actor, code: '4821' }).catch((e) => e);
    expect(err.status).toBe(423);
    expect(transitionOrder).not.toHaveBeenCalled();
  });

  test('without a code: needs a reason AND the door photo, and is flagged', async () => {
    await expect(confirmDelivery({ orderId: ORDER, actor })).rejects.toThrow(/code/);
    await expect(confirmDelivery({ orderId: ORDER, actor, noCodeReason: 'phone is dead' })).rejects.toThrow('photo');
    photos = ['delivery_proof'];
    await confirmDelivery({ orderId: ORDER, actor, noCodeReason: 'phone is dead', fix: AT_DOOR });
    expect(writes(tx.orderProof.create)[0]).toMatchObject({ method: 'photo_no_code', flags: ['no_code'], note: 'phone is dead' });
  });

  test('only from IN_TRANSIT', async () => {
    orderRow.status = 'DISPATCHED';
    await expect(confirmDelivery({ orderId: ORDER, actor, code: '4821' })).rejects.toThrow('not out for delivery');
  });

  test('a code that is not 4 digits never reaches the database', async () => {
    await expect(confirmDelivery({ orderId: ORDER, actor, code: '12345' })).rejects.toThrow('4 digits');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('disputeDelivery (customer: "I didn\'t get my order")', () => {
  test('puts a checked delivery back in the review queue and tells the thread', async () => {
    deliveryProof = { id: 7n, flags: [], created_at: new Date(), reviewed_at: new Date() };
    await disputeDelivery({ orderId: ORDER, note: 'nobody came' });
    // Operators are told (push), in the same transaction as the flag.
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), 'delivery.disputed', { orderId: ORDER });
    expect(tx.orderProof.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { flags: { push: 'customer_disputed' }, reviewed_at: null, reviewed_by: null },
    }));
    expect(postMessage.mock.calls[0][0].body).toContain('nobody came');
    expect(transitionOrder).not.toHaveBeenCalled();
  });

  test('twice is once', async () => {
    deliveryProof = { id: 7n, flags: ['customer_disputed'], created_at: new Date() };
    await disputeDelivery({ orderId: ORDER });
    expect(tx.orderProof.update).not.toHaveBeenCalled();
  });

  test('only for a delivered order, and only within the window', async () => {
    await expect(disputeDelivery({ orderId: ORDER })).rejects.toThrow('not been delivered');
    deliveryProof = { id: 7n, flags: [], created_at: new Date(Date.now() - (proof.DISPUTE_WINDOW_HOURS + 1) * 3600e3) };
    await expect(disputeDelivery({ orderId: ORDER })).rejects.toThrow('too late');
  });
});
