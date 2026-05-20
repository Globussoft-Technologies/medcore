-- ================================================================
-- 20260520000003_pearl_m1_doctor_nmc_reg_number
--
-- Pearl ERP Stage 1 §2.1.4 hard acceptance — every signed Rx PDF
-- must carry the prescriber's NMC (National Medical Commission)
-- registration number. The Doctor model had `signatureUrl` and
-- `qualification` but not the registration number itself.
--
-- Additive + backward-compatible: nullable String column. Existing
-- doctors get NULL and the PDF renders "-" until an admin fills it
-- in via the doctor settings editor. The Rx PDF generator and the
-- /dashboard/doctors/:id detail page read this column.
-- ================================================================

ALTER TABLE "doctors" ADD COLUMN "nmcRegNumber" TEXT;
