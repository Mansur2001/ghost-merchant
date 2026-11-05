-- Sign-in and setup codes are email-only now (no SMS), so an applicant's email is where their
-- setup code goes once an admin creates the account. The phone stays as a contact reference.
-- Nullable: requests from before this have none, and the admin types one in when creating.
ALTER TABLE access_requests ADD COLUMN email TEXT;
