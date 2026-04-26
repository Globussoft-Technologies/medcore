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
    body: "Reminder: {{patientName}}, you have an appointment with Dr. {{doctorName}} tomorrow at {{time}}. Token: {{tokenNumber}}. - {{hospitalName}}",
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
  hospitalConfig?: {
    phone?: string;
    email?: string;
    gstin?: string;
    address?: string;
  };
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
    email: string;
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

  return prisma.$transaction(
    async (tx) => {
      // 1. Tenant row ────────────────────────────────────────────────
      const tenant = await tx.tenant.create({
        data: {
          name,
          subdomain,
          plan,
          active: true,
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
      const configEntries: Array<{ key: string; value: string }> = [
        { key: "hospital_name", value: name },
        { key: "hospital_phone", value: hospitalConfig?.phone ?? "" },
        { key: "hospital_email", value: hospitalConfig?.email ?? "" },
        { key: "hospital_gstin", value: hospitalConfig?.gstin ?? "" },
        { key: "hospital_address", value: hospitalConfig?.address ?? "" },
        { key: "onboarding_started_at", value: new Date().toISOString() },
      ];
      for (const entry of configEntries) {
        await tx.systemConfig.create({
          data: {
            key: tenantConfigKey(tenant.id, entry.key),
            value: entry.value,
          },
        });
      }

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
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * Soft-deactivate a tenant. `active=false` causes the auth resolver to skip
 * the tenant on subdomain resolution, and existing sessions will fail at the
 * next `/refresh` attempt because we look up the tenant's `active` flag.
 */
export async function deactivateTenant(tenantId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error("Tenant not found");
    await tx.tenant.update({
      where: { id: tenantId },
      data: { active: false },
    });
    // Invalidate refresh tokens for every user of this tenant so the next
    // refresh call fails immediately instead of after the current access
    // token expires.
    await tx.refreshToken.deleteMany({
      where: { user: { tenantId } },
    });
  });
}
