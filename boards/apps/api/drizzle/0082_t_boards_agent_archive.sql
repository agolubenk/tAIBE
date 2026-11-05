-- TB-74: an agent idle for a day goes to the archive and leaves the owner's cap; nullable, no backfill, re-runnable like 0078–0081.
ALTER TABLE "agent_profile" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;
