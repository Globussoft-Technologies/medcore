-- ================================================================
-- 20260517000002_scrub_e2e_seed_notes_and_mock_razorpay_from_billing
--
-- Closes: #903 (E2E billing test fixtures leaking into live ledger)
--
-- Two data-hygiene defects on live Billing observed on staging:
--
--   1. ~34% of invoices carry `notes` starting with "E2E " — relic of
--      seed scripts that ran against the live tenant. Invoices like
--      INV000426 even show "E2E billing-id seed (PENDING — no payments)"
--      on the PDF footer while having real payments + PAID watermark.
--      These notes are confusing for auditors and embarrassing on
--      patient receipts.
--
--   2. Some invoices reference `razorpayOrderId: "order_mock_*"` — a
--      sandbox/mock token from the razorpay.ts mock-fallback path that
--      kicked in when RAZORPAY_KEY_ID/SECRET were unset. These tokens
--      are unverifiable against the Razorpay dashboard and cannot be
--      refunded through the gateway. The companion runtime fix (in
--      services/razorpay.ts on this commit) makes the mock path
--      fail-closed in production so new mock tokens cannot be created;
--      this migration cleans up what's already at rest.
--
-- Conservative scrubbing:
--   - `notes` patterns: only strings starting with "E2E " (literal,
--     case-sensitive) are scrubbed. We don't match "%seed%" because
--     real users could legitimately write "seed dose" / "seed lot" in
--     a clinical note that happens to land on an invoice notes field
--     via a typo or copy-paste. "E2E " is the exact prefix the seed
--     scripts used and won't false-positive on real data.
--   - `razorpayOrderId` patterns: only `order_mock_%` (the literal
--     prefix razorpay.ts:56 generates). Real Razorpay order IDs are
--     `order_<base62>` — no `mock` substring.
--
-- We set both fields to NULL (rather than DELETE the invoice rows)
-- because real payments have been recorded against many of them and
-- deleting the invoice would orphan the payment + audit chain. NULLing
-- the bad metadata leaves the financial truth intact while removing
-- the misleading data.
--
-- Idempotent: re-running this migration is a no-op (the patterns
-- match nothing on a freshly scrubbed DB).
-- ================================================================

-- ── #903 part 1: scrub E2E seed-note pollution ────────────────────
UPDATE "invoices"
   SET "notes" = NULL
 WHERE "notes" LIKE 'E2E %';

-- ── #903 part 2: null out mock Razorpay order IDs ─────────────────
-- Real Razorpay order IDs match ^order_[A-Za-z0-9]+$ but never carry
-- the `mock_` substring. Schema-level CHECK constraint would be ideal
-- here but Prisma's @db.Text doesn't support inline CHECK constraints
-- via the Prisma schema language — the runtime guard in
-- services/razorpay.ts is the authoritative defense going forward.
UPDATE "invoices"
   SET "razorpayOrderId" = NULL
 WHERE "razorpayOrderId" LIKE 'order_mock_%';
