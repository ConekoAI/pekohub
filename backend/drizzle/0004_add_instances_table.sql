CREATE TABLE IF NOT EXISTS "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_id" integer NOT NULL,
	"runtime_id" varchar(255) NOT NULL,
	"runtime_display_name" varchar(255),
	"bundle_ref" varchar(255),
	"status" varchar(20) DEFAULT 'offline' NOT NULL,
	"exposure" varchar(20) DEFAULT 'unexposed' NOT NULL,
	"allowed_users" jsonb DEFAULT '[]',
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"capabilities" jsonb DEFAULT '[]',
	"metadata" jsonb DEFAULT '{}'
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "instances" ADD CONSTRAINT "instances_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_owner_id" ON "instances" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_runtime_id" ON "instances" USING btree ("runtime_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_exposure_status" ON "instances" USING btree ("exposure","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_last_seen_at" ON "instances" USING btree ("last_seen_at");