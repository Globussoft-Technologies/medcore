-- ================================================================
-- 20260522000003_pearl_referral_commission_split
--
-- Pearl ERP Stage 1 §4.1 (gap row 101) — Referring-doctor commission
-- auto-split. When an Invoice is created for a visit that names a
-- referring doctor, auto-compute the commission owed (per a
-- commissionPercent resolved Referral-override → Doctor-default) and
-- snapshot it into a `ReferralCommission` row inside the same
-- transaction as the Invoice. The §4.4 referring-doctor commission
-- ledger report (gap row 114) is a separate piece that reads these
-- rows.
--
-- Additive only — no destructive changes:
--   * Doctor.commissionPercent — nullable DECIMAL(5,2); null = no
--     auto-commission for invoices this doctor referred.
--   * Referral.commissionPercent — nullable DECIMAL(5,2) override of
--     the doctor-level default for that one referral.
--   * Invoice.referringDoctorId / referralId — both nullable; legacy
--     and walk-in invoices have no referring doctor.
--   * Brand-new table `referral_commissions` with UNIQUE invoiceId
--     so the snapshot is one-to-one (a POST /invoices retry can't
--     create a duplicate).
-- ================================================================

-- ── Doctor: default commission % ──
ALTER TABLE "doctors"
  ADD COLUMN "commissionPercent" DECIMAL(5,2);

-- ── Referral: per-referral override ──
ALTER TABLE "referrals"
  ADD COLUMN "commissionPercent" DECIMAL(5,2);

-- ── Invoice: referring-doctor + originating-referral pointers ──
ALTER TABLE "invoices"
  ADD COLUMN "referringDoctorId" TEXT,
  ADD COLUMN "referralId"        TEXT;

CREATE INDEX "invoices_referringDoctorId_idx"
  ON "invoices"("referringDoctorId");

-- ── ReferralCommission table ──
CREATE TABLE "referral_commissions" (
  "id"                TEXT NOT NULL,
  "invoiceId"         TEXT NOT NULL,
  "referringDoctorId" TEXT NOT NULL,
  "referralId"        TEXT,
  "commissionPercent" DECIMAL(5,2) NOT NULL,
  "commissionAmount"  DECIMAL(10,2) NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "paidAt"            TIMESTAMP(3),
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_commissions_pkey" PRIMARY KEY ("id")
);

-- ── Uniqueness + indexes ──
CREATE UNIQUE INDEX "referral_commissions_invoiceId_key"
  ON "referral_commissions"("invoiceId");

CREATE INDEX "referral_commissions_referringDoctorId_idx"
  ON "referral_commissions"("referringDoctorId");

CREATE INDEX "referral_commissions_tenantId_idx"
  ON "referral_commissions"("tenantId");

CREATE INDEX "referral_commissions_tenantId_status_idx"
  ON "referral_commissions"("tenantId", "status");

-- ── Foreign keys ──
ALTER TABLE "referral_commissions"
  ADD CONSTRAINT "referral_commissions_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referral_commissions"
  ADD CONSTRAINT "referral_commissions_referringDoctorId_fkey"
  FOREIGN KEY ("referringDoctorId") REFERENCES "doctors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
