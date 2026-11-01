DROP INDEX IF EXISTS "digest_idx";--> statement-breakpoint
ALTER TABLE "bundle_versions" ALTER COLUMN "manifest_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bundle_versions" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "display_name" varchar(256);--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "avatar" varchar(64);--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "model" varchar(256);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digest_idx" ON "bundle_versions" USING btree ("digest");