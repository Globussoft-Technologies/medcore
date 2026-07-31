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
import { Role, containsHtmlOrScript } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { tenantConfigKey } from "../services/tenant-provisioning";
import { invalidateRazorpayCacheForTenant } from "../services/razorpay";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN));

// ─── Schemas ──────────────────────────────────────────────────────────

// Issue #717: Hospital Name silently saved blank — reject empty + whitespace
// + over-long. min(1) refines AFTER trim so " " also fails.
//
// Issue #938 (2026-05-23, High/Security): Hospital Name accepted raw HTML/
// `<script>` payloads that later rendered in PDF headers + notification
// templates (stored XSS). Logo URL accepted `javascript:` and `data:` schemes
// that became active links on any branded page. Reject both via the canonical
// `containsHtmlOrScript` guard, AND require logoUrl to be an http(s) URL when
// non-empty so a phishing-style scheme can't smuggle in.
const updateBrandingSchema = z.object({
  hospitalName: z
    .string()
    .trim()
    .min(1, "Hospital Name is required")
    .max(200, "Hospital Name must be 200 characters or fewer")
    .refine((v) => !containsHtmlOrScript(v), {
      message: "Hospital Name cannot contain HTML or script tags",
    }),
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
    .refine((v) => v === "" || !/^\s*javascript:/i.test(v), {
      message: "Logo URL cannot use the javascript: scheme",
    })
    .refine((v) => v === "" || /^https?:\/\//i.test(v), {
      message: "Logo URL must start with http:// or https://",
    })
    .refine((v) => v === "" || !containsHtmlOrScript(v), {
      message: "Logo URL cannot contain HTML or script tags",
    })
    .optional()
    .or(z.literal("")),
  // Hospital contact / legal identity — rendered on invoices, prescriptions,
  // receipts and the super-admin "Hospital Config" panel. All optional; empty
  // string clears the stored value. HTML/script rejected (stored-XSS guard,
  // Issue #938) since these strings land in PDFs + notification templates.
  hospitalPhone: z
    .string()
    .trim()
    .max(20, "Phone is too long")
    .refine((v) => v === "" || /^[+\d][\d\s()\-]{4,}$/.test(v), {
      message: "Enter a valid phone number",
    })
    .optional()
    .or(z.literal("")),
  hospitalEmail: z
    .string()
    .trim()
    .max(120, "Email is too long")
    .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: "Enter a valid email address",
    })
    .optional()
    .or(z.literal("")),
  hospitalGstin: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9A-Za-z]{15}$/.test(v), {
      message: "GSTIN must be 15 letters/digits",
    })
    .optional()
    .or(z.literal("")),
  hospitalAddress: z
    .string()
    .trim()
    .max(500, "Address is too long")
    .refine((v) => v === "" || !containsHtmlOrScript(v), {
      message: "Address cannot contain HTML or script tags",
    })
    .optional()
    .or(z.literal("")),
  hospitalCity: z
    .string()
    .trim()
    .max(120, "City is too long")
    .refine((v) => v === "" || !containsHtmlOrScript(v), {
      message: "City cannot contain HTML or script tags",
    })
    .optional()
    .or(z.literal("")),
  hospitalPincode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{6}$/.test(v), {
      message: "PIN code must be 6 digits",
    })
    .optional()
    .or(z.literal("")),
  hospitalLatitude: z
    .string()
    .trim()
    .refine((v) => {
      if (v === "") return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= -90 && n <= 90;
    }, {
      message: "Latitude must be between -90 and 90",
    })
    .optional()
    .or(z.literal("")),
  hospitalLongitude: z
    .string()
    .trim()
    .refine((v) => {
      if (v === "") return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= -180 && n <= 180;
    }, {
      message: "Longitude must be between -180 and 180",
    })
    .optional()
    .or(z.literal("")),
});

