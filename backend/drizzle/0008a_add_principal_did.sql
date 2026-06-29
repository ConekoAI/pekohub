-- 0008a — add `principal_did` (ADR-041)
--
-- Adds the new column that the by-did resolver will use, alongside
-- the existing `agent_did`. The runtime emits
-- `did:peko:principal:<keyhash>` post-#82, so the new column is the
-- authoritative key for new rows.
--
-- Backfill: copy any pre-existing `agent_did` value into
-- `principal_did` so a half-applied migration leaves the DB in a
-- queryable state — the by-did resolver falls through to `agent_did`
-- for older rows until `0008d` drops it.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "principal_did" varchar(512);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_instances_principal_did" ON "instances" USING btree ("principal_did");--> statement-breakpoint
UPDATE "instances" SET "principal_did" = "agent_did" WHERE "agent_did" IS NOT NULL;
