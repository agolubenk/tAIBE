ALTER TABLE "owner_approval" ADD COLUMN "fail_reason" text;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD COLUMN "done_ref" text;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD COLUMN "done_reason" text;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD COLUMN "queue_item_id" text;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD COLUMN "queue_item_version" integer;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD COLUMN "queue_synced_status" text;--> statement-breakpoint
CREATE INDEX "owner_approval_status_expires_idx" ON "owner_approval" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_approval_queue_item_idx" ON "owner_approval" USING btree ("queue_item_id");