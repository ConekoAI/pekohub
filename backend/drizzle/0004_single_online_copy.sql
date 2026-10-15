-- ADR-081 D7: one online copy per principal. Keep the most recently seen
-- instance for each Hub ID before the link becomes unique.
DELETE FROM "instances" a
USING "instances" b
WHERE a."hub_id" IS NOT NULL
  AND a."hub_id" = b."hub_id"
  AND (COALESCE(a."last_seen_at", a."created_at"), a."id")
    < (COALESCE(b."last_seen_at", b."created_at"), b."id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "principal_move_approvals" (
	"hub_id" uuid PRIMARY KEY NOT NULL,
	"runtime_id" varchar(255) NOT NULL,
	"approved_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "principal_move_approvals" ADD CONSTRAINT "principal_move_approvals_hub_id_hub_principals_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hub_principals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "principal_move_approvals" ADD CONSTRAINT "principal_move_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instances_hub_id_unique" ON "instances" USING btree ("hub_id");