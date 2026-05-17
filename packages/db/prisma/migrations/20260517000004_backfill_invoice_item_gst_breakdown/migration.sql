-- ================================================================
-- 20260517000004_backfill_invoice_item_gst_breakdown
--
-- Closes: #894 — invoice line items showed cgst:0 / sgst:0 / gstRate:0 /
-- hsnSac:null on EVERY line while the invoice header carried real
-- cgstAmount + sgstAmount + taxAmount. The rendered PDF therefore
-- showed "HSN/SAC 9993, CGST Rs.0.00, SGST Rs.0.00" per row under a
-- non-zero Total GST footer — invalid as a GST tax invoice under
-- CGST Rule 46(g) (per-line HSN) and Rule 46(i)/(j) (per-line CGST/SGST).
--
-- The route fix (apps/api/src/routes/billing.ts on this commit) makes
-- NEW invoices persist the per-line GST snapshot correctly. This
-- migration backfills HISTORICAL line items with the same breakdown
-- the new code would produce — distributing the parent invoice's
-- taxAmount proportionally to line.amount and tagging hsnSac from the
-- canonical category mapping.
--
-- Two-pass:
--   1. Populate cgst/sgst/gstRate for items on invoices where header
--      taxAmount > 0 AND subtotal > 0 (the broken case from the bug
--      report). Skip rows that already have non-zero GST (idempotent
--      re-runs / migrations that landed mid-cleanup).
--   2. Populate hsnSac for ALL rows where it's null, regardless of
--      whether the line was taxed (a Rs.0-GST line still needs an
--      HSN per Rule 46(g) for B2B invoices).
--
-- HSN/SAC mapping mirrors packages/shared/src/validation/finance.ts:
--   MEDICINE / PHARMACY → 3004 (formulated drugs)
--   everything else     → 9993 (healthcare services)
--
-- Idempotent: re-running matches zero rows once the backfill completes.
-- ================================================================

-- ── Pass 1: backfill per-line GST breakdown from header proportions ─
-- Subquery joins each invoice_item to its parent invoice so we can
-- compute line.gstRate = inv.taxAmount / inv.subtotal * 100, then
-- distribute the line's share proportionally.
UPDATE "invoice_items" ii
   SET "cgst"    = ROUND(((ii."amount" * "inv"."taxAmount" / NULLIF("inv"."subtotal", 0)) / 2)::numeric, 2)::double precision,
       "sgst"    = ROUND(((ii."amount" * "inv"."taxAmount" / NULLIF("inv"."subtotal", 0))
                          - ((ii."amount" * "inv"."taxAmount" / NULLIF("inv"."subtotal", 0)) / 2))::numeric, 2)::double precision,
       "gstRate" = ROUND(("inv"."taxAmount" / NULLIF("inv"."subtotal", 0) * 100)::numeric, 2)::double precision
  FROM "invoices" "inv"
 WHERE ii."invoiceId" = "inv".id
   AND ii."cgst" = 0
   AND ii."sgst" = 0
   AND ii."gstRate" = 0
   AND "inv"."subtotal" > 0
   AND "inv"."taxAmount" > 0;

-- ── Pass 2: backfill HSN/SAC for any line item missing it ────────
-- Independent of the GST math — HSN/SAC is required on B2B invoices
-- regardless of whether the line carries tax. Most categories map to
-- 9993 (healthcare services SAC); medicine-sale lines use 3004 (drugs
-- HSN). Mirrors hsnSacForCategory() in packages/shared.
UPDATE "invoice_items"
   SET "hsnSac" = CASE
                    WHEN UPPER("category") IN ('MEDICINE', 'PHARMACY') THEN '3004'
                    ELSE '9993'
                  END
 WHERE "hsnSac" IS NULL;
