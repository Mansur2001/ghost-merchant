// Push notifications: the right person, the right words, nothing private on a lock screen.
import { describe, test, expect } from '@jest/globals';
import { targetsFor, textFor, TEXT } from '../src/domain/push.js';
import { parsePush } from '../src/domain/pushSettings.js';

const order = { id: 'o1', user_id: 7, driver_id: 3n, kind: 'DELIVERY', status: 'DISPATCHED' };
const ride = { ...order, kind: 'RIDE' };
const ev = (name, payload) => ({ name, payload });

describe('who is told', () => {
  test('dispatched: the customer (words by job kind) and the assigned driver', () => {
    const t = targetsFor(ev('order.state_changed', { orderId: 'o1', from: 'PAID_UNASSIGNED', to: 'DISPATCHED', actor: 'system:dispatch' }), order);
    expect(t).toEqual([
      expect.objectContaining({ to: { role: 'customer', id: 7 }, kind: 'dispatched', url: '/?order=o1', tag: 'order-o1' }),
      expect.objectContaining({ to: { role: 'driver', id: '3' }, kind: 'new_job', url: '/driver/?job=o1' }),
    ]);
    expect(targetsFor(ev('order.state_changed', { from: 'PAID_UNASSIGNED', to: 'DISPATCHED' }), ride).map((x) => x.kind)).toEqual(['dispatched_ride', 'new_ride']);
  });

  test('a driver releasing a job: the customer hears "finding another"; the driver is not told about their own act', () => {
    const t = targetsFor(ev('order.state_changed', { from: 'DISPATCHED', to: 'PAID_UNASSIGNED', actor: 'driver:3' }), { ...order, driver_id: null });
    expect(t.map((x) => [x.to.role, x.kind])).toEqual([['customer', 'released']]);
  });

  test('stopped by the office: the customer and the driver; stopped by the driver: only the customer', () => {
    const byOp = targetsFor(ev('order.state_changed', { from: 'IN_TRANSIT', to: 'FAILED_REFUND', actor: 'operator:1:hodan' }), order);
    expect(byOp.map((x) => x.kind)).toEqual(['failed', 'job_removed']);
    const byDriver = targetsFor(ev('order.state_changed', { from: 'IN_TRANSIT', to: 'FAILED_REFUND', actor: 'driver:3' }), order);
    expect(byDriver.map((x) => x.kind)).toEqual(['failed']);
  });

  test('messages: driver/operator -> customer; customer -> driver; system lines -> nobody', () => {
    const fromDriver = targetsFor(ev('message.posted', { orderId: 'o1', message: { sender: 'driver', body: 'at the gate' } }), order);
    expect(fromDriver.map((x) => x.to.role)).toEqual(['customer']);
    const fromUser = targetsFor(ev('message.posted', { orderId: 'o1', message: { sender: 'user', body: 'hi' } }), order);
    expect(fromUser.map((x) => x.to.role)).toEqual(['driver']);
    expect(targetsFor(ev('message.posted', { orderId: 'o1', message: { sender: 'system', body: 'x' } }), order)).toEqual([]);
  });

  test('operators: payment claims, disputes, unclear wallet payments', () => {
    expect(targetsFor(ev('payment.claimed', { orderId: 'o1' }), order)[0]).toMatchObject({ to: { role: 'operator', admins: false }, kind: 'op_claimed' });
    expect(targetsFor(ev('delivery.disputed', { orderId: 'o1' }), order)[0].kind).toBe('op_disputed');
    expect(targetsFor(ev('payment.attempt', { orderId: 'o1', status: 'unknown' }), order)[0].kind).toBe('op_pay_unknown');
    expect(targetsFor(ev('payment.attempt', { orderId: 'o1', status: 'declined' }), order)[0]).toMatchObject({ to: { role: 'customer' }, kind: 'pay_declined' });
  });
});

describe('what is said', () => {
  test('every notification exists in English and Somali', () => {
    expect(Object.keys(TEXT.so).sort()).toEqual(Object.keys(TEXT.en).sort());
    expect(textFor('dispatched_ride', 'so').title).toBe('Darawalku waa soo socdaa');
    expect(textFor('nonexistent')).toBeNull();
  });

  test('nothing private: no digits (codes, amounts, phones) and no message words on a lock screen', () => {
    for (const lang of ['en', 'so']) {
      for (const [title, body] of Object.values(TEXT[lang])) expect(`${title} ${body}`).not.toMatch(/\d/);
    }
  });
});

describe('settings', () => {
  test('both VAPID keys or neither; FCM needs a real service account', () => {
    expect(parsePush({}).webpush.enabled).toBe(false);
    expect(parsePush({ VAPID_PUBLIC_KEY: 'a' }).errors).toHaveLength(1);
    expect(parsePush({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', OWNER_EMAIL: 'o@x.com' }).webpush).toMatchObject({ enabled: true, subject: 'mailto:o@x.com' });
    expect(parsePush({ FCM_SERVICE_ACCOUNT: 'not json' }).errors[0]).toMatch(/FCM_SERVICE_ACCOUNT/);
    const sa = Buffer.from(JSON.stringify({ client_email: 'x@p.iam', private_key: 'k', project_id: 'p' })).toString('base64');
    expect(parsePush({ FCM_SERVICE_ACCOUNT: sa }).fcm.enabled).toBe(true);
  });
});
