ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "hooks" jsonb;--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "compatibility" jsonb;