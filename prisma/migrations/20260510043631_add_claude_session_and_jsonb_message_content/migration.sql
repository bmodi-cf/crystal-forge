-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "claude_session_id" UUID;

-- AlterTable
ALTER TABLE "messages"
  ALTER COLUMN "content" TYPE JSONB
  USING jsonb_build_array(jsonb_build_object('type', 'text', 'text', "content"));
