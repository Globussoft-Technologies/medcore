-- ================================================================
-- 20260519000001_backfill_impossible_age_dob_896
--
-- Closes: #896 (historical bad-data half — the schema-side guard
--               already shipped at `1d807b2` so NEW writes are blocked)
--
-- Three patients on STAGING were created before the cross-field
-- `createPatientSchema.superRefine` shipped, and carry an `age` value
-- that contradicts their `dateOfBirth` by > 2 years (the tolerance
-- band the guard uses). On 2026-05-19 these are:
--
--   MR000003 Amit Patel        age=52  dob=2099-12-31  (future DOB)
--   MR000273 Ramu              age=40  dob=2026-05-08  (newborn ≠ 40)
--   MR000275 "Mismatch Test"   age=80  dob=2020-01-01  (the reporter's
--                                                       probe row)
--
-- We CANNOT pick which of (age, dob) is correct from data alone — both
-- are operator-entered, both are wrong-shaped (the dobs include a 2099
-- date and a future date that the post-fix guard would also reject).
-- The safe move is to clear the unreliable `age` column. Downstream
-- modules that compute age from DOB will now derive a (still wrong but
-- internally consistent) value; reception can correct each chart at
-- next visit.
--
-- We do NOT clear `dateOfBirth` because some downstream surfaces (age
-- groups, pediatric dose calc) genuinely need a DOB and the operator
-- knows the DOB is rough. Future deploys + a follow-up data-correction
-- pass by Reception will fix the DOBs themselves.
--
-- Targeted by mrNumber so the migration is idempotent + auditable; we
-- don't sweep the table because the guard already protects new writes
-- and we don't want to silently mass-edit rows that may have other
-- mismatches we haven't seen.
-- ================================================================

-- NB: patients has no `updatedAt` column (different from User/Doctor models),
-- so we don't write one. The patientId-keyed audit chain on User.updatedAt
-- is the closest auditability surface, but that's a different concern.
UPDATE patients
SET age = NULL
WHERE "mrNumber" IN ('MR000003', 'MR000273', 'MR000275')
  AND age IS NOT NULL
  AND "dateOfBirth" IS NOT NULL
  AND abs(age - extract(year from age("dateOfBirth"))::int) > 2;
