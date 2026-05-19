-- ================================================================
-- 20260519000004_add_medicineid_fk_to_prescription_items_898
--
-- Closes: #898 — `prescription_items` referenced medicines by free-text
-- `medicineName` only with no `medicineId` FK to the `medicines` master
-- table. That broke:
--   - the allergy / drug-interaction engine (string-match was unreliable
--     across spellings, brand vs. generic, and strength suffixes)
--   - pharmacy FEFO dispense + per-batch stock deduction (no SKU to join
--     against `pharmacy_inventory`)
--   - per-SKU refill quota enforcement
--   - analytics (same drug spelled three ways counted as three drugs)
--
-- Three-step migration:
--   1. ADD COLUMN medicineId TEXT (nullable; existing rows are pre-FK)
--   2. Backfill via case-insensitive trim()'d name match against the
--      `medicines` master. STAGING probe (2026-05-19) shows ~48 distinct
--      `medicineName` strings in `prescription_items` vs. 87 rows in
--      `medicines`. Anything that doesn't match exactly after lower+trim
--      stays NULL — we intentionally do NOT fuzzy-match further (no
--      pg_trgm similarity, no Levenshtein) because a wrong link would
--      poison the allergy/interaction engine the FK is supposed to
--      protect. Operators / migration follow-up will resolve the misses.
--   3. ADD FK CONSTRAINT with ON DELETE SET NULL — historical Rx items
--      survive a master delete with their `medicineName` snapshot intact.
--
-- We KEEP `medicineName` for now as the canonical display name:
--   - Back-compat for older readers that still project `medicineName`
--     directly (e.g. printed Rx, leaflets, PDF, RAG indexer).
--   - Historical snapshot — if a `Medicine.name` is later corrected
--     ("ORS sachet" → "ORS Sachet"), the old Rx still renders the
--     name the doctor actually wrote.
-- A follow-up migration will drop `medicineName` once every reader is
-- converted to project from the FK relation (or a denormalized
-- `medicineNameSnapshot` is added per the issue body's suggestion).
-- ================================================================

-- Step 1: add the new column (nullable for back-compat with the 48
-- pre-existing rows that have no FK yet).
ALTER TABLE "prescription_items"
  ADD COLUMN "medicineId" TEXT;

-- Step 2: best-effort backfill via exact case-insensitive trim match.
-- Anything that doesn't match stays NULL (see header rationale).
UPDATE "prescription_items" pi
SET    "medicineId" = m.id
FROM   "medicines" m
WHERE  lower(trim(pi."medicineName")) = lower(trim(m.name))
  AND  pi."medicineId" IS NULL;

-- Step 3: add the FK constraint + supporting index for the back-relation
-- and dispense-flow joins.
ALTER TABLE "prescription_items"
  ADD CONSTRAINT "prescription_items_medicineId_fkey"
  FOREIGN KEY ("medicineId") REFERENCES "medicines"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "prescription_items_medicineId_idx"
  ON "prescription_items"("medicineId");
