#!/usr/bin/env tsx
/**
 * backfill-default-tenant
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 2 of the multi-tenant rollout.
 *
 * After migrations `20260423000004_tenant_foundation` and
 * `20260423000005_tenant_scope_extended` have shipped, every tenant-scoped
 * table now has a NULLABLE `tenantId TEXT` column populated with NULL for
 * every pre-existing row. This script:
 *
 *   1. Upserts a single `DEFAULT` tenant (subdomain `default`).
 *   2. Walks the 57 tenant-scoped tables (20 foundation + 37 extended) and
 *      sets `tenantId = <DEFAULT.id>` on every row where `tenantId IS NULL`.
 *   3. Reports per-table counts so the operator can spot-check that every
 *      expected row got labelled.
 *
 * A follow-up migration will then flip `tenantId` to `NOT NULL`.
 *
 * Design notes
 * ─────────────
 * • Dry-run by default. Pass `--apply` to write.
 * • `updateMany({ where: { tenantId: null } })` — idempotent. Re-runs simply
 *   find zero rows to update.
 * • Uses the raw `prisma` client (no tenant scoping) on purpose — backfill
 *   must be cross-tenant.
 * • stderr carries progress logging; stdout carries a single JSON summary.
 *
 * Usage
 * ─────
 *   # dry-run (DEFAULT):
 *   npx tsx scripts/backfill-default-tenant.ts
 *
 *   # apply:
 *   npx tsx scripts/backfill-default-tenant.ts --apply
 */

import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@medcore/db";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "apps/api/.env") });

if (!process.env.DATABASE_URL) {
  console.error(
    "[backfill] FATAL: DATABASE_URL is not set. Aborting before any DB work.",
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
        "Usage: tsx scripts/backfill-default-tenant.ts [--apply]",
      );
      process.exit(0);
    }
  }
  return { apply };
}

const args = parseArgs(process.argv.slice(2));
const MODE: "DRY_RUN" | "APPLY" = args.apply ? "APPLY" : "DRY_RUN";

// ── Tenant-scoped table driver ──────────────────────────────────────────────

/**
 * Each entry binds a human-readable label to the matching Prisma model
 * delegate. We call `count` and `updateMany` through the delegate so that
 * the TypeScript compiler keeps us honest about typos — no raw SQL.
 */
