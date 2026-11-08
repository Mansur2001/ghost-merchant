-- Rides, a generic catalog, fixed places, and live driver locations.
--
-- One `orders` table for both jobs. A ride runs the same state machine as a delivery
-- (PENDING_PAYMENT -> PAID_UNASSIGNED -> DISPATCHED -> IN_TRANSIT -> DELIVERED), is paid the
-- same way, and fails into the same refund ledger. Only the proof rules and dispatch differ
-- (domain/proof.js, domain/dispatch.js), keyed off `kind`.

CREATE TYPE order_kind AS ENUM ('DELIVERY', 'RIDE');

ALTER TABLE orders
  ADD COLUMN kind          order_kind NOT NULL DEFAULT 'DELIVERY',
  -- Where the job starts: the rider's pickup point, or the market a delivery is bought at.
  -- lat/lng/landmark_text stay the END of the job (the customer's door, the rider's destination).
  ADD COLUMN pickup_lat    DOUBLE PRECISION,
  ADD COLUMN pickup_lng    DOUBLE PRECISION,
  ADD COLUMN pickup_text   TEXT,
  ADD COLUMN vehicle       TEXT,
  ADD COLUMN distance_m    INTEGER,
  -- total_amount = subtotal + fee. Kept apart so a receipt and a refund can say which is which.
  -- Null on orders from before this migration (and old app builds), whose total was typed.
  ADD COLUMN subtotal      DECIMAL(12, 2),
  ADD COLUMN fee           DECIMAL(12, 2),
  -- Drivers who released this job before pickup. Dispatch skips them for it, so "release" can't
  -- bounce the same job back to the same driver.
  ADD COLUMN released_by   BIGINT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT orders_vehicle_check CHECK (vehicle IS NULL OR vehicle IN ('bajaj', 'car')),
  ADD CONSTRAINT orders_ride_shape_check CHECK (
    kind <> 'RIDE' OR (vehicle IS NOT NULL AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
                       AND lat IS NOT NULL AND lng IS NOT NULL)
  ),
  ADD CONSTRAINT orders_amount_parts_check CHECK (
    (subtotal IS NULL AND fee IS NULL) OR (subtotal >= 0 AND fee >= 0 AND subtotal + fee = total_amount)
  );

CREATE INDEX idx_orders_kind_status ON orders (kind, status);

-- Ride proofs: the rider's code at pickup (or a reason), a drop-off fix at the end.
ALTER TABLE order_proofs DROP CONSTRAINT order_proofs_method_check;
ALTER TABLE order_proofs ADD CONSTRAINT order_proofs_method_check
  CHECK (method IN ('photo', 'code', 'photo_no_code', 'no_code', 'dropoff'));

-- Drivers: what they drive, and whether they want work right now.
ALTER TABLE drivers
  ADD COLUMN vehicle TEXT NOT NULL DEFAULT 'bajaj',
  ADD COLUMN online  BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT drivers_vehicle_check CHECK (vehicle IN ('bajaj', 'car', 'moto'));

-- Latest position per driver. One row each, overwritten: this is "where is she now", not a
-- history of everywhere she has been (that would be a record of people's movements we have no
-- use for). The fix that proves a step is kept on order_proofs instead.
CREATE TABLE driver_locations (
  driver_id   BIGINT PRIMARY KEY REFERENCES drivers (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy_m  INTEGER,
  heading     INTEGER,
  speed_kmh   INTEGER,
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT driver_locations_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT driver_locations_lng_check CHECK (lng BETWEEN -180 AND 180)
);

-- Fixed places: markets (where deliveries are bought), landmarks and districts (what people
-- give as an address in Somali cities). Search runs over these, not a geocoder.
CREATE TABLE places (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  name_en    TEXT NOT NULL,
  name_so    TEXT NOT NULL,
  city       TEXT NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT places_kind_check CHECK (kind IN ('market', 'landmark', 'district')),
  CONSTRAINT places_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT places_lng_check CHECK (lng BETWEEN -180 AND 180)
);

-- The generic catalog: common goods and meals with a fixed price. Not a restaurant's menu —
-- the driver buys them at the market with the company float, as before. Anything unusual is
-- a free-text line with a photo.
CREATE TABLE catalog_categories (
  id       SERIAL PRIMARY KEY,
  name_en  TEXT NOT NULL,
  name_so  TEXT NOT NULL,
  icon     TEXT NOT NULL DEFAULT '',
  active   BOOLEAN NOT NULL DEFAULT true,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE catalog_items (
  id          SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES catalog_categories (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  name_en     TEXT NOT NULL,
  name_so     TEXT NOT NULL,
  unit_en     TEXT NOT NULL DEFAULT '',
  unit_so     TEXT NOT NULL DEFAULT '',
  price       DECIMAL(12, 2) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT catalog_items_price_check CHECK (price > 0)
);

CREATE INDEX idx_catalog_items_category ON catalog_items (category_id, sort);

-- Requests to a payment provider (WaafiPay: EVC Plus, Zaad, Sahal). The id is the
-- provider's referenceId, so a retried request is recognisable. A confirmed attempt becomes a
-- `transactions` row through confirmPayment, like any other payment.
CREATE TABLE payment_attempts (
  id          UUID PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  provider    TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  payer       TEXT NOT NULL,
  amount      DECIMAL(12, 2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  reference   TEXT,
  detail      TEXT,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_status_check
    CHECK (status IN ('pending', 'approved', 'declined', 'unknown'))
);

-- One push at a time per order: two prompts on the customer's phone is two chances to pay twice.
CREATE UNIQUE INDEX idx_payment_attempts_one_pending ON payment_attempts (order_id)
  WHERE status = 'pending';
CREATE INDEX idx_payment_attempts_order ON payment_attempts (order_id, created_at);
