// The order state machine — the single source of truth for legal transitions.
// Nothing else in the codebase may set orders.status directly; everything goes through
// assertTransition(). Illegal transitions throw. This is the one discipline that prevents
// "how did this order get into a weird state" bugs in a distributed SMS-based system.

export const STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID_UNASSIGNED: 'PAID_UNASSIGNED',
  DISPATCHED: 'DISPATCHED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  FAILED_REFUND: 'FAILED_REFUND',
};

// Allowed forward transitions. Any order can fail/refund from a live state.
const TRANSITIONS = {
  PENDING_PAYMENT: ['PAID_UNASSIGNED', 'FAILED_REFUND'],
  PAID_UNASSIGNED: ['DISPATCHED', 'FAILED_REFUND'],
  DISPATCHED: ['IN_TRANSIT', 'FAILED_REFUND'],
  IN_TRANSIT: ['DELIVERED', 'FAILED_REFUND'],
  DELIVERED: [], // terminal
  FAILED_REFUND: [], // terminal
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!STATUS[to]) throw new Error(`Unknown target status: ${to}`);
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} → ${to}`);
  }
}

// Which auto-response (if any) fires on entering a state. Consumed by the auto-responder.
export const AUTO_RESPONSES = {
  PAID_UNASSIGNED: 'Payment confirmed. We are finding a driver for you now.',
  DISPATCHED: 'A driver has accepted your order and is heading to the market.',
  IN_TRANSIT: 'Your driver has the items and is on the way to you.',
  DELIVERED: 'Your order has been delivered. Thank you!',
  FAILED_REFUND: 'There was a problem with your order. An operator will contact you shortly.',
};
