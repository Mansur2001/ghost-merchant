-- Two more kinds of job on the one order table (CLAUDE.md, Rides, catalog…):
--   PARCEL   send a package from one address to another (the customer is the sender)
--   SERVICE  a technician's visit (Farsamo): a prepaid visit fee by trade
-- Its own migration: Postgres can't use an enum value in the transaction that adds it.
ALTER TYPE order_kind ADD VALUE IF NOT EXISTS 'PARCEL';
ALTER TYPE order_kind ADD VALUE IF NOT EXISTS 'SERVICE';
