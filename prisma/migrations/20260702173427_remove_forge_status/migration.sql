-- DropIndex
DROP INDEX "forges_status_idx";

-- AlterTable
ALTER TABLE "forges" DROP COLUMN "status";

-- DropEnum
DROP TYPE "ForgeStatus";
