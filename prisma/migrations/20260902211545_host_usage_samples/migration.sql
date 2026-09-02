-- CreateTable
CREATE TABLE "host_samples" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu_jiffies_total" BIGINT NOT NULL,
    "cpu_jiffies_idle" BIGINT NOT NULL,
    "cpu_jiffies_iowait" BIGINT NOT NULL,
    "cpu_count" INTEGER NOT NULL,
    "mem_total" BIGINT NOT NULL,
    "mem_available" BIGINT NOT NULL,
    "disk_total" BIGINT NOT NULL,
    "disk_available" BIGINT NOT NULL,
    "docker_images" BIGINT,
    "docker_containers" BIGINT,
    "docker_volumes" BIGINT,
    "docker_build_cache" BIGINT,
    "running_forges" INTEGER,

    CONSTRAINT "host_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_samples_at_idx" ON "host_samples"("at");
