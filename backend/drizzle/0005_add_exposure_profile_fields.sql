ALTER TABLE "instances" ADD COLUMN "public_name" varchar(255);--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "tags" jsonb DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "category" varchar(32);--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "tos_required" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "tos_text" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "daily_quota" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "weekly_quota" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "featured" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "monetization" jsonb DEFAULT '{"enabled":false}';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_published_at" ON "instances" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_featured" ON "instances" USING btree ("featured");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_category" ON "instances" USING btree ("category");