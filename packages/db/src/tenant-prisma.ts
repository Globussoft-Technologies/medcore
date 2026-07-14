/**
 * Tenant-scoped Prisma client + AsyncLocalStorage primitives.
 *
 * This module is the canonical home for multi-tenant scoping in the MedCore
 * platform. It exports two things that always belong together:
 *
 *   1. The AsyncLocalStorage primitive (`tenantAsyncStorage`,
 *      `runWithTenant`, `getTenantId`, `requireTenantId`) — the per-async-task
 *      "current tenant" channel.
 *   2. `tenantScopedPrisma` — a Prisma client extension that reads from the
 *      ALS channel and auto-injects `tenantId` on writes / auto-filters
 *      reads for the models listed in `TENANT_SCOPED_MODELS`.
 *
 * Architectural note (A10, 2026-05-04):
 *   This wrapper used to live at `apps/api/src/services/tenant-prisma.ts`,
 *   which forced workers / cron / secondary services to cross the
 *   `apps → packages` arrow to consume it. Lifting it into `@medcore/db`
 *   makes `packages/*` the single source of truth for tenant scoping. The
 *   former location now ships a thin re-export shim so the 100+ existing
 *   `import { tenantScopedPrisma } from "../services/tenant-prisma"` call
 *   sites in the API app keep compiling unchanged.
 *
 * Express-specific glue (the `withTenantContext` middleware) intentionally
 * stays in `apps/api/src/services/tenant-context.ts` — `@medcore/db` MUST
 * NOT depend on Express. That file now re-exports the storage primitives
 * from here so there is exactly ONE `AsyncLocalStorage` instance
 * process-wide; a second instance would silently break tenant propagation
 * across the very surface this module is supposed to protect.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Role } from "@prisma/client";
import { prisma } from "./client";

// ── Platform-role allow-list ────────────────────────────────────────────────

/**
 * Roles that operate at the PLATFORM level rather than within a single
 * tenant scope. Users with these roles carry `tenantId = null` in their
 * JWT — `tenantContextMiddleware` short-circuits tenant resolution for
 * them so they can act across tenants (onboard new tenants, view all
 * platform invoices, etc.) without the `tenantScopedPrisma` extension
 * silently filtering everything out.
 *
 * Lives here (next to `tenantScopedPrisma`) so the source of truth for
 * "is this caller exempt from tenant scoping?" is co-located with the
 * scoping primitives themselves — both the storage primitive and the
 * allow-list update together when a new platform role lands.
 *
 * Pearl ERP Stage 1 §8.2 (gap row 209 scope-reduced), 2026-05-24. Add
 * any future platform-level role to this set so the bypass picks it up
 * without needing to touch the Express middleware.
 */
export const PLATFORM_ROLES: ReadonlySet<Role> = new Set<Role>([
  Role.PLATFORM_OPERATOR,
  Role.PLATFORM_BILLING_OPERATOR,
  // 2026-06-11 — SUPER_ADMIN is the cross-tenant "root" role and must see /
  // manage every tenant, not just the one it happens to be bound to. Adding it
  // here makes `tenantContextMiddleware` short-circuit tenant resolution for
  // super-admins (req.tenantId stays undefined) so `tenantScopedPrisma` applies
  // no filter. Caveat: writes made by a super-admin are NOT auto-tagged with a
  // tenant (no context) — super-admins are operators, not data-entry users; any
  // tenant-owned row they must create should be made via a tenant-bound account.
  Role.SUPER_ADMIN,
]);

/**
 * Predicate convenience — `true` when the given role string (or `Role`
 * enum value) is on the platform-level allow-list. Accepts unknown
 * inputs because callers typically pass `req.user?.role` which is
 * typed as `Role | undefined` at the application layer but flows in
 * here as `string | undefined` from the decoded JWT.
 */
export function isPlatformRole(role: string | undefined | null): boolean {
  if (!role) return false;
  return PLATFORM_ROLES.has(role as Role);
}

// ── AsyncLocalStorage tenant context ────────────────────────────────────────

/**
 * Per-request context propagated across async boundaries so that code deep
 * in the call stack — most importantly the Prisma extension below — can
 * discover which tenant the current request belongs to without having to
 * thread it through every function signature.
 */
export interface TenantContext {
  /** Tenant id resolved from the JWT or `X-Tenant-Id` header. */
  tenantId: string;
}

/**
 * AsyncLocalStorage instance holding the current request's tenant. Use
 * {@link getTenantId} / {@link requireTenantId} from request-scoped code —
 * importing this export directly should be reserved for framework glue
 * (Prisma middleware, integration test setup) or pre-flight assertions
 * that verify no stray tenant frame is in scope.
 */
