-- Named operator accounts, replacing the single shared OPERATOR_PASSWORD.
--
-- Why this matters beyond hygiene: the operator surface can read every order and drive every
-- state machine, and `order_events.actor` is the dispute-resolution record. With one shared
-- login every action reads "operator:super" — so when a customer disputes a refund or an
-- order is marked paid that wasn't, the audit trail cannot say who did it. Shared credentials
-- also can't be revoked when someone leaves without locking out the whole desk.
CREATE TABLE IF NOT EXISTS operators (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,     -- lowercase, normalized in domain/operator.js
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,            -- scrypt, same scheme as driver PINs
  active        BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT false, -- set on the bootstrap account
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT                      -- actor label of whoever created this account
);

-- Login looks up by username among active accounts.
CREATE INDEX IF NOT EXISTS idx_operators_active ON operators(username) WHERE active;
