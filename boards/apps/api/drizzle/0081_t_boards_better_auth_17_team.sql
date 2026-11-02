-- better-auth 1.7 organization/teams: seat counter on team + single-column membership key; re-runnable like 0078–0080.
-- membership_key stays NULL on legacy rows: the library falls back to the (team_id, user_id) lookup, and NULLs do not collide in a UNIQUE constraint.
ALTER TABLE "team" ADD COLUMN IF NOT EXISTS "member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "team" t SET "member_count" = c.n
FROM (SELECT "team_id", count(*)::integer AS n FROM "team_member" GROUP BY "team_id") c
WHERE c."team_id" = t."id" AND t."member_count" <> c.n;--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN IF NOT EXISTS "membership_key" text;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_member_membership_key_unique') THEN
		ALTER TABLE "team_member" ADD CONSTRAINT "team_member_membership_key_unique" UNIQUE("membership_key");
	END IF;
END $$;
