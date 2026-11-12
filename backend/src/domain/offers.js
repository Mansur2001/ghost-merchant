// Offers: the customer chose a driver, and that driver gets the job first — if they take it.
//
// A paid ride with a chosen driver is not assigned to them straight away: a driver who looked
// free on the list a minute ago may be at the pump. They get OFFER_TTL_MS to accept. A decline
// or silence hands the ride to automatic dispatch (the nearest free driver), never back to the
// customer to choose again — a rider on a corner should not have to start over.
//
// While an offer is open the order stays PAID_UNASSIGNED (nothing has changed hands), with
// offer_driver_id/offer_expires_at set. Both outcomes add the driver to `released_by`, so the
// order is never offered or auto-dispatched to them again.

export const OFFER_TTL_MS = 30_000;

export const offerLive = (order, now = Date.now()) => Boolean(
  order?.offer_driver_id != null && order.offer_expires_at && new Date(order.offer_expires_at).getTime() > now
);

// Should this order be offered to the driver the customer chose? Only rides, only once.
export function wantsOffer(order) {
  if (!order || order.kind !== 'RIDE' || order.requested_driver_id == null) return false;
  const released = new Set((order.released_by || []).map(String));
  return !released.has(String(order.requested_driver_id));
}
