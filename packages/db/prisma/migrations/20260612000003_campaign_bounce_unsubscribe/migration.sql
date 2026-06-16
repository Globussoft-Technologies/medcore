-- Pearl §5.1 — campaign bounce + unsubscribe tracking.
-- Adds: SendStatus.UNSUBSCRIBED enum value + bouncedAt/unsubscribedAt columns
-- on campaign_sends. Additive, nullable; zero-data-loss. Idempotent + uses the
-- @@map'd lowercase table name ("campaign_sends") so `migrate deploy` (raw SQL)
-- applies cleanly.
DO $$ BEGIN
  ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'UNSUBSCRIBED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "campaign_sends" ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3);
ALTER TABLE "campaign_sends" ADD COLUMN IF NOT EXISTS "unsubscribedAt" TIMESTAMP(3);
