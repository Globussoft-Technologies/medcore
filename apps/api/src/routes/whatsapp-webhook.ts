// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-ii of 4).
//
// Inbound WhatsApp webhook receivers.
//
// What / which modules / why:
//   - Five providers post their inbound message events here:
//       POST /api/v1/wa/webhook/:provider
//     where :provider ∈ {gupshup, wati, aisensei, interakt, meta} (case-
//     insensitive). The route is UNAUTHENTICATED — provider gateways
//     don't carry our JWT; per-provider signature verification (in
//     services/whatsapp-providers.ts) is the only thing that gates the
//     write.
//   - Meta Cloud API also performs a one-shot verify-token GET handshake
//     during webhook subscription: GET ?hub.mode=subscribe&hub.verify_token=X
//     &hub.challenge=Y → echo Y if X matches the stored verifyToken.
//   - On a successfully verified inbound the route:
//       (a) resolves the tenant by matching the destination phone against
//           WhatsAppConfig.credentials.sourcePhone (Gupshup) or
//           .phoneNumberId (Meta), etc.
//       (b) finds/creates WhatsAppConversation for (tenantId, fromPhone);
//       (c) writes WhatsAppMessage(direction=INBOUND, status=DELIVERED);
//       (d) bumps lastInboundAt / lastMessageAt / unreadCount on convo.
//   - Idempotency: dedupe on providerMessageId; second delivery is a no-op.
//   - Audit row WHATSAPP_INBOUND_RECEIVED logs ONLY the provider, the
//     conversation id, and the LAST 4 DIGITS of the phone (`phoneSuffix`).
//     Never the full phone, never the message body — PHI per PRD §18.
//   - Mounted in app.ts BEFORE express.json() so we can express.raw() the
//     body for signature verification (HMAC over the exact bytes Meta /
//     Gupshup signed). Mounted BEFORE authenticate so the route stays
//     unauth.

import { Router, Request, Response } from "express";
import express from "express";
import { prisma } from "@medcore/db";
import { auditLog } from "../middleware/audit";
import { decryptCredentials, resolveActiveCredentials } from "../services/whatsapp-crypto";
import { isIntegrationEnabled } from "../services/integration-flags";
import {
  verifyInboundSignature,
  parseInboundMessage,
  extractDestinationPhone,
  ProviderName,
  DecryptedProviderConfig,
} from "../services/whatsapp-providers";

const router = Router();

const PROVIDER_NAMES: Record<string, ProviderName> = {
  gupshup: "GUPSHUP",
  wati: "WATI",
  aisensei: "AISENSEI",
  interakt: "INTERAKT",
  meta: "META",
};

function normalizeProvider(raw: string): ProviderName | null {
  return PROVIDER_NAMES[raw.toLowerCase()] ?? null;
}

function phoneSuffix(phone: string): string {
  return phone.length >= 4 ? phone.slice(-4) : phone;
}

interface WhatsAppConfigRow {
  id: string;
  tenantId: string;
  provider: ProviderName;
  credentialsEncrypted: string | null;
  active: boolean;
}

/**
 * Resolves the tenant for an inbound webhook by:
 *   1. Filtering WhatsAppConfig rows by `provider`
 *   2. Decrypting each credentialsEncrypted blob
 *   3. Returning the FIRST row whose source phone / phone-number-id
 *      matches the inbound destination (or null on no-match).
 *
 * Performance note: this is O(N) over the active WhatsAppConfig rows
 * for the requested provider per tenant. In practice each tenant has
 * exactly one row per provider; we expect <100 tenants total Stage 1,
 * and <10 active providers tenant-wide. If this becomes a hot path
 * we'd hoist `sourcePhone` into its own indexed column.
 */
