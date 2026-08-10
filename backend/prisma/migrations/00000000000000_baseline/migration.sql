-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PENDING_PAYMENT', 'PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED_REFUND');

-- CreateTable
CREATE TABLE "users" (
    "phone_number" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("phone_number")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" BIGSERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_phone" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "total_amount" DECIMAL(12,2) NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "landmark_text" TEXT NOT NULL,
    "driver_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID,
    "telecom_receipt_id" TEXT NOT NULL,
    "sender_msisdn" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "raw_sms" TEXT,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "client_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_photos" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" BIGSERIAL NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "failed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'owed',
    "settled_at" TIMESTAMPTZ(6),
    "settled_by" TEXT,
    "settlement_reference" TEXT,
    "settlement_note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_msisdn_key" ON "drivers"("msisdn");

-- CreateIndex
CREATE UNIQUE INDEX "operators_username_key" ON "operators"("username");

-- CreateIndex
CREATE INDEX "idx_orders_driver" ON "orders"("driver_id");

-- CreateIndex
CREATE INDEX "idx_orders_status" ON "orders"("status");

-- CreateIndex
CREATE INDEX "idx_orders_user" ON "orders"("user_phone");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_telecom_receipt_id_key" ON "transactions"("telecom_receipt_id");

-- CreateIndex
CREATE INDEX "idx_transactions_order" ON "transactions"("order_id");

-- CreateIndex
CREATE INDEX "idx_tx_sender_amount" ON "transactions"("sender_msisdn", "amount");

-- CreateIndex
CREATE INDEX "idx_messages_order" ON "messages"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_order_events_order" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_photos_object_key_key" ON "order_photos"("object_key");

-- CreateIndex
CREATE INDEX "idx_order_photos_order" ON "order_photos"("order_id", "kind");

-- CreateIndex
CREATE INDEX "idx_otp_expires" ON "otp_codes"("expires_at");

-- CreateIndex
CREATE INDEX "idx_refunds_created" ON "refunds"("created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_phone_fkey" FOREIGN KEY ("user_phone") REFERENCES "users"("phone_number") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ─────────────────────────────────────────────────────────────────────────────
-- Everything below is INVISIBLE to schema.prisma. Prisma cannot express partial
-- indexes or CHECK constraints, so they are declared here and must be carried
-- forward by hand. They are not decoration:
-- ─────────────────────────────────────────────────────────────────────────────

-- The idempotency guarantee for the offline write queue. A queued message whose response was
-- lost is replayed on reconnect; without this UNIQUE it lands twice and the customer sees
-- themselves stutter — in a delivery dispute, the transcript would be wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_client_id"
  ON "messages"("client_id") WHERE "client_id" IS NOT NULL;

-- The outbox relay's hot query: the small set of undelivered rows, in id order. Partial so it
-- stays tiny no matter how much delivered history accumulates.
CREATE INDEX IF NOT EXISTS "idx_outbox_pending"
  ON "outbox"("id") WHERE "published_at" IS NULL AND NOT "failed";

-- Retention sweep looks up delivered rows by age.
CREATE INDEX IF NOT EXISTS "idx_outbox_published_at"
  ON "outbox"("published_at") WHERE "published_at" IS NOT NULL;

-- Login looks up by username among ACTIVE accounts only.
CREATE INDEX IF NOT EXISTS "idx_operators_active"
  ON "operators"("username") WHERE "active";

-- One OPEN refund per order: an order cannot owe the same money twice. Settled/waived rows
-- don't block a later one (a re-opened dispute), hence partial.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_refunds_one_open"
  ON "refunds"("order_id") WHERE "status" = 'owed';

-- The reconciliation queue: everything still owed.
CREATE INDEX IF NOT EXISTS "idx_refunds_owed"
  ON "refunds"("created_at") WHERE "status" = 'owed';

-- Value constraints Prisma does not model.
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_amount_check" CHECK ("total_amount" >= 0);
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_kind_check"
  CHECK ("kind" IN ('order_ref', 'delivery_proof'));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check"
  CHECK ("status" IN ('owed', 'settled', 'waived'));
