/**
 * Tenant provisioning service.
 *
 * Encapsulates the transactional logic for creating a brand-new tenant:
 *
 *   1. Insert the `Tenant` row (tenant id becomes the key for everything below).
 *   2. Create the first ADMIN `User` row for that tenant, with hashed password.
 *   3. Seed tenant-scoped reference data:
 *        - Default notification templates (one per NotificationType × Channel combo)
 *        - Default notification preferences for the admin user
 *        - Default leave-balance records (current year, all 7 leave types)
 *        - Default public holidays for the current calendar year (from HOLIDAY_TEMPLATE)
 *        - SystemConfig rows for hospital identity (prefixed by `tenant:<id>:*` so
 *          the single global SystemConfig table can hold per-tenant values)
 *
 * Everything is wrapped in a single `prisma.$transaction` so a partial failure
 * (e.g. unique-constraint violation midway) rolls back all of the above —
 * never leaves an orphan admin user without templates, or a tenant row without
 * an admin.
 *
 * Catalog tables (Icd10Code, Medicine, TestCatalog, …) are intentionally
 * cross-tenant — see `TENANT_SCOPED_MODELS` in `tenant-prisma.ts` — so they
 * do NOT need to be copied from the "default" tenant; they are already shared.
 *
 * The service uses the un-scoped `prisma` export (not `tenantScopedPrisma`)
 * because the new tenant's id is being created mid-transaction and the tenant
 * AsyncLocalStorage isn't set yet. Tenant id is passed explicitly on every
 * create.
 */

import bcrypt from "bcryptjs";
import { prisma } from "@medcore/db";
import type {
  NotificationChannel as NCh,
  NotificationType as NTy,
  TenantPlan,
  LeaveType,
} from "@prisma/client";
import { PLAN_DEFINITIONS, TRIAL_DAYS, type Plan } from "@medcore/shared";

// ─── Reserved subdomains ─────────────────────────────────────────────
// Subdomains that must never be taken by an operator-created tenant. `default`
// is our seed tenant; `www`/`api`/`app`/`admin` are legacy / routing labels;
// `medcore` is our own apex. Keep alphabetised.
export const RESERVED_SUBDOMAINS = new Set<string>([
  "admin",
  "api",
  "app",
  "auth",
  "console",
  "dashboard",
  "default",
  "docs",
  "help",
  "mail",
  "medcore",
  "public",
  "root",
  "status",
  "support",
  "system",
  "www",
]);

/** Subdomain rules, also used server-side by the Zod schema. */
export const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;

export function validateSubdomain(subdomain: string): string | null {
  const s = (subdomain || "").trim();
  if (s.length < 3 || s.length > 30) return "Subdomain must be 3-30 characters";
  // Reject uppercase / whitespace / underscores etc. verbatim — we do NOT
  // silently normalise, since the caller typed the subdomain literally.
  if (!SUBDOMAIN_REGEX.test(s))
    return "Subdomain must use lowercase letters, digits or hyphens (no leading/trailing hyphen)";
  if (RESERVED_SUBDOMAINS.has(s)) return "Subdomain is reserved";
  return null;
}

// ─── Default notification templates ──────────────────────────────────
// Kept small & generic so a new tenant has something usable out of the box.
// Admins can customise via /dashboard/notification-templates.
interface TemplateSeed {
  type: NTy;
  channel: NCh;
  name: string;
  subject?: string;
  body: string;
}

