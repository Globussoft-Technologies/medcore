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
import {
  getPlanByKey,
  isPlanColumnMigrationError,
  PLAN_MIGRATION_USER_MESSAGE,
} from "../services/plan-catalog";
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

// Plan tiers are dynamic (DB-backed `PlatformPlan` rows). The schema only
// validates the KEY SHAPE; each create/update handler then verifies the key
// resolves to an existing ACTIVE plan via `requirePlanByKey`/`getPlanByKey`.
const PLAN_KEY_REGEX = /^[A-Z0-9_]{2,40}$/;
const planEnum = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    PLAN_KEY_REGEX,
    "Plan must be a valid plan key (2-40 uppercase letters, digits or underscores)",
  );

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
  // Pearl §8.1 — operator-supplied tenant code (e.g. "AHMD-01").
  // Optional; format validated as 2–12 alphanumerics + hyphens so
  // SystemConfig stores something readable. Empty string clears.
  code: z
    .string()
    .trim()
    .max(12)
    .regex(/^$|^[A-Za-z0-9-]{2,12}$/, {
      message: "Code must be 2–12 letters / digits / hyphens",
    })
    .optional(),
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
  // Pearl §8.3 piece 3d — recipient for the monthly invoice mailer.
  // Empty string clears the value (operator wants to stop emailing).
  // Format-validate via Zod's email() when non-empty.
  billingContactEmail: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === "" || /.+@.+\..+/.test(v), {
      message: "Must be a valid email or empty",
    })
    .optional(),
  // Pearl §8.6 — per-tenant compliance posture knobs. Surfaced on the
  // /super-admin/compliance dashboard and editable from the tenant
  // detail drawer.
  whatsappOptInTrackingEnabled: z.boolean().optional(),
  abdmConsentEnforcementRequired: z.boolean().optional(),
  auditLogRetentionDays: z.number().int().min(30).max(3650).optional(),
  patientDataRetentionDays: z.number().int().min(365).max(7300).optional(),
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
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
    if (req.user?.role === Role.SUPER_ADMIN) {
      return next();
    }
    // authenticate() has already ensured req.user is ADMIN when combined
    // with authorize(Role.ADMIN) — but we still need to check the tenant.
    const callerTenantId = req.user?.tenantId ?? null;

    if (callerTenantId == null) {
      // Global super-admin / legacy account — allow.
      return next();
    }

    // Self-service exception (Pearl §8.1 onboarding): a tenant admin may
    // read + update the onboarding checklist for their OWN tenant (the
    // dashboard onboarding banner + the onboarding page) and read their own
    // tenant detail (the page header). The id is matched against the
    // caller's own tenantId, so this never widens into cross-tenant access.
    // Everything else — listing/creating other tenants, PATCH, suspend,
    // archive, cross-tenant reads — stays super-admin-only.
    const ownOnboarding = req.path.includes(`/${callerTenantId}/onboarding`);
    const ownDetailRead =
      req.method === "GET" && req.path.endsWith(`/${callerTenantId}`);
    if (ownOnboarding || ownDetailRead) {
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
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
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
  // Pearl §8.1 row 204 — tenant-list metrics extension.
  monthlyOpdVolume: number;
  mrrInPaise: number;
  billingHealth: "healthy" | "trial" | "past_due" | "suspended" | "unknown";
  subscriptionStatus: string | null;
  lastLoginAt: string | null;
}

