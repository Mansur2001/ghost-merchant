-- Codes by email as well as SMS (Twilio SendGrid).
--
-- Customers: phone stays the identity. An email is stored only AFTER a signed-in customer
-- confirmed it with a code, and only then can sign-in codes be sent there — so typing someone
-- else's phone number plus your own email gets you nothing.
ALTER TABLE users ADD COLUMN email TEXT;

-- The pending "confirm this email" code. Separate from otp_codes on purpose: a code sent to an
-- address that isn't confirmed yet must never work as a login code for the phone.
CREATE TABLE email_challenges (
  phone        TEXT        PRIMARY KEY,
  email        TEXT        NOT NULL,
  code_hash    TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT         NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_challenges_expires ON email_challenges (expires_at);

-- Staff: where an admin chose to send the setup code instead of a text. Contact data only.
ALTER TABLE drivers ADD COLUMN email TEXT;
ALTER TABLE operators ADD COLUMN email TEXT;
