-- Wallet picker: the customer chooses EVC Plus / eDahab / Zaad / Sahal, each paying its own
-- merchant number. "I've paid" now says which one, so the operator checks the right phone.
-- Nullable and additive: older claims, old app builds and manual-path orders leave it empty.
ALTER TABLE orders ADD COLUMN payment_claim_wallet TEXT;