const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    type: "APPOINTMENT_BOOKED" as NTy,
    channel: "SMS" as NCh,
    name: "Appointment Booked (SMS)",
    body: "Hi {{patientName}}, your appointment with Dr. {{doctorName}} is confirmed for {{date}} at {{time}}. Token: {{tokenNumber}}. - {{hospitalName}}",
  },
  {
    type: "APPOINTMENT_BOOKED" as NTy,
    channel: "EMAIL" as NCh,
    name: "Appointment Booked (Email)",
    subject: "Appointment Confirmed — {{date}}",
    body:
      "Dear {{patientName}},\n\nYour appointment with Dr. {{doctorName}} on {{date}} at {{time}} is confirmed.\nToken: {{tokenNumber}}\n\n— {{hospitalName}}",
  },
  {
    type: "APPOINTMENT_REMINDER" as NTy,
    channel: "SMS" as NCh,
    name: "Appointment Reminder (SMS)",
    // Issue #879: never bake the word "tomorrow" into the persisted SMS
    // body. The notification row outlives "tomorrow" by days and the
    // patient ends up reading a temporally-false reminder. Use the
    // {{date}} variable (already populated upstream as a DD-MMM-YYYY
    // string) so a row read 2 days later still says "is scheduled for
    // 09 May 2026" — factually correct even after the appointment has
    // passed.
    body: "Reminder: {{patientName}}, you have an appointment with Dr. {{doctorName}} on {{date}} at {{time}}. Token: {{tokenNumber}}. - {{hospitalName}}",
  },
  {
    type: "APPOINTMENT_CANCELLED" as NTy,
    channel: "SMS" as NCh,
    name: "Appointment Cancelled (SMS)",
    body: "Hi {{patientName}}, your appointment with Dr. {{doctorName}} on {{date}} has been cancelled.",
  },
  {
    type: "TOKEN_CALLED" as NTy,
    channel: "PUSH" as NCh,
    name: "Token Called (Push)",
    subject: "Your turn!",
    body: "Your turn is next at Dr. {{doctorName}}'s cabin",
  },
  {
    type: "PRESCRIPTION_READY" as NTy,
    channel: "SMS" as NCh,
    name: "Prescription Ready (SMS)",
    body: "Hi {{patientName}}, your prescription from Dr. {{doctorName}} is ready. Download: {{downloadLink}}",
  },
  {
    type: "BILL_GENERATED" as NTy,
    channel: "SMS" as NCh,
    name: "Bill Generated (SMS)",
    body: "Invoice #{{invoiceNumber}} for ₹{{amount}} is ready. Pay: {{paymentLink}}",
  },
  {
    type: "PAYMENT_RECEIVED" as NTy,
    channel: "SMS" as NCh,
    name: "Payment Received (SMS)",
    body: "Thank you {{patientName}}! We received ₹{{amount}} for invoice #{{invoiceNumber}}.",
  },
  {
    type: "LAB_RESULT_READY" as NTy,
    channel: "SMS" as NCh,
    name: "Lab Result Ready (SMS)",
    body: "Hi {{patientName}}, your lab results ({{testName}}) are ready. View: {{loginLink}}",
  },
  {
    type: "ADMISSION" as NTy,
    channel: "SMS" as NCh,
    name: "Admission (SMS)",
    body: "Admitted to {{wardName}}, Bed {{bedNumber}} on {{date}}",
  },
  {
    type: "DISCHARGE" as NTy,
    channel: "SMS" as NCh,
    name: "Discharge (SMS)",
    body: "Discharged from {{wardName}}. Discharge summary available.",
  },
  {
    type: "MEDICATION_DUE" as NTy,
    channel: "PUSH" as NCh,
    name: "Medication Due (Push)",
    subject: "Medication reminder",
    body: "Medication reminder: {{medicineName}} {{dosage}}",
  },
  {
    type: "LOW_STOCK_ALERT" as NTy,
    channel: "EMAIL" as NCh,
    name: "Low Stock Alert (Email)",
    subject: "Low stock: {{medicineName}}",
    body: "{{medicineName}} is below reorder level ({{currentStock}}/{{reorderLevel}}).",
  },
];

// ─── Default public holidays (Indian 2026 calendar). ─────────────
// Issue #72 — corrected dates for Holi (Mar 4), Eid al-Fitr (Mar 21),
// Diwali (Nov 8) and added missing Ram Navami / Mahavir Jayanti / Good
// Friday / Buddha Purnima / Eid al-Adha / Janmashtami. MM-DD format;
// year is filled in at seed time. Festival dates are 2026-specific —
// callers seeding for non-2026 years should override.
const HOLIDAY_TEMPLATE: Array<{ date: string; name: string; type: string }> = [
  { date: "01-26", name: "Republic Day", type: "PUBLIC" },
  { date: "03-04", name: "Holi", type: "PUBLIC" },
  { date: "03-21", name: "Eid al-Fitr", type: "PUBLIC" },
  { date: "03-26", name: "Ram Navami", type: "OPTIONAL" },
  { date: "03-31", name: "Mahavir Jayanti", type: "OPTIONAL" },
  { date: "04-03", name: "Good Friday", type: "PUBLIC" },
  { date: "04-14", name: "Dr. Ambedkar Jayanti", type: "PUBLIC" },
  { date: "05-01", name: "Buddha Purnima", type: "OPTIONAL" },
  { date: "05-27", name: "Eid al-Adha", type: "PUBLIC" },
  { date: "08-15", name: "Independence Day", type: "PUBLIC" },
  { date: "09-04", name: "Janmashtami", type: "OPTIONAL" },
  { date: "10-02", name: "Gandhi Jayanti", type: "PUBLIC" },
  { date: "10-20", name: "Dussehra", type: "PUBLIC" },
  { date: "11-08", name: "Diwali", type: "PUBLIC" },
  { date: "12-25", name: "Christmas", type: "PUBLIC" },
];

