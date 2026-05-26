-- Pearl ERP §2.1.3 — SNOMED CT concept catalogue. Same shape as the
-- ICD-10 table; seed.ts upserts the starter set on every db:seed run.

CREATE TABLE "snomed_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snomed_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "snomed_codes_code_key" ON "snomed_codes"("code");
CREATE INDEX "snomed_codes_code_idx" ON "snomed_codes"("code");
CREATE INDEX "snomed_codes_category_idx" ON "snomed_codes"("category");
