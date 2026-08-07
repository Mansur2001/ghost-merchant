// Order-scoped authorization. Mount AFTER requireAuth on every route with an :id that names
// an order. Loads the order once, applies the domain rule, and stashes it on req.order so the
// handler doesn't re-fetch it.
//
// Deliberate choice: a denied request gets 404, not 403. A 403 confirms "this order exists,
// it just isn't yours", which is exactly the signal an enumeration script wants. Order IDs
// are still sequential integers until the UUID migration (P1), so the response for
// "not yours" and "doesn't exist" must be byte-identical.
import { getOrder } from '../queries/orders.js';
import { canAccessOrder } from '../domain/access.js';

const NOT_FOUND = { error: 'not found' };

export async function requireOrderAccess(req, res, next) {
  try {
    const order = await getOrder(req.params.id);
    if (!order || !canAccessOrder(req.auth, order)) {
      return res.status(404).json(NOT_FOUND);
    }
    req.order = order;
    next();
  } catch {
    // A malformed id (non-numeric against a BIGSERIAL column) throws in pg. Same answer.
    return res.status(404).json(NOT_FOUND);
  }
}
