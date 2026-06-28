-- 0008d — drop the legacy `agent_did` column (ADR-041)
--
-- Final step of the principal migration: drop the column that was
-- the by-did key in the pre-#82 runtime. The by-did resolver now
-- reads `principal_did` exclusively. The unique index on
-- `agent_did` is dropped first so the column drop succeeds.
DROP INDEX IF EXISTS "idx_instances_agent_did";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN IF EXISTS "agent_did";
