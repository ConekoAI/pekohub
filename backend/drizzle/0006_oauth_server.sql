CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
	"code_hash" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"scope" varchar(256),
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_device_codes" (
	"device_code_hash" varchar(64) PRIMARY KEY NOT NULL,
	"user_code" varchar(16) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"scope" varchar(256),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "client_id" varchar(64);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_device_codes_user_code_idx" ON "oauth_device_codes" USING btree ("user_code");