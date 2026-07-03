-- 0009 — add transport preference and advertised direct endpoint
--
-- * instances.transport_preference: callee-side preference for
--   principal_send (auto | tunnel | direct).
-- * runtimes.direct_endpoint: the URL the runtime advertises for inbound
--   direct WebSocket connections.
--
-- The rename of owner_principal → owner_subject catches up the
-- production schema with the code model that was already in place
-- before this migration; it is guarded so it is safe to re-run.

ALTER TABLE "instances"
  ADD COLUMN IF NOT EXISTS "transport_preference" varchar(20) DEFAULT 'auto' NOT NULL;--> statement-breakpoint

ALTER TABLE "runtimes"
  ADD COLUMN IF NOT EXISTS "direct_endpoint" varchar(512);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instances' AND column_name = 'owner_principal'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instances' AND column_name = 'owner_subject'
  ) THEN
    ALTER TABLE "instances" RENAME COLUMN "owner_principal" TO "owner_subject";
  END IF;
END
$$;
