-- A customer is an ACCOUNT, reached by a verified phone (SMS code) or a verified email (email
-- code). Either alone is enough to sign up, so email works where SMS can't be delivered.
--
-- orders.user_phone stays, as the phone the driver calls: typed at checkout, not proven.
-- Ownership moves to orders.user_id — an unproven number must never decide who sees an order.
ALTER TABLE orders DROP CONSTRAINT orders_user_phone_fkey;

ALTER TABLE users ADD COLUMN id SERIAL;
ALTER TABLE users DROP CONSTRAINT users_pkey;
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;
CREATE UNIQUE INDEX users_phone_number_key ON users (phone_number);
-- An account nobody can sign in to is a dead account holding someone's orders.
ALTER TABLE users ADD CONSTRAINT users_has_login CHECK (phone_number IS NOT NULL OR email IS NOT NULL);

ALTER TABLE orders ADD COLUMN user_id INTEGER;
UPDATE orders o SET user_id = u.id FROM users u WHERE u.phone_number = o.user_phone;
ALTER TABLE orders ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION;
DROP INDEX idx_orders_user;
CREATE INDEX idx_orders_user ON orders (user_id);

-- "Confirm this email" codes now belong to an account, not a phone. They live 5 minutes, so
-- dropping any in flight costs a resend at most.
DELETE FROM email_challenges;
ALTER TABLE email_challenges DROP CONSTRAINT email_challenges_pkey;
ALTER TABLE email_challenges DROP COLUMN phone;
ALTER TABLE email_challenges ADD COLUMN user_id INTEGER NOT NULL;
ALTER TABLE email_challenges ADD CONSTRAINT email_challenges_pkey PRIMARY KEY (user_id);
ALTER TABLE email_challenges ADD CONSTRAINT email_challenges_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE NO ACTION;
