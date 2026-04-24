/**
 * Tenant-scoped Prisma client.
 *
 * Wraps the shared `prisma` singleton exported from `@medcore/db` with a
 * `$extends({ query: … })` block that automatically injects `tenantId` on
 * `create` and automatically filters by `tenantId` on read/update/delete
 * operations for the set of tenant-scoped models listed in
 * {@link TENANT_SCOPED_MODELS}.
 *
 * The tenant id comes from the per-request `AsyncLocalStorage` populated by
 * `withTenantContext` (see `./tenant-context.ts`). When no tenant is in
 * scope — for example during the initial admin bootstrap, migrations, a
 * cron job running outside of an HTTP request, or support-engineer
 * cross-tenant admin tooling — the extension behaves as a pass-through,
 * letting the caller see/modify rows across every tenant.
 *
 * Callers should `import { tenantScopedPrisma } from ".../services/tenant-prisma"`
 * going forward. The un-scoped `prisma` export remains available for the
 * parts of the codebase that are still being migrated and for admin-console
 * and migration scripts that explicitly need cross-tenant reach.
 */

import { prisma } from "@medcore/db";
import { getTenantId } from "./tenant-context";

/**
 * Models whose rows are owned by exactly one tenant. Keep this list in sync
 * with the Prisma schema — any new model that gains a `tenantId` column
 * MUST be added here or the extension will not scope it.
 *
 * Models NOT in this set (e.g. `Icd10Code`, `Medicine` catalog, system
 * config, ABDM/FHIR/insurance artefacts, AI reference data) are
 * intentionally cross-tenant and fall through the extension untouched.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  "AdherenceSchedule",
  "Admission",
  "AIScribeSession",
  "AITriageSession",
  "AncVisit",
  "AntenatalCase",
  "Appointment",
  "Bed",
  "ChatMessage",
  "ChatParticipant",
  "ChatRoom",
  "ChronicCondition",
  "Complaint",
  "ConsentArtefact",
  "Consultation",
  "CoordinatedVisit",
  "Doctor",
  "EmergencyCase",
  "FamilyHistory",
  "GrowthRecord",
  "HealthPackage",
  "Holiday",
  "Immunization",
  "Invoice",
  "IpdVitals",
  "LabOrder",
  "LabReportExplanation",
  "LabResult",
  "LeaveRequest",
  "MedicationAdministration",
  "MedicationOrder",
  "MedReconciliation",
  "Notification",
  "NurseRound",
  "OvertimeRecord",
  "PackagePurchase",
  "Patient",
  "PatientAllergy",
  "PatientDocument",
  "PatientFamilyLink",
  "PatientFeedback",
  "Payment",
  "PaymentPlan",
  "PaymentPlanInstallment",
  "PreAuthRequest",
  "Prescription",
  "Referral",
  "ReportRun",
  "ScheduledReport",
  "StaffCertification",
  "StaffShift",
  "Surgery",
  "TelemedicineSession",
  "User",
  "Vitals",
  "WaitlistEntry",
  "Ward",
  // Patient-tools bundle (Apr 2026)
  "BillExplanation",
  "PrevisitChecklist",
  "SymptomDiaryEntry",
  "ChronicCarePlan",
  "ChronicCareCheckIn",
  "ChronicCareAlert",
  // Ops-quality bundle
  "FraudAlert",
  "DocQAReport",
  "FeedbackSentiment",
  "NpsDailyRollup",
  // Ops-forecast bundle
  "StaffRosterProposal",
  // Claims AI bundle
  "ClaimDenialHistory",
  // ── Extended scope (2026-04-24 — migration
  //    20260424000002_admission_dama_and_tenant_extension) ────────────────
  "DoctorSchedule",
  "ScheduleOverride",
  "PrescriptionTemplate",
  "InsuranceClaim",
  "IpdIntakeOutput",
  "InventoryItem",
  "StockMovement",
  "OperatingTheater",
  "AnesthesiaRecord",
  "PostOpObservation",
  "Supplier",
  "PurchaseOrder",
  "Expense",
  "BloodDonor",
  "BloodDonation",
  "BloodScreening",
  "BloodTemperatureLog",
  "BloodCrossMatch",
  "BloodUnit",
  "BloodRequest",
  "Ambulance",
  "AmbulanceFuelLog",
  "AmbulanceTrip",
  "Asset",
  "AssetTransfer",
  "AssetAssignment",
  "AssetMaintenance",
  "UltrasoundRecord",
  "Visitor",
  "CreditNote",
  "AdvancePayment",
  "SupplierPayment",
  "SupplierCatalogItem",
  "Grn",
  "VisitorBlacklist",
  "ExpenseBudget",
  "LeaveBalance",
  "NotificationTemplate",
  "NotificationSchedule",
  "NotificationBroadcast",
  "AdvanceDirective",
  "PatientBelongings",
  "DiscountApproval",
  "PharmacyReturn",
  "StockTransfer",
  "ControlledSubstanceEntry",
  "LabQCEntry",
  "SharedLink",
  "Partograph",
  "PostnatalVisit",
  "MilestoneRecord",
  "FeedingLog",
  "DonorDeferral",
  "ComponentSeparation",
  "AdherenceDoseLog",
  "AbhaLink",
  "CareContext",
  "InsuranceClaim2",
  // Radiology Report Drafting (PRD §7.2, 2026-04-24)
  "RadiologyStudy",
  "RadiologyReport",
]);

/** Operations on which we INJECT `tenantId` into `args.data`. */
const CREATE_OPERATIONS = new Set<string>(["create", "createMany", "upsert"]);

