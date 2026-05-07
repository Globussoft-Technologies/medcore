-- Issue #713 (May 2026): public PATIENT registration now collects an
-- emergency-contact block (name + phone + relationship). Name and phone
-- already had columns on Patient; this migration adds the relationship
-- column. Nullable to keep historic rows valid; the API layer enforces
-- presence at registration time.
ALTER TABLE "Patient" ADD COLUMN "emergencyContactRelationship" TEXT;
