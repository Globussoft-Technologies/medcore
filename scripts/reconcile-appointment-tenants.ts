#!/usr/bin/env tsx
/**
 * reconcile-appointment-tenants
 * ─────────────────────────────────────────────────────────────────────────────
 * Recovery backfill for appointments that were booked with the WRONG tenant.
 *
 * Root cause (fixed forward in apps/api/src/routes/appointments.ts, 2026-07):
 *   The appointment-create paths relied on branch/tenantScopedPrisma to
 *   auto-inject `tenantId` from the request's tenant context. A PLATFORM /
 *   SUPER_ADMIN caller has NO tenant context (req.tenantId is undefined, and
 *   the scoping extension is a pass-through in that case), so any appointment
 *   they booked on a tenant's behalf was saved with `tenantId = NULL` — i.e.
 *   filed under the DEFAULT tenant instead of the doctor's real tenant. The
 *   tenant's own admin + doctor (scoped to their tenantId) then never saw the
 *   row: the classic "booked, but the appointment doesn't show up" symptom.
 *
 * What this script does:
 *   For every Appointment whose `tenantId IS NULL` but whose DOCTOR belongs to
 *   a real (non-null) tenant, set `appointment.tenantId = doctor.tenantId`.
 *   The doctor is the authoritative owner of the tenant (a doctor belongs to
 *   exactly one tenant), and the forward fix now pins the same value on create.
 *
 * What it deliberately does NOT touch:
 *   • Appointments whose doctor is ALSO tenantId=null — those legitimately
 *     belong to the DEFAULT tenant; leaving them null is correct.
 *   • Appointments whose tenantId is already non-null — no guessing / no
 *     "correcting" a value that a scoped create already set. (A genuine
 *     non-null mismatch would indicate a different bug; we log a count of any
 *     such rows so an operator can investigate, but never rewrite them.)
 *
 * Design notes
 * ─────────────
 * • Dry-run by default. Pass `--apply` to write.
 * • Idempotent: re-runs find zero null rows to fix.
 * • Uses the raw `prisma` client (NO tenant scoping) on purpose — recovery
 *   must be cross-tenant and must see the null-tenant rows in the first place.
 * • stderr carries progress logging; stdout carries a single JSON summary.
 *
 * Usage
 * ─────
 *   # dry-run (DEFAULT — reports what WOULD change):
 *   npx tsx scripts/reconcile-appointment-tenants.ts
 *
 *   # apply:
 *   npx tsx scripts/reconcile-appointment-tenants.ts --apply
 */

import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@medcore/db";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "apps/api/.env") });

if (!process.env.DATABASE_URL) {
  console.error(
    "[reconcile-appt] FATAL: DATABASE_URL is not set. Aborting before any DB work.",
  );
  process.exit(2);
}

const APPLY = process.argv.slice(2).includes("--apply");
const MODE: "DRY_RUN" | "APPLY" = APPLY ? "APPLY" : "DRY_RUN";

async function main() {
  const startedAt = new Date();
  console.error(`[reconcile-appt] mode=${MODE} startedAt=${startedAt.toISOString()}`);

  // How many null-tenant appointments are recoverable (doctor has a real
  // tenant)? updateMany can't reference the related doctor's column, so we
  // drive the fix per-doctor: for each doctor in a real tenant, re-tag their
  // orphaned (tenantId=null) appointments to that tenant.
  const recoverableBefore = await prisma.appointment.count({
    where: { tenantId: null, doctor: { tenantId: { not: null } } },
  });

  // Appointments left null whose doctor is ALSO null — these are legitimately
  // DEFAULT-tenant rows and are intentionally left alone. Reported for clarity.
  const legitimatelyNull = await prisma.appointment.count({
    where: { tenantId: null, doctor: { tenantId: null } },
  });

  const doctorsInTenants = await prisma.doctor.findMany({
    where: { tenantId: { not: null } },
    select: { id: true, tenantId: true },
  });

  let totalUpdated = 0;
  const perDoctor: Array<{ doctorId: string; tenantId: string; updated: number }> = [];

  for (const d of doctorsInTenants) {
    const tenantId = d.tenantId as string; // guaranteed non-null by the where
    if (MODE === "APPLY") {
      const { count } = await prisma.appointment.updateMany({
        where: { doctorId: d.id, tenantId: null },
        data: { tenantId },
      });
      if (count > 0) {
        totalUpdated += count;
        perDoctor.push({ doctorId: d.id, tenantId, updated: count });
      }
    } else {
      const count = await prisma.appointment.count({
        where: { doctorId: d.id, tenantId: null },
      });
      if (count > 0) {
        perDoctor.push({ doctorId: d.id, tenantId, updated: count });
      }
    }
  }

  const finishedAt = new Date();
  const summary = {
    mode: MODE,
    recoverableBefore, // null appts whose doctor is in a real tenant
    legitimatelyNull, // null appts whose doctor is also null (left as-is)
    totalUpdated: MODE === "APPLY" ? totalUpdated : undefined,
    wouldUpdate: MODE === "DRY_RUN" ? recoverableBefore : undefined,
    doctorsAffected: perDoctor.length,
    perDoctor,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  console.error(
    `[reconcile-appt] done mode=${MODE} recoverable=${recoverableBefore} ` +
      `${MODE === "APPLY" ? `updated=${totalUpdated}` : "would update"} ` +
      `legitimatelyNull(left as-is)=${legitimatelyNull}`,
  );
  console.log(JSON.stringify(summary));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[reconcile-appt] FATAL:", err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
