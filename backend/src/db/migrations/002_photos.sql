-- Photo attachments (customer reference photos + driver delivery-proof), stored in MinIO.
-- The bytes live in object storage; this table is the metadata index. Idempotency guarantee:
-- object_key is UNIQUE, so a re-upload of the same logical photo (deterministic key) upserts
-- one row and overwrites one object rather than accumulating duplicates — important for the
-- sensitive-data requirement (no orphaned copies of a customer photo pile up).
CREATE TABLE IF NOT EXISTS order_photos (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('order_ref', 'delivery_proof')),
  object_key   TEXT NOT NULL UNIQUE,           -- MinIO key; deterministic per (order, kind)
  content_type TEXT,
  uploaded_by  TEXT NOT NULL,                  -- 'user' | 'driver:<id>' | 'system'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_photos_order ON order_photos(order_id, kind);
