// Payment references: the transaction id on an EVC Plus / eDahab receipt. Pure domain.
//
// With no device reading receipts, the reference is how a confirmed payment stays tied to ONE
// order: it is stored in transactions.telecom_receipt_id, which is UNIQUE — so the same real
// payment can never be credited to two orders, even if two people both point at it.

export const MAX_REFERENCE_LENGTH = 40;

// Canonical form, so "abc 123", " ABC123 " and "abc-123" can't slip past the uniqueness check as
// three different references. Returns '' for nothing usable; null if it isn't a reference.
export function normalizeReference(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!s) return '';
  if (s.length > MAX_REFERENCE_LENGTH || !/^[A-Z0-9._/]+$/.test(s)) return null;
  return s;
}

// The receipt id recorded when the operator confirms without a reference. Unique per order, so
// it can't collide with a real reference or with another order's confirmation.
export function manualReceiptId(orderId) {
  return `MANUAL:${orderId}`;
}
