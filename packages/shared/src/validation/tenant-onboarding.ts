// Pearl ERP Stage 1 §8.1 — gap item #6 piece 2 of 4. Zod schema for the
// 3-step super-admin onboarding wizard.
//
// What / which modules / why:
//   - The wizard's atomic POST /api/v1/tenant-onboarding accepts ONE
//     payload composed of tenant basics + first-branch + first-admin
//     fields. The transaction provisions all three rows in one shot.
//   - PRD §8.1 calls for an 8-step wizard; we ship a 3-step MVP here
//     (tenant + first branch + super-admin user). HFR/HPR/WhatsApp/
//     Razorpay config steps are deferred to piece 2b (no schema yet,
//     and each needs an external integration the wizard would validate
//     against).
//   - We deliberately do NOT reuse the existing `createTenantSchema`
//     from `validation/auth.ts` shape (the in-band /dashboard/tenants
//     modal posts a flat shape directly to `POST /api/v1/tenants`).
//     The super-admin wizard's API wants a nested `{tenant, branch,
//     admin}` shape so each step's payload is grouped clearly and
//     server-side 409s can return a `field` that points back to the
//     right step.

import { z } from "zod";

// Subdomain rules mirror `tenant-provisioning.SUBDOMAIN_REGEX` exactly —
// the same regex the existing `/api/v1/tenants` route uses. Kept inline
// because @medcore/shared cannot import from @medcore/db / the api
// package (cyclic).
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;
const RESERVED_SUBDOMAINS = new Set<string>([
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

// Branch code regex matches `validation/branch.ts:branchCodeRegex`.
const BRANCH_CODE_REGEX = /^[A-Z0-9_-]{1,10}$/;

// PIN code: 6 digits, as everywhere else.
const PINCODE_REGEX = /^\d{6}$/;

// Loose Indian-or-international phone (matches branch.ts:phoneRegex).
const PHONE_REGEX = /^\+?\d{7,15}$/;

// Plan tiers are now dynamic (DB-backed `PlatformPlan` rows), so the
// schema only validates the KEY SHAPE here — `@medcore/shared` cannot
// import from `@medcore/db` (cyclic dep), so it can't check existence.
// The route handler verifies the key resolves to an existing ACTIVE
// `PlatformPlan` before provisioning.
const PLAN_KEY_REGEX = /^[A-Z0-9_]{2,40}$/;
const planEnum = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    PLAN_KEY_REGEX,
    "Plan must be a valid plan key (2-40 uppercase letters, digits or underscores)",
  );

// ─── Step 1 — Tenant basics ──────────────────────────────────────────
export const tenantOnboardingTenantSchema = z.object({
  name: z.string().trim().min(2, "Hospital name too short").max(120),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (s) => SUBDOMAIN_REGEX.test(s) && !RESERVED_SUBDOMAINS.has(s),
      {
        message:
          "Subdomain must be 3-30 chars, lowercase letters/digits/hyphens, not a reserved word",
      },
    ),
  plan: planEnum,
});

// ─── Step 2 — First branch ───────────────────────────────────────────
export const tenantOnboardingBranchSchema = z.object({
  name: z.string().trim().min(2, "Branch name too short").max(120),
  // Code is optional on Branch CRUD; we follow suit so a one-branch
  // tenant can skip it. When provided we still enforce the same regex.
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(BRANCH_CODE_REGEX, "Branch code must be 1-10 uppercase alphanumerics")
    .optional()
    .nullable(),
  address: z.string().trim().max(512).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  pincode: z
    .string()
    .trim()
    .regex(PINCODE_REGEX, "Pincode must be 6 digits")
    .optional()
    .nullable(),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Invalid phone (7-15 digits, optional leading +)")
    .optional()
    .nullable(),
});

// ─── Step 3 — Super-admin user ───────────────────────────────────────
export const tenantOnboardingAdminSchema = z.object({
  name: z.string().trim().min(2, "Admin name too short").max(120),
  email: z.string().email("Invalid email"),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Invalid phone (7-15 digits, optional leading +)"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

// ─── Step 4 (optional) — WhatsApp config ─────────────────────────────
// Pearl §8.7 acceptance: day-zero wizard MAY include WhatsApp creds so
// the tenant can send patient notifications immediately. Operator can
// skip — empty object accepted; the section is wired post-onboarding
// via /dashboard/settings/whatsapp if skipped here.
export const tenantOnboardingWhatsappSchema = z.object({
  apiUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  apiKey: z.string().trim().max(500).optional().or(z.literal("")),
  appName: z.string().trim().max(120).optional().or(z.literal("")),
  sourceNumber: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Invalid sender number (7-15 digits, optional leading +)")
    .optional()
    .or(z.literal("")),
});

// ─── Step 5 (optional) — Razorpay payment gateway ────────────────────
// Per Pearl gap #10b, tenant-scoped Razorpay creds enable multi-tenant
// payment processing. Same skip-friendly shape as WhatsApp.
export const tenantOnboardingRazorpaySchema = z.object({
  keyId: z.string().trim().max(120).optional().or(z.literal("")),
  keySecret: z.string().trim().max(500).optional().or(z.literal("")),
  mode: z.enum(["test", "live"]).optional(),
});

// ─── Combined wizard payload ─────────────────────────────────────────
export const tenantOnboardingSchema = z.object({
  tenant: tenantOnboardingTenantSchema,
  branch: tenantOnboardingBranchSchema,
  admin: tenantOnboardingAdminSchema,
  // Optional integrations — wizard may skip; operator finishes later.
  whatsapp: tenantOnboardingWhatsappSchema.optional(),
  razorpay: tenantOnboardingRazorpaySchema.optional(),
});

export type TenantOnboardingInput = z.infer<typeof tenantOnboardingSchema>;
export type TenantOnboardingTenantInput = z.infer<
  typeof tenantOnboardingTenantSchema
>;
export type TenantOnboardingBranchInput = z.infer<
  typeof tenantOnboardingBranchSchema
>;
export type TenantOnboardingAdminInput = z.infer<
  typeof tenantOnboardingAdminSchema
>;
export type TenantOnboardingWhatsappInput = z.infer<
  typeof tenantOnboardingWhatsappSchema
>;
export type TenantOnboardingRazorpayInput = z.infer<
  typeof tenantOnboardingRazorpaySchema
>;

// Re-exports of the constants so consumers (UI client-side validation)
// can stay in sync without redefining the rules.
export const TENANT_ONBOARDING_SUBDOMAIN_REGEX = SUBDOMAIN_REGEX;
export const TENANT_ONBOARDING_RESERVED_SUBDOMAINS = RESERVED_SUBDOMAINS;