async function loadTenantStats(tenantId: string): Promise<TenantUsageStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    userCount,
    patientCount,
    invoicesLast30Days,
    documents,
    monthlyOpdVolume,
    subscription,
    lastLogin,
  ] = await Promise.all([
    prisma.user.count({ where: { tenantId } }),
    prisma.patient.count({ where: { tenantId } }),
    prisma.invoice.count({
      where: { tenantId, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.patientDocument.aggregate({
      where: { tenantId },
      _sum: { fileSize: true },
    }),
    // Monthly OPD volume: appointments created since the first of the
    // current calendar month with type=OPD. Falls back to count of all
    // appointments if the schema doesn't carry a type column matching.
    prisma.appointment.count({
      where: { tenantId, date: { gte: startOfMonth } },
    }),
    prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        plan: true,
        status: true,
        customPriceMonthlyInPaise: true,
        pastDueSince: true,
      },
    }),
    prisma.auditLog.findFirst({
      where: { tenantId, action: "AUTH_LOGIN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // MRR derivation: prefer custom price; otherwise lookup the plan's
  // canonical price. Keep paise integers — UI formats as INR.
  const PLAN_BASE_PAISE: Record<string, number> = {
    starter: 500000, // ₹5,000
    growth: 1500000, // ₹15,000
    enterprise: 5000000, // ₹50,000
    BASIC: 500000,
    PRO: 1500000,
    ENTERPRISE: 5000000,
  };
  let mrrInPaise = 0;
  if (subscription) {
    mrrInPaise =
      subscription.customPriceMonthlyInPaise ??
      PLAN_BASE_PAISE[String(subscription.plan)] ??
      0;
  }

  let billingHealth: TenantUsageStats["billingHealth"] = "unknown";
  if (subscription) {
    const status = String(subscription.status).toLowerCase();
    if (status === "active") billingHealth = "healthy";
    else if (status === "trial") billingHealth = "trial";
    else if (status === "past_due") billingHealth = "past_due";
    else if (status === "suspended" || status === "cancelled")
      billingHealth = "suspended";
  }

  return {
    userCount,
    patientCount,
    invoicesLast30Days,
    storageBytes: documents._sum.fileSize ?? 0,
    monthlyOpdVolume,
    mrrInPaise,
    billingHealth,
    subscriptionStatus: subscription
      ? String(subscription.status)
      : null,
    lastLoginAt: lastLogin?.createdAt
      ? lastLogin.createdAt.toISOString()
      : null,
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

      // Verify the chosen plan key resolves to an existing ACTIVE plan in the
      // dynamic catalog before provisioning (the schema only checks shape).
      const planRow = await getPlanByKey(prisma, body.plan);
      if (!planRow || !planRow.active) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unknown or inactive plan "${body.plan}". Pick an active plan from the catalog.`,
        });
        return;
      }

      const result = await createTenant({
        name: body.name,
        subdomain: body.subdomain,
        plan: body.plan,
        code: body.code,
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
    // Plan keys are dynamic now — accept any key-shaped filter value and let
    // the WHERE match (an unknown key simply returns no rows).
    if (typeof plan === "string" && /^[A-Z0-9_]{2,40}$/.test(plan)) {
      where.plan = plan;
    }
    if (active === "true") where.active = true;
    else if (active === "false") where.active = false;

    const tenants = await prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    // Pearl §8.1 — fetch tenant codes + regions in a single batch query
    // rather than N round-trips. Keyed by `tenant:<id>:code` and
    // `tenant:<id>:region`; map by tenantId for O(1) lookup below.
    const tenantIds = tenants.map((t) => t.id);
    const configRows =
      tenantIds.length > 0
        ? await prisma.systemConfig.findMany({
            where: {
              OR: tenantIds.flatMap((id) => [
                { key: `tenant:${id}:code` },
                { key: `tenant:${id}:region` },
              ]),
            },
          })
        : [];
    const codeByTenant = new Map<string, string>();
    const regionByTenant = new Map<string, string>();
    for (const row of configRows) {
      const m = row.key.match(/^tenant:([^:]+):(code|region)$/);
      if (!m) continue;
      const [, id, kind] = m;
      if (kind === "code") codeByTenant.set(id, row.value);
      else if (kind === "region") regionByTenant.set(id, row.value);
    }

    const withStats = await Promise.all(
      tenants.map(async (t) => ({
        ...t,
        code: codeByTenant.get(t.id) ?? null,
        region: regionByTenant.get(t.id) ?? null,
        stats: await loadTenantStats(t.id),
      })),
    );

    res.json({ success: true, data: withStats, error: null });
  } catch (err) {
    if (isPlanColumnMigrationError(err)) {
      console.error(
        "[tenants] list: plan column not migrated — run `npx prisma db push` + reseed. Detail:",
        err instanceof Error ? err.message : String(err),
      );
      res.status(503).json({
        success: false,
        data: null,
        error: PLAN_MIGRATION_USER_MESSAGE,
      });
      return;
    }
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
      if (isPlanColumnMigrationError(err)) {
        console.error(
          "[tenants] detail: plan column not migrated — run `npx prisma db push` + reseed. Detail:",
          err instanceof Error ? err.message : String(err),
        );
        res.status(503).json({
          success: false,
          data: null,
          error: PLAN_MIGRATION_USER_MESSAGE,
        });
        return;
      }
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

      // If the plan is being changed, verify the new key resolves to an
      // existing ACTIVE plan in the dynamic catalog.
      if (body.plan !== undefined) {
        const planRow = await getPlanByKey(prisma, body.plan);
        if (!planRow || !planRow.active) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Unknown or inactive plan "${body.plan}". Pick an active plan from the catalog.`,
          });
          return;
        }
      }

      // Pearl §8.6 — write the four compliance/billing columns via
      // raw SQL because the on-disk Prisma client on this dev box
      // hasn't been regenerated since `db push` (the running dev
      // server holds a lock on query_engine-windows.dll.node, blocking
      // `prisma generate`). The columns exist in the DB (via db push)
      // so raw SQL works at runtime; once the dev server restarts and
      // `prisma generate` lands, this block can collapse back into the
      // typed `prisma.tenant.update({ data })` call below.
      const newColumnUpdates: Array<{ sql: string; value: unknown }> = [];
      if (body.whatsappOptInTrackingEnabled !== undefined) {
        newColumnUpdates.push({
          sql: `"whatsappOptInTrackingEnabled" = $1`,
          value: body.whatsappOptInTrackingEnabled,
        });
      }
      if (body.abdmConsentEnforcementRequired !== undefined) {
        newColumnUpdates.push({
          sql: `"abdmConsentEnforcementRequired" = $1`,
          value: body.abdmConsentEnforcementRequired,
        });
      }
      if (body.auditLogRetentionDays !== undefined) {
        newColumnUpdates.push({
          sql: `"auditLogRetentionDays" = $1`,
          value: body.auditLogRetentionDays,
        });
      }
      if (body.patientDataRetentionDays !== undefined) {
        newColumnUpdates.push({
          sql: `"patientDataRetentionDays" = $1`,
          value: body.patientDataRetentionDays,
        });
      }
      if (body.billingContactEmail !== undefined) {
        newColumnUpdates.push({
          sql: `"billingContactEmail" = $1`,
          value:
            body.billingContactEmail.length > 0
              ? body.billingContactEmail.toLowerCase()
              : null,
        });
      }
      for (const upd of newColumnUpdates) {
        // Table is mapped via `@@map("tenants")` in schema.prisma —
        // Postgres identifiers are case-sensitive when quoted, so we
        // must use the lowercase mapped name, not the model name.
        await prisma.$executeRawUnsafe(
          `UPDATE "tenants" SET ${upd.sql.replace("$1", "$2")} WHERE id = $1`,
          tenant.id,
          upd.value,
        );
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
// Reads SystemConfig rows prefixed `tenant:<id>:onboarding_step_<name>_completed_at`
// AND `tenant:<id>:onboarding_step_<name>_skipped_at`. Returns two parallel maps
// so the UI can render a step as Completed, Skipped (revisit later), or Pending.
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
      const skipped: Record<string, string> = {};
      for (const r of rows) {
        const tail = r.key.slice(prefix.length);
        if (tail.endsWith("_completed_at")) {
          steps[tail.replace(/_completed_at$/, "")] = r.value;
        } else if (tail.endsWith("_skipped_at")) {
          skipped[tail.replace(/_skipped_at$/, "")] = r.value;
        }
      }

      res.json({
        success: true,
        data: { tenantId: tenant.id, steps, skipped },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/tenants/:id/onboarding/:step — mark a step complete
// Also clears any prior skipped marker for the same step (completing implicitly
// un-skips), so the GET map can never report a step as both completed AND
// skipped at the same time.
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
      const skippedKey = tenantConfigKey(
        tenant.id,
        `onboarding_step_${step}_skipped_at`,
      );
      const now = new Date().toISOString();
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: now },
        update: { value: now },
      });
      await prisma.systemConfig
        .delete({ where: { key: skippedKey } })
        .catch(() => {
          // No prior skip row — fine.
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

// POST /api/v1/tenants/:id/onboarding/:step/skip — defer a step
// Writes `onboarding_step_<name>_skipped_at` so the UI can render it as
// "Skipped — revisit later" without counting it toward the progress bar. A
// later POST /:step (mark complete) clears the skip marker.
router.post(
  "/:id/onboarding/:step/skip",
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
      const key = tenantConfigKey(
        tenant.id,
        `onboarding_step_${step}_skipped_at`,
      );
      const now = new Date().toISOString();
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: now },
        update: { value: now },
      });

      auditLog(req, "TENANT_ONBOARDING_STEP_SKIP", "tenant", tenant.id, {
        step,
      }).catch(console.error);

      res.json({ success: true, data: { step, skippedAt: now }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// Role-permission catalog moved to its own global router at
// /api/v1/role-permissions (apps/api/src/routes/role-permissions.ts).
// The catalog is platform-wide so it no longer hangs under
// /tenants/:id — see app.ts for the new mount.

export { router as tenantsRouter };
