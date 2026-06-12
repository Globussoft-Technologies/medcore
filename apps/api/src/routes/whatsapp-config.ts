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
import {
  encryptCredentials,
  decryptCredentials,
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

    let credentials: Record<string, unknown> | null = null;
    let plaintextWarning = false;
    if (row.credentialsEncrypted) {
      try {
        const decoded = decryptCredentials(row.credentialsEncrypted);
        if (decoded && decoded.__plaintext === true) {
          plaintextWarning = true;
        }
        credentials = decoded;
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
        defaultProductId?: string | null;
        autoReply?: boolean;
        active?: boolean;
      };

      const { provider, ...credFields } = body.credentials;
      const credentialsEncrypted = encryptCredentials(credFields);

      const row = await prisma.whatsAppConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          provider: provider as
            | "GUPSHUP"
            | "WATI"
            | "AISENSEI"
            | "INTERAKT"
            | "META",
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          autoReply: body.autoReply ?? true,
          active: body.active ?? true,
        },
        update: {
          provider: provider as
            | "GUPSHUP"
            | "WATI"
            | "AISENSEI"
            | "INTERAKT"
            | "META",
          credentialsEncrypted,
          defaultProductId: body.defaultProductId ?? null,
          ...(body.autoReply !== undefined ? { autoReply: body.autoReply } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
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
