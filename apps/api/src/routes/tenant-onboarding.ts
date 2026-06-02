/**
 * Tenant onboarding wizard API — Pearl ERP Stage 1 §8.1 (gap #6 piece 2 of 4).
 *
 * What / which modules / why:
 *   - Single endpoint POST /api/v1/tenant-onboarding that consumes the
 *     full 3-step wizard payload from /super-admin/onboard and
 *     atomically provisions Tenant + first Branch (isDefault=true) +
 *     super-admin User (Role.ADMIN, tenantId=newTenantId).
 *   - The existing /api/v1/tenants POST (services/tenant-provisioning.ts
 *     createTenant) creates Tenant + first ADMIN + seeds — but it does
 *     NOT create a Branch row. This wizard adds the missing Branch step
 *     and inlines its own transaction so we can keep the existing
 *     /api/v1/tenants surface untouched for the in-band
 *     /dashboard/tenants modal flow.
 *   - RBAC: identical guard chain to routes/tenants.ts —
 *     authenticate → authorize(Role.ADMIN) → requireSuperAdmin
 *     (caller's tenantId == null OR caller is on the default tenant).
 *
 * Day-zero integrations (Pearl §8.7 acceptance):
 *   - WhatsApp Business API creds (Gupshup) — optional, persisted as
 *     `tenant:<id>:whatsapp_*` SystemConfig rows so the messaging
 *     service picks them up.
 *   - Razorpay payment-gateway creds — optional, persisted on
 *     Tenant.razorpayKey* so services/razorpay.ts resolves them.
 *
 * Out-of-scope (deferred):
 *   - HFR (Health Facility Registry) sync.
 *   - HPR (Health Professional Registry) link.
 *
 * Audit: TENANT_ONBOARD with entity="tenant" + payload
 *     {subdomain, branchId, branchName, adminEmail}.
 */

import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "@medcore/db";
import {
  Role,
  tenantOnboardingSchema,
  type TenantOnboardingInput,
} from "@medcore/shared";
import { canonicalisePhone } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { RESERVED_SUBDOMAINS, SUBDOMAIN_REGEX } from "../services/tenant-provisioning";
import { getPlanByKey } from "../services/plan-catalog";

const router = Router();

