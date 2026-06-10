// WhatsApp Business channel adapter.
//
// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-iv of 4).
//
// Two pathways:
//   (a) tenant-scoped — when `tenantId` is supplied AND a WhatsAppConfig
//       row exists for that tenant. Decrypts the stored creds and routes
//       through services/whatsapp-providers.ts::sendOutboundMessage().
//       This is the path the reception inbox reply endpoint goes through.
//   (b) env-based — back-compat for the existing transactional reminder
//       sends (campaign-dispatcher, prescription share, appointment SMS)
//       that aren't tenant-scoped yet. Activates only when
//       WHATSAPP_API_URL + WHATSAPP_API_KEY are set; otherwise stub mode.
//
// Env vars (back-compat path only):
//   WHATSAPP_API_URL  — provider HTTP endpoint
//   WHATSAPP_API_KEY  — bearer token / API key

import { prisma } from "@medcore/db";
import { decryptCredentials } from "../whatsapp-crypto";
import {
  sendOutboundMessage,
  type DecryptedProviderConfig,
  type ProviderName,
} from "../whatsapp-providers";

export interface ChannelResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends a single WhatsApp text message.
 *
 * - If `tenantId` is provided AND a `WhatsAppConfig` exists for that
 *   tenant (active=true), routes through that tenant's provider.
 * - Otherwise falls back to the env-based generic Gupshup pathway.
 * - If neither route is available, returns a stub success so dev / CI
 *   don't break.
 */
export async function sendWhatsApp(
  to: string,
  text: string,
  tenantId?: string | null,
): Promise<ChannelResult> {
  if (tenantId) {
    const viaTenant = await trySendViaTenantConfig(tenantId, to, text);
    if (viaTenant !== null) return viaTenant;
  }
  return sendViaEnv(to, text);
}

interface ConfigRow {
  provider: ProviderName;
  credentialsEncrypted: string | null;
  active: boolean;
}

async function trySendViaTenantConfig(
  tenantId: string,
  to: string,
  text: string,
): Promise<ChannelResult | null> {
  let row: ConfigRow | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (prisma as any).whatsAppConfig.findUnique({
      where: { tenantId },
      select: {
        provider: true,
        credentialsEncrypted: true,
        active: true,
      },
    });
    row = raw as ConfigRow | null;
  } catch (e) {
    console.warn(
      `[WhatsApp] tenant-config lookup failed for tenant=${tenantId}: ${String(e)}`,
    );
    return null;
  }
  if (!row || !row.active || !row.credentialsEncrypted) return null;

  let creds: DecryptedProviderConfig;
  try {
    creds = decryptCredentials(
      row.credentialsEncrypted,
    ) as DecryptedProviderConfig;
  } catch (e) {
    return { ok: false, error: `decrypt failed: ${String(e)}` };
  }

  try {
    const result = await sendOutboundMessage(row.provider, creds, to, text);
    return { ok: true, messageId: result.providerMessageId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function sendViaEnv(to: string, text: string): Promise<ChannelResult> {
  const apiKey = process.env.WHATSAPP_API_KEY;
  const apiUrl = process.env.WHATSAPP_API_URL;

  if (!apiKey || !apiUrl) {
    // No legacy WHATSAPP_API_URL/KEY configured. Before falling back to the
    // dev stub, try the Meta Cloud API sender (services/messaging/whatsapp.ts)
    // which uses WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID — the env
    // the project actually configures. This is what makes appointment-booking
    // confirmations (notification pipeline) actually deliver, matching the
    // public-booking flow. Imported lazily to avoid a static cycle.
    if (
      process.env.WHATSAPP_ACCESS_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID
    ) {
      const { sendWhatsApp: sendViaMetaCloud } = await import(
        "../messaging/whatsapp"
      );
      const r = await sendViaMetaCloud({ to, body: text });
      return r.ok
        ? { ok: true, messageId: r.messageId }
        : { ok: false, error: r.error };
    }
    console.log(`[WhatsApp stub] to=${to} text=${text}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as {
      messageId?: string;
      id?: string;
    };
    return { ok: true, messageId: data.messageId || data.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