// Per-tenant Razorpay payment credentials.
//
// Until now the ONLY write path for a tenant's Razorpay creds was the
// super-admin route (`PATCH /api/v1/tenants/:id`, gated by requireSuperAdmin),
// so a normal tenant ADMIN could not self-serve their own gateway keys. This
// schema backs the in-band tenant-admin route below. It operates strictly on
// the caller's OWN tenantId (never a path param), so it can never widen into
// cross-tenant access — the same boundary as the branding/integrations writes.
//
// keyId must look like Razorpay's `rzp_test_…` / `rzp_live_…`. keySecret is
// WRITE-ONLY: the GET route returns only a masked prefix + a `hasSecret` flag,
// and omitting keySecret on PATCH LEAVES the stored secret unchanged (so an
// admin can re-save mode/webhook without re-typing the secret they can't read
// back). webhookSecret lands in SystemConfig (`razorpay_webhook_secret`) to
// mirror where the super-admin onboarding flow stores it.
const updatePaymentSchema = z.object({
  razorpayKeyId: z
    .string()
    .trim()
    .regex(
      /^rzp_(test|live)_[A-Za-z0-9]{6,}$/,
      "Key ID must look like rzp_test_XXXX or rzp_live_XXXX",
    ),
  razorpayKeySecret: z
    .string()
    .trim()
    .min(8, "Key Secret looks too short")
    .max(128)
    .optional()
    .or(z.literal("")),
  razorpayMode: z.enum(["test", "live"]),
  razorpayWebhookSecret: z
    .string()
    .trim()
    .max(256)
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
// `twilio` was split into `sms` + `whatsapp` so each channel toggles
// independently (a hospital may run WhatsApp via Meta/Gupshup while using
// Twilio only for SMS, or run one channel and not the other).
const KNOWN_INTEGRATIONS = [
  "sendgrid",
  "sms",
  "whatsapp",
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
    // hospital_* keys hold the name mirror plus contact/legal identity
    // (phone/email/gstin/address). readConfigMap strips the `hospital_`
    // prefix, so `hospital_phone` → `phone`, etc.
    const hospital = await readConfigMap(tenantId, "hospital_");

    res.json({
      success: true,
      data: {
        hospitalName: tenant.name || hospital.name || "",
        primaryColor: branding.primary_color || "",
        logoUrl: branding.logo_url || "",
        hospitalPhone: hospital.phone || "",
        hospitalEmail: hospital.email || "",
        hospitalGstin: hospital.gstin || "",
        hospitalAddress: hospital.address || "",
        hospitalCity: hospital.city || "",
        hospitalPincode: hospital.pincode || "",
        hospitalLatitude: hospital.latitude || "",
        hospitalLongitude: hospital.longitude || "",
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

      // Hospital contact / legal fields. Upsert whenever the field was sent
      // (including "" so the admin can CLEAR a value); GSTIN is normalised to
      // uppercase to match the canonical government format.
      if (body.hospitalPhone !== undefined) {
        await upsertConfig(tenantId, "hospital_phone", body.hospitalPhone);
      }
      if (body.hospitalEmail !== undefined) {
        await upsertConfig(tenantId, "hospital_email", body.hospitalEmail);
      }
      if (body.hospitalGstin !== undefined) {
        await upsertConfig(tenantId, "hospital_gstin", body.hospitalGstin.toUpperCase());
      }
      if (body.hospitalAddress !== undefined) {
        await upsertConfig(tenantId, "hospital_address", body.hospitalAddress);
      }
      if (body.hospitalCity !== undefined) {
        await upsertConfig(tenantId, "hospital_city", body.hospitalCity);
      }
      if (body.hospitalPincode !== undefined) {
        await upsertConfig(tenantId, "hospital_pincode", body.hospitalPincode);
      }
      if (body.hospitalLatitude !== undefined) {
        await upsertConfig(tenantId, "hospital_latitude", body.hospitalLatitude);
      }
      if (body.hospitalLongitude !== undefined) {
        await upsertConfig(tenantId, "hospital_longitude", body.hospitalLongitude);
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
          hospitalPhone: body.hospitalPhone ?? "",
          hospitalEmail: body.hospitalEmail ?? "",
          hospitalGstin: (body.hospitalGstin ?? "").toUpperCase(),
          hospitalAddress: body.hospitalAddress ?? "",
          hospitalCity: body.hospitalCity ?? "",
          hospitalPincode: body.hospitalPincode ?? "",
          hospitalLatitude: body.hospitalLatitude ?? "",
          hospitalLongitude: body.hospitalLongitude ?? "",
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

      // "Configured" (has creds on file) is stored in DIFFERENT places per
      // integration, so we can't just look in SystemConfig for all of them:
      //   - whatsapp → the WhatsAppConfig table (per-tenant provider vault)
      //   - razorpay → Tenant.razorpayKeyId + razorpayKeySecret
      //   - everything else → tenant-scoped `integration_<key>_*` rows
      // Without this, WhatsApp/Razorpay always read "Not yet configured" even
      // after the admin set them up in the WhatsApp / Payments tabs.
      const [waRow, tenant] = await Promise.all([
        prisma.whatsAppConfig.findUnique({
          where: { tenantId },
          select: { id: true },
        }),
        prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { razorpayKeyId: true, razorpayKeySecret: true },
        }),
      ]);
      const configuredByKey: Record<string, boolean> = {
        whatsapp: !!waRow,
        razorpay: !!(tenant?.razorpayKeyId && tenant?.razorpayKeySecret),
      };

      const integrations = KNOWN_INTEGRATIONS.map((key) => ({
        key,
        // DEFAULT ON: enabled unless explicitly turned off. Matches the runtime
        // enforcement in services/integration-flags.ts — a disabled toggle
        // actually stops the connector, so an untouched one reads as enabled.
        enabled: map[`${key}_enabled`] !== "false",
        // Non-secret status hint — never the credential itself.
        configured:
          key in configuredByKey
            ? configuredByKey[key]
            : Object.keys(map).some(
                (k) => k.startsWith(`${key}_`) && k !== `${key}_enabled`,
              ),
      }));

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

// GET /api/v1/settings/payment — read this tenant's Razorpay config (masked).
//
// Never returns the secret. Surfaces only what the UI needs to render current
// state: whether keys are configured, the (non-secret) key-id prefix, the
// mode, and boolean flags for whether a secret / webhook secret is on file.
router.get("/payment", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { razorpayKeyId: true, razorpayKeySecret: true, razorpayMode: true },
    });
    if (!tenant) {
      res.status(404).json({ success: false, data: null, error: "Tenant not found" });
      return;
    }

    const webhook = await prisma.systemConfig.findUnique({
      where: { key: tenantConfigKey(tenantId, "razorpay_webhook_secret") },
    });

    res.json({
      success: true,
      data: {
        provider: "razorpay",
        configured: !!(tenant.razorpayKeyId && tenant.razorpayKeySecret),
        razorpayKeyId: tenant.razorpayKeyId || "",
        // Mask the id defensively — the key id is not itself a secret, but we
        // only need enough for the admin to recognise which key is on file.
        razorpayKeyIdMasked: tenant.razorpayKeyId
          ? `${tenant.razorpayKeyId.slice(0, 12)}…`
          : "",
        razorpayMode: tenant.razorpayMode || "test",
        hasSecret: !!tenant.razorpayKeySecret,
        hasWebhookSecret: !!webhook?.value,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/settings/payment — set/rotate this tenant's Razorpay creds.
//
// Writes razorpayKeyId / razorpayKeySecret / razorpayMode onto the caller's
// OWN Tenant row (scoped by req.user.tenantId — no path param, no cross-tenant
// reach), upserts the webhook secret into SystemConfig, and busts the
// per-tenant Razorpay client cache so the very next payment uses the new keys.
// The audit row records ONLY the mode + a short key-id prefix — never the
// secret. Payments then resolve per-tenant automatically via
// services/razorpay.ts getCreds(tenantId).
router.patch(
  "/payment",
  validate(updatePaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const body = req.body as z.infer<typeof updatePaymentSchema>;

      // Guard: a brand-new config MUST include the secret; a rotation may omit
      // it to keep the existing one. So only allow an omitted secret when one
      // is already stored.
      const existing = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { razorpayKeySecret: true },
      });
      const secretProvided = !!body.razorpayKeySecret && body.razorpayKeySecret.length > 0;
      if (!secretProvided && !existing?.razorpayKeySecret) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Key Secret is required when saving Razorpay credentials for the first time",
        });
        return;
      }

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          razorpayKeyId: body.razorpayKeyId,
          razorpayMode: body.razorpayMode,
          // Only overwrite the secret when the admin actually typed a new one.
          ...(secretProvided ? { razorpayKeySecret: body.razorpayKeySecret } : {}),
        },
      });

      if (body.razorpayWebhookSecret && body.razorpayWebhookSecret.length > 0) {
        await upsertConfig(
          tenantId,
          "razorpay_webhook_secret",
          body.razorpayWebhookSecret,
        );
      }

      // Stamp the onboarding wizard step so the "Payment gateway" item flips to
      // completed in BOTH the super-admin tenant checklist and the tenant's own
      // onboarding page. Previously only the super-admin route stamped this, so
      // a tenant admin configuring their own gateway left the checklist reading
      // "Not started" even though payments were live.
      await upsertConfig(
        tenantId,
        "onboarding_step_payment_gateway_completed_at",
        new Date().toISOString(),
      );

      // Bust the creds cache so the next createPaymentOrder/verifyPayment for
      // this tenant picks up the rotated keys immediately (60s TTL otherwise).
      try {
        invalidateRazorpayCacheForTenant(tenantId);
      } catch {
        /* non-fatal — cache will expire on its own within the TTL */
      }

      auditLog(req, "TENANT_PAYMENT_GATEWAY_SET", "tenant", tenantId, {
        provider: "razorpay",
        mode: body.razorpayMode,
        keyIdPrefix: body.razorpayKeyId.slice(0, 12),
        secretRotated: secretProvided,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          provider: "razorpay",
          razorpayKeyId: body.razorpayKeyId,
          razorpayMode: body.razorpayMode,
          hasSecret: secretProvided || !!existing?.razorpayKeySecret,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as settingsRouter };