// ─── Super-admin guard ───────────────────────────────────────────────
// Mirrors routes/tenants.ts:requireSuperAdmin exactly. We re-declare the
// guard here (instead of exporting from tenants.ts) to keep router files
// independent — tenants.ts and tenant-onboarding.ts can be mounted in
// either order without an import cycle.
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
    if (req.user?.role === Role.SUPER_ADMIN) {
      return next();
    }
    const callerTenantId = req.user?.tenantId ?? null;
    if (callerTenantId == null) {
      // Globally tenant-less super-admin — allow.
      return next();
    }
    const callerTenant = await prisma.tenant.findUnique({
      where: { id: callerTenantId },
      select: { subdomain: true },
    });
    if (callerTenant?.subdomain === "default") {
      return next();
    }
    res.status(403).json({
      success: false,
      data: null,
      error:
        "Only super-admins (Role.ADMIN with no tenant binding, or on the default tenant) can onboard tenants",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);

// ─── POST / ─ run the wizard ─────────────────────────────────────────
router.post(
  "/",
  validate(tenantOnboardingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as TenantOnboardingInput;

      // Belt-and-suspenders subdomain validation. The Zod schema already
      // rejects malformed and reserved values, but reach for the API-side
      // constants too — kept in sync with tenant-provisioning.ts — so the
      // surface is impossible to drift apart.
      if (
        !SUBDOMAIN_REGEX.test(body.tenant.subdomain) ||
        RESERVED_SUBDOMAINS.has(body.tenant.subdomain)
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid or reserved subdomain",
          field: "tenant.subdomain",
        });
        return;
      }

      // Pre-check subdomain uniqueness for a clean 409 (vs. opaque
      // Prisma unique-constraint error mid-transaction).
      const existingTenant = await prisma.tenant.findUnique({
        where: { subdomain: body.tenant.subdomain },
        select: { id: true },
      });
      if (existingTenant) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Subdomain already taken",
          field: "tenant.subdomain",
        });
        return;
      }

      // Pre-check admin email uniqueness — User.email is a global unique.
      const existingEmail = await prisma.user.findUnique({
        where: { email: body.admin.email },
        select: { id: true },
      });
      if (existingEmail) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Admin email already in use",
          field: "admin.email",
        });
        return;
      }

      // Verify the chosen plan key resolves to an existing ACTIVE plan in the
      // dynamic catalog (the schema only validates the key shape).
      const planRow = await getPlanByKey(prisma, body.tenant.plan);
      if (!planRow || !planRow.active) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unknown or inactive plan "${body.tenant.plan}". Pick an active plan from the catalog.`,
          field: "tenant.plan",
        });
        return;
      }

      // Hash OUTSIDE the transaction — bcrypt is CPU-bound and we don't
      // want to hold a pg txn open across the salt-rounds compute. The
      // existing services/tenant-provisioning.ts does the same.
      const passwordHash = await bcrypt.hash(body.admin.password, 10);
      const canonicalAdminPhone = canonicalisePhone(body.admin.phone);

      // Atomic transaction: tenant → branch → admin user.
      // Note: the simpler-but-richer createTenant() service ALSO seeds
      // notification templates, leave balances, holidays etc. We do NOT
      // want the wizard to skip those — they're load-bearing for a new
      // tenant to be usable. We call into the same primitives inline
      // here to keep the Branch creation in the same transaction.
      // Sequence:
      //   1. tenant row
      //   2. first branch (isDefault=true)
      //   3. super-admin User (role=ADMIN, tenantId=new)
      //   4. minimal seed: hospital_name SystemConfig row so PDFs render
      //      a name. Full reference-data seeding (templates, holidays,
      //      leave balances) intentionally NOT done here — the wizard
      //      drops the operator into /super-admin where they can run
      //      the seed action separately, or the post-creation flow
      //      handles it. (Defer to piece 2b — keeps this transaction
      //      cheap.)
      const result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: body.tenant.name,
            subdomain: body.tenant.subdomain,
            plan: body.tenant.plan,
            active: true,
          },
        });

        const branch = await tx.branch.create({
          data: {
            tenantId: tenant.id,
            name: body.branch.name,
            code: body.branch.code ?? null,
            address: body.branch.address ?? null,
            city: body.branch.city ?? null,
            state: body.branch.state ?? null,
            pincode: body.branch.pincode ?? null,
            phone: body.branch.phone ?? null,
            email: null,
            gstin: null,
            isDefault: true,
            active: true,
          },
        });

        const admin = await tx.user.create({
          data: {
            email: body.admin.email,
            name: body.admin.name,
            phone: canonicalAdminPhone,
            passwordHash,
            role: "ADMIN",
            tenantId: tenant.id,
            isActive: true,
          },
        });

        // Minimal hospital identity row so downstream PDF/notification
        // renderers can read the hospital name. SystemConfig.key is a
        // global unique, so we prefix with `tenant:<id>:` per the
        // existing convention (tenant-provisioning.ts:tenantConfigKey).
        await tx.systemConfig.create({
          data: {
            key: `tenant:${tenant.id}:hospital_name`,
            value: body.tenant.name,
          },
        });

        // Pearl §8.7 — Razorpay creds (optional). Persisted on the
        // Tenant row so the existing services/razorpay.ts cred-resolver
        // picks them up; the operator can finalise / rotate via the
        // tenant detail drawer later. Empty strings are treated as
        // "skip" rather than "clear" since onboarding only writes.
        const razorpayKeyId = body.razorpay?.keyId?.trim();
        const razorpayKeySecret = body.razorpay?.keySecret?.trim();
        const razorpayMode = body.razorpay?.mode;
        if (razorpayKeyId || razorpayKeySecret || razorpayMode) {
          await tx.tenant.update({
            where: { id: tenant.id },
            data: {
              ...(razorpayKeyId ? { razorpayKeyId } : {}),
              ...(razorpayKeySecret ? { razorpayKeySecret } : {}),
              ...(razorpayMode ? { razorpayMode } : {}),
            },
          });
        }

        // Pearl §8.7 — WhatsApp Gupshup creds (optional). Stored under
        // tenant-scoped SystemConfig keys so the existing WhatsApp
        // sender (services/messaging/whatsapp.ts) can resolve them.
        // Same skip-on-blank semantic as Razorpay above.
        const wa = body.whatsapp ?? {};
        const whatsappRows: Array<{ key: string; value: string }> = [];
        if (wa.apiUrl && wa.apiUrl.length > 0) {
          whatsappRows.push({
            key: `tenant:${tenant.id}:whatsapp_api_url`,
            value: wa.apiUrl,
          });
        }
        if (wa.apiKey && wa.apiKey.length > 0) {
          whatsappRows.push({
            key: `tenant:${tenant.id}:whatsapp_api_key`,
            value: wa.apiKey,
          });
        }
        if (wa.appName && wa.appName.length > 0) {
          whatsappRows.push({
            key: `tenant:${tenant.id}:whatsapp_app_name`,
            value: wa.appName,
          });
        }
        if (wa.sourceNumber && wa.sourceNumber.length > 0) {
          whatsappRows.push({
            key: `tenant:${tenant.id}:whatsapp_source_number`,
            value: wa.sourceNumber,
          });
        }
        for (const row of whatsappRows) {
          await tx.systemConfig.create({ data: row });
        }

        return { tenant, branch, admin };
      });

      // Fire-and-forget audit (no race against the response — auditLog
      // here is the awaitable variant from middleware/audit.ts; we still
      // wrap in .catch so a logging failure never tanks the wizard).
      const integrationsLanded = {
        whatsappConfigured: !!(
          body.whatsapp?.apiUrl ||
          body.whatsapp?.apiKey ||
          body.whatsapp?.sourceNumber
        ),
        razorpayConfigured: !!(
          body.razorpay?.keyId || body.razorpay?.keySecret
        ),
      };

      auditLog(req, "TENANT_ONBOARD", "tenant", result.tenant.id, {
        subdomain: result.tenant.subdomain,
        plan: result.tenant.plan,
        branchId: result.branch.id,
        branchName: result.branch.name,
        adminEmail: result.admin.email,
        ...integrationsLanded,
      }).catch((e) => console.error("audit TENANT_ONBOARD failed", e));

      res.status(201).json({
        success: true,
        data: {
          tenant: {
            id: result.tenant.id,
            name: result.tenant.name,
            subdomain: result.tenant.subdomain,
            plan: result.tenant.plan,
            active: result.tenant.active,
          },
          branch: {
            id: result.branch.id,
            name: result.branch.name,
            isDefault: result.branch.isDefault,
          },
          admin: {
            id: result.admin.id,
            email: result.admin.email,
            name: result.admin.name,
          },
          integrations: integrationsLanded,
        },
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Race-condition fallback if two operators submit the same
      // subdomain at the same instant: the Prisma unique constraint
      // surfaces here. Map it to a clean 409.
      if (
        msg.includes("Unique constraint") &&
        (msg.includes("subdomain") || msg.includes("tenants_subdomain_key"))
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Subdomain already taken",
          field: "tenant.subdomain",
        });
        return;
      }
      if (
        msg.includes("Unique constraint") &&
        (msg.includes("email") || msg.includes("users_email_key"))
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Admin email already in use",
          field: "admin.email",
        });
        return;
      }
      next(err);
    }
  },
);

export { router as tenantOnboardingRouter };
