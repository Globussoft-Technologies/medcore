-- ================================================================
-- 20260517000005_backfill_admission_total_bill_from_ipd_invoices
--
-- Closes: #900 part 1 of 2 — backfill admissions.totalBillAmount from
-- the IPD-consolidated invoices that ARE being raised against them.
-- The route fix (apps/api/src/routes/billing.ts on this commit) makes
-- the IPD invoice POST atomically increment the admission column;
-- this backfill brings existing admissions up to date.
--
-- Background:
--   Staging showed 6 of 8 currently-ADMITTED patients with
--   totalBillAmount = 0 despite stays of up to 30 days. The IPD
--   consolidated-invoice POST (the only billing path admissions
--   currently feed) was creating invoices but never updating the
--   admission column. Per-service accumulators (per-day bed,
--   drug-dispense, lab-order, OT) remain separate build work.
--
-- Linkage:
--   IPD invoices are stamped with `notes` matching '[IPD <admissionNumber>]'
--   when the consolidated-invoice route fires (billing.ts line ~2497).
--   This marker is the only deterministic invoice→admission link in
--   the schema today (no admissionId FK on Invoice). The backfill
--   uses it as the join key.
--
-- Scope:
--   - Only sum invoices for the matching admissionNumber prefix.
--   - Always overwrite totalBillAmount with the recomputed SUM
--     (not increment) so re-running on a partially-correct DB
--     converges to truth.
--
-- Idempotent: re-running matches the same admissions and computes
-- the same sums.
-- ================================================================

UPDATE "admissions" a
   SET "totalBillAmount" = COALESCE(s.total, 0)
  FROM (
    SELECT
      a2."id" AS admission_id,
      SUM(i."totalAmount") AS total
    FROM "admissions" a2
    JOIN "invoices" i
      ON i."notes" LIKE CONCAT('[IPD ', a2."admissionNumber", ']%')
    GROUP BY a2."id"
  ) s
 WHERE a."id" = s.admission_id;