const TABLES: Array<{
  label: string;
  count: () => Promise<number>;
  updateNullToDefault: (defaultId: string) => Promise<{ count: number }>;
}> = [
  {
    label: "users",
    count: () => prisma.user.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.user.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "doctors",
    count: () => prisma.doctor.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.doctor.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "patients",
    count: () => prisma.patient.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.patient.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "appointments",
    count: () => prisma.appointment.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.appointment.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "consultations",
    count: () => prisma.consultation.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.consultation.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "prescriptions",
    count: () => prisma.prescription.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.prescription.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "invoices",
    count: () => prisma.invoice.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.invoice.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "payments",
    count: () => prisma.payment.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.payment.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "lab_orders",
    count: () => prisma.labOrder.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.labOrder.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "lab_results",
    count: () => prisma.labResult.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.labResult.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "admissions",
    count: () => prisma.admission.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.admission.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "medication_orders",
    count: () => prisma.medicationOrder.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.medicationOrder.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "nurse_rounds",
    count: () => prisma.nurseRound.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.nurseRound.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "referrals",
    count: () => prisma.referral.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.referral.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "surgeries",
    count: () => prisma.surgery.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.surgery.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "staff_shifts",
    count: () => prisma.staffShift.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.staffShift.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "leave_requests",
    count: () => prisma.leaveRequest.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.leaveRequest.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "telemedicine_sessions",
    count: () => prisma.telemedicineSession.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.telemedicineSession.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "emergency_cases",
    count: () => prisma.emergencyCase.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.emergencyCase.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "notifications",
    count: () => prisma.notification.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.notification.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  // ── Extended scope (2026-04-23 — migration
  //    20260423000005_tenant_scope_extended) ─────────────────────────────────
  {
    label: "patient_allergies",
    count: () => prisma.patientAllergy.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.patientAllergy.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "chronic_conditions",
    count: () => prisma.chronicCondition.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.chronicCondition.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "family_history",
    count: () => prisma.familyHistory.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.familyHistory.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "immunizations",
    count: () => prisma.immunization.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.immunization.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "patient_documents",
    count: () => prisma.patientDocument.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.patientDocument.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "vitals",
    count: () => prisma.vitals.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.vitals.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "ipd_vitals",
    count: () => prisma.ipdVitals.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.ipdVitals.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "patient_family_links",
    count: () => prisma.patientFamilyLink.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.patientFamilyLink.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "medication_administrations",
    count: () =>
      prisma.medicationAdministration.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.medicationAdministration.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "antenatal_cases",
    count: () => prisma.antenatalCase.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.antenatalCase.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "anc_visits",
    count: () => prisma.ancVisit.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.ancVisit.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "growth_records",
    count: () => prisma.growthRecord.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.growthRecord.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "med_reconciliations",
    count: () => prisma.medReconciliation.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.medReconciliation.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "preauth_requests",
    count: () => prisma.preAuthRequest.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.preAuthRequest.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "ai_scribe_sessions",
    count: () => prisma.aIScribeSession.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.aIScribeSession.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "ai_triage_sessions",
    count: () => prisma.aITriageSession.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.aITriageSession.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "lab_report_explanations",
    count: () =>
      prisma.labReportExplanation.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.labReportExplanation.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "adherence_schedules",
    count: () => prisma.adherenceSchedule.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.adherenceSchedule.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "consent_artefacts",
    count: () => prisma.consentArtefact.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.consentArtefact.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "waitlist_entries",
    count: () => prisma.waitlistEntry.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.waitlistEntry.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "coordinated_visits",
    count: () => prisma.coordinatedVisit.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.coordinatedVisit.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "health_packages",
    count: () => prisma.healthPackage.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.healthPackage.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "package_purchases",
    count: () => prisma.packagePurchase.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.packagePurchase.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "payment_plans",
    count: () => prisma.paymentPlan.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.paymentPlan.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "payment_plan_installments",
    count: () =>
      prisma.paymentPlanInstallment.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.paymentPlanInstallment.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "scheduled_reports",
    count: () => prisma.scheduledReport.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.scheduledReport.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "report_runs",
    count: () => prisma.reportRun.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.reportRun.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "patient_feedback",
    count: () => prisma.patientFeedback.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.patientFeedback.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "complaints",
    count: () => prisma.complaint.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.complaint.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "staff_certifications",
    count: () =>
      prisma.staffCertification.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.staffCertification.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "overtime_records",
    count: () => prisma.overtimeRecord.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.overtimeRecord.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "holidays",
    count: () => prisma.holiday.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.holiday.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "beds",
    count: () => prisma.bed.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.bed.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "wards",
    count: () => prisma.ward.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.ward.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "chat_rooms",
    count: () => prisma.chatRoom.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.chatRoom.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "chat_messages",
    count: () => prisma.chatMessage.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.chatMessage.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
  {
    label: "chat_participants",
    count: () => prisma.chatParticipant.count({ where: { tenantId: null } }),
    updateNullToDefault: (id) =>
      prisma.chatParticipant.updateMany({
        where: { tenantId: null },
        data: { tenantId: id },
      }),
  },
];

const DEFAULT_TENANT_SUBDOMAIN = "default";
const DEFAULT_TENANT_NAME = "DEFAULT";

async function ensureDefaultTenant(): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.tenant.findUnique({
    where: { subdomain: DEFAULT_TENANT_SUBDOMAIN },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id, created: false };
  }

  if (MODE === "DRY_RUN") {
    // Synthesise a placeholder id so the rest of the script can continue
    // printing accurate per-table counts. No writes happen.
    return { id: "<dry-run-would-create>", created: true };
  }

  const created = await prisma.tenant.create({
    data: {
      name: DEFAULT_TENANT_NAME,
      subdomain: DEFAULT_TENANT_SUBDOMAIN,
      plan: "BASIC",
      active: true,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

async function main() {
  const startedAt = new Date();
  console.error(
    `[backfill] mode=${MODE} startedAt=${startedAt.toISOString()}`,
  );

  const tenant = await ensureDefaultTenant();
  console.error(
    `[backfill] default tenant id=${tenant.id} created=${tenant.created}`,
  );

  const perTable: Array<{
    table: string;
    nullBefore: number;
    updated: number;
  }> = [];

  for (const t of TABLES) {
    const nullBefore = await t.count();
    let updated = 0;

    if (MODE === "APPLY" && nullBefore > 0) {
      const result = await t.updateNullToDefault(tenant.id);
      updated = result.count;
    }

    console.error(
      `[backfill:${MODE}] ${t.label}: ${nullBefore} NULL rows, ${
        MODE === "APPLY" ? `${updated} updated` : "would update"
      }`,
    );

    perTable.push({ table: t.label, nullBefore, updated });
  }

  const totalNull = perTable.reduce((a, b) => a + b.nullBefore, 0);
  const totalUpdated = perTable.reduce((a, b) => a + b.updated, 0);

  const finishedAt = new Date();
  const summary = {
    mode: MODE,
    defaultTenantId: tenant.id,
    defaultTenantCreated: tenant.created,
    totalNullRows: totalNull,
    totalUpdated,
    perTable,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  console.error(
    `[backfill] done mode=${MODE} totalNull=${totalNull} totalUpdated=${totalUpdated}`,
  );
  console.log(JSON.stringify(summary));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] FATAL:", err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
