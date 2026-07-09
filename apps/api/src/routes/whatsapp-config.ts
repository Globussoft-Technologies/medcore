/**
 * Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-i of 4).
 *
 * Per-tenant WhatsApp provider config — GET + PUT /api/v1/wa/config.
 *
 * What / which modules / why:
 *   - Backed by the new WhatsAppConfig Prisma model (one row per tenant).
 *   - Five providers supported (GUPSHUP / WATI / AISENSEI / INTERAKT / META)
 *     via the discriminated-union Zod schema in
 *     packages/shared/src/validation/whatsapp-config.ts.
 *   - Credentials are encrypted at rest with AES-256-GCM via
 *     apps/api/src/services/whatsapp-crypto.ts (dev/stub mode supported).
 *   - The outbound adapter (apps/api/src/services/channels/whatsapp.ts)
 *     stays unchanged this piece — it keeps reading WHATSAPP_API_URL /
 *     WHATSAPP_API_KEY env vars. Piece 3j-iv flips it to per-tenant creds
 *     resolved from this table.
 *   - AuditLog row writes `WHATSAPP_CONFIG_UPDATED` with ONLY the changed
 *     `provider` + the active/autoReply flags — never the creds.
 *
 * RBAC: ADMIN-only (matches /api/v1/settings/integrations).
 */

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role, whatsappConfigPutSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { tenantConfigKey } from "../services/tenant-provisioning";
import {
  encryptCredentials,
  decryptCredentials,
  credentialsMap,
  resolveActiveCredentials,
} from "../services/whatsapp-crypto";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN));

function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({
      success: false,
      data: null,
      error: "WhatsApp config requires a tenant context",
    });
    return null;
  }
  return tenantId;
}

// GET /api/v1/wa/config — current tenant's WhatsApp config (creds decrypted)
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const row = await prisma.whatsAppConfig.findUnique({
      where: { tenantId },
    });
    if (!row) {
      res.json({ success: true, data: { config: null }, error: null });
      return;
    }

    // `credentials` = the ACTIVE provider's flat creds (backward-compatible
    // with the standalone /dashboard/settings/whatsapp page). `credentialsByProvider`
    // = the full per-provider vault, so the multi-provider Settings tab can show
    // every saved provider and let the admin flip the active one.
    let credentials: Record<string, unknown> | null = null;
    let credentialsByProvider: Record<string, Record<string, unknown>> = {};
    let plaintextWarning = false;
    if (row.credentialsEncrypted) {
      try {
        const decoded = decryptCredentials(row.credentialsEncrypted);
        // Plaintext-mode marker lives on the OUTER blob; unwrap for the flag.
        if (decoded && (decoded as { __plaintext?: boolean }).__plaintext === true) {
          plaintextWarning = true;
        }
        credentialsByProvider = credentialsMap(decoded, row.provider);
        credentials = resolveActiveCredentials(decoded, row.provider);
      } catch (err) {
        // Tamper / missing-key path — surface a 200 with the metadata
        // but without creds. Logged so ops can investigate.
        console.error(
          `[wa/config GET] decrypt failed for tenant=${tenantId}: ${String(err)}`,
        );
        credentials = null;
      }
    }

    res.json({
      success: true,
      data: {
        config: {
          id: row.id,
          provider: row.provider,
          credentials,
          credentialsByProvider,
          defaultProductId: row.defaultProductId,
          autoReply: row.autoReply,
          active: row.active,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          plaintextWarning,
        },
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/wa/config — upsert tenant's WhatsApp config
router.put(
  "/",
  validate(whatsappConfigPutSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const body = req.body as {
        credentials: { provider: string } & Record<string, unknown>;
        activeProvider?: string;
        defaultProductId?: string | null;
        autoReply?: boolean;
        active?: boolean;
      };

      const { provider, ...credFields } = body.credentials;

      // Merge into the per-provider vault: load whatever the tenant already has
      // saved, upsert THIS provider's creds, and keep the rest untouched. This
      // is what lets a hospital store several providers and switch between them
      // without re-entering the others.
      const existing = await prisma.whatsAppConfig.findUnique({
        where: { tenantId },
        select: { provider: true, credentialsEncrypted: true },
      });
      let byProvider: Record<string, Record<string, unknown>> = {};
      if (existing?.credentialsEncrypted) {
        try {
          byProvider = {
            ...credentialsMap(
              decryptCredentials(existing.credentialsEncrypted),
              existing.provider,
            ),
          };
        } catch {
          // Unreadable prior blob (tamper / rotated key) — start fresh rather
          // than block the admin from re-saving.
          byProvider = {};
        }
      }
      byProvider[provider] = credFields;

      // Which provider is ACTIVE after this save. Defaults to the one just
      // saved; an explicit `activeProvider` must be one we now hold creds for.
      const activeProvider = body.activeProvider ?? provider;
      if (!byProvider[activeProvider]) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot set ${activeProvider} active — no credentials saved for it yet.`,
        });
        return;
      }

      const credentialsEncrypted = encryptCredentials({ byProvider });
      const activeEnum = activeProvider as
        | "GUPSHUP"
        | "WATI"
        | "AISENSEI"
        | "INTERAKT"
        | "META";

      const row = await prisma.whatsAppConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          provider: activeEnum,
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          autoReply: body.autoReply ?? true,
          active: body.active ?? true,
        },
        update: {
          provider: activeEnum,
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          ...(body.autoReply !== undefined ? { autoReply: body.autoReply } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });

      // Stamp the onboarding wizard step so the "WhatsApp Business" item flips
      // to completed in BOTH the super-admin tenant checklist and the tenant's
      // own onboarding page. Previously only the super-admin route stamped it,
      // so a tenant admin configuring WhatsApp themselves left the checklist
      // reading "Not started" even though messaging was live.
      const stampKey = tenantConfigKey(
        tenantId,
        "onboarding_step_whatsapp_completed_at",
      );
      const stampVal = new Date().toISOString();
      await prisma.systemConfig.upsert({
        where: { key: stampKey },
        create: { key: stampKey, value: stampVal },
        update: { value: stampVal },
      });

      // Critically — log ONLY the metadata, never the creds.
      auditLog(req, "WHATSAPP_CONFIG_UPDATED", "whatsapp_config", row.id, {
        provider: row.provider,
        autoReply: row.autoReply,
        active: row.active,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          config: {
            id: row.id,
            provider: row.provider,
            defaultProductId: row.defaultProductId,
            autoReply: row.autoReply,
            active: row.active,
            updatedAt: row.updatedAt,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as whatsappConfigRouter };
