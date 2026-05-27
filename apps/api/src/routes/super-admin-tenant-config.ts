/**
 * Super-admin per-tenant configuration — Pearl ERP Stage 1 §8.1 (wizard
 * steps 4-8 backend wiring).
 *
 * What / which modules / why:
 *   - The onboarding wizard at /super-admin/onboard provisions a tenant
 *     atomically in steps 1-3 (tenant + branch + admin) but the
 *     remaining steps (doctor modes, ABDM HFR/HPR, WhatsApp Gupshup,
 *     Razorpay / Cashfree, final go-live) were previously stored only in
 *     the browser's sessionStorage. This route wires those steps to
 *     server-side persistence so the configuration survives across
 *     browser sessions and is visible from any super-admin's seat.
 *   - All endpoints accept a `tenantId` path param and are super-admin
 *     scoped (mirrors `routes/tenants.ts:requireSuperAdmin`).
 *
 * Mounts at /api/v1/super-admin/tenants:
 *   POST  /:id/doctor-modes      — set default doctor mode on first branch
 *   POST  /:id/abdm-onboarding   — stash HFR / HPR draft + checklist
 *   POST  /:id/whatsapp-config   — upsert Gupshup creds (encrypted)
 *   POST  /:id/payment-gateway   — store Razorpay / Cashfree creds
 *   POST  /:id/go-live           — atomic activation (idempotent)
 *
 * Audit: awaited auditLog() for each handler so integration tests can
 * read AuditLog immediately.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role, FEATURE_KEYS, FEATURE_METADATA } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { enforceSuperAdminIdleTimeout } from "../middleware/session-idle";
import { tenantConfigKey } from "../services/tenant-provisioning";
import { encryptCredentials } from "../services/whatsapp-crypto";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const callerTenantId = req.user?.tenantId ?? null;
    if (callerTenantId == null) {
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
      error: "Only super-admins may configure tenants",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

async function loadTenantOr404(
  req: Request,
  res: Response,
): Promise<{ id: string; subdomain: string; active: boolean } | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    select: { id: true, subdomain: true, active: true },
  });
  if (!tenant) {
    res
      .status(404)
      .json({ success: false, data: null, error: "Tenant not found" });
    return null;
  }
  return tenant;
}

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
router.use(enforceSuperAdminIdleTimeout);

// ─── Schemas ─────────────────────────────────────────────────────────

const doctorModeEnum = z.enum(["CALLING", "TOKEN", "SLOT"]);

const doctorModesSchema = z.object({
  defaultMode: doctorModeEnum,
  applyToExistingDoctors: z.boolean().optional().default(true),
});

const abdmFacilityType = z.enum([
  "HOSPITAL",
  "CLINIC",
  "DIAGNOSTIC_CENTER",
  "PHARMACY",
  "OTHER",
]);

const abdmSpecialty = z.enum([
  "GENERAL_PRACTICE",
  "CARDIOLOGY",
  "DERMATOLOGY",
  "PEDIATRICS",
  "ORTHOPEDICS",
  "GYNECOLOGY",
  "ENT",
  "OTHER",
]);

const abdmOnboardingSchema = z.object({
  hfr: z
    .object({
      facilityName: z.string().trim().min(2).max(200),
      hfrId: z
        .string()
        .trim()
        .regex(/^\d{8,14}$/, "HFR ID must be 8-14 digits"),
      facilityType: abdmFacilityType,
      state: z.string().trim().min(1).max(80),
      district: z.string().trim().max(80).optional().nullable(),
    })
    .optional()
    .nullable(),
  hpr: z
    .object({
      hprId: z
        .string()
        .trim()
        .regex(/^\d{8,14}$/, "HPR ID must be 8-14 digits"),
      doctorName: z.string().trim().min(2).max(200),
      specialty: abdmSpecialty,
      councilRegNo: z.string().trim().min(2).max(80),
    })
    .optional()
    .nullable(),
  checklist: z
    .object({
      hfrAccountCreated: z.boolean().optional(),
      hfrFacilityRegistered: z.boolean().optional(),
      hprAccountCreated: z.boolean().optional(),
      consentManagerWired: z.boolean().optional(),
    })
    .optional(),
});

const whatsappConfigBodySchema = z.object({
  provider: z
    .enum(["GUPSHUP", "WATI", "AISENSEI", "INTERAKT", "META"])
    .default("GUPSHUP"),
  appName: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(512),
  sourcePhone: z
    .string()
    .trim()
    .regex(/^\+\d{7,15}$/, "Source phone must be E.164 (e.g. +919876543210)"),
  defaultProductId: z.string().trim().max(120).optional().nullable(),
  autoReply: z.boolean().optional().default(true),
});

const paymentGatewaySchema = z
  .object({
    provider: z.enum(["RAZORPAY", "CASHFREE"]),
    mode: z.enum(["TEST", "LIVE"]).default("TEST"),
    businessName: z.string().trim().min(2).max(200).optional(),
    keyId: z.string().trim().min(4).max(120),
    keySecret: z.string().trim().min(4).max(256),
    webhookSecret: z.string().trim().min(4).max(256).optional().nullable(),
  })
  .refine(
    (v) => {
      if (v.provider === "RAZORPAY") {
        return /^rzp_(test|live)_[A-Za-z0-9]{6,}$/.test(v.keyId);
      }
      return v.keyId.length >= 4;
    },
    {
      message:
        "Razorpay Key ID must look like rzp_test_XXXX or rzp_live_XXXX",
      path: ["keyId"],
    },
  );

const goLiveSchema = z.object({
  acknowledgements: z
    .object({
      doctorModesConfigured: z.boolean().optional(),
      whatsappConfigured: z.boolean().optional(),
      paymentGatewayConfigured: z.boolean().optional(),
      abdmConfigured: z.boolean().optional(),
    })
    .optional(),
});

// Pearl SoW §8.1 wizard step 1 — region (Indian state / UT). Persisted
// into SystemConfig so downstream GST / billing / reporting flows can
// read it. Kept off the Tenant row to avoid a schema migration.
const regionSchema = z.object({
  region: z.string().trim().min(1).max(80),
});

// Pearl SoW §8.1 wizard step 1 — short human-readable tenant code.
// Distinct from `subdomain` (which is URL-routing). Persisted to
// SystemConfig under `tenant:<id>:code` so reporting / receipts can
// render a short identifier without taking another column on Tenant.
const tenantCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,10}$/, "Code must be 2-10 uppercase chars (A-Z, 0-9, -)"),
});

// Pearl SoW §8.1 row 233 — manual archive trigger. Operator may choose
// to archive a suspended tenant immediately rather than wait for the
// 90-day cron. `force=true` bypasses the 90-day minimum (use sparingly
// — there's no recovery short of restoring from S3).
const archiveSchema = z.object({
  force: z.boolean().optional().default(false),
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function stampStep(tenantId: string, step: string): Promise<string> {
  const key = tenantConfigKey(tenantId, `onboarding_step_${step}_completed_at`);
  const now = new Date().toISOString();
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value: now },
    update: { value: now },
  });
  return now;
}

// ─── Step 4 — Doctor modes ───────────────────────────────────────────
// Sets the tenant default + (optionally) bulk-applies it to every doctor
// currently in the tenant. The default lives in SystemConfig under the
// `default_doctor_mode` key; per-doctor mode lives on Doctor.appointmentMode.
router.post(
  "/:id/doctor-modes",
  validate(doctorModesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof doctorModesSchema>;
      const key = tenantConfigKey(tenant.id, "default_doctor_mode");
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: body.defaultMode },
        update: { value: body.defaultMode },
      });

      let updatedDoctors = 0;
      if (body.applyToExistingDoctors) {
        const result = await prisma.doctor.updateMany({
          where: { tenantId: tenant.id },
          data: { appointmentMode: body.defaultMode },
        });
        updatedDoctors = result.count;
      }

      await stampStep(tenant.id, "doctor_modes");

      await auditLog(req, "TENANT_DOCTOR_MODES_SET", "tenant", tenant.id, {
        defaultMode: body.defaultMode,
        updatedDoctors,
      });

      res.json({
        success: true,
        data: {
          tenantId: tenant.id,
          defaultMode: body.defaultMode,
          updatedDoctors,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 1 follow-up — tenant code ──────────────────────────────────
// Persists the wizard step-1 tenant code (short human-readable
// identifier) into SystemConfig under `tenant:<id>:code`. Idempotent.
router.post(
  "/:id/code",
  validate(tenantCodeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof tenantCodeSchema>;
      const key = tenantConfigKey(tenant.id, "code");
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: body.code },
        update: { value: body.code },
      });

      await auditLog(req, "TENANT_CODE_SET", "tenant", tenant.id, {
        code: body.code,
      });

      res.json({
        success: true,
        data: { tenantId: tenant.id, code: body.code },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 1 follow-up — region (Indian state / UT) ───────────────────
// Persists the wizard step-1 region selection into SystemConfig under
// `tenant:<id>:region`. Idempotent. Returns the persisted value so the
// client can verify the write landed.
router.post(
  "/:id/region",
  validate(regionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof regionSchema>;
      const key = tenantConfigKey(tenant.id, "region");
      await prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: body.region },
        update: { value: body.region },
      });

      await auditLog(req, "TENANT_REGION_SET", "tenant", tenant.id, {
        region: body.region,
      });

      res.json({
        success: true,
        data: { tenantId: tenant.id, region: body.region },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Manual archive trigger ──────────────────────────────────────────
// Suspended tenants are auto-archived to S3 after 90 days via the
// `tenant_archive_sweep` cron. This endpoint lets a super-admin
// trigger the archive flow manually for one tenant — useful when an
// operator wants to free DB rows ahead of the 90-day window, or to
// re-run a failed archive. `force=true` bypasses the 90-day floor.
router.post(
  "/:id/archive",
  validate(archiveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      if (tenant.active) {
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Cannot archive an active tenant — suspend the tenant first.",
        });
        return;
      }

      const body = req.body as z.infer<typeof archiveSchema>;
      const { archiveTenant } = await import("../services/tenant-archival");
      try {
        const result = await archiveTenant(prisma, tenant.id, {
          minSuspendDays: body.force ? 0 : undefined,
        });

        await auditLog(req, "TENANT_ARCHIVED_MANUAL", "tenant", tenant.id, {
          subdomain: tenant.subdomain,
          force: body.force,
          archiveS3Key: result.archiveS3Key,
          archiveSizeBytes: result.archiveSizeBytes,
        });

        res.json({
          success: true,
          data: {
            tenantId: tenant.id,
            archivedAt: new Date().toISOString(),
            archiveS3Key: result.archiveS3Key,
            archiveSizeBytes: result.archiveSizeBytes,
            archiveChecksum: result.archiveChecksum,
            rowCounts: result.rowCounts,
          },
          error: null,
        });
      } catch (err) {
        // archiveTenant throws on "not suspended long enough" /
        // "already archived" / S3-upload failures. Surface as 400 with
        // the message so the UI can render it.
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          success: false,
          data: null,
          error: msg,
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 5 — ABDM HFR / HPR onboarding ──────────────────────────────
// Persists the draft + checklist into tenant-scoped SystemConfig keys.
// The first ADMIN on the new tenant picks these up at
// /dashboard/settings/abdm to complete the live ABDM linking flow.
router.post(
  "/:id/abdm-onboarding",
  validate(abdmOnboardingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof abdmOnboardingSchema>;
      const writes: Array<Promise<unknown>> = [];

      if (body.hfr) {
        const key = tenantConfigKey(tenant.id, "abdm_hfr_draft");
        writes.push(
          prisma.systemConfig.upsert({
            where: { key },
            create: { key, value: JSON.stringify(body.hfr) },
            update: { value: JSON.stringify(body.hfr) },
          }),
        );
      }
      if (body.hpr) {
        const key = tenantConfigKey(tenant.id, "abdm_hpr_draft");
        writes.push(
          prisma.systemConfig.upsert({
            where: { key },
            create: { key, value: JSON.stringify(body.hpr) },
            update: { value: JSON.stringify(body.hpr) },
          }),
        );
      }
      if (body.checklist) {
        const key = tenantConfigKey(tenant.id, "abdm_onboarding_checklist");
        writes.push(
          prisma.systemConfig.upsert({
            where: { key },
            create: { key, value: JSON.stringify(body.checklist) },
            update: { value: JSON.stringify(body.checklist) },
          }),
        );
      }

      await Promise.all(writes);
      await stampStep(tenant.id, "abdm");

      await auditLog(req, "TENANT_ABDM_ONBOARD_DRAFT", "tenant", tenant.id, {
        hfr: body.hfr ? { hfrId: body.hfr.hfrId } : null,
        hpr: body.hpr ? { hprId: body.hpr.hprId } : null,
        checklist: body.checklist ?? null,
      });

      res.json({
        success: true,
        data: { tenantId: tenant.id, persisted: true },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 6 — WhatsApp Gupshup config ────────────────────────────────
// Persists per-tenant WhatsApp Business creds into the WhatsAppConfig
// table (creds AES-256-GCM encrypted). Mirrors the in-band PUT /wa/config
// route but addressed by tenantId so the super-admin caller (whose
// session has tenantId=null) can write on a tenant's behalf.
router.post(
  "/:id/whatsapp-config",
  validate(whatsappConfigBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof whatsappConfigBodySchema>;

      const credFields = {
        apiKey: body.apiKey,
        appName: body.appName,
        sourcePhone: body.sourcePhone,
      };
      const credentialsEncrypted = encryptCredentials(credFields);

      const row = await prisma.whatsAppConfig.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
          provider: body.provider,
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          autoReply: body.autoReply ?? true,
          active: true,
        },
        update: {
          provider: body.provider,
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          autoReply: body.autoReply ?? true,
          active: true,
        },
      });

      await stampStep(tenant.id, "whatsapp");

      await auditLog(
        req,
        "TENANT_WHATSAPP_CONFIG_SET",
        "whatsapp_config",
        row.id,
        {
          tenantId: tenant.id,
          provider: row.provider,
          appName: body.appName,
        },
      );

      res.json({
        success: true,
        data: {
          tenantId: tenant.id,
          provider: row.provider,
          appName: body.appName,
          autoReply: row.autoReply,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 7 — Payment gateway (Razorpay / Cashfree) ──────────────────
// Razorpay creds land on the Tenant row's first-class columns
// (razorpayKeyId / razorpayKeySecret / razorpayMode) so the existing
// services/razorpay.ts code path picks them up. Cashfree creds (which
// have no dedicated column today) land in SystemConfig under
// `payment_gateway_cashfree`.
router.post(
  "/:id/payment-gateway",
  validate(paymentGatewaySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof paymentGatewaySchema>;

      if (body.provider === "RAZORPAY") {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            razorpayKeyId: body.keyId,
            razorpayKeySecret: body.keySecret,
            razorpayMode: body.mode.toLowerCase(),
          },
        });

        // Bust the Razorpay cache so the new creds take effect immediately.
        try {
          const { invalidateRazorpayCacheForTenant } = await import(
            "../services/razorpay"
          );
          invalidateRazorpayCacheForTenant(tenant.id);
        } catch {
          /* non-fatal */
        }

        if (body.webhookSecret) {
          const wkey = tenantConfigKey(tenant.id, "razorpay_webhook_secret");
          await prisma.systemConfig.upsert({
            where: { key: wkey },
            create: { key: wkey, value: body.webhookSecret },
            update: { value: body.webhookSecret },
          });
        }
      } else {
        // Cashfree — persist as a JSON blob in SystemConfig (no first-
        // class column on Tenant yet; Stage 2+ may add one).
        const ckey = tenantConfigKey(tenant.id, "payment_gateway_cashfree");
        await prisma.systemConfig.upsert({
          where: { key: ckey },
          create: {
            key: ckey,
            value: JSON.stringify({
              mode: body.mode,
              keyId: body.keyId,
              keySecret: body.keySecret,
              webhookSecret: body.webhookSecret ?? null,
              businessName: body.businessName ?? null,
            }),
          },
          update: {
            value: JSON.stringify({
              mode: body.mode,
              keyId: body.keyId,
              keySecret: body.keySecret,
              webhookSecret: body.webhookSecret ?? null,
              businessName: body.businessName ?? null,
            }),
          },
        });
      }

      if (body.businessName) {
        const bkey = tenantConfigKey(tenant.id, "payment_business_name");
        await prisma.systemConfig.upsert({
          where: { key: bkey },
          create: { key: bkey, value: body.businessName },
          update: { value: body.businessName },
        });
      }

      await stampStep(tenant.id, "payment_gateway");

      await auditLog(
        req,
        "TENANT_PAYMENT_GATEWAY_SET",
        "tenant",
        tenant.id,
        {
          provider: body.provider,
          mode: body.mode,
          keyIdPrefix: body.keyId.slice(0, 12),
        },
      );

      res.json({
        success: true,
        data: {
          tenantId: tenant.id,
          provider: body.provider,
          mode: body.mode,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Step 8 — Atomic go-live ─────────────────────────────────────────
// Idempotent endpoint that flips the tenant's `active` flag to true and
// clears `deactivatedAt`. Captures the operator's acknowledgements about
// what was configured (audit trail) so the post-incident review can tell
// whether a launch shipped without the optional steps in place.
router.post(
  "/:id/go-live",
  validate(goLiveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof goLiveSchema>;

      const updated = await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          active: true,
          deactivatedAt: null,
        },
      });

      await stampStep(tenant.id, "go_live");

      await auditLog(req, "TENANT_GO_LIVE", "tenant", tenant.id, {
        subdomain: updated.subdomain,
        acknowledgements: body.acknowledgements ?? null,
      });

      res.json({
        success: true,
        data: {
          tenantId: updated.id,
          subdomain: updated.subdomain,
          active: updated.active,
          goLiveAt: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET — fetch persisted config for a tenant ───────────────────────
// Single endpoint that powers the tenant detail page's "Configuration"
// section. Returns whatever has been persisted; sensitive values
// (api keys / secrets) are masked.
router.get(
  "/:id/config",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const fullTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
      });

      const prefix = `tenant:${tenant.id}:`;
      const rows = await prisma.systemConfig.findMany({
        where: { key: { startsWith: prefix } },
      });
      const config: Record<string, string> = {};
      for (const r of rows) {
        config[r.key.slice(prefix.length)] = r.value;
      }

      const wa = await prisma.whatsAppConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          provider: true,
          defaultProductId: true,
          autoReply: true,
          active: true,
          updatedAt: true,
        },
      });

      res.json({
        success: true,
        data: {
          tenantId: tenant.id,
          defaultDoctorMode: config["default_doctor_mode"] ?? null,
          abdm: {
            hfr: config["abdm_hfr_draft"]
              ? JSON.parse(config["abdm_hfr_draft"])
              : null,
            hpr: config["abdm_hpr_draft"]
              ? JSON.parse(config["abdm_hpr_draft"])
              : null,
            checklist: config["abdm_onboarding_checklist"]
              ? JSON.parse(config["abdm_onboarding_checklist"])
              : null,
          },
          whatsapp: wa
            ? {
                provider: wa.provider,
                defaultProductId: wa.defaultProductId,
                autoReply: wa.autoReply,
                active: wa.active,
                updatedAt: wa.updatedAt,
              }
            : null,
          paymentGateway: {
            razorpay: fullTenant?.razorpayKeyId
              ? {
                  keyIdPrefix: fullTenant.razorpayKeyId.slice(0, 12),
                  mode: fullTenant.razorpayMode,
                }
              : null,
            cashfree: config["payment_gateway_cashfree"]
              ? (() => {
                  try {
                    const cf = JSON.parse(config["payment_gateway_cashfree"]);
                    return {
                      mode: cf.mode,
                      keyIdPrefix: String(cf.keyId ?? "").slice(0, 12),
                    };
                  } catch {
                    return null;
                  }
                })()
              : null,
            businessName: config["payment_business_name"] ?? null,
          },
          steps: Object.fromEntries(
            Object.entries(config)
              .filter(([k]) => k.startsWith("onboarding_step_"))
              .map(([k, v]) => [
                k.replace(/^onboarding_step_/, "").replace(/_completed_at$/, ""),
                v,
              ]),
          ),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Feature flag override management ────────────────────────────────
// Single endpoint to update the per-tenant featureFlags JSON column.
// Body shape: { flags: { "<key>": true|false, ... } } — replaces the
// entire JSON map. Pass {} to clear all overrides.
const featureFlagsSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
});

router.put(
  "/:id/feature-flags",
  validate(featureFlagsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const body = req.body as z.infer<typeof featureFlagsSchema>;

      const updated = await prisma.tenant.update({
        where: { id: tenant.id },
        data: { featureFlags: body.flags },
      });

      await auditLog(req, "TENANT_FEATURE_FLAGS_UPDATED", "tenant", tenant.id, {
        flagCount: Object.keys(body.flags).length,
      });

      res.json({
        success: true,
        data: {
          tenantId: updated.id,
          featureFlags: updated.featureFlags,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /:id/feature-flags — returns the FULL feature catalog (canonical
// FEATURE_KEYS + FEATURE_METADATA) merged with the tenant's stored
// overrides, so the UI doesn't have to hardcode the list and can never
// drift out of sync with the shared package. Also surfaces any
// "unknown" keys persisted in the tenant's featureFlags JSON (e.g.
// legacy keys removed from FEATURE_KEYS, or custom keys an operator
// added directly via the DB) so they're visible + clearable.
router.get(
  "/:id/feature-flags",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await loadTenantOr404(req, res);
      if (!tenant) return;

      const row = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { featureFlags: true },
      });
      const stored =
        (row?.featureFlags as Record<string, unknown> | null) ?? {};

      const catalog = FEATURE_KEYS.map((key) => {
        const meta = FEATURE_METADATA[key];
        const override = stored[key];
        const hasOverride = typeof override === "boolean";
        return {
          key,
          label: meta.label,
          description: meta.description,
          defaultEnabled: meta.defaultEnabled,
          override: hasOverride ? (override as boolean) : null,
          effective: hasOverride ? (override as boolean) : meta.defaultEnabled,
          known: true,
        };
      });

      // Surface any keys persisted in the tenant's featureFlags JSON
      // that are NOT in the current canonical catalog (legacy / custom).
      const knownSet = new Set<string>(FEATURE_KEYS as readonly string[]);
      const unknown = Object.entries(stored)
        .filter(([k]) => !knownSet.has(k))
        .map(([key, value]) => ({
          key,
          label: key,
          description: "Custom or legacy key — not in the canonical catalog.",
          defaultEnabled: true,
          override: typeof value === "boolean" ? value : null,
          effective: typeof value === "boolean" ? value : true,
          known: false,
        }));

      res.json({
        success: true,
        data: {
          tenantId: tenant.id,
          features: [...catalog, ...unknown],
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as superAdminTenantConfigRouter };
