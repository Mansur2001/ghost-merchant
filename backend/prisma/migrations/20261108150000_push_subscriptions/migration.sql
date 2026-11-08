-- Push notifications: where to reach a signed-in person's phone or browser.
--
-- One row per device. `role` + `subject_id` say whose it is (users.id, drivers.id or
-- operators.id) and come from the session that registered it, never from the client.
-- A Web Push row has the browser's endpoint + keys; an FCM row (the Android app) a token.
-- Rows the push service reports gone (404/410) are deleted; nothing here outlives its use.
CREATE TABLE push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  role        TEXT NOT NULL,
  subject_id  BIGINT NOT NULL,
  channel     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT,
  auth        TEXT,
  lang        TEXT NOT NULL DEFAULT 'en',
  failures    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ(6),
  CONSTRAINT push_subscriptions_role_check CHECK (role IN ('customer', 'driver', 'operator')),
  CONSTRAINT push_subscriptions_channel_check CHECK (channel IN ('webpush', 'fcm')),
  CONSTRAINT push_subscriptions_webpush_keys_check CHECK (channel <> 'webpush' OR (p256dh IS NOT NULL AND auth IS NOT NULL)),
  -- One row per device: re-registering the same browser moves it to whoever signed in last.
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX idx_push_subscriptions_subject ON push_subscriptions (role, subject_id);
