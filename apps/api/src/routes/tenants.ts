/**
 * Tenants admin API.
 *
 * Operator-facing endpoints for managing multi-tenant hospital installations.
 * ALL endpoints require ADMIN role AND a caller who is either:
 *   (a) attached to the seeded "default" tenant, or
 *   (b) globally tenant-less (legacy super-admin accounts with tenantId == null)
 *
 * Tenants are created atomically via `tenant-provisioning.createTenant`;
 * read / list / update endpoints use the un-scoped `prisma` export because
 * cross-tenant visibility is the whole point of this module.
 *
 * All mutations emit an AuditLog row (actions TENANT_CREATE / TENANT_UPDATE
 * / TENANT_SUSPENDED / TENANT_RESTORED) tagged with the caller's userId.
 * Pearl §8.1 row 206 — suspend/restore are symmetric POST endpoints
 * (`/:id/deactivate` retained as the suspend path for back-compat; the
 * matching restore is `/:id/restore`). S3 archival of suspended-tenant
 * data remains a separate piece (deferred).
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import {
  createTenant,
  deactivateTenant,
  activateTenant,
  validateSubdomain,
  tenantConfigKey,
} from "../services/tenant-provisioning";

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────

const planEnum = z.enum(["BASIC", "PRO", "ENTERPRISE"]);

const createTenantSchema = z.object({
  name: z.string().trim().min(2, "Name too short").max(120),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((s) => validateSubdomain(s) === null, {
      message:
        "Invalid subdomain: 3-30 chars, lowercase letters/digits/hyphens, not reserved",
    }),
  plan: planEnum,
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8, "Password must be at least 8 characters"),
  adminName: z.string().trim().min(2).max(120),
  hospitalConfig: z
    .object({
      phone: z.string().trim().max(32).optional(),
      email: z.string().email().optional().or(z.literal("")),
      gstin: z.string().trim().max(32).optional(),
      address: z.string().trim().max(512).optional(),
    })
    .optional(),
});

const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  plan: planEnum.optional(),
  active: z.boolean().optional(),
  // Pearl gap #10b — per-tenant Razorpay creds + ADMIN TOTP policy.
  // razorpayKeySecret accepts null to clear (rotate); razorpayMode is
  // an informational label that the gateway URL doesn't actually depend
  // on (Razorpay routes by keyId prefix), but the super-admin UI shows
  // it to make accidental "test keys in prod" easier to spot.
  razorpayKeyId: z.string().trim().min(8).max(64).nullable().optional(),
  razorpayKeySecret: z.string().trim().min(8).max(128).nullable().optional(),
  razorpayMode: z.enum(["test", "live"]).nullable().optional(),
  requireAdminTOTP: z.boolean().optional(),
  // Pearl §8.2 row 212 — per-tenant idle session timeout (minutes).
  // Range [5, 1440] = 5 min floor (avoids accidental "logged out
  // every page load" misconfiguration) → 24 h ceiling (avoids
  // effectively-never-expires). JWT TTL enforcement deferred — this
  // PATCH only persists the configured value for now.
  sessionIdleMinutes: z.number().int().min(5).max(1440).optional(),
});

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Only allow callers from the default tenant or globally-tenant-less admins
 * to manage the tenant fleet. Non-default-tenant admins (operators of an
 * individual hospital) are NOT allowed to list/create other tenants.
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // authenticate() has already ensured req.user is ADMIN when combined
    // with authorize(Role.ADMIN) — but we still need to check the tenant.
    const callerTenantId = req.user?.tenantId ?? null;

    if (callerTenantId == null) {
      // Global super-admin / legacy account — allow.
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
      error: "Only super-admins on the default tenant can manage tenants",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

router.use(authenticate);
router.use(authorize(Role.ADMIN));
router.use(requireSuperAdmin);
// #511 audit (2026-05-05, cron-tick): all handlers verified safe via
// router-level authorize(Role.ADMIN) + requireSuperAdmin guard. PATIENT
// is excluded by the role check; non-default-tenant admins are excluded
// by requireSuperAdmin. Tenant administration is super-admin-only by
// definition — no per-row ownership check applies.

// ─── Usage-stats helper ──────────────────────────────────────────────

interface TenantUsageStats {
  userCount: number;
  patientCount: number;
  invoicesLast30Days: number;
  storageBytes: number;
}

async function loadTenantStats(tenantId: string): Promise<TenantUsageStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [userCount, patientCount, invoicesLast30Days, documents] = await Promise.all([
    prisma.user.count({ where: { tenantId } }),
    prisma.patient.count({ where: { tenantId } }),
    prisma.invoice.count({
      where: { tenantId, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.patientDocument.aggregate({
      where: { tenantId },
      _sum: { fileSize: true },
    }),
  ]);

  return {
    userCount,
    patientCount,
    invoicesLast30Days,
    storageBytes: documents._sum.fileSize ?? 0,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────

// POST /api/v1/tenants — create a new tenant (full provisioning)
router.post(
  "/",
  validate(createTenantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createTenantSchema>;

      // Pre-check subdomain uniqueness for a clean 409 instead of a Prisma error.
      const existing = await prisma.tenant.findUnique({
        where: { subdomain: body.subdomain },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Subdomain already in use",
        });
        return;
      }

      const result = await createTenant({
        name: body.name,
        subdomain: body.subdomain,
        plan: body.plan,
        adminEmail: body.adminEmail,
        adminPassword: body.adminPassword,
        adminName: body.adminName,
        hospitalConfig: body.hospitalConfig
          ? {
              phone: body.hospitalConfig.phone,
              email: body.hospitalConfig.email,
              gstin: body.hospitalConfig.gstin,
              address: body.hospitalConfig.address,
            }
          : undefined,
      });

      auditLog(req, "TENANT_CREATE", "tenant", result.tenant.id, {
        subdomain: result.tenant.subdomain,
        plan: result.tenant.plan,
        adminEmail: result.adminUser.email,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      // Translate common Prisma errors to a cleaner HTTP response.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("subdomain")) {
        res.status(409).json({ success: false, data: null, error: msg });
        return;
      }
      if (msg.toLowerCase().includes("email already exists")) {
        res.status(409).json({ success: false, data: null, error: msg });
        return;
      }
      next(err);
    }
  },
);

// GET /api/v1/tenants — list with usage stats
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, plan, active } = req.query as {
      search?: string;
      plan?: string;
      active?: string;
    };

    const where: Record<string, unknown> = {};
    if (typeof search === "string" && search.trim().length > 0) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { subdomain: { contains: term.toLowerCase() } },
      ];
    }
    if (plan && ["BASIC", "PRO", "ENTERPRISE"].includes(plan)) {
      where.plan = plan;
    }
    if (active === "true") where.active = true;
    else if (active === "false") where.active = false;

    const tenants = await prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const withStats = await Promise.all(
      tenants.map(async (t) => ({
        ...t,
        stats: await loadTenantStats(t.id),
      })),
    );

    res.json({ success: true, data: withStats, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/tenants/:id — detail
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      const [stats, admins, configRows] = await Promise.all([
        loadTenantStats(tenant.id),
        prisma.user.findMany({
          where: { tenantId: tenant.id, role: "ADMIN" },
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.systemConfig.findMany({
          where: { key: { startsWith: `tenant:${tenant.id}:` } },
        }),
      ]);

      // Flatten tenant-scoped SystemConfig into a small map keyed by the
      // un-prefixed key (e.g. `hospital_name`) so the UI can render easily.
      const prefix = `tenant:${tenant.id}:`;
      const config: Record<string, string> = {};
      for (const row of configRows) {
        config[row.key.slice(prefix.length)] = row.value;
      }

      res.json({
        success: true,
        data: { ...tenant, stats, admins, config },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/tenants/:id — update name/plan/active (subdomain is immutable)
router.patch(
  "/:id",
  validate(updateTenantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof updateTenantSchema>;
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      // Safety: never let an operator accidentally deactivate the default tenant.
      if (tenant.subdomain === "default" && body.active === false) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot deactivate the default tenant",
        });
        return;
      }

      const updated = await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.plan !== undefined ? { plan: body.plan } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.razorpayKeyId !== undefined ? { razorpayKeyId: body.razorpayKeyId } : {}),
          ...(body.razorpayKeySecret !== undefined ? { razorpayKeySecret: body.razorpayKeySecret } : {}),
          ...(body.razorpayMode !== undefined ? { razorpayMode: body.razorpayMode } : {}),
          ...(body.requireAdminTOTP !== undefined ? { requireAdminTOTP: body.requireAdminTOTP } : {}),
          ...(body.sessionIdleMinutes !== undefined
            ? { sessionIdleMinutes: body.sessionIdleMinutes }
            : {}),
        },
      });

      // Pearl §8.2 row 212 — dedicated audit row when the idle-timeout
      // changes, so super-admin policy changes are independently
      // discoverable from the generic TENANT_UPDATE stream.
      if (
        body.sessionIdleMinutes !== undefined &&
        body.sessionIdleMinutes !== tenant.sessionIdleMinutes
      ) {
        auditLog(req, "TENANT_SESSION_IDLE_UPDATED", "tenant", tenant.id, {
          previous: tenant.sessionIdleMinutes,
          next: body.sessionIdleMinutes,
        }).catch(console.error);
      }
      // Pearl #10b — bust the Razorpay creds cache so the next payment
      // call uses the new keys immediately (no stale 60s window).
      if (
        body.razorpayKeyId !== undefined ||
        body.razorpayKeySecret !== undefined ||
        body.razorpayMode !== undefined
      ) {
        try {
          const { invalidateRazorpayCacheForTenant } = await import("../services/razorpay");
          invalidateRazorpayCacheForTenant(tenant.id);
        } catch {
          /* circular-import safety — non-fatal */
        }
      }

      // If hospital name changed, mirror it into tenant-scoped SystemConfig
      // so downstream PDF/notification renderers pick it up.
      if (body.name !== undefined) {
        await prisma.systemConfig.upsert({
          where: { key: tenantConfigKey(tenant.id, "hospital_name") },
          create: {
            key: tenantConfigKey(tenant.id, "hospital_name"),
            value: body.name,
          },
          update: { value: body.name },
        });
      }

      auditLog(req, "TENANT_UPDATE", "tenant", tenant.id, body as Record<string, unknown>).catch(
        console.error,
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/tenants/:id/deactivate — soft deactivate / suspend
// Pearl §8.1 row 206 — emits TENANT_SUSPENDED (replaces the legacy
// TENANT_DEACTIVATE action so suspend/restore audit pairs cleanly).
router.post(
  "/:id/deactivate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }
      if (tenant.subdomain === "default") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot deactivate the default tenant",
        });
        return;
      }

      await deactivateTenant(tenant.id);

      auditLog(req, "TENANT_SUSPENDED", "tenant", tenant.id, {
        subdomain: tenant.subdomain,
      }).catch(console.error);

      res.json({
        success: true,
        data: { id: tenant.id, active: false },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/tenants/:id/restore — mirror of /deactivate
// Pearl §8.1 row 206 — flips `Tenant.active=true` and emits
// TENANT_RESTORED. Idempotent at the service layer (no-op if already
// active). Super-admin-only via the router-level requireSuperAdmin
// guard. S3 cold-storage archival on suspend remains a separate
// piece (explicitly deferred).
router.post(
  "/:id/restore",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      await activateTenant(tenant.id);

      auditLog(req, "TENANT_RESTORED", "tenant", tenant.id, {
        subdomain: tenant.subdomain,
      }).catch(console.error);

      res.json({
        success: true,
        data: { id: tenant.id, active: true },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/tenants/:id/onboarding — per-tenant onboarding state
// Reads SystemConfig rows prefixed `tenant:<id>:onboarding_step_<name>_completed_at`.
router.get(
  "/:id/onboarding",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      const prefix = `tenant:${tenant.id}:onboarding_step_`;
      const rows = await prisma.systemConfig.findMany({
        where: { key: { startsWith: prefix } },
      });
      const steps: Record<string, string> = {};
      for (const r of rows) {
        steps[r.key.slice(prefix.length).replace(/_completed_at$/, "")] = r.value;
      }

      res.json({
        success: true,
        data: { tenantId: tenant.id, steps },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/tenants/:id/onboarding/:step — mark a step complete
router.post(
  "/:id/onboarding/:step",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, step } = req.params;
      if (!/^[a-z0-9_]{1,40}$/.test(step)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid step name",
        });
        return;
      }
      const tenant = await prisma.tenant.findUnique({ where: { id } });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      const key = tenantConfigKey(tenant.id, `onboarding_step_${step}_completed_at`);
      const now = new Date().toISOString();
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: now },
        update: { value: now },
      });

      auditLog(req, "TENANT_ONBOARDING_STEP", "tenant", tenant.id, { step }).catch(
        console.error,
      );

      res.json({ success: true, data: { step, completedAt: now }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as tenantsRouter };
