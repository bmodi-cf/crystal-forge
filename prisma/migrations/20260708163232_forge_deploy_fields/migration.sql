-- AlterTable
ALTER TABLE "forges" ADD COLUMN     "deploy_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deploy_version" TEXT;