export const tenantAsyncStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` inside an async-local scope bound to `tenantId`. Every Promise
 * chain, timer, or microtask created inside `fn` sees the same context via
 * {@link getTenantId}.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantAsyncStorage.run({ tenantId }, fn);
}

/**
 * Returns the tenant id for the current async context, or `undefined` if
 * no context has been established (e.g. background jobs, tests, requests
 * where the middleware did not run).
 */
export function getTenantId(): string | undefined {
  return tenantAsyncStorage.getStore()?.tenantId;
}

/**
 * Like {@link getTenantId} but throws if no tenant is in scope. Use this
 * from code paths that are never supposed to run outside a tenant-scoped
 * request (e.g. Prisma middleware attached to tenant-owned models).
 */
export function requireTenantId(): string {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error(
      "No tenant in async context. Ensure tenantContextMiddleware ran and " +
        "that tenant-scoped code is executed via runWithTenant()/withTenantContext.",
    );
  }
  return tenantId;
}

// ── Tenant-scoped Prisma extension ──────────────────────────────────────────

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
  "Requisition",
  "RequisitionItem",
  "Department",
  "DepartmentMember",
  "Material",
  "MaterialMovement",
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
  "Implant",
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
  // PM-JAY (Ayushman Bharat) — migration 20260713000002
  "PmjayBeneficiary",
  "PmjayVerificationHistory",
  "PmjayPackage",
  "PmjayDocumentUpload",
  "TenantPmjayConfiguration",
  // Radiology Report Drafting (PRD §7.2, 2026-04-24)
  "RadiologyStudy",
  "RadiologyReport",
  // PRD closure (2026-04-24) — migration 20260424000004
  "PatientDataExport",
  "FrontDeskCall",
  "MedicationIncident",
  // Issue #456 (2026-05-04) — migration 20260504000002
  "AuditLog",
  // 2026-05-27 — cross-tenant leak fixes (chronic CI red on
  // insurance-providers.test.ts + referral-commissions.test.ts).
  // Both rows carry a `tenantId` column but were missing from this set,
  // so `tenantScopedPrisma` was a no-op and a default-tenant admin (or
  // any cross-tenant admin) could see another tenant's rows.
  "InsuranceProvider",
  "ReferralCommission",
  // 2026-06-11 — per-tenant drug formulary. medicines.ts switched to the
  // scoped client; Medicine.name is now @@unique([tenantId, name]) so two
  // tenants can each carry "Paracetamol".
  "Medicine",
  // 2026-06-11 — close the enforcement gap. These models already carried a
  // tenantId column but were missing from this set, so any route using the
  // scoped client returned cross-tenant rows. Each is created TOP-LEVEL
  // (verified: no nested-relation creates) so auto-tagging on write is sound,
  // and the matching base-prisma routes were switched to the scoped client in
  // the same change. The WhatsApp inbound webhook stays on the base client and
  // sets tenantId explicitly, so it is unaffected by this scoping.
  "AppointmentRemark",
  "Branch",
  "CalendarEvent",
  "Campaign",
  "CampaignAudience",
  "CampaignSend",
  "Cohort",
  "CohortMember",
  "DoctorFavouriteMedicine",
  "Lead",
  "LeadActivity",
  // SupportTicket intentionally OMITTED — its route (routes/support-tickets.ts)
  // is a dual-purpose operator inbox that serves cross-tenant super-admin reads
  // and does its own tenant filtering; auto-scoping would break that view.
  "UserInvite",
  "WhatsAppConfig",
  "WhatsAppConversation",
  "WhatsAppMessage",
  // NOTE: still intentionally NOT enforced (ownership column only): the
  // line-item children (InvoiceItem/LabOrderItem/PrescriptionItem/
  // PurchaseOrderItem/GrnItem/ClaimDocument/ClaimStatusEvent/
  // PlatformInvoiceLineItem/SupportTicketMessage — nested writes), auth-time
  // tokens (RefreshToken/PasswordResetCode/TwoFactorTempToken/
  // PatientOtpChallenge), user prefs (NotificationPreference/
  // UserDashboardPreference), platform billing (PlatformInvoice/
  // TenantSubscription/TenantUsageDaily/DPDPErasureRequest), telemetry
  // (RequestMetric/UsageEvent/ScheduledTaskRun), and LabTest/
  // LabTestReferenceRange (global @unique code + base-client FHIR/HL7 ingest —
  // needs a composite-unique + tenant-aware ingest before it can be enforced).
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
export function shouldScope(
  model: string | undefined,
  operation: string,
): boolean {
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
    next.where = existing ? { ...existing, tenantId } : { tenantId };
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
 * import { tenantScopedPrisma } from "@medcore/db";
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
