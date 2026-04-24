#!/usr/bin/env tsx
/**
 * backfill-patient-ages
 * ─────────────────────────────────────────────────────────────────────────────
 * Remediate Issue #13 (multiple patients show age = 0) on prod data.
 *
 * Scope:
 *   Walks every Patient row where `age = 0` AND `dateOfBirth IS NOT NULL`,
 *   recomputes `age` from `dateOfBirth` (completed years, leap-year safe),
 *   and writes it back.
 *
 * What this does NOT do:
 *   - Does NOT touch patients where `dateOfBirth IS NULL`. Those rows are
 *     correctly unknown; the UI now renders "—" via formatPatientAge(), so
 *     they no longer display "0". Fabricating a DOB for them would lie.
 *   - Does NOT touch infants where the computed age is genuinely 0 (DOB is
 *     less than a year in the past). A newborn's age really is 0.
 *
 * Design notes
 * ─────────────
 * - Dry-run by default (same pattern as scripts/backfill-default-tenant.ts).
 *   Pass `--apply` to write.
 * - Uses raw `prisma` (NOT tenantScopedPrisma) so the script sees every tenant.
 *   Multi-tenant filtering would be wrong here — backfill is cross-tenant.
 * - Emits per-patient dry-run rows to stderr for operator spot-check, plus
 *   a single JSON summary to stdout.
 *
 * Usage
 * ─────
 *   # dry-run (DEFAULT — safe, zero writes):
 *   npx tsx scripts/backfill-patient-ages.ts
 *
 *   # apply:
 *   npx tsx scripts/backfill-patient-ages.ts --apply
 */

import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@medcore/db";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "apps/api/.env") });

if (!process.env.DATABASE_URL) {
  console.error(
    "[backfill] FATAL: DATABASE_URL is not set. Aborting before any DB work."
  );
  process.exit(2);
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  apply: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--help" || arg === "-h") {
      console.error(
        "Usage: tsx scripts/backfill-patient-ages.ts [--apply]\n" +
          "\n" +
          "Recomputes Patient.age from Patient.dateOfBirth for any row where\n" +
          "age = 0 AND dateOfBirth IS NOT NULL. Dry-run by default."
      );
      process.exit(0);
    }
  }
  return { apply };
}

const args = parseArgs(process.argv.slice(2));
const MODE: "DRY_RUN" | "APPLY" = args.apply ? "APPLY" : "DRY_RUN";

// ── Age helper (inlined — cannot import from apps/web) ──────────────────────
//
// Completed years between birth and now, using anniversary comparison so we
// do not drift on leap years. Returns null for future DOBs (never 0).
function ageFromDOB(dob: Date, now: Date = new Date()): number | null {
  if (!(dob instanceof Date) || Number.isNaN(dob.getTime())) return null;
  if (dob.getTime() > now.getTime()) return null;
  let years = now.getFullYear() - dob.getFullYear();
  const monthDelta = now.getMonth() - dob.getMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getDate() < dob.getDate())
  ) {
    years--;
  }
  if (years < 0 || years > 150) return null;
  return years;
}

// ── Driver ──────────────────────────────────────────────────────────────────

interface PerRow {
  id: string;
  mrNumber: string;
  dateOfBirth: string;
  before: number;
  computed: number | null;
  updated: boolean;
  reason?: string;
}

async function main() {
  const startedAt = new Date();
  console.error(
    `[backfill-ages] mode=${MODE} startedAt=${startedAt.toISOString()}`
  );

  // Select only the rows that actually need remediation: age=0 AND DOB set.
  // Note: use `prisma` (unscoped) so we find rows across every tenant.
  const candidates = await prisma.patient.findMany({
    where: {
      age: 0,
      dateOfBirth: { not: null },
    },
    select: {
      id: true,
      mrNumber: true,
      dateOfBirth: true,
    },
    orderBy: { mrNumber: "asc" },
  });

  console.error(
    `[backfill-ages] candidates (age=0 AND DOB NOT NULL): ${candidates.length}`
  );

  const perRow: PerRow[] = [];
  let updatedCount = 0;
  let skippedInfant = 0;
  let skippedInvalid = 0;

  for (const p of candidates) {
    const dob = p.dateOfBirth as Date;
    const computed = ageFromDOB(dob);

    if (computed === null) {
      // Future DOB or sentinel — cannot trust, skip.
      skippedInvalid++;
      perRow.push({
        id: p.id,
        mrNumber: p.mrNumber,
        dateOfBirth: dob.toISOString().slice(0, 10),
        before: 0,
        computed: null,
        updated: false,
        reason: "invalid_or_future_dob",
      });
      console.error(
        `[backfill-ages:${MODE}] SKIP ${p.mrNumber} dob=${dob
          .toISOString()
          .slice(0, 10)} (invalid/future)`
      );
      continue;
    }

    if (computed === 0) {
      // Genuine infant — age really is 0, nothing to backfill.
      skippedInfant++;
      perRow.push({
        id: p.id,
        mrNumber: p.mrNumber,
        dateOfBirth: dob.toISOString().slice(0, 10),
        before: 0,
        computed: 0,
        updated: false,
        reason: "genuine_infant",
      });
      console.error(
        `[backfill-ages:${MODE}] SKIP ${p.mrNumber} dob=${dob
          .toISOString()
          .slice(0, 10)} (infant, age=0 is correct)`
      );
      continue;
    }

    if (MODE === "APPLY") {
      await prisma.patient.update({
        where: { id: p.id },
        data: { age: computed },
      });
      updatedCount++;
    }

    perRow.push({
      id: p.id,
      mrNumber: p.mrNumber,
      dateOfBirth: dob.toISOString().slice(0, 10),
      before: 0,
      computed,
      updated: MODE === "APPLY",
    });

    console.error(
      `[backfill-ages:${MODE}] ${p.mrNumber} dob=${dob
        .toISOString()
        .slice(0, 10)} 0 → ${computed}${MODE === "APPLY" ? " UPDATED" : ""}`
    );
  }

  const wouldUpdate = perRow.filter(
    (r) => r.computed !== null && r.computed > 0
  ).length;

  const finishedAt = new Date();
  const summary = {
    mode: MODE,
    candidates: candidates.length,
    wouldUpdate,
    updated: updatedCount,
    skippedInfant,
    skippedInvalid,
    perRow,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  console.error(
    `[backfill-ages] done mode=${MODE} candidates=${candidates.length} ` +
      `wouldUpdate=${wouldUpdate} updated=${updatedCount} ` +
      `skippedInfant=${skippedInfant} skippedInvalid=${skippedInvalid}`
  );
  console.log(JSON.stringify(summary));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill-ages] FATAL:", err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
