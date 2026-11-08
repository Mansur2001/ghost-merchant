-- Customer wallet: a balance the customer tops up through the gateway and spends on orders.
--
-- This makes GuriKaabe hold customer money (stored value). It ships switched OFF
-- (WALLET_ENABLED) — turning it on is a licensing decision, not a deploy.
--
-- The LEDGER is the truth: wallet_entries is append-only, and every row carries the balance it
-- left behind. wallet_accounts.balance_cents is the running total, updated in the same
-- transaction under a row lock, and can never go below zero.

CREATE TABLE wallet_accounts (
  user_id        INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  balance_cents  BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wallet_accounts_balance_check CHECK (balance_cents >= 0)
);

CREATE TABLE wallet_entries (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  amount_cents        BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  kind                TEXT NOT NULL,
  order_id            UUID REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- A top-up's gateway transaction id, a withdrawal's payout reference: what a dispute checks.
  reference           TEXT,
  actor               TEXT NOT NULL,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wallet_entries_amount_check CHECK (amount_cents <> 0),
  CONSTRAINT wallet_entries_balance_check CHECK (balance_after_cents >= 0),
  CONSTRAINT wallet_entries_kind_check CHECK (kind IN
    ('topup', 'order_payment', 'refund', 'withdrawal', 'withdrawal_reversal')),
  CONSTRAINT wallet_entries_sign_check CHECK (
    (kind IN ('topup', 'refund', 'withdrawal_reversal') AND amount_cents > 0)
    OR (kind IN ('order_payment', 'withdrawal') AND amount_cents < 0)
  )
);
CREATE INDEX idx_wallet_entries_user ON wallet_entries (user_id, id);
-- One wallet payment per order, one wallet refund per order: a retry can't spend or credit twice.
CREATE UNIQUE INDEX idx_wallet_entries_order_once ON wallet_entries (order_id, kind)
  WHERE kind IN ('order_payment', 'refund');
CREATE TRIGGER wallet_entries_append_only BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Cash-out requests. The amount is taken from the balance when requested (so it can't be spent
-- twice); an admin pays it from the business wallet and records the reference, or rejects it
-- and the amount goes back.
CREATE TABLE wallet_withdrawals (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  amount_cents  BIGINT NOT NULL,
  payout_phone  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested',
  reference     TEXT,
  note          TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ(6),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wallet_withdrawals_amount_check CHECK (amount_cents > 0),
  CONSTRAINT wallet_withdrawals_status_check CHECK (status IN ('requested', 'paid', 'rejected'))
);
CREATE INDEX idx_wallet_withdrawals_open ON wallet_withdrawals (created_at) WHERE status = 'requested';

-- Top-ups go through the same gateway attempts as order payments, with no order.
ALTER TABLE payment_attempts
  ALTER COLUMN order_id DROP NOT NULL,
  ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'order',
  ADD CONSTRAINT payment_attempts_purpose_check CHECK (
    (purpose = 'order' AND order_id IS NOT NULL) OR (purpose = 'topup' AND user_id IS NOT NULL AND order_id IS NULL)
  );
-- One pending top-up prompt per customer, like one per order.
CREATE UNIQUE INDEX idx_payment_attempts_one_pending_topup ON payment_attempts (user_id)
  WHERE status = 'pending' AND purpose = 'topup';