async function resolveTenantConfig(
  provider: ProviderName,
  destination: string | null,
): Promise<{ config: WhatsAppConfigRow; creds: DecryptedProviderConfig } | null> {
  if (!destination) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: WhatsAppConfigRow[] = await (prisma as any).whatsAppConfig.findMany(
    {
      where: { provider, active: true },
      select: {
        id: true,
        tenantId: true,
        provider: true,
        credentialsEncrypted: true,
        active: true,
      },
    },
  );

  for (const row of rows) {
    if (!row.credentialsEncrypted) continue;
    // Settings → Integrations master switch: ignore inbound for tenants whose
    // WhatsApp integration is turned off.
    if (!(await isIntegrationEnabled(row.tenantId, "whatsapp"))) continue;
    let creds: DecryptedProviderConfig;
    try {
      const active = resolveActiveCredentials(
        decryptCredentials(row.credentialsEncrypted),
        row.provider,
      );
      if (!active) continue;
      creds = active as DecryptedProviderConfig;
    } catch (err) {
      console.error(
        `[wa-webhook] decrypt failed for tenant=${row.tenantId}: ${String(err)}`,
      );
      continue;
    }
    // Match either the configured source phone (Gupshup/Wati/AiSensei/Interakt)
    // OR the phoneNumberId (Meta — destination here is the immutable id, not
    // a phone). Lenient match: ignore "+" prefix differences.
    const candidate = (
      creds.sourcePhone ??
      creds.phoneNumberId ??
      ""
    ).replace(/^\+/, "");
    const dest = destination.replace(/^\+/, "");
    if (candidate && candidate === dest) {
      return { config: row, creds };
    }
  }
  return null;
}

// ── GET /api/v1/wa/webhook/:provider — Meta verify-token handshake ────
// Meta requires a one-time GET handshake to subscribe the webhook URL.
// Other providers don't use this; we 404 them at this verb.
router.get("/:provider", async (req: Request, res: Response) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) {
    res.status(404).json({ ok: false, reason: "unknown provider" });
    return;
  }
  if (provider !== "META") {
    res.status(404).json({ ok: false, reason: "provider does not support GET" });
    return;
  }

  const mode = String(req.query["hub.mode"] ?? "");
  const verifyToken = String(req.query["hub.verify_token"] ?? "");
  const challenge = String(req.query["hub.challenge"] ?? "");
  if (mode !== "subscribe" || !verifyToken) {
    res.status(400).json({ ok: false, reason: "missing handshake params" });
    return;
  }

  // Find ANY active META config whose verifyToken matches. We don't have
  // tenant context here (the verify-token is the tenant's chosen secret)
  // so scanning all META rows is acceptable — there are very few.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: WhatsAppConfigRow[] = await (prisma as any).whatsAppConfig.findMany({
    where: { provider: "META", active: true },
    select: {
      id: true,
      tenantId: true,
      provider: true,
      credentialsEncrypted: true,
      active: true,
    },
  });
  for (const row of rows) {
    if (!row.credentialsEncrypted) continue;
    try {
      const creds = resolveActiveCredentials(
        decryptCredentials(row.credentialsEncrypted),
        row.provider,
      ) as DecryptedProviderConfig | null;
      if (creds && creds.verifyToken && creds.verifyToken === verifyToken) {
        res.status(200).type("text/plain").send(challenge);
        return;
      }
    } catch {
      continue;
    }
  }
  res.status(403).json({ ok: false, reason: "verify_token mismatch" });
});

