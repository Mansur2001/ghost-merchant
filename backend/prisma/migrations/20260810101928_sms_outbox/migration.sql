-- CreateTable
CREATE TABLE "sms_outbox" (
    "id" BIGSERIAL NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),

    CONSTRAINT "sms_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_sms_outbox_pending" ON "sms_outbox"("created_at");
