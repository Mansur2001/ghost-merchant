-- Client-supplied idempotency key for chat messages.
--
-- The offline queue (P2) replays writes when the network returns. Without a key, a message
-- whose response was lost — sent successfully, but the reply never arrived — is re-sent on
-- reconnect and appears twice in the thread. The customer sees themselves stuttering, and in
-- a delivery dispute the transcript is wrong.
--
-- Same shape as the order-creation key: the CLIENT mints a UUID, the database enforces that
-- it can only land once. Nullable because system and operator messages are generated
-- server-side and have no client to mint one.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id UUID;

-- Partial unique index: many NULLs are fine, but a given client_id lands exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(client_id) WHERE client_id IS NOT NULL;
