// The authorization rule is the thing standing between a stranger and a customer's phone
// number, home landmark, chat and photos. It gets exhaustive tests, including the
// null-vs-null cases that are how "undefined === undefined" becomes a data breach.
import { canAccessOrder, senderForRole } from '../src/domain/access.js';

const ORDER = { id: 7, user_phone: '+252612345678', driver_id: 3 };

describe('canAccessOrder', () => {
  test('operator sees every order', () => {
    expect(canAccessOrder({ role: 'operator', id: 'super' }, ORDER)).toBe(true);
    expect(canAccessOrder({ role: 'operator', id: 'super' }, { id: 1 })).toBe(true);
  });

  test('customer sees only their own order', () => {
    expect(canAccessOrder({ role: 'customer', phone: '+252612345678' }, ORDER)).toBe(true);
    expect(canAccessOrder({ role: 'customer', phone: '+252619999999' }, ORDER)).toBe(false);
  });

  test('driver sees only orders assigned to them', () => {
    expect(canAccessOrder({ role: 'driver', id: 3 }, ORDER)).toBe(true);
    expect(canAccessOrder({ role: 'driver', id: 4 }, ORDER)).toBe(false);
  });

  test('driver id compares across string/number representations', () => {
    // pg returns BIGINT as a string in some driver configurations; a strict === on mixed
    // types would silently deny every driver.
    expect(canAccessOrder({ role: 'driver', id: '3' }, ORDER)).toBe(true);
    expect(canAccessOrder({ role: 'driver', id: 3 }, { ...ORDER, driver_id: '3' })).toBe(true);
  });

  test('unassigned order is invisible to every driver', () => {
    const unassigned = { ...ORDER, driver_id: null };
    expect(canAccessOrder({ role: 'driver', id: 3 }, unassigned)).toBe(false);
  });

  test('null claims never match null order fields', () => {
    expect(canAccessOrder({ role: 'customer', phone: null }, { user_phone: null })).toBe(false);
    expect(canAccessOrder({ role: 'customer' }, { user_phone: undefined })).toBe(false);
    expect(canAccessOrder({ role: 'driver', id: null }, { driver_id: null })).toBe(false);
    expect(canAccessOrder({ role: 'driver' }, { driver_id: undefined })).toBe(false);
  });

  test('unknown or missing role is denied', () => {
    expect(canAccessOrder({ role: 'admin' }, ORDER)).toBe(false);
    expect(canAccessOrder({}, ORDER)).toBe(false);
    expect(canAccessOrder(null, ORDER)).toBe(false);
    expect(canAccessOrder({ role: 'customer', phone: '+252612345678' }, null)).toBe(false);
  });

  test('a driver id of 0 is not treated as absent', () => {
    // `id != null` rather than a truthiness check — driver 0 would otherwise be denied.
    expect(canAccessOrder({ role: 'driver', id: 0 }, { driver_id: 0 })).toBe(true);
  });
});

describe('senderForRole', () => {
  test('maps roles to chat senders', () => {
    expect(senderForRole('customer')).toBe('user');
    expect(senderForRole('driver')).toBe('driver');
    expect(senderForRole('operator')).toBe('operator');
  });

  test('never yields a privileged sender for an unknown role', () => {
    // A client must not be able to post a message that renders as a system announcement.
    expect(senderForRole('system')).toBeNull();
    expect(senderForRole(undefined)).toBeNull();
  });
});
