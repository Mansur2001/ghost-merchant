-- Transactional outbox.
--
-- The problem it fixes: commands used to COMMIT the state change and THEN publish to the
-- in-process event bus. Those are two separate steps with a gap between them. Crash in the
-- gap (deploy, OOM, power cut on a cheap VPS) and Postgres is correct while every connected
-- client is permanently stale — the customer's page still says "awaiting payment" for an
-- order that is paid, until they think to reload. On a phone in Mogadishu, they don't.
--
-- The fix: the event row is written in the SAME transaction as the state change, so they
-- commit or roll back together. A relay then publishes committed rows and marks them done.
-- Delivery becomes at-least-once (a crash after publish but before marking redelivers),
-- which is why every consumer must tolerate a duplicate — see events/outbox.js.
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,   -- also the ordering key: events replay in write order
  event_name   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,             -- NULL = not yet relayed
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  failed       BOOLEAN NOT NULL DEFAULT false  -- gave up; needs a human, skipped by the relay
);

-- The relay's hot query: the small set of undelivered rows, in id order. Partial index so it
-- stays tiny no matter how much history the table accumulates.
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox(id) WHERE published_at IS NULL AND NOT failed;

-- Retention sweep looks up published rows by age.
CREATE INDEX IF NOT EXISTS idx_outbox_published_at ON outbox(published_at)
  WHERE published_at IS NOT NULL;
