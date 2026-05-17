-- ================================================================
-- 20260517000003_backfill_invoice_due_date
--
-- Closes: #902 part 1 of 2 — backfill existing PENDING/PARTIAL invoices
-- with dueDate = createdAt + 14 days so AR can age and dunning has a
-- baseline to fire against. The companion route fix
-- (apps/api/src/routes/billing.ts on this commit) ensures NEW invoices
-- get the same default automatically.
--
-- Background:
--   Staging showed ~50 of 100 PENDING invoices with dueDate=null. The
--   route omitted dueDate when the client didn't pass one, leaving the
--   column NULL — receivables sat at 0 days indefinitely, no dunning,
--   no late-fee revenue, no aged-AR visibility.
--
-- Scope:
--   - Only update invoices where dueDate IS NULL (don't overwrite
--     explicitly-set due dates).
--   - Only update PENDING or PARTIAL invoices — PAID invoices don't
--     need a due date anymore (and setting one would confuse aged-AR
--     reports retroactively).
--   - Use the same 14-day default the route now applies; if a tenant
--     changes `invoice_default_due_days` later, new invoices follow
--     the new policy but back-filled ones keep the 14-day anchor (no
--     migration re-runs).
--
-- Idempotent: re-running matches zero rows once dueDates are set.
-- ================================================================

UPDATE "invoices"
   SET "dueDate" = "createdAt" + INTERVAL '14 days'
 WHERE "dueDate" IS NULL
   AND "paymentStatus" IN ('PENDING', 'PARTIAL');
