CREATE TABLE IF NOT EXISTS "hub_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signing_did" varchar(512) NOT NULL,
	"identity_key" varchar(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_principals_signing_did_unique" UNIQUE("signing_did"),
	CONSTRAINT "hub_principals_identity_key_unique" UNIQUE("identity_key")
);
--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "exposure" SET DEFAULT 'local_only';--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "hub_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "local_id" varchar(255);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "instances" ADD CONSTRAINT "instances_hub_id_hub_principals_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hub_principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
