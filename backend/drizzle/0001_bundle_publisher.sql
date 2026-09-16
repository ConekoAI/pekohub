ALTER TABLE "bundles" ADD COLUMN "publisher_id" uuid;--> statement-breakpoint
-- Backfill (ADR-056): legacy rows predate publisher tracking. The
-- pre-publisher ownership rule was `users.namespace == bundles.namespace`,
-- so match on that; rows under multi-segment or unmatched namespaces
-- stay NULL and remain claimable by the namespace-matching pusher.
UPDATE "bundles" b SET "publisher_id" = u.id
FROM "users" u
WHERE u."namespace" = b."namespace";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bundles" ADD CONSTRAINT "bundles_publisher_id_users_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
