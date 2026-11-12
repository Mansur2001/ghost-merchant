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
  // Back to PAID_UNASSIGNED: the driver released the job before pickup (too far, breakdown).
  // It is re-dispatched to someone else; nothing has been bought or carried yet.
  DISPATCHED: ['IN_TRANSIT', 'PAID_UNASSIGNED', 'FAILED_REFUND'],
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

// Which auto-response (if any) fires on entering a state. Consumed by transitionOrder.
export const AUTO_RESPONSES = {
  PAID_UNASSIGNED: 'Payment confirmed. We are finding a driver for you now.',
  DISPATCHED: 'A driver has accepted your order and is heading to the market.',
  IN_TRANSIT: 'Your driver has the items and is on the way to you.',
  DELIVERED: 'Your order has been delivered. Thank you!',
  FAILED_REFUND: 'There was a problem with your order. An operator will contact you shortly.',
};

const RIDE_RESPONSES = {
  PAID_UNASSIGNED: 'Payment confirmed. We are finding a driver near you.',
  DISPATCHED: 'A driver is on the way to pick you up.',
  IN_TRANSIT: 'Your ride has started.',
  DELIVERED: 'You have arrived. Thank you for riding with GuriKaabe!',
  FAILED_REFUND: 'There was a problem with your ride. An operator will contact you shortly.',
};

const PARCEL_RESPONSES = {
  PAID_UNASSIGNED: 'Payment confirmed. We are finding a driver to collect your parcel.',
  DISPATCHED: 'A driver is on the way to collect your parcel.',
  IN_TRANSIT: 'Your parcel has been collected and is on the way.',
  DELIVERED: 'Your parcel has been delivered. Thank you!',
  FAILED_REFUND: 'There was a problem with your parcel. An operator will contact you shortly.',
};

const SERVICE_RESPONSES = {
  PAID_UNASSIGNED: 'Payment confirmed. We are finding a technician for you.',
  DISPATCHED: 'A technician is on the way to you.',
  IN_TRANSIT: 'Your technician has arrived and started work.',
  DELIVERED: 'The job is done. Thank you!',
  FAILED_REFUND: 'There was a problem with your visit. An operator will contact you shortly.',
};

const BY_KIND = { RIDE: RIDE_RESPONSES, PARCEL: PARCEL_RESPONSES, SERVICE: SERVICE_RESPONSES };

export function autoResponse(from, to, kind = 'DELIVERY') {
  if (from === 'DISPATCHED' && to === 'PAID_UNASSIGNED') {
    return kind === 'SERVICE'
      ? 'Your technician could not make it. We are finding you another one.'
      : 'Your driver could not make it. We are finding you another one.';
  }
  return (BY_KIND[kind] || AUTO_RESPONSES)[to] || null;
}
