-- ================================================================
-- 20260517000001_redo_attacker_test_users_and_ambulance_cleanup_with_correct_table_name
--
-- Re-runs the #722 / #738 cleanup that was originally shipped as
-- migration 20260508000003 but never actually executed.
--
-- Background:
--   20260508000003_cleanup_attacker_test_users_and_test_ambulances
--   used `DELETE FROM "User"` (uppercase, double-quoted), but the
--   users table is mapped to `users` (lowercase, per
--   `@@map("users")` in schema.prisma + the original `CREATE TABLE
--   "users"` in the init migration). Postgres quoted identifiers are
--   case-sensitive, so `"User"` resolves to a non-existent relation
--   and the statement fails.
--
--   Per issue #908, on the dev DB the failed `0003` was force-marked
--   `applied` to unblock the chain (likely a `prisma migrate resolve
--   --applied`). The chain then progressed until `20260509000001`
--   hit the SAME `"User"` bug — that's where the deploy has been
--   stuck since 2026-05-08. Migration `0001` was fixed in `cd50553`;
--   migration `0003` cannot be edited in place because editing an
--   applied migration causes a checksum mismatch and would itself
--   block the chain.
--
--   So we re-do the cleanup work as a fresh migration with the
--   correct table name (`users`, lowercase). On any DB where `0003`
--   really executed (e.g. CI's `--force-reset` test DBs), this is a
--   no-op idempotent re-run because the patterns won't match
--   anything. On the dev DB (where `0003`'s SQL did NOT run), this
--   actually closes #722 + #738.
--
-- Idempotent: running on a clean DB or a DB where the cleanup already
-- ran is a no-op (the DELETE patterns are unambiguously synthetic).
-- ================================================================

-- ── #722: cleanup synthetic Attacker test users (re-run with correct table) ─
-- The DELETE patterns are intentionally CONSERVATIVE — only rows that
-- are unambiguously synthetic (Attacker-named users, evil.test emails,
-- pentest emails) are removed. Real-world admins occasionally have
-- legitimate test environments where the seed runs; the patterns
-- below will not collide with any production-shape data.
DELETE FROM "users"
 WHERE name ILIKE '%attacker%'
    OR email ILIKE '%attacker%'
    OR email ILIKE '%@evil.test%'
    OR email ILIKE '%pentest%@%';

-- ── #738: cleanup synthetic test/demo ambulances (idempotent re-run) ─
-- registration_number lives on `vehicleNumber` per schema.prisma.
-- driverName matches "Demo Driver" exactly to avoid clobbering real
-- drivers whose real first name happens to be "Demo" (extremely rare
-- but cheaper to be precise).
-- Trips referencing these ambulances are kept (FK does not cascade);
-- those completed trips are useful audit trail. Active trips on
-- TEST-/DEMO- ambulances should not exist in prod, but if they do,
-- the migration will fail loudly via FK constraint and ops can
-- investigate before re-running.
DELETE FROM "ambulances"
 WHERE "vehicleNumber" ILIKE 'TEST-%'
    OR "vehicleNumber" ILIKE 'DEMO%'
    OR "vehicleNumber" ILIKE 'AMB-DEMO-%'
    OR "driverName" = 'Demo Driver';
