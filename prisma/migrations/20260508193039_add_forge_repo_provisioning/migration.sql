/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `forges` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[repo_full_name]` on the table `forges` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `repo_full_name` to the `forges` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "forges" ADD COLUMN     "repo_full_name" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "forges_name_key" ON "forges"("name");

-- CreateIndex
CREATE UNIQUE INDEX "forges_repo_full_name_key" ON "forges"("repo_full_name");
