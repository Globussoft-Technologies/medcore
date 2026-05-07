-- ================================================================
-- 20260508000003_cleanup_attacker_test_users_and_test_ambulances
--
-- Closes:
--   #722 — Test "Attacker" row from prior security testing persists in
--          the Users list. The row was added during runtime
--          security-testing (penetration sweep on 2026-04-30 and
--          subsequent BOLA / mass-assignment campaigns) and never
--          cleaned up. It is NOT created by any seed file — searches
--          across `packages/db/src/seed-*.ts` come back empty —
--          so the only safe cleanup vector is a one-time migration.
--
--   #738 — Test/dummy ambulance records visible in production. Same
--          story: rows shaped `TEST-*` / `DEMO*` registration numbers
--          and `Demo Driver` driver names landed via demo-data seeding
--          early in 2026 and never got pruned. The runtime filter
--          (apps/api/src/routes/ambulance.ts, NODE_ENV=production)
--          masks them on read; this migration removes them at rest.
--
-- The DELETE patterns are intentionally CONSERVATIVE — only rows that
-- are unambiguously synthetic (Attacker-named users, evil.test emails,
-- TEST-/DEMO- vehicle numbers, "Demo Driver" exact match) are
-- removed. Real-world admins occasionally have legitimate test
-- environments where the seed runs; the patterns below will not
-- collide with any production-shape data.
--
-- Idempotent: running this migration on a clean DB is a no-op.
-- ================================================================

-- ── #722: cleanup synthetic Attacker test users ───────────────────
-- Match three independent indicators so a single typo doesn't survive
-- the cleanup. Email patterns are the most stable — names get edited
-- but the email is the unique key of record.
DELETE FROM "User"
 WHERE name ILIKE '%attacker%'
    OR email ILIKE '%attacker%'
    OR email ILIKE '%@evil.test%'
    OR email ILIKE '%pentest%@%';

-- ── #738: cleanup synthetic test/demo ambulances ──────────────────
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
