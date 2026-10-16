-- No Oracle device: payments are confirmed by an operator.
--
-- The customer can say "I've paid" (optionally with the EVC/eDahab reference) so the operator
-- knows which order to check on the merchant phone. A claim is NOT a payment and never changes
-- the order's status — only the operator's confirmation does (commands/payments.js).
ALTER TABLE orders ADD COLUMN payment_claimed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN payment_claim_ref TEXT;

-- The Oracle phone's outbound-SMS queue and the missed-call challenges it answered. Both
-- features are gone (login codes go out through ClickSend), and neither table holds anything
-- worth keeping: undelivered codes expire in minutes and challenges in seconds.
DROP TABLE IF EXISTS sms_outbox;
DROP TABLE IF EXISTS call_challenges;