// ── POST /api/v1/wa/webhook/:provider — inbound message receiver ──────
router.post(
  "/:provider",
  // Raw-body parsing: HMAC verification (Meta / Gupshup) requires the
  // exact bytes the provider signed. Express's default JSON parser
  // would re-serialise on access and break the signature. Restrict the
  // raw parser to this route only.
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req: Request, res: Response) => {
    const provider = normalizeProvider(req.params.provider);
    if (!provider) {
      res.status(404).json({ ok: false, reason: "unknown provider" });
      return;
    }

    const raw: Buffer = Buffer.isBuffer(req.body)
      ? (req.body as Buffer)
      : Buffer.from("");

    // Parse JSON eagerly (after we've kept the raw bytes for HMAC) so we
    // can extract the destination phone for tenant routing.
    let payload: unknown;
    try {
      const text = raw.toString("utf8");
      payload = text ? JSON.parse(text) : {};
    } catch {
      res.status(400).json({ ok: false, reason: "invalid json" });
      return;
    }

    const destination = extractDestinationPhone(provider, payload);
    const resolution = await resolveTenantConfig(provider, destination);
    if (!resolution) {
      // Unknown destination → 200 so provider doesn't retry. We don't
      // 4xx because providers treat 4xx as "fix the URL and retry" —
      // we just don't have a tenant for this number.
      res.status(200).json({ ok: false, reason: "unknown destination" });
      return;
    }

    const { config, creds } = resolution;

    // Signature verification — provider-keyed. Failure ⇒ 401.
    const sigOk = verifyInboundSignature(provider, raw, req.headers, creds);
    if (!sigOk) {
      res.status(401).json({ ok: false, reason: "invalid signature" });
      return;
    }

    // Stamp tenantId on the request so auditLog picks it up via the
    // standard middleware path (no req.user since we're unauthed).
    req.tenantId = config.tenantId;

    const normalized = parseInboundMessage(provider, payload);
    if (!normalized) {
      // Non-message event (delivery receipt, status update). Ack 200
      // silently — these are common and shouldn't bloat audit rows.
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    // Find-or-create the conversation. The (tenantId, phone) unique
    // constraint on WhatsAppConversation guarantees idempotency under
    // concurrent first-message races; we upsert to take advantage.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conversation = await (prisma as any).whatsAppConversation.upsert({
      where: {
        tenantId_phone: {
          tenantId: config.tenantId,
          phone: normalized.phone,
        },
      },
      create: {
        tenantId: config.tenantId,
        phone: normalized.phone,
        lastInboundAt: normalized.sentAt,
        lastMessageAt: normalized.sentAt,
        unreadCount: 1,
        status: "OPEN",
      },
      update: {
        lastInboundAt: normalized.sentAt,
        lastMessageAt: normalized.sentAt,
        unreadCount: { increment: 1 },
        // If a previously CLOSED convo gets a new inbound, re-open it.
        status: "OPEN",
      },
    });

    // Idempotent message persist — dedupe on providerMessageId when
    // present. We don't put a DB-level @@unique on it (would prevent
    // null cohabitation across providers); we instead do a defensive
    // findFirst before insert. The race window is the same as razorpay-
    // webhook.ts and we accept it (rare; second write would fail with
    // a sane "duplicate" log).
    if (normalized.providerMessageId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (prisma as any).whatsAppMessage.findFirst({
        where: {
          tenantId: config.tenantId,
          providerMessageId: normalized.providerMessageId,
        },
        select: { id: true },
      });
      if (existing) {
        // Already persisted — silently ack so the provider stops
        // retrying. We also reverse the unreadCount bump from the
        // upsert above so the convo's unread count stays correct
        // across redelivery.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).whatsAppConversation.update({
          where: { id: conversation.id },
          data: { unreadCount: { decrement: 1 } },
        });
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (prisma as any).whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        tenantId: config.tenantId,
        direction: "INBOUND",
        body: normalized.body,
        mediaUrl: normalized.mediaUrl ?? null,
        providerMessageId: normalized.providerMessageId ?? null,
        status: "DELIVERED",
        sentAt: normalized.sentAt,
        deliveredAt: new Date(),
      },
    });

    // PHI-safe audit: NEVER the body or full phone.
    auditLog(req, "WHATSAPP_INBOUND_RECEIVED", "whatsapp_message", message.id, {
      provider,
      conversationId: conversation.id,
      phoneSuffix: phoneSuffix(normalized.phone),
    }).catch((e) =>
      console.error("[wa-webhook] audit write failed", e),
    );

    res.status(200).json({ ok: true });
  },
);

export { router as whatsappWebhookRouter };
