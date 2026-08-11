-- CreateTable
CREATE TABLE "call_challenges" (
    "phone" TEXT NOT NULL,
    "ticket_hash" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_open_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_challenges_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE INDEX "idx_call_challenge_expires" ON "call_challenges"("expires_at");
