-- The full customer app (stakeholder mockup, 2026-11-11): the customer picks their driver,
-- ratings, parcels, technicians, catalog pictures and customer suggestions, an admin promo
-- switch, and a notifications inbox.

-- ── Drivers and technicians ──
-- A technician is a staff account like a driver (same invite, same PIN app), doing SERVICE
-- jobs in the trades listed. Plate and photo are what a customer sees before choosing.
ALTER TABLE drivers
  ADD COLUMN role      TEXT   NOT NULL DEFAULT 'driver',
  ADD COLUMN trades    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN plate     TEXT,
  ADD COLUMN photo_key TEXT,
  ADD CONSTRAINT drivers_role_check CHECK (role IN ('driver', 'technician')),
  ADD CONSTRAINT drivers_plate_check CHECK (plate IS NULL OR length(plate) BETWEEN 2 AND 16);

-- ── Orders ──
ALTER TABLE orders
  -- The driver the customer chose (rides). Dispatch offers them the job for 30 s first.
  ADD COLUMN requested_driver_id BIGINT REFERENCES drivers (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- A live offer: the job is still PAID_UNASSIGNED until the driver accepts.
  ADD COLUMN offer_driver_id     BIGINT REFERENCES drivers (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN offer_expires_at    TIMESTAMPTZ(6),
  -- SERVICE: which trade (trades.slug). Extra work is a new prepaid order pointing at the visit.
  ADD COLUMN trade               TEXT,
  ADD COLUMN parent_order_id     UUID REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- PARCEL: what is in it. SERVICE: what is wrong. The customer's own words.
  ADD COLUMN details             TEXT,
  -- PARCEL: the number the driver calls at the drop-off (the receiver). Never an identity.
  ADD COLUMN recipient_phone     TEXT,
  -- 'free_delivery' when the admin's promo waived the fee on this order.
  ADD COLUMN promo               TEXT,
  ADD CONSTRAINT orders_details_check CHECK (details IS NULL OR length(details) <= 500),
  ADD CONSTRAINT orders_offer_check CHECK ((offer_driver_id IS NULL) = (offer_expires_at IS NULL));

CREATE INDEX idx_orders_offer ON orders (offer_expires_at) WHERE offer_driver_id IS NOT NULL;
CREATE INDEX idx_orders_parent ON orders (parent_order_id) WHERE parent_order_id IS NOT NULL;

-- ── Ratings: one per finished job, by its customer ──
CREATE TABLE ratings (
  order_id   UUID PRIMARY KEY REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  driver_id  BIGINT NOT NULL REFERENCES drivers (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  stars      SMALLINT NOT NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT ratings_stars_check CHECK (stars BETWEEN 1 AND 5),
  CONSTRAINT ratings_comment_check CHECK (comment IS NULL OR length(comment) <= 300)
);
CREATE INDEX idx_ratings_driver ON ratings (driver_id);

-- ── Trades (Farsamo): admin-edited, never deleted ──
CREATE TABLE trades (
  id        SERIAL PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  name_en   TEXT NOT NULL,
  name_so   TEXT NOT NULL,
  icon      TEXT NOT NULL DEFAULT '',
  visit_fee DECIMAL(12, 2) NOT NULL,
  active    BOOLEAN NOT NULL DEFAULT true,
  sort      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT trades_slug_check CHECK (slug ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT trades_fee_check CHECK (visit_fee > 0 AND visit_fee <= 1000)
);

-- ── Catalog: which home tile a category belongs to, pictures, a line of description ──
ALTER TABLE catalog_categories
  ADD COLUMN service TEXT NOT NULL DEFAULT 'shop',
  ADD CONSTRAINT catalog_categories_service_check CHECK (service IN ('food', 'grocery', 'pharmacy', 'water', 'shop'));
ALTER TABLE catalog_items
  -- 'stock/<file>' = a bundled licence-free picture; 'obj/<key>' = an approved upload in MinIO.
  ADD COLUMN image          TEXT,
  ADD COLUMN description_en TEXT NOT NULL DEFAULT '',
  ADD COLUMN description_so TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT catalog_items_image_check CHECK (image IS NULL OR image ~ '^(stock|obj)/[A-Za-z0-9._/-]{1,120}$');

-- ── Customer suggestions: a photo of something to sell, reviewed then published ──
CREATE TABLE catalog_submissions (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  name              TEXT NOT NULL,
  note              TEXT,
  service           TEXT,
  photo_key         TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
  review_note       TEXT,
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ(6),
  published_item_id INTEGER REFERENCES catalog_items (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  published_by      TEXT,
  published_at      TIMESTAMPTZ(6),
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT catalog_submissions_status_check CHECK (status IN ('new', 'forwarded', 'rejected', 'published')),
  CONSTRAINT catalog_submissions_name_check CHECK (length(name) BETWEEN 2 AND 80),
  CONSTRAINT catalog_submissions_note_check CHECK (note IS NULL OR length(note) <= 300)
);
CREATE INDEX idx_catalog_submissions_status ON catalog_submissions (status, created_at);
CREATE INDEX idx_catalog_submissions_user ON catalog_submissions (user_id, created_at);

-- ── Admin settings (the free-delivery promo). Every change audited. ──
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ── Notifications inbox: derived from what already happened; this is only "seen up to" ──
ALTER TABLE users ADD COLUMN notifications_seen_at TIMESTAMPTZ(6);
-- What the customer is called in the greeting. Optional, never required.
ALTER TABLE users ADD COLUMN display_name TEXT,
  ADD CONSTRAINT users_display_name_check CHECK (display_name IS NULL OR length(display_name) <= 40);

-- Manual top-ups (operator confirms the telecom reference, like an order payment).
ALTER TABLE payment_attempts ADD COLUMN claim_ref TEXT;
-- A claimed top-up waits for an operator; a rejected one never credits anything.
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN ('pending', 'approved', 'declined', 'unknown', 'claimed', 'rejected'));
-- One waiting manual top-up per customer.
CREATE UNIQUE INDEX idx_payment_attempts_one_claimed_topup ON payment_attempts (user_id)
  WHERE status = 'claimed' AND purpose = 'topup';
