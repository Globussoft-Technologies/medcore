-- ================================================================
-- 20260525000002_add_patient_city_and_whatsapp_optin
--
-- Pearl ERP Stage 1 §5.1 row 161 closure: lands the two demographic /
-- consent columns the audience-compiler was emitting no-ops for.
--
-- Adds 2 columns to `patients`:
--   - city          — TEXT NULL. Explicit city field separate from the
--                     freetext `address` column. Legacy patients stay
--                     valid with city=NULL (city filter only matches
--                     non-null rows when active).
--   - whatsappOptIn — BOOLEAN NOT NULL DEFAULT false. Affirmative opt-in
--                     for marketing/campaign pushes via WhatsApp. DPDP-
--                     aligned — defaults to false so legacy patients
--                     are NOT auto-enrolled into marketing.
--
-- Strictly additive — no existing column altered, no FK, no backfill.
-- ================================================================

ALTER TABLE "patients"
    ADD COLUMN "city"          TEXT,
    ADD COLUMN "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false;
