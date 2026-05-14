/**
 * Tenant-scoped admin settings (Branding + Integrations).
 *
 * Issues #716/#717 (2026-05-08): the Settings page surfaced four "ghost" tabs
 * (Branding, Notifications, Security, Integrations) that the user expected
 * to be wired up. Notifications + Security live on the personal settings
 * surface (already shipped). Branding and Integrations are tenant-wide
 * admin operations that needed a dedicated read/write route — so this file
 * exists.
 *
 * Backed by the existing SystemConfig key/value table using the
 * `tenantConfigKey()` namespacing helper (`tenant:<id>:branding_*`,
 * `tenant:<id>:integration_*`). The Tenant.name column is the canonical
 * "Hospital Name" that downstream PDF/notification renderers read; we keep
 * it in sync via `prisma.tenant.update({ name })` AND mirror it into
 * `tenant:<id>:hospital_name` so existing renderers continue to work.
 *
 * RBAC: ADMIN-only for both reads (the page is admin-only) and writes.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { tenantConfigKey } from "../services/tenant-provisioning";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN));

// ─── Schemas ──────────────────────────────────────────────────────────

// Issue #717: Hospital Name silently saved blank — reject empty + whitespace
// + over-long. min(1) refines AFTER trim so " " also fails.
const updateBrandingSchema = z.object({
  hospitalName: z
    .string()
    .trim()
    .min(1, "Hospital Name is required")
    .max(200, "Hospital Name must be 200 characters or fewer"),
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Primary color must be a hex like #1e40af")
    .optional()
    .or(z.literal("")),
  logoUrl: z
    .string()
    .trim()
    .max(500, "Logo URL is too long")
    .optional()
    .or(z.literal("")),
});

const updateIntegrationsSchema = z.object({
  integrations: z.array(
    z.object({
      key: z
        .string()
        .trim()
        .regex(/^[a-z0-9_-]{1,40}$/, "Invalid integration key"),
      enabled: z.boolean(),
      // zod 4: z.record(value) → z.record(key, value); explicit string keys.
      config: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

// Known integrations the UI knows how to render. Anything outside this
// list is rejected so a stray write can't pollute the SystemConfig table.
const KNOWN_INTEGRATIONS = [
  "sendgrid",
  "twilio",
  "razorpay",
  "abdm",
  "fhir",
  "hl7v2",
  "sentry",
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────

function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({
      success: false,
      data: null,
      error: "Settings requires a tenant context",
    });
    return null;
  }
  return tenantId;
}

async function readConfigMap(
  tenantId: string,
  prefix: string,
): Promise<Record<string, string>> {
  const fullPrefix = tenantConfigKey(tenantId, prefix);
  const rows = await prisma.systemConfig.findMany({
    where: { key: { startsWith: fullPrefix } },
  });
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.key.slice(fullPrefix.length)] = row.value;
  }
  return out;
}

async function upsertConfig(
  tenantId: string,
  key: string,
  value: string,
): Promise<void> {
  const k = tenantConfigKey(tenantId, key);
  await prisma.systemConfig.upsert({
    where: { key: k },
    create: { key: k, value },
    update: { value },
  });
}

// ─── Routes ──────────────────────────────────────────────────────────

// GET /api/v1/settings/branding — read tenant branding
router.get("/branding", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      res.status(404).json({ success: false, data: null, error: "Tenant not found" });
      return;
    }

    const branding = await readConfigMap(tenantId, "branding_");
    const hospitalNameMirror =
      (await prisma.systemConfig.findUnique({
        where: { key: tenantConfigKey(tenantId, "hospital_name") },
      }))?.value ?? null;

    res.json({
      success: true,
      data: {
        hospitalName: tenant.name || hospitalNameMirror || "",
        primaryColor: branding.primary_color || "",
        logoUrl: branding.logo_url || "",
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/settings/branding — update tenant branding
//
// Issue #717: hospitalName is required (server-side guard). The schema
// trims+rejects empty/whitespace BEFORE the upsert so a blank Tenant.name
// can never be persisted.
router.patch(
  "/branding",
  validate(updateBrandingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const body = req.body as z.infer<typeof updateBrandingSchema>;

      // Tenant.name is the canonical hospital name read by every PDF and
      // notification template — keep it as the source of truth and mirror
      // into SystemConfig for legacy code paths.
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { name: body.hospitalName },
      });
      await upsertConfig(tenantId, "hospital_name", body.hospitalName);

      if (body.primaryColor && body.primaryColor.length > 0) {
        await upsertConfig(tenantId, "branding_primary_color", body.primaryColor);
      }
      if (body.logoUrl && body.logoUrl.length > 0) {
        await upsertConfig(tenantId, "branding_logo_url", body.logoUrl);
      }

      auditLog(req, "TENANT_BRANDING_UPDATE", "tenant", tenantId, {
        hospitalName: body.hospitalName,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          hospitalName: body.hospitalName,
          primaryColor: body.primaryColor || "",
          logoUrl: body.logoUrl || "",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/settings/integrations — list known integrations + enabled state
router.get(
  "/integrations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const map = await readConfigMap(tenantId, "integration_");
      const integrations = KNOWN_INTEGRATIONS.map((key) => {
        const enabledRaw = map[`${key}_enabled`];
        return {
          key,
          enabled: enabledRaw === "true",
          // Surface a non-secret status hint — never the credential itself.
          configured: Object.keys(map).some(
            (k) => k.startsWith(`${key}_`) && k !== `${key}_enabled`,
          ),
        };
      });

      res.json({
        success: true,
        data: { integrations },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/settings/integrations — toggle integrations on/off.
router.patch(
  "/integrations",
  validate(updateIntegrationsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const body = req.body as z.infer<typeof updateIntegrationsSchema>;

      for (const entry of body.integrations) {
        if (!(KNOWN_INTEGRATIONS as readonly string[]).includes(entry.key)) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Unknown integration: ${entry.key}`,
          });
          return;
        }
        await upsertConfig(
          tenantId,
          `integration_${entry.key}_enabled`,
          entry.enabled ? "true" : "false",
        );
      }

      auditLog(req, "TENANT_INTEGRATION_UPDATE", "tenant", tenantId, {
        keys: body.integrations.map((i) => i.key),
      }).catch(console.error);

      res.json({ success: true, data: { ok: true }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as settingsRouter };
