-- ================================================================
-- 20260509000001_backfill_stale_visitors_and_misrouted_patient_notifications
--
-- Closes:
--   #761 — Stale ACTIVE visitors persist (~27 days). The
--          `auto_checkout_stale_visitors` scheduled task (registered in
--          apps/api/src/services/scheduled-tasks.ts by 4217f08) will
--          keep things clean going forward, but the legacy rows that
--          existed BEFORE the task was deployed sat at checkOutAt=NULL
--          long enough to surface in prod with elapsed times of
--          ~39465m (27.4 days). This one-shot backfill flips every
--          stale ACTIVE row (checkOutAt IS NULL AND checkInAt < now - 12h)
--          to checked-out at NOW(), with a marker note so a human
--          reviewer can tell it was a backfill (not a real human
--          checkout). Runs idempotently — a second pass finds zero
--          rows.
--
--   #759 — Patient-targeted "Discharge Summary" PUSH notification
--          routed to Reception staff inbox. The seed-templated
--          notifications created BEFORE issue #272 was fixed
--          (commit prior to e3166f0) routed patient-copy notification
--          types (DISCHARGE, ADMISSION, PRESCRIPTION_READY,
--          BILL_GENERATED, PAYMENT_RECEIVED, LAB_RESULT_READY,
--          MEDICATION_DUE, APPOINTMENT_*, TOKEN_CALLED) to ANY active
--          user — so RECEPTION/DOCTOR/NURSE/ADMIN inboxes got
--          patient-phrased "Your discharge has been processed" and
--          "Your prescription is ready" copy. The seed code was
--          fixed but the bad rows it had written remained at rest.
--          This one-shot DELETE removes any Notification row whose
--          `type` is patient-copy AND whose recipient User.role is
--          NOT PATIENT. Companion runtime invariant in
--          apps/api/src/services/notification.ts hard-rejects new
--          writes of this shape so the gap can't re-open.
--
-- Idempotent: running this migration on a clean DB is a no-op.
-- ================================================================

-- ── #761: backfill stale ACTIVE visitors ──────────────────────────
-- Defensively use the SAME 12h ceiling the runtime cron uses
-- (MAX_VISIT_DURATION_HOURS_DEFAULT in scheduled-tasks.ts). Append
-- a marker to `notes` so a human reviewer can tell it was a backfill
-- (vs the cron's per-row "Auto-checked-out: 12h limit" marker —
-- this one says "Backfill" so they're distinguishable).
UPDATE "visitors"
   SET "checkOutAt" = NOW(),
       "notes" = COALESCE("notes" || E'\n', '') || 'Backfill auto-checkout (12h limit, migration 20260509000001)'
 WHERE "checkOutAt" IS NULL
   AND "checkInAt" < NOW() - INTERVAL '12 hours';

-- ── #759: delete misrouted patient-copy notifications ─────────────
-- Patient-only notification types — must NEVER land in a non-PATIENT
-- inbox. Source of truth is the audience contract pinned in
-- apps/api/src/test/integration/notification-audience-272.test.ts.
-- We DELETE (not soft-delete) because:
--   1. Notification rows are ephemeral by design — the model has no
--      `deletedAt` and the inbox UI has no concept of soft-deleted.
--   2. The misrouted rows are unambiguously bogus data — keeping them
--      in archive form serves no audit purpose; the original send
--      was itself a routing-bug artefact.
DELETE FROM "notifications" n
 USING "User" u
 WHERE n."userId" = u.id
   AND u.role <> 'PATIENT'
   AND n.type IN (
     'DISCHARGE',
     'ADMISSION',
     'PRESCRIPTION_READY',
     'BILL_GENERATED',
     'PAYMENT_RECEIVED',
     'LAB_RESULT_READY',
     'MEDICATION_DUE',
     'APPOINTMENT_BOOKED',
     'APPOINTMENT_REMINDER',
     'APPOINTMENT_CANCELLED',
     'TOKEN_CALLED'
   );
