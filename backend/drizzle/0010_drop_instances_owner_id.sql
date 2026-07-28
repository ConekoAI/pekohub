-- 0010 — drop legacy `instances.owner_id` integer column (H1)
--
-- Pre-launch: every row in the column was backfilled into the typed
-- `owner_subject` JSONB column by migration 0008a; dropping `owner_id`
-- loses no owner information. The typed column is the source of truth
-- for "who owns this instance" from this release onward.
--
-- This migration:
--   1. Drops the B-tree index that existed only to serve the integer FK.
--   2. Drops the FK constraint `instances_owner_id_fkey` to `users.id`.
--   3. Drops the `instances.owner_id` column itself.
--
-- The `runtimes.owner_id` column on the sibling table is unaffected —
-- it remains in use (H1 is scoped to `instances` only, per audit H1).
--
-- After this migration the application's join from instances to users
-- routes through `owner_subject->>'id'` (cast to `users.id`'s type)
-- instead of the integer FK. See services/instances.ts and
-- routes/api/instances.ts for the new query shape.

DROP INDEX IF EXISTS "idx_instances_owner_id";--> statement-breakpoint

ALTER TABLE "instances"
  DROP CONSTRAINT IF EXISTS "instances_owner_id_fkey";--> statement-breakpoint

ALTER TABLE "instances"
  DROP COLUMN IF EXISTS "owner_id";