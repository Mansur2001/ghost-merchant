// The state machine is invariant #1: the single source of truth for order status. These
// tests lock down every legal edge and prove that illegal transitions throw rather than
// silently corrupting an order — the whole point of routing writes through assertTransition.
import { describe, test, expect } from '@jest/globals';
import {
  STATUS,
  canTransition,
  assertTransition,
  AUTO_RESPONSES,
} from '../src/domain/stateMachine.js';

const LIVE = ['PENDING_PAYMENT', 'PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'];
const TERMINAL = ['DELIVERED', 'FAILED_REFUND'];

describe('legal forward transitions', () => {
  test.each([
    ['PENDING_PAYMENT', 'PAID_UNASSIGNED'],
    ['PAID_UNASSIGNED', 'DISPATCHED'],
    ['DISPATCHED', 'IN_TRANSIT'],
    ['IN_TRANSIT', 'DELIVERED'],
  ])('%s → %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });
});

describe('any live state can fail/refund', () => {
  test.each(LIVE)('%s → FAILED_REFUND is allowed', (from) => {
    expect(canTransition(from, 'FAILED_REFUND')).toBe(true);
  });
});

describe('terminal states are dead ends', () => {
  test.each(TERMINAL)('%s cannot transition anywhere', (from) => {
    for (const to of Object.keys(STATUS)) {
      expect(canTransition(from, to)).toBe(false);
    }
  });
});

describe('illegal transitions are rejected', () => {
  test('cannot skip payment (PENDING_PAYMENT → DISPATCHED)', () => {
    expect(canTransition('PENDING_PAYMENT', 'DISPATCHED')).toBe(false);
    expect(() => assertTransition('PENDING_PAYMENT', 'DISPATCHED')).toThrow(/Illegal transition/);
  });

  test('cannot go backwards (IN_TRANSIT → DISPATCHED)', () => {
    expect(() => assertTransition('IN_TRANSIT', 'DISPATCHED')).toThrow(/Illegal transition/);
  });

  test('cannot reopen a delivered order', () => {
    expect(() => assertTransition('DELIVERED', 'IN_TRANSIT')).toThrow(/Illegal transition/);
  });

  test('unknown target status throws a distinct error', () => {
    expect(() => assertTransition('PENDING_PAYMENT', 'NOT_A_STATE')).toThrow(/Unknown target status/);
  });

  test('unknown source status is simply not transitionable', () => {
    expect(canTransition('GARBAGE', 'DELIVERED')).toBe(false);
  });
});

describe('auto-responses', () => {
  test('every non-initial state has customer-facing copy', () => {
    for (const s of ['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED_REFUND']) {
      expect(typeof AUTO_RESPONSES[s]).toBe('string');
      expect(AUTO_RESPONSES[s].length).toBeGreaterThan(0);
    }
  });

  test('PENDING_PAYMENT has no auto-response (nothing has happened yet)', () => {
    expect(AUTO_RESPONSES.PENDING_PAYMENT).toBeUndefined();
  });
});
