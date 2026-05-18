-- ================================================================
-- 20260519000003_nullable_user_email_and_clear_placeholders_891
--
-- Closes: #891 (STAGING — synthetic `noemail+<MR>@medcore.invalid`
--               placeholder emails on real patient User rows)
--
-- Background. The patients-registration route at
-- apps/api/src/routes/patients.ts historically fabricated a
-- placeholder email whenever reception didn't capture one — the
-- schema's `email String @unique` (NOT NULL) meant we couldn't store
-- `null`, so we substituted `noemail+<MR>@medcore.invalid`. The
-- sentinel was masked on the patients API read path, but every other
-- consumer that did `prisma.user.findUnique(...)` directly
-- (notifications, Razorpay receipts, password-reset, FHIR exports,
-- HL7 emit) saw the synthetic string and either bounced an email,
-- printed it on a tax-invoice, or polluted CRM lists.
--
-- The companion CLAUDE.md change (#891) and the source-code change
-- at routes/patients.ts already removed the placeholder generator
-- for NEW writes. This migration:
--
--   1. Drops the NOT NULL constraint on users.email so a `null`
--      can be written at registration time when no email is
--      provided (the new behaviour). The @unique constraint is
--      kept — Postgres treats multiple NULLs as distinct, so the
--      composition is correct.
--
--   2. Clears the 183 existing placeholder rows on staging back to
--      NULL so downstream EMAIL-channel sends see a null and skip
--      cleanly (notification.ts now guards on null and emits an
--      audit row). The LIKE pattern also catches the older
--      `patient_<n>@medcore.local` rows that predated the .invalid
--      cutover at #331.
--
-- Idempotent — re-running is a no-op once the constraint is dropped
-- and the placeholder rows are cleared. Targeted by LIKE pattern so
-- we never touch a legitimate user-supplied email.
-- ================================================================

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

UPDATE "users"
   SET "email" = NULL,
       "updatedAt" = now()
 WHERE "email" LIKE 'noemail+%@medcore.invalid'
    OR "email" LIKE 'patient\_%@medcore.local' ESCAPE '\';
