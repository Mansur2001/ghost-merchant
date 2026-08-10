/*
  Warnings:

  - You are about to drop the column `id_document_key` on the `access_requests` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "access_requests" DROP COLUMN "id_document_key",
ADD COLUMN     "id_back_key" TEXT,
ADD COLUMN     "id_front_key" TEXT;
