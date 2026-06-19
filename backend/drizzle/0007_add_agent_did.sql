ALTER TABLE "instances" ADD COLUMN "agent_did" varchar(512);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_instances_agent_did" ON "instances" USING btree ("agent_did");