/*
  Warnings:

  - The values [admin] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the `user_roles` table. If the table is not empty, all the data it contains will be lost.

  NOTE: Prisma's generated enum-swap ordered `ALTER TABLE "users" ALTER COLUMN
  "role"` before the column was added, which cannot apply. The statements below
  are reordered so the new enum + column exist before the backfill, and the old
  enum is dropped only after `user_roles` is gone. The two UPDATE statements are
  the data backfill specified in the implementation plan (Task 1, Step 5).
*/

-- Create the replacement enum with the three explicit roles.
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'DEVELOPER', 'DEFAULT_USER');

-- Add the new column (defaults everyone to DEFAULT_USER; backfill fixes it up).
ALTER TABLE "users" ADD COLUMN "role" "Role_new" NOT NULL DEFAULT 'DEFAULT_USER';

-- Backfill roles from the old user_roles table before it is dropped.
UPDATE "users" SET "role" = 'ADMIN'
  WHERE "id" IN (SELECT "user_id" FROM "user_roles" WHERE "role"::text = 'admin');
UPDATE "users" SET "role" = 'DEVELOPER'
  WHERE "id" NOT IN (SELECT "user_id" FROM "user_roles" WHERE "role"::text = 'admin');

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";

-- DropTable
DROP TABLE "user_roles";

-- Swap the enum: the old type is now unused, so drop it and promote the new one.
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
