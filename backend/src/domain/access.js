// Who may see or touch a given order. Pure decision function — no DB, no Express — so the
// rule can be unit-tested exhaustively. This is the single place the answer is defined;
// the HTTP middleware and the WebSocket layer both call it, and must never re-derive it.
//
// Rules:
//   operator -> every order (the dispatch desk is the manual-override surface).
//   customer -> only orders placed from their own account (user_id). Never by the order's
//               phone: that's the number the driver calls, typed at checkout, not proven.
//   driver   -> only orders the operator has explicitly ASSIGNED to them. Dispatch is
//               operator-driven, so an unassigned order is invisible to every driver.
//
// Defensive by construction: every branch requires BOTH sides of the comparison to be
// present. A null id must never match a null id — that is how "undefined === undefined"
// turns into a data breach.
export function canAccessOrder(auth, order) {
  if (!auth || !order) return false;

  switch (auth.role) {
    case 'operator':
      return true;

    case 'customer':
      return Number.isInteger(auth.uid) && Number.isInteger(order.user_id) && auth.uid === order.user_id;

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
