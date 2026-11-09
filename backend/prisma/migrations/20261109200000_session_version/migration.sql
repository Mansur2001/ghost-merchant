-- A customer's sign-ins carry the version they were issued under; raising it (a password set,
-- changed or reset) signs out every device holding an older one. Existing sign-ins carry none,
-- which counts as 0, so this migration signs nobody out.
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
