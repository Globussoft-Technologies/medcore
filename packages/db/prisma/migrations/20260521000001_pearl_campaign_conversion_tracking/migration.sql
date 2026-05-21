-- ================================================================
-- 20260521000001_pearl_campaign_conversion_tracking
--
-- Pearl ERP Stage 1 §5.1 piece 3c — click + conversion attribution.
-- The piece-2b dispatcher already writes a CampaignSend per
-- (patient, channel) at delivery; this migration adds the four
-- columns the click-tracker + conversion helper backfill at later
-- points in time:
--
--   * clickedAt        — set by GET /api/v1/campaigns/click/:sendId
--                        when the recipient taps the trackable URL the
--                        dispatcher mints into the message body.
--   * convertedAt      — set by recordCampaignConversion() when a
--                        downstream event (appointment booked /
--                        invoice generated within the attribution
--                        window, default 7 days) is credited to this
--                        send.
--   * convertedRefId   — the appointment.id / invoice.id that earned
--                        the credit (so the operator can drill down
--                        from the stats endpoint).
--   * convertedType    — discriminator: "APPOINTMENT" | "INVOICE" |
--                        future. Kept as TEXT (not an enum) so the
--                        attribution catalog can grow without
--                        chained migrations.
--
-- And on Campaign:
--   * linkTargetUrl    — the destination the click endpoint 302s to
--                        AFTER recording clickedAt. Per-campaign so
--                        the marketer can land each campaign on its
--                        own landing page / booking deep-link.
--
-- All columns are nullable and additive — existing CampaignSend rows
-- written by piece 2b stay valid (clickedAt=NULL = "no recorded click";
-- convertedAt=NULL = "not yet attributed").
-- ================================================================

ALTER TABLE "campaign_sends"
  ADD COLUMN "clickedAt"      TIMESTAMP(3),
  ADD COLUMN "convertedAt"    TIMESTAMP(3),
  ADD COLUMN "convertedRefId" TEXT,
  ADD COLUMN "convertedType"  TEXT;

ALTER TABLE "campaigns"
  ADD COLUMN "linkTargetUrl" TEXT;

-- Index for fast attribution lookups: "find this patient's most
-- recent clicked-but-not-converted CampaignSend within the last N
-- days." Composite (patientId, clickedAt) is enough — convertedAt
-- IS NULL filter prunes the small tail in-memory.
CREATE INDEX "campaign_sends_patientId_clickedAt_idx"
  ON "campaign_sends" ("patientId", "clickedAt");
