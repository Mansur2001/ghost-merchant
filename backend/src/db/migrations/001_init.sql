-- Ghost Merchant initial schema.
-- The Transactions.telecom_receipt_id UNIQUE constraint is the anti-double-spend guarantee:
-- a duplicated SMS webhook physically cannot credit an order twice.

-- Order lifecycle state machine (single source of truth also enforced in code).
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'PENDING_PAYMENT',
    'PAID_UNASSIGNED',
    'DISPATCHED',
    'IN_TRANSIT',
    'DELIVERED',
    'FAILED_REFUND'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Customers are identified purely by phone number (frictionless auth).
CREATE TABLE IF NOT EXISTS users (
  phone_number TEXT PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drivers are hardcoded by the admin and log in with a PIN.
CREATE TABLE IF NOT EXISTS drivers (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  msisdn     TEXT NOT NULL UNIQUE,
  pin_hash   TEXT NOT NULL,          -- scrypt hash, never store the raw PIN
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  user_phone     TEXT NOT NULL REFERENCES users(phone_number),
  status         order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  total_amount   NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  items          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ghost menu / coordination request
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  landmark_text  TEXT NOT NULL,
  driver_id      BIGINT REFERENCES drivers(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_phone);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);

-- Verified payment receipts parsed from telecom SMS by the Android Oracle.
CREATE TABLE IF NOT EXISTS transactions (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           BIGINT REFERENCES orders(id),
  telecom_receipt_id TEXT NOT NULL UNIQUE,     -- anti double-spend
  sender_msisdn      TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL,
  raw_sms            TEXT,                      -- keep the original for audit/dispute
  matched            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tx_sender_amount ON transactions(sender_msisdn, amount);

-- In-app coordination chat (Option A: sovereign, no WhatsApp). One thread per order.
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  sender     TEXT NOT NULL,           -- 'user' | 'driver' | 'operator' | 'system'
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);

-- Append-only audit of every state transition (observability + dispute resolution).
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id),
  from_status order_status,
  to_status   order_status NOT NULL,
  actor       TEXT NOT NULL,          -- 'system' | 'operator:<id>' | 'driver:<id>'
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);
