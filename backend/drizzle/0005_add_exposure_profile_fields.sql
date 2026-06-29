ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "public_name" varchar(255);--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "category" varchar(32);--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "tos_required" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "tos_text" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "daily_quota" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "weekly_quota" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "featured" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "monetization" jsonb DEFAULT '{"enabled":false}';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_published_at" ON "instances" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_featured" ON "instances" USING btree ("featured");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_category" ON "instances" USING btree ("category");