const DEFAULT_LEAVE_TYPES: LeaveType[] = [
  "CASUAL",
  "SICK",
  "EARNED",
  "MATERNITY",
  "PATERNITY",
  "UNPAID",
] as LeaveType[];

const DEFAULT_LEAVE_ENTITLEMENTS: Record<string, number> = {
  CASUAL: 10,
  SICK: 12,
  EARNED: 18,
  MATERNITY: 180,
  PATERNITY: 15,
  UNPAID: 0,
};

// Namespacing helper for per-tenant SystemConfig. SystemConfig.key is globally
// unique, so we prefix every hospital-identity row with `tenant:<id>:` to
// get a per-tenant keyspace on top of the shared table.
export function tenantConfigKey(tenantId: string, key: string): string {
  return `tenant:${tenantId}:${key}`;
}

export interface CreateTenantParams {
  name: string;
  subdomain: string;
  plan: TenantPlan;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
  /**
   * Pearl §8.1 — human-readable tenant code (e.g. "AHMD-01"). Operator-
   * supplied via the Create Tenant form; persisted in SystemConfig under
   * `tenant:<id>:code` and read back by the tenants list endpoint.
   * Optional — leave blank to fill in later via tenant detail config.
   */
  code?: string;
  hospitalConfig?: {
    phone?: string;
    email?: string;
    gstin?: string;
    address?: string;
  };
  /**
   * Pearl Stage 1 §8.3 (gap rows 215-218 piece 3a wiring) — the platform-
   * billing `Plan` tier the new tenant pays on. Independent of the legacy
   * `plan: TenantPlan` field above (which feeds `Tenant.plan` for the
   * older BASIC/PRO/ENTERPRISE pricing — kept for back-compat).
   *
   * Default `STARTER` (every freshly-onboarded tenant lands on Starter +
   * 30-day trial unless super-admin onboards a bespoke Enterprise
   * tenant and explicitly overrides). Resolved `includedFeatures` are
   * materialised onto `Tenant.featureFlags` in the same transaction so
   * `requireFeature(...)` middleware gates accordingly from day 1.
   */
  initialPlan?: Plan;
}

export interface CreateTenantResult {
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    plan: TenantPlan;
    active: boolean;
  };
  adminUser: {
    id: string;
    // #891: schema widened to `email String?`. Tenant provisioning
    // always supplies an `adminEmail` so this field is never null in
    // practice, but type it as nullable to match the Prisma return.
    email: string | null;
    name: string;
    role: string;
  };
  seeded: {
    notificationTemplates: number;
    notificationPreferences: number;
    leaveBalances: number;
    holidays: number;
    systemConfigRows: number;
  };
  /**
   * Pearl Stage 1 §8.3 — the auto-provisioned `TenantSubscription` row
   * (see gap rows 215-218 piece 3a wiring). Always present on a fresh
   * `createTenant()` call; field is included so callers (super-admin
   * onboarding UI, future Stage-1 e2e helpers) can echo the plan tier +
   * trial deadline back to the operator without a follow-up read.
   */
  subscription: {
    id: string;
    plan: Plan;
    status: "trial";
    trialEndsAt: Date;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  };
}

/**
 * Create a brand-new tenant and provision its baseline data in one atomic
 * transaction. Throws on subdomain conflict (unique constraint) or any seed
 * step failure — the entire transaction rolls back on throw.
 */
export async function createTenant(
  params: CreateTenantParams,
): Promise<CreateTenantResult> {
  const {
    name,
    subdomain,
    plan,
    adminEmail,
    adminPassword,
    adminName,
    hospitalConfig,
  } = params;

  // Hash OUTSIDE the transaction — bcrypt is CPU-bound and the pg client
  // should not hold a txn open while we compute the salt rounds.
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  // Pearl Stage 1 §8.3 — every freshly-onboarded tenant lands on a
  // platform-billing plan tier with a 30-day trial. When the caller
  // doesn't explicitly pass `initialPlan`, we derive it from the
  // legacy `Tenant.plan` (BASIC/PRO/ENTERPRISE) so the two plan
  // fields stay in sync — otherwise the operator picks ENTERPRISE on
  // the create form and the subscription silently lands on STARTER,
  // which is what was making /super-admin/platform-billing show
  // "STARTER" for tenants the operator just created as ENTERPRISE.
  //
  //   BASIC      → STARTER
  //   PRO        → GROWTH
  //   ENTERPRISE → ENTERPRISE
  function planFromLegacy(p: TenantPlan | undefined): Plan {
    if (p === "ENTERPRISE") return "ENTERPRISE";
    if (p === "PRO") return "GROWTH";
    return "STARTER";
  }
  const initialPlan: Plan =
    params.initialPlan ?? planFromLegacy(plan as TenantPlan | undefined);
  const planDef = PLAN_DEFINITIONS[initialPlan];
  if (!planDef) {
    throw new Error(`Unknown plan tier: ${initialPlan}`);
  }
  const featureFlagsForPlan: Record<string, boolean> = {};
  for (const key of planDef.includedFeatures) {
    featureFlagsForPlan[key] = true;
  }
  const provisionedAt = new Date();
  const trialEndsAt = new Date(
    provisionedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
  );

  return prisma.$transaction(
    async (tx) => {
      // 1. Tenant row ────────────────────────────────────────────────
      const tenant = await tx.tenant.create({
        data: {
          name,
          subdomain,
          plan,
          active: true,
          // Pearl Stage 1 §6 + §8.3 — materialise the plan's included
          // features as the initial `featureFlags` JSON. Stage-2+
          // features default to false (omitted ⇒ falls through to
          // FEATURE_METADATA.defaultEnabled, but explicit-true here is
          // load-bearing for the requireFeature middleware).
          featureFlags: featureFlagsForPlan,
        },
      });

      // 2. First ADMIN user ──────────────────────────────────────────
      // Pre-check email uniqueness — users.email is a global unique index so
      // reusing an email across tenants is not allowed. This also gives us a
      // cleaner error than the raw Prisma constraint exception.
      const existingEmailUser = await tx.user.findUnique({
        where: { email: adminEmail },
      });
      if (existingEmailUser) {
        throw new Error(
          "An account with this email already exists. Use a different admin email.",
        );
      }

      const adminUser = await tx.user.create({
        data: {
          email: adminEmail,
          name: adminName,
          phone: hospitalConfig?.phone?.trim() || "0000000000",
          passwordHash,
          role: "ADMIN",
          tenantId: tenant.id,
          isActive: true,
        },
      });

      // 3. Notification templates ─────────────────────────────────────
      // NotificationTemplate has @@unique([type, channel]); since this is a
      // global unique (not per-tenant) we scope the default set to THIS
      // tenant only by writing rows with a per-tenant name prefix and — if
      // the composite already exists from another tenant — skip it. The
      // existing `tenantId` FK on NotificationTemplate will still scope
      // reads correctly when tenantScopedPrisma is used downstream.
      //
      // Implementation: `createMany` with `skipDuplicates: true` so the
      // operation never aborts the transaction on a conflict.
      const templateRows = DEFAULT_TEMPLATES.map((t) => ({
        type: t.type,
        channel: t.channel,
        name: t.name,
        subject: t.subject ?? null,
        body: t.body,
        isActive: true,
        tenantId: tenant.id,
      }));
      const tplResult = await tx.notificationTemplate.createMany({
        data: templateRows,
        skipDuplicates: true,
      });

      // 4. Notification preferences for the admin user (all 4 channels ON) ─
      const prefChannels: NCh[] = [
        "WHATSAPP" as NCh,
        "SMS" as NCh,
        "EMAIL" as NCh,
        "PUSH" as NCh,
      ];
      await tx.notificationPreference.createMany({
        data: prefChannels.map((channel) => ({
          userId: adminUser.id,
          channel,
          enabled: true,
        })),
        skipDuplicates: true,
      });

      // 5. Leave balances for admin user for the current year ─────────
      const currentYear = new Date().getFullYear();
      const leaveRows = DEFAULT_LEAVE_TYPES.map((type) => ({
        userId: adminUser.id,
        type,
        year: currentYear,
        entitled: DEFAULT_LEAVE_ENTITLEMENTS[type] ?? 0,
        used: 0,
        carried: 0,
        tenantId: tenant.id,
      }));
      await tx.leaveBalance.createMany({
        data: leaveRows,
        skipDuplicates: true,
      });

      // 6. Holidays ──────────────────────────────────────────────────
      // Holiday @@unique([date, name]) is also global; use skipDuplicates
      // so a tenant that shares date+name with an existing row (legacy or
      // another tenant, e.g. default) doesn't break the transaction.
      const holidayRows = HOLIDAY_TEMPLATE.map((h) => ({
        date: new Date(`${currentYear}-${h.date}T00:00:00.000Z`),
        name: h.name,
        type: h.type,
        tenantId: tenant.id,
      }));
      const holidayResult = await tx.holiday.createMany({
        data: holidayRows,
        skipDuplicates: true,
      });

      // 7. SystemConfig rows for hospital identity, namespaced by tenant id.
      //    SystemConfig.key is a global unique, so we prefix with
      //    `tenant:<id>:`. Callers should read via tenantConfigKey().
      // Pearl §8.1 — `code` is operator-supplied via the Create Tenant
      // form (NOT auto-generated). When the operator leaves it blank,
      // we skip the row so the Code column on the tenants list shows
      // "—" until the operator fills it in later.
      const configEntries: Array<{ key: string; value: string }> = [
        { key: "hospital_name", value: name },
        { key: "hospital_phone", value: hospitalConfig?.phone ?? "" },
        { key: "hospital_email", value: hospitalConfig?.email ?? "" },
        { key: "hospital_gstin", value: hospitalConfig?.gstin ?? "" },
        { key: "hospital_address", value: hospitalConfig?.address ?? "" },
        { key: "onboarding_started_at", value: new Date().toISOString() },
        ...(params.code && params.code.trim().length > 0
          ? [{ key: "code", value: params.code.trim().toUpperCase() }]
          : []),
      ];
      for (const entry of configEntries) {
        await tx.systemConfig.create({
          data: {
            key: tenantConfigKey(tenant.id, entry.key),
            value: entry.value,
          },
        });
      }

      // 8. Platform-billing TenantSubscription row ─────────────────────
      // Pearl Stage 1 §8.3 (gap rows 215-218 piece 3a wiring 2026-05-25)
      // — every new tenant gets a `TenantSubscription` in `trial` status
      // with `trialEndsAt = provisionedAt + 30d`. Without this, the
      // monthly platform-invoice generator (`platform-invoice-generator.
      // ts`) skips the tenant entirely because its
      // `tenantSubscription.findMany({status: not cancelled})` query
      // would return nothing — silent missed billing.
      //
      // currentPeriodStart = now; currentPeriodEnd = trialEndsAt so the
      // first billable window (post-trial) starts exactly when the
      // trial expires. Plan defaults to STARTER unless super-admin
      // overrode `initialPlan` (e.g. for a hand-onboarded Enterprise
      // tenant). One subscription per tenant — guarded by
      // `TenantSubscription.tenantId @unique`.
      const subscription = await tx.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          plan: initialPlan,
          status: "trial",
          trialEndsAt,
          currentPeriodStart: provisionedAt,
          currentPeriodEnd: trialEndsAt,
        },
      });

      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          subdomain: tenant.subdomain,
          plan: tenant.plan,
          active: tenant.active,
        },
        adminUser: {
          id: adminUser.id,
          email: adminUser.email,
          name: adminUser.name,
          role: adminUser.role,
        },
        seeded: {
          notificationTemplates: tplResult.count,
          notificationPreferences: prefChannels.length,
          leaveBalances: leaveRows.length,
          holidays: holidayResult.count,
          systemConfigRows: configEntries.length,
        },
        subscription: {
          id: subscription.id,
          plan: initialPlan,
          status: "trial" as const,
          trialEndsAt,
          currentPeriodStart: provisionedAt,
          currentPeriodEnd: trialEndsAt,
        },
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * Pearl Stage 1 §8.3 (gap rows 215-218 piece 3a wiring 2026-05-25) —
 * back-fill helper. Walks every `Tenant` row that has NO
 * `TenantSubscription` and creates one. Use case: pre-existing tenants
 * that were created before this auto-provisioning landed; without a
 * subscription they are silently invisible to the monthly invoice
 * generator.
 *
 * Differences vs the fresh-onboarding path in `createTenant`:
 *   - status is `active` (not `trial`) — back-filled tenants are not
 *     on a trial window; they have been running in production already.
 *   - trialEndsAt = null.
 *   - currentPeriodStart = first of the current calendar month (UTC);
 *     currentPeriodEnd = first of next calendar month (UTC). This
 *     aligns with the monthly invoice generator's window math (see
 *     `computePreviousMonthUtcWindow` in `platform-invoice-generator.
 *     ts`) so the very first invoice covers a clean calendar month.
 *
 * Idempotent — skips any tenant that already has a subscription. Safe
 * to call multiple times. Returns the count of subscriptions created.
 *
 * Not auto-wired into a route; super-admin can invoke via a one-shot
 * npm script (`tsx -e "..."`) or a follow-up admin route. Kept as a
 * pure function for testability.
 */
