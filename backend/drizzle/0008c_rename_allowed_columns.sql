-- 0008c — rename `allowed_users` → `allowed_principals` and
-- backfill the typed subject array (ADR-041)
--
-- The legacy `allowed_users` column held bare user-id strings. The
-- new `allowed_principals` holds an array of typed `Subject` records
-- (`{ kind, id }`). Pre-#11 rows need to be rewritten from
-- `["alice", "bob"]` to `[{ kind: "user", id: "alice" }, { kind:
-- "user", id: "bob" }]`.
--
-- Step 1: add the new column.
-- Step 2: backfill from the old column when the old column's
-- contents are bare strings.
-- Step 3: drop the old column.
ALTER TABLE "instances" ADD COLUMN "allowed_principals_new" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
UPDATE "instances"
   SET "allowed_principals_new" = COALESCE(
     (
       SELECT jsonb_agg(jsonb_build_object('kind', 'user', 'id', elem))
         FROM jsonb_array_elements_text("allowed_users") AS elem
     ),
     '[]'::jsonb
   )
 WHERE jsonb_typeof("allowed_users") = 'array';--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "allowed_users";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "allowed_principals_new" TO "allowed_principals";
