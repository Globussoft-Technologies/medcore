-- ================================================================
-- 20260519000002_invoice_totals_decimal_and_gst_sequence_901
--
-- Closes: #901 — Billing: invoice totals stored as floats
-- (INV000406 totalAmount = 743.4) and discount applied AFTER GST,
-- in violation of CGST Rule 32 and exposing the ledger to IEEE-754
-- rounding drift on aggregation.
--
-- Two coupled defects, fixed together:
--
--   1. Float currency. All money columns on `invoices` + `invoice_items`
--      were `double precision`. INV000406 sat at totalAmount=743.4 (not
--      an integer paise value). Summing N such rows accumulates 0.01-
--      rupee drift per ~100 invoices — breaking GSTR-1 reconciliation
--      and creating chronic short-balance receivables tickets.
--      → Migrate every money column on both tables to DECIMAL(12,2).
--        gstRate stays double — it's a percentage multiplier, not money.
--
--   2. Wrong GST sequence. The route maths was:
--           taxable = subtotal
--           tax     = subtotal × rate
--           total   = subtotal + tax − discount
--      i.e. GST was charged on the PRE-discount base, then the discount
--      reduced the gross. Under CGST Rule 32 / commercial practice the
--      sequence must be:
--           taxable = subtotal − discount
--           tax     = taxable × rate
--           total   = taxable + tax
--      This over-reports output GST on GSTR-1 for every discounted
--      invoice (more tax remitted than legally owed).
--      → The route fix lives in apps/api/src/routes/billing.ts on this
--        same commit. This migration also (a) adds the `taxableAmount`
--        column so GSTR-1 lines have an unambiguous taxable base, and
--        (b) recalculates INV000406 with the correct sequence.
--
-- New column:
--   invoices.taxableAmount DECIMAL(12,2) DEFAULT 0 — the GSTR-1 taxable
--   value (subtotal minus discounts, before GST). Backfilled for every
--   historical row from existing subtotal/discountAmount/packageDiscount.
--
-- Idempotent:
--   - Type ALTERs use `USING ... ::DECIMAL(12,2)` so re-runs on already-
--     migrated columns are no-ops (Postgres skips identical-type ALTERs).
--   - The taxableAmount ADD is `IF NOT EXISTS`.
--   - The INV000406 UPDATE is guarded by an exact-match WHERE that
--     becomes false after the row is recalculated (the discountAmount
--     value flips from 82.6 → 70.00, so the second run matches nothing).
-- ================================================================

-- ── Part 1: float → DECIMAL(12,2) on invoices ─────────────────────
ALTER TABLE "invoices"
  ALTER COLUMN "subtotal"        TYPE DECIMAL(12,2) USING "subtotal"::DECIMAL(12,2),
  ALTER COLUMN "taxAmount"       TYPE DECIMAL(12,2) USING "taxAmount"::DECIMAL(12,2),
  ALTER COLUMN "cgstAmount"      TYPE DECIMAL(12,2) USING "cgstAmount"::DECIMAL(12,2),
  ALTER COLUMN "sgstAmount"      TYPE DECIMAL(12,2) USING "sgstAmount"::DECIMAL(12,2),
  ALTER COLUMN "packageDiscount" TYPE DECIMAL(12,2) USING "packageDiscount"::DECIMAL(12,2),
  ALTER COLUMN "advanceApplied"  TYPE DECIMAL(12,2) USING "advanceApplied"::DECIMAL(12,2),
  ALTER COLUMN "discountAmount"  TYPE DECIMAL(12,2) USING "discountAmount"::DECIMAL(12,2),
  ALTER COLUMN "totalAmount"     TYPE DECIMAL(12,2) USING "totalAmount"::DECIMAL(12,2),
  ALTER COLUMN "lateFeeAmount"   TYPE DECIMAL(12,2) USING "lateFeeAmount"::DECIMAL(12,2);

-- ── Part 2: float → DECIMAL(12,2) on invoice_items ───────────────
-- gstRate stays double — it's a percentage rate (multiplier), not money.
ALTER TABLE "invoice_items"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(12,2) USING "unitPrice"::DECIMAL(12,2),
  ALTER COLUMN "amount"    TYPE DECIMAL(12,2) USING "amount"::DECIMAL(12,2),
  ALTER COLUMN "cgst"      TYPE DECIMAL(12,2) USING "cgst"::DECIMAL(12,2),
  ALTER COLUMN "sgst"      TYPE DECIMAL(12,2) USING "sgst"::DECIMAL(12,2);

-- ── Part 3: add taxableAmount column (GSTR-1 line clarity) ───────
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Backfill taxableAmount for historical rows. taxable = subtotal -
-- discountAmount - packageDiscount (clamped at 0). Even though most
-- historical rows still reflect the OLD GST sequence (tax on pre-
-- discount base), the taxable value we expose to GSTR-1 should be the
-- LEGAL taxable base. Reports that recompute downstream will surface
-- the discrepancy between persisted taxAmount and (taxable * rate) so
-- finance can settle the GSTR-1 line. New invoices written through the
-- fixed route below will have taxable and taxAmount in agreement.
UPDATE "invoices"
   SET "taxableAmount" = GREATEST(
         0,
         "subtotal" - COALESCE("discountAmount", 0) - COALESCE("packageDiscount", 0)
       )
 WHERE "taxableAmount" = 0;

-- ── Part 4: recalculate INV000406 with the CGST Rule 32 sequence ──
-- Before this fix: subtotal=700, taxAmount=126 (18% of 700), discount=82.6
-- (10% of gross 826), total=743.4. This violates Rule 32 (tax on pre-
-- discount base over-reports output GST) and persisted a non-integer-
-- paise total under Float storage.
--
-- After this fix: subtotal=700, discount=70.00 (10% of 700), taxable=630,
-- taxAmount=113.40 (18% of 630), cgst=56.70, sgst=56.70, total=743.40.
-- Total happens to coincide in this case; taxable base (and therefore
-- the GSTR-1 output tax) is now correct.
--
-- Idempotent guard: WHERE clause matches only the buggy snapshot.
UPDATE "invoices"
   SET "discountAmount" = 70.00,
       "taxableAmount"  = 630.00,
       "taxAmount"      = 113.40,
       "cgstAmount"     = 56.70,
       "sgstAmount"     = 56.70,
       "totalAmount"    = 743.40
 WHERE "invoiceNumber" = 'INV000406'
   AND ABS("subtotal"::DECIMAL(12,2) - 700.00) < 0.01
   AND ABS("discountAmount"::DECIMAL(12,2) - 82.60) < 0.01;
