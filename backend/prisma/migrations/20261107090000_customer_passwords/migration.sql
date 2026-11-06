-- Customers may sign in with email + password, so a day when email codes don't arrive is not a
-- day nobody can sign in. Email codes remain the proof of owning the address (and the reset).
ALTER TABLE users ADD COLUMN password_hash TEXT;
-- Set when a code sent to the email was used. A password account starts unverified; the first
-- code sign-in proves the address and removes any password a squatter set on it.
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ(6);
-- A code sign-in opens a short window to set a new password without the old one (the reset).
ALTER TABLE users ADD COLUMN password_reset_until TIMESTAMPTZ(6);

-- Every email on file so far was proven with a code.
UPDATE users SET email_verified_at = created_at WHERE email IS NOT NULL;
