-- Order IDs: BIGSERIAL -> UUID.
--
-- Two reasons, one of which is a prerequisite for everything after it:
--
-- 1. ENUMERATION. Sequential ids mean /api/orders/1..N enumerates the whole business.
--    requireOrderAccess already denies them (and answers 404 so "not yours" and "doesn't
--    exist" are indistinguishable), but that is one middleware standing between a stranger
--    and every customer record. A UUID makes the guess itself infeasible — defence in depth,
--    not a replacement for the check.
-- 2. OFFLINE WRITES (P2). A phone with no signal must be able to create an order and sync it
--    later, which means the CLIENT has to mint the id. That is impossible with a sequence.
--    A client-supplied UUID doubles as an idempotency key: retrying a create that already
--    succeeded returns the same order instead of making a second one.
--
-- Data-preserving: every existing order keeps its row and its children; only the key changes.
-- Dropping a column also drops the constraints and indexes that depend on it, so the child
-- FKs disappear with their columns and are recreated at the end.

-- 1. Give every order a UUID alongside its current id.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS new_id UUID NOT NULL DEFAULT gen_random_uuid();

-- 2. Add the new foreign key column to each child and backfill it through the old key.
ALTER TABLE transactions  ADD COLUMN IF NOT EXISTS new_order_id UUID;
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS new_order_id UUID;
ALTER TABLE order_events  ADD COLUMN IF NOT EXISTS new_order_id UUID;
ALTER TABLE order_photos  ADD COLUMN IF NOT EXISTS new_order_id UUID;

UPDATE transactions t SET new_order_id = o.new_id FROM orders o WHERE o.id = t.order_id;
UPDATE messages     m SET new_order_id = o.new_id FROM orders o WHERE o.id = m.order_id;
UPDATE order_events e SET new_order_id = o.new_id FROM orders o WHERE o.id = e.order_id;
UPDATE order_photos p SET new_order_id = o.new_id FROM orders o WHERE o.id = p.order_id;

-- Fail loudly rather than silently orphaning rows: every child that had an order must still
-- have one. (transactions.order_id is legitimately NULL for unmatched receipts.)
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM transactions WHERE order_id IS NOT NULL AND new_order_id IS NULL;
  IF orphans > 0 THEN RAISE EXCEPTION 'transactions: % rows failed to map to a UUID', orphans; END IF;
  SELECT count(*) INTO orphans FROM messages WHERE new_order_id IS NULL;
  IF orphans > 0 THEN RAISE EXCEPTION 'messages: % rows failed to map to a UUID', orphans; END IF;
  SELECT count(*) INTO orphans FROM order_events WHERE new_order_id IS NULL;
  IF orphans > 0 THEN RAISE EXCEPTION 'order_events: % rows failed to map to a UUID', orphans; END IF;
  SELECT count(*) INTO orphans FROM order_photos WHERE new_order_id IS NULL;
  IF orphans > 0 THEN RAISE EXCEPTION 'order_photos: % rows failed to map to a UUID', orphans; END IF;
END $$;

-- 3. Swap the child columns (drops the old FKs and their indexes with them).
ALTER TABLE transactions DROP COLUMN order_id;
ALTER TABLE transactions RENAME COLUMN new_order_id TO order_id;

ALTER TABLE messages DROP COLUMN order_id;
ALTER TABLE messages RENAME COLUMN new_order_id TO order_id;
ALTER TABLE messages ALTER COLUMN order_id SET NOT NULL;

ALTER TABLE order_events DROP COLUMN order_id;
ALTER TABLE order_events RENAME COLUMN new_order_id TO order_id;
ALTER TABLE order_events ALTER COLUMN order_id SET NOT NULL;

ALTER TABLE order_photos DROP COLUMN order_id;
ALTER TABLE order_photos RENAME COLUMN new_order_id TO order_id;
ALTER TABLE order_photos ALTER COLUMN order_id SET NOT NULL;

-- 4. Swap the primary key. Dropping `id` takes the PK constraint and the sequence with it.
ALTER TABLE orders DROP COLUMN id;
ALTER TABLE orders RENAME COLUMN new_id TO id;
ALTER TABLE orders ADD PRIMARY KEY (id);

-- 5. Restore the foreign keys and the indexes that lived on the dropped columns.
ALTER TABLE transactions ADD CONSTRAINT transactions_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE messages ADD CONSTRAINT messages_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE order_events ADD CONSTRAINT order_events_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE order_photos ADD CONSTRAINT order_photos_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_photos_order ON order_photos(order_id, kind);
CREATE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_id);
