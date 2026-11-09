-- Bug reports filed from the apps (Help -> Report a problem), triaged in the operator console.
-- Adapted from the team bug tracker (TCSS 460 group 8): same fields and limits, same states.
-- Kept small and short-lived: closed reports are deleted 90 days after closing (what people
-- type here can include their own details, and a fixed bug needs no archive of them).
CREATE TABLE bug_reports (
  id             SERIAL PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  repro_steps    TEXT,
  reporter_email TEXT,
  -- The signed-in account, from the session (never the body). Null for a signed-out visitor.
  user_id        INTEGER REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  app            TEXT NOT NULL,
  app_version    TEXT,
  lang           TEXT,
  page           TEXT,
  -- Only ever an order the reporter owns (checked on the server).
  order_id       UUID REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  user_agent     TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  triage_note    TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ(6),
  CONSTRAINT bug_reports_status_check CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  CONSTRAINT bug_reports_app_check CHECK (app IN ('customer', 'driver', 'operator')),
  CONSTRAINT bug_reports_title_check CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT bug_reports_description_check CHECK (char_length(description) BETWEEN 1 AND 5000),
  CONSTRAINT bug_reports_repro_check CHECK (repro_steps IS NULL OR char_length(repro_steps) <= 5000)
);
CREATE INDEX idx_bug_reports_status ON bug_reports (status, created_at DESC);