export async function backfillTenantSubscriptions(
  client: {
    tenant: {
      findMany: (args: {
        where: { tenantSubscription: { is: null } };
        select: { id: true };
      }) => Promise<Array<{ id: string }>>;
    };
    tenantSubscription: {
      create: (args: {
        data: {
          tenantId: string;
          plan: Plan;
          status: "active";
          trialEndsAt: null;
          currentPeriodStart: Date;
          currentPeriodEnd: Date;
        };
      }) => Promise<unknown>;
    };
  } = prisma as never,
  opts: { defaultPlan?: Plan; now?: Date } = {},
): Promise<{ created: number }> {
  const defaultPlan: Plan = opts.defaultPlan ?? "STARTER";
  const now = opts.now ?? new Date();
  // First-of-current-month / first-of-next-month in UTC, matching the
  // generator's window math.
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  const orphanTenants = await client.tenant.findMany({
    where: { tenantSubscription: { is: null } },
    select: { id: true },
  });

  let created = 0;
  for (const t of orphanTenants) {
    await client.tenantSubscription.create({
      data: {
        tenantId: t.id,
        plan: defaultPlan,
        status: "active",
        trialEndsAt: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    created += 1;
  }
  return { created };
}

/**
 * Soft-deactivate a tenant. `active=false` causes the auth resolver to skip
 * the tenant on subdomain resolution, and existing sessions will fail at the
 * next `/refresh` attempt because we look up the tenant's `active` flag.
 *
 * Pearl §8.1 row 233 (2026-05-25) — stamps `deactivatedAt = now` so the
 * daily `tenant_archive_sweep` cron can detect tenants suspended >=90
 * days and trigger `archiveTenant()`. Idempotent: re-suspending an
 * already-suspended tenant does NOT advance `deactivatedAt` (we keep the
 * original suspend timestamp so the 90-day window doesn't slide on a
 * second click).
 */
export async function deactivateTenant(tenantId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error("Tenant not found");
    const data: { active: false; deactivatedAt?: Date } = { active: false };
    // Only set deactivatedAt on the first suspend — keep the original
    // timestamp so the 90-day archive window is anchored to the first
    // suspend, not the most recent click.
    if (!tenant.deactivatedAt) {
      data.deactivatedAt = new Date();
    }
    await tx.tenant.update({
      where: { id: tenantId },
      data,
    });
    // Invalidate refresh tokens for every user of this tenant so the next
    // refresh call fails immediately instead of after the current access
    // token expires.
    await tx.refreshToken.deleteMany({
      where: { user: { tenantId } },
    });
  });
}

/**
 * Restore a previously-suspended tenant. Mirror of `deactivateTenant` — flips
 * `active=true` so the auth resolver lets the tenant's users log in again.
 * Refresh tokens are NOT re-issued (they were wiped on deactivate); users
 * must perform a fresh `/auth/login`. Idempotent — restoring an already-
 * active tenant is a no-op.
 *
 * Pearl §8.1 row 206 — suspend/restore symmetry. Row 233 (2026-05-25)
 * additionally clears `deactivatedAt` so a future suspend re-anchors the
 * 90-day archival window. Archive metadata (`archivedAt`,
 * `archiveS3Key`, etc.) is NOT cleared by restore — those are stamped by
 * `archiveTenant()` and remain even after a restore so the operator
 * retains a forensic trail of "this tenant was once archived to S3 key
 * X". A restored tenant is again live (active=true) but the historical
 * archive in S3 stays put until the operator explicitly purges via
 * `purgeArchivedTenant()`.
 */
export async function activateTenant(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("Tenant not found");
  if (tenant.active) return;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { active: true, deactivatedAt: null },
  });
}
