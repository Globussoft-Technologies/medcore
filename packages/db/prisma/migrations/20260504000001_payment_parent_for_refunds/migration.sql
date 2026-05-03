-- Migration: Link refund Payment rows back to the original CAPTURED Payment
--            so cumulative-refund detection can fire (2026-05-04).
--
-- Background: `apps/api/src/routes/billing.ts::handleRefundProcessed` already
-- catches two fraud classes per Razorpay refund.processed event:
--   (a) REFUND_AGAINST_NON_CAPTURED_PAYMENT — original was FAILED/REFUNDED.
--   (b) REFUND_EXCEEDS_PAYMENT — single refund > original amount.
--
-- Neither catches the "many small refunds totalling more than the original
-- amount" case. Five sequential refunds of ₹30 each against a ₹100 capture
-- would currently slip through every guard — Razorpay's API itself prevents
-- this on the way out, but a forged/replayed webhook stream wouldn't be
-- bound by their server-side checks.
--
-- This migration adds a nullable self-FK on `payments.parentPaymentId`
-- pointing at the original captured Payment row, so the handler can
-- `SUM(amount) WHERE parentPaymentId = original.id AND status='REFUNDED'`
-- before approving a new refund. Backfill is intentionally NOT done here —
-- existing legacy refund rows have no recoverable link to their original
-- captures, and cumulative-detection only matters for new refund flow.
--
-- Additive only: nullable column + index. Old code (which doesn't read or
-- write the column) keeps working. Safe to roll forward without an
-- [allow-destructive-migration] marker.

ALTER TABLE "payments"
  ADD COLUMN "parentPaymentId" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_parentPaymentId_fkey"
  FOREIGN KEY ("parentPaymentId")
  REFERENCES "payments"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Used by `handleRefundProcessed` to sum prior refunds in a single hot
-- query before deciding whether the incoming refund pushes the cumulative
-- past the original captured amount.
CREATE INDEX "payments_parentPaymentId_idx" ON "payments" ("parentPaymentId");
