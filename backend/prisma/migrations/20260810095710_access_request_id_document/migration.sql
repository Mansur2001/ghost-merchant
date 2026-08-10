-- AlterTable
ALTER TABLE "access_requests" ADD COLUMN     "id_document_at" TIMESTAMPTZ(6),
ADD COLUMN     "id_document_key" TEXT;
