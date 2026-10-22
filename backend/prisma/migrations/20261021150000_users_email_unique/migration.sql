-- Sign in by typing your email: the email has to find exactly one account. If two accounts
-- somehow confirmed the same address, neither keeps it (each can confirm it again, and the
-- one that does takes it) rather than guessing which customer it belongs to.
UPDATE users SET email = NULL
 WHERE email IN (SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
