-- Customer authentication: one-time passcodes sent to the phone number that IS the identity.
--
-- Design notes:
--  * ONE live challenge per phone (phone is the PK). Requesting a new code atomically
--    replaces the old one, so an attacker can't accumulate valid codes by spamming requests.
--  * The code is stored scrypt-hashed, never in plaintext — a DB read must not yield a
--    login. `attempts` caps online guessing; `expires_at` caps the window.
--  * `last_sent_at` backs the resend cooldown (also the SMS-cost guard: every send is a real
--    SMS off the Oracle phone, so a resend loop costs us actual money).
CREATE TABLE IF NOT EXISTS otp_codes (
  phone        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeping expired challenges is a cheap periodic job; index the column it scans.
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_codes(expires_at);
