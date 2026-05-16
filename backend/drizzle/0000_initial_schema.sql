CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(128) NOT NULL,
	"prefix" varchar(8) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"namespace" varchar(128) NOT NULL,
	"user_id" integer,
	"action" varchar(64) NOT NULL,
	"resource" varchar(256) NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"digest" varchar(71) NOT NULL,
	"size" integer NOT NULL,
	"media_type" varchar(128),
	"storage_key" varchar(512) NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	CONSTRAINT "blobs_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bundle_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer NOT NULL,
	"version" varchar(64) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"size" integer NOT NULL,
	"deprecated" boolean DEFAULT false,
	"deprecated_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"namespace" varchar(128) NOT NULL,
	"name" varchar(128) NOT NULL,
	"bundle_type" varchar(32) NOT NULL,
	"extension_type" varchar(32),
	"description" text,
	"author" varchar(256),
	"license" varchar(64),
	"tags" jsonb,
	"categories" jsonb,
	"model_providers" jsonb,
	"required_mcp_servers" jsonb,
	"homepage" text,
	"repository" text,
	"readme" text,
	"forked_from" varchar(256),
	"star_count" integer DEFAULT 0 NOT NULL,
	"pull_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pull_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer NOT NULL,
	"version_id" integer,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" varchar(256) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"namespace" varchar(128) NOT NULL,
	"display_name" varchar(256),
	"email" varchar(256),
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_namespace_unique" UNIQUE("namespace")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bundle_versions" ADD CONSTRAINT "bundle_versions_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pull_stats" ADD CONSTRAINT "pull_stats_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pull_stats" ADD CONSTRAINT "pull_stats_version_id_bundle_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."bundle_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blob_digest_idx" ON "blobs" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bundle_version_idx" ON "bundle_versions" USING btree ("bundle_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digest_idx" ON "bundle_versions" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "namespace_name_idx" ON "bundles" USING btree ("namespace","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_type_idx" ON "bundles" USING btree ("bundle_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_idx" ON "bundles" USING btree ("namespace","name","description");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_date_idx" ON "pull_stats" USING btree ("bundle_id","date");