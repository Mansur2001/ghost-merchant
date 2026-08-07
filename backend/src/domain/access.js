// Who may see or touch a given order. Pure decision function — no DB, no Express — so the
// rule can be unit-tested exhaustively. This is the single place the answer is defined;
// the HTTP middleware and the WebSocket layer both call it, and must never re-derive it.
//
// Rules:
//   operator -> every order (the dispatch desk is the manual-override surface).
//   customer -> only orders created under their own verified phone number.
//   driver   -> only orders the operator has explicitly ASSIGNED to them. Dispatch is
//               operator-driven, so an unassigned order is invisible to every driver.
//
// Defensive by construction: every branch requires BOTH sides of the comparison to be
// present. A null phone must never match a null phone — that is how "undefined === undefined"
// turns into a data breach.
export function canAccessOrder(auth, order) {
  if (!auth || !order) return false;

  switch (auth.role) {
    case 'operator':
      return true;

    case 'customer':
      return Boolean(auth.phone) && Boolean(order.user_phone) && auth.phone === order.user_phone;

    case 'driver':
      return (
        auth.id != null &&
        order.driver_id != null &&
        String(auth.id) === String(order.driver_id)
      );

    default:
      return false;
  }
}

// Which `sender` value a chat message gets, derived from the authenticated role rather than
// from client input — otherwise anyone could post a message styled as 'system' or 'operator'.
export function senderForRole(role) {
  switch (role) {
    case 'customer':
      return 'user';
    case 'driver':
      return 'driver';
    case 'operator':
      return 'operator';
    default:
      return null;
  }
}
