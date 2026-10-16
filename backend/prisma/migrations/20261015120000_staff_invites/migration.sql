-- Staff onboarding by invite: an admin creates the account, the person receives a one-time
-- setup code by SMS and chooses their OWN PIN/password. The admin never knows the secret.

-- Admins manage staff; ordinary operators dispatch. The bootstrap account is the first admin.
ALTER TABLE operators ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
-- Where an operator's setup code is texted. Operators sign in by username, so this is contact
-- data only — never an identity.
ALTER TABLE operators ADD COLUMN phone TEXT;
UPDATE operators SET is_admin = true WHERE created_by = 'system:bootstrap' OR username = 'admin';
-- A roster with no admin at all could never add staff again: promote its oldest active member.
UPDATE operators SET is_admin = true
 WHERE id = (SELECT id FROM operators WHERE active ORDER BY id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM operators WHERE is_admin);

-- Null until the person has chosen their own PIN (an invited driver starts with an unusable
-- random hash). Existing drivers already have one.
ALTER TABLE drivers ADD COLUMN pin_set_at TIMESTAMPTZ;
UPDATE drivers SET pin_set_at = created_at;

-- Which account a request produced, so an approved request leaves the queue only once its
-- account exists, and the trail shows who asked -> who approved -> what was created.
ALTER TABLE access_requests ADD COLUMN account_created_at TIMESTAMPTZ;
ALTER TABLE access_requests ADD COLUMN account_ref TEXT;

CREATE TABLE staff_invites (
  id          BIGSERIAL PRIMARY KEY,
  role        TEXT        NOT NULL CHECK (role IN ('driver', 'operator')),
  account_id  BIGINT      NOT NULL,
  phone       TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live code per account: re-sending REPLACES it, so an old text can't still be used.
CREATE UNIQUE INDEX idx_staff_invites_account ON staff_invites (role, account_id);
CREATE INDEX idx_staff_invites_phone ON staff_invites (role, phone);
