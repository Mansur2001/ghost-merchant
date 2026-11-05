// Who gets the next paid order. Pure, so the rule is testable and nobody can argue with it.
//
// No human picks a driver. A paid order goes to the active driver (PIN set) with the fewest
// active orders; ties go to whoever has waited longest since their last assignment, then to
// the oldest account. That is fair rotation: no favourites, no one starved, and a driver who
// already has MAX_ACTIVE jobs is skipped until one is done.
export const MAX_ACTIVE_PER_DRIVER = 3;

// candidates: [{ id, active, ready, active_orders, last_assigned_at }]
export function pickDriver(candidates, maxActive = MAX_ACTIVE_PER_DRIVER) {
  const eligible = candidates.filter((d) => d.active && d.ready && d.active_orders < maxActive);
  if (!eligible.length) return null;
  const waited = (d) => (d.last_assigned_at ? new Date(d.last_assigned_at).getTime() : 0);
  eligible.sort((a, b) =>
    a.active_orders - b.active_orders
    || waited(a) - waited(b)
    || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  return eligible[0];
}
