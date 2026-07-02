-- CreateEnum
CREATE TYPE "BumpLevel" AS ENUM ('major', 'minor', 'patch');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('checks_running', 'checks_failed', 'awaiting_approval', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "promotion_requests" (
    "id" UUID NOT NULL,
    "forge_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "pr_url" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "bump_level" "BumpLevel" NOT NULL,
    "target_version" TEXT NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'checks_running',
    "image_ref" TEXT,
    "summary" JSONB,
    "approved_by" UUID,
    "reject_reason" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promotion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_requests_forge_id_idx" ON "promotion_requests"("forge_id");

-- CreateIndex
CREATE INDEX "promotion_requests_status_idx" ON "promotion_requests"("status");

-- AddForeignKey
ALTER TABLE "promotion_requests" ADD CONSTRAINT "promotion_requests_forge_id_fkey" FOREIGN KEY ("forge_id") REFERENCES "forges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_requests" ADD CONSTRAINT "promotion_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_requests" ADD CONSTRAINT "promotion_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
