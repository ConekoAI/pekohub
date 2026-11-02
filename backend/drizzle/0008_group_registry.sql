CREATE TABLE IF NOT EXISTS "hub_group_members" (
	"group_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_groups" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"home_runtime" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_address" varchar(255) NOT NULL,
	"visibility" varchar(16) DEFAULT 'invite_only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hub_group_members" ADD CONSTRAINT "hub_group_members_group_id_hub_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."hub_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hub_group_members" ADD CONSTRAINT "hub_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hub_groups" ADD CONSTRAINT "hub_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_group_members_user_idx" ON "hub_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_groups_home_channel_unique" ON "hub_groups" USING btree ("home_runtime","channel_id");