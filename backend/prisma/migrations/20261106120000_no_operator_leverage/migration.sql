-- Take leverage away from operators. Dispatch becomes automatic (fair rotation needs to know
-- when each driver last got an order), and every human decision is written to a log that
-- nobody — not an operator, not an admin, not the app itself — can edit or delete.

ALTER TABLE drivers ADD COLUMN last_assigned_at TIMESTAMPTZ(6);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 'operator:<id>:<username>' | 'driver:<id>' | 'system:<what>'
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_log_at ON audit_log (at DESC);

-- Append-only, enforced by the database. A row trigger can't stop TRUNCATE, which only the
-- dev seed runs (and production refuses to seed).
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