/**
 * Operations on which we INJECT `tenantId` into `args.where`. `upsert` is
 * deliberately in BOTH sets — we need the where clause to find the row and
 * the create payload to tag a new row.
 */
const READ_WRITE_OPERATIONS = new Set<string>([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "upsert",
]);

/**
 * Return whether the Prisma-extension $allModels hook should act on a given
 * (model, operation) pair. Exported for tests.
 */
export function shouldScope(model: string | undefined, operation: string): boolean {
  if (!model || !TENANT_SCOPED_MODELS.has(model)) return false;
  return (
    CREATE_OPERATIONS.has(operation) || READ_WRITE_OPERATIONS.has(operation)
  );
}

/**
 * Inject `tenantId` into `args.where` / `args.data` as appropriate. Exposed
 * for unit tests — the public API is {@link tenantScopedPrisma}.
 */
export function applyTenantScope<A extends Record<string, unknown>>(
  args: A | undefined,
  operation: string,
  tenantId: string,
): A {
  // Always start from a shallow copy so we never mutate caller input.
  const next: Record<string, unknown> = { ...(args ?? {}) };

  if (READ_WRITE_OPERATIONS.has(operation)) {
    const existing =
      (next.where as Record<string, unknown> | undefined) ?? undefined;
    next.where = existing
      ? { ...existing, tenantId }
      : { tenantId };
  }

  if (CREATE_OPERATIONS.has(operation)) {
    const data = next.data;
    if (Array.isArray(data)) {
      next.data = data.map((row) =>
        row && typeof row === "object" ? { ...row, tenantId } : row,
      );
    } else if (data && typeof data === "object") {
      next.data = { ...(data as Record<string, unknown>), tenantId };
    } else if (operation === "create" || operation === "createMany") {
      // `data` is required for these — leaving undefined will let Prisma
      // raise its normal validation error.
      next.data = { tenantId };
    }

    // For upsert, also tag the `create` branch.
    if (operation === "upsert") {
      const create = next.create;
      if (create && typeof create === "object") {
        next.create = { ...(create as Record<string, unknown>), tenantId };
      } else {
        next.create = { tenantId };
      }
    }
  }

  return next as A;
}

/**
 * Prisma client with automatic tenant scoping.
 *
 * Usage:
 *
 * ```ts
 * import { tenantScopedPrisma } from "../services/tenant-prisma";
 *
 * const mine = await tenantScopedPrisma.patient.findMany();
 * //   ^ automatically filtered by the caller's tenantId
 * ```
 */
export const tenantScopedPrisma = prisma.$extends({
  name: "tenant-scoping",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !shouldScope(model, operation)) {
          return query(args);
        }
        const scoped = applyTenantScope(
          args as Record<string, unknown>,
          operation,
          tenantId,
        );
        return query(scoped);
      },
    },
  },
});

export type TenantScopedPrisma = typeof tenantScopedPrisma;
