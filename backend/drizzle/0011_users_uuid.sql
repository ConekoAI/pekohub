-- H3: switch users.id from serial to UUID.
--
-- The runtime always emits `user.id` as a string (it lives in JWT `sub`
-- and the `x-pekohub-user-id` tunnel header), so the integer FK
-- round-trip through pekohub -> runtime -> pekohub was a coercion
-- hazard. A native UUID column is the canonical shape on both sides.
--
-- Pre-launch — no migration of existing rows is needed.
--
-- Dependency order: drop FKs, alter columns, recreate FKs. The
-- `api_keys.user_id`, `refresh_tokens.user_id`, `runtimes.owner_id`,
-- and `audit_logs.user_id` columns all reference users.id and must
-- be widened together. We use `USING gen_random_uuid()` because the
-- pre-launch DB has no rows to preserve; the column change is a
-- type-and-default swap, not a row-by-row rewrite.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop FKs that reference users.id before altering the column type.
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "runtimes" DROP CONSTRAINT IF EXISTS "runtimes_owner_id_fkey";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_user_id_fkey";
--> statement-breakpoint

-- users.id: serial -> uuid
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint

-- Widen the FK columns. No row values to preserve (pre-launch);
-- gen_random_uuid() materializes default UUIDs for any new rows
-- added during the migration gap, but no existing rows are touched.
ALTER TABLE "api_keys" ALTER COLUMN "user_id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "user_id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "runtimes" ALTER COLUMN "owner_id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "user_id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint

-- Recreate FKs against the new UUID users.id.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "runtimes"
  ADD CONSTRAINT "runtimes_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");
