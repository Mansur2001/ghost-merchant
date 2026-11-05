-- Proof of delivery. Every step a driver takes now needs evidence the server checks:
--   pickup   -> a photo of the goods (order_photos kind 'pickup_proof')
--   delivery -> the customer's 4-digit handoff code, or a door photo + a reason (flagged)
-- The evidence row is written in the SAME transaction as the transition it justifies.

ALTER TABLE order_photos DROP CONSTRAINT order_photos_kind_check;
ALTER TABLE order_photos ADD CONSTRAINT order_photos_kind_check
  CHECK ("kind" IN ('order_ref', 'pickup_proof', 'delivery_proof'));

-- Kept OUT of the orders table on purpose: order rows go to the assigned driver
-- (GET /orders/:id, socket events). A code the driver can read proves nothing.
CREATE TABLE delivery_handoffs (
  order_id    UUID PRIMARY KEY REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  code        TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ(6),
  CONSTRAINT delivery_handoffs_code_check CHECK (code ~ '^[0-9]{4}$')
);

-- Live orders from before this migration get a code too, from gen_random_uuid() (strong
-- randomness, unlike random()). Finished orders need none.
INSERT INTO delivery_handoffs (order_id, code)
SELECT id, lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int % 10000)::text, 4, '0')
FROM orders WHERE status NOT IN ('DELIVERED', 'FAILED_REFUND');

CREATE TABLE order_proofs (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  step        TEXT NOT NULL,
  method      TEXT NOT NULL,
  note        TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  accuracy_m  INTEGER,
  -- From the driver's fix to the customer's drop pin, when both exist.
  distance_m  INTEGER,
  -- Why an operator should look (empty = nothing to check). Decided at write time.
  flags       TEXT[] NOT NULL DEFAULT '{}',
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ(6),
  CONSTRAINT order_proofs_step_check CHECK (step IN ('pickup', 'delivery')),
  CONSTRAINT order_proofs_method_check CHECK (method IN ('photo', 'code', 'photo_no_code')),
  -- One proof per step: the transition it justifies happens once.
  CONSTRAINT order_proofs_order_step_key UNIQUE (order_id, step)
);

-- The operator's review queue: flagged deliveries nobody has looked at yet.
CREATE INDEX idx_order_proofs_review ON order_proofs (created_at)
  WHERE reviewed_at IS NULL AND cardinality(flags) > 0;
