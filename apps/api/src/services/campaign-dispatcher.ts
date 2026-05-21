// Pearl ERP Stage 1 §5.1 piece 2b — Campaign dispatcher.
//
// Synchronously fans out a Campaign over its compiled audience × the
// channels it enables. Writes one CampaignSend row per (patient, channel)
// with status SENT / FAILED / SUPPRESSED. Calls the existing per-channel
// adapters directly (services/channels/{whatsapp,sms,email,push}.ts)
// rather than routing through services/notification.ts — the campaign
// operator chose the channel set explicitly, so we must not let
// per-recipient preferences silently re-route to a different channel.
//
// Scope: piece 2b only. A/B variant resolution + conversion attribution
// + tracking-aggregate rollups land in piece 3; the campaigns UI lands
// in piece 4. The endpoint that calls this service (POST
// /api/v1/campaigns/:id/dispatch) handles the state-machine transitions
// + audit log.

import type { PrismaClient } from "@prisma/client";
import { compileAudience } from "./audience-compiler";
import type { AudienceRules } from "@medcore/shared";
import { sendWhatsApp } from "./channels/whatsapp";
import { sendSMS } from "./channels/sms";
import { sendEmail } from "./channels/email";
import { sendPush } from "./channels/push";
import type { ChannelResult } from "./channels/whatsapp";

export interface DispatchSummary {
  total: number;
  sent: number;
  failed: number;
  suppressed: number;
}

interface DispatchParams {
  campaignId: string;
  tenantId: string;
}

// IST = UTC+5:30. The campaign sendWindow fields are minute-of-day in
// the tenant's local clock (Pearl is India-only for Stage 1; if other
// regions land later this becomes per-tenant).
const IST_OFFSET_MIN = 5 * 60 + 30;

export function nowMinuteOfDayIST(now: Date = new Date()): number {
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMin + IST_OFFSET_MIN) % (24 * 60);
}

export function isWithinSendWindow(
  start: number | null | undefined,
  end: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (start == null || end == null) return true; // no window configured → always allowed
  const mod = nowMinuteOfDayIST(now);
  return mod >= start && mod < end;
}

// For the 409 response when outside the window — returns the next Date
// at which `mod === start`. If today's window has not yet opened, that's
// today; otherwise tomorrow.
export function nextSendWindowStart(start: number, now: Date = new Date()): Date {
  const mod = nowMinuteOfDayIST(now);
  // Construct an IST anchor for today at minute=start, then convert back to UTC.
  const utcMidnightMin = -IST_OFFSET_MIN + start; // minute-of-day in UTC for IST `start`
  const dayMin = 24 * 60;
  const normalised = ((utcMidnightMin % dayMin) + dayMin) % dayMin;
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  anchor.setUTCMinutes(normalised);
  // If start hasn't fired yet today (in IST), `anchor` already represents
  // "today at IST `start`"; otherwise push it 24h forward.
  if (mod >= start) anchor.setUTCDate(anchor.getUTCDate() + 1);
  return anchor;
}

// Token substitution. Supported tokens:
//   {{patient.firstName}}, {{patient.lastName}}, {{patient.fullName}}
//   {{patient.mrNumber}}, {{tenant.name}}
//   {{campaignClickUrl}}            (Pearl §5.1 piece 3c — single-level
//                                    token that resolves to the click-
//                                    tracking redirect for this send)
// Unknown tokens are left in the output verbatim so the operator can
// spot a typo on receipt rather than ship a silently-blank message.
interface TokenContext {
  patient: {
    firstName: string;
    lastName: string;
    fullName: string;
    mrNumber: string;
  };
  tenant: { name: string };
  campaignClickUrl?: string;
}

export function substituteTemplate(
  template: string | null | undefined,
  ctx: TokenContext,
): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, path: string) => {
    const parts = path.split(".");
    // Single-level token: campaignClickUrl.
    if (parts.length === 1) {
      if (parts[0] === "campaignClickUrl") return ctx.campaignClickUrl ?? raw;
      return raw;
    }
    if (parts.length !== 2) return raw;
    const top = parts[0] as keyof TokenContext;
    if (top !== "patient" && top !== "tenant") return raw;
    const inner = parts[1];
    const obj = ctx[top] as Record<string, string>;
    if (!(inner in obj)) return raw;
    return obj[inner] ?? raw;
  });
}

// Pearl §5.1 piece 3c — public base URL for the click-tracking
// redirect. Defaults are dev-friendly; production is set via the
// `PUBLIC_API_URL` env var (matches the existing convention used for
// the Rx-QR verify URL in services/pdf-generator.ts, which hard-codes
// the demo host — same one is the right default here).
function publicApiBaseUrl(): string {
  return (process.env.PUBLIC_API_URL || "https://medcore.globusdemos.com/api/v1").replace(/\/$/, "");
}

export function buildClickUrl(sendId: string): string {
  // Mounted on the unauthenticated `/api/v1/public` mount alongside
  // the existing Rx-QR verify router — same shape, same precedent.
  return `${publicApiBaseUrl()}/public/campaigns/click/${sendId}`;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

// Pearl §5.1 piece 3 — A/B variant resolution at dispatch.
//
// abVariants is persisted as Json on Campaign (shape validated by the
// createCampaignSchema in @medcore/shared); we re-validate here at
// runtime so a malformed row from a manual DB edit doesn't crash the
// dispatcher. Returns null when no variants are configured (the
// dispatcher then falls back to campaign.subject/body unchanged).
export interface CampaignVariant {
  id: string;
  weight: number;
  subjectOverride?: string;
  bodyOverride?: string;
}

export function parseAbVariants(raw: unknown): CampaignVariant[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: CampaignVariant[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const weight = typeof obj.weight === "number" ? Math.floor(obj.weight) : 0;
    if (!id || weight <= 0) continue;
    const subjectOverride =
      typeof obj.subjectOverride === "string" ? obj.subjectOverride : undefined;
    const bodyOverride =
      typeof obj.bodyOverride === "string" ? obj.bodyOverride : undefined;
    out.push({ id, weight, subjectOverride, bodyOverride });
  }
  return out.length > 0 ? out : null;
}

// Weighted random pick. Math.random() is fine for A/B distribution —
// we want true randomness, not determinism (so re-dispatch can re-roll
// for a re-targeted patient set). Conversion attribution (piece 3c)
// reads variantId off CampaignSend, so the picker just needs to be
// reasonably uniform over many runs.
export function pickVariant(variants: CampaignVariant[]): CampaignVariant {
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let pick = Math.random() * totalWeight;
  for (const v of variants) {
    pick -= v.weight;
    if (pick <= 0) return v;
  }
  // Float drift edge — fall back to the last variant.
  return variants[variants.length - 1];
}

// Map CampaignChannel → NotificationPreference.channel (same string set
// in the current schema, but kept explicit so a future divergence is
// caught at the boundary).
type CampaignChannel = "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";
const PREF_CHANNEL: Record<CampaignChannel, "WHATSAPP" | "SMS" | "EMAIL" | "PUSH"> = {
  WHATSAPP: "WHATSAPP",
  SMS: "SMS",
  EMAIL: "EMAIL",
  PUSH: "PUSH",
};

async function deliverToChannel(
  channel: CampaignChannel,
  recipient: {
    phone: string | null;
    email: string | null;
    pushToken: string | null;
  },
  subject: string,
  body: string,
): Promise<ChannelResult & { addressMissing?: boolean }> {
  switch (channel) {
    case "WHATSAPP":
      if (!recipient.phone) return { ok: false, error: "no phone", addressMissing: true };
      return sendWhatsApp(recipient.phone, body);
    case "SMS":
      if (!recipient.phone) return { ok: false, error: "no phone", addressMissing: true };
      return sendSMS(recipient.phone, body);
    case "EMAIL":
      if (!recipient.email) return { ok: false, error: "no email", addressMissing: true };
      return sendEmail(recipient.email, subject || "Message", body);
    case "PUSH":
      if (!recipient.pushToken) return { ok: false, error: "no push token", addressMissing: true };
      return sendPush([recipient.pushToken], subject || "MedCore", body);
  }
}

export async function dispatchCampaign(
  prisma: PrismaClient,
  params: DispatchParams,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { total: 0, sent: 0, failed: 0, suppressed: 0 };

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.campaignId, tenantId: params.tenantId },
    include: {
      audience: true,
      tenant: { select: { name: true } },
    },
  });
  if (!campaign || !campaign.audience) return summary;

  // Compile audience → patient rows. Resolve user + preferences in the
  // same query so we don't N+1 the channel-preference lookup below.
  const where = compileAudience((campaign.audience.rules ?? {}) as AudienceRules);
  const patients = await prisma.patient.findMany({
    where: { tenantId: params.tenantId, AND: [where] },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          pushToken: true,
          notificationPreferences: {
            select: { channel: true, enabled: true },
          },
        },
      },
    },
  });

  const channels = (campaign.channels || []) as CampaignChannel[];
  const tenantCtx = { name: campaign.tenant?.name ?? "" };
  const variants = parseAbVariants(campaign.abVariants);

  for (const patient of patients) {
    if (!patient.user) continue;
    const fullName = patient.user.name ?? "";
    const { firstName, lastName } = splitName(fullName);
    const ctx: TokenContext = {
      patient: {
        firstName,
        lastName,
        fullName,
        mrNumber: patient.mrNumber ?? "",
      },
      tenant: tenantCtx,
    };

    // Pearl §5.1 piece 3 — pick a variant per recipient (not per
    // channel — same patient gets the same copy across channels).
    const variant = variants ? pickVariant(variants) : null;
    const variantId: string | null = variant?.id ?? null;
    const sourceBody = variant?.bodyOverride ?? campaign.body;
    const sourceSubject = variant?.subjectOverride ?? campaign.subject ?? "";

    for (const channel of channels) {
      summary.total += 1;

      // Pearl §5.1 piece 3c — create the CampaignSend row FIRST so its
      // id can be embedded in the click-tracking URL substituted into
      // the message body. Initial status QUEUED; we promote to
      // SENT/FAILED/SUPPRESSED after the channel adapter resolves.
      const send = await prisma.campaignSend.create({
        data: {
          campaignId: campaign.id,
          tenantId: campaign.tenantId,
          patientId: patient.id,
          channel,
          variantId,
          status: "QUEUED",
        },
      });

      const clickUrl = buildClickUrl(send.id);
      const substitutedBody = substituteTemplate(sourceBody, {
        ...ctx,
        campaignClickUrl: clickUrl,
      });
      const substitutedSubject = substituteTemplate(sourceSubject, {
        ...ctx,
        campaignClickUrl: clickUrl,
      });

      // Patient opt-out check. `enabled === false` row → suppress; rows
      // missing for a channel default to enabled (consistent with the
      // notification orchestrator's existing semantics).
      const pref = patient.user.notificationPreferences.find(
        (p) => p.channel === PREF_CHANNEL[channel],
      );
      if (pref && pref.enabled === false) {
        await prisma.campaignSend.update({
          where: { id: send.id },
          data: {
            status: "SUPPRESSED",
            failureReason: "patient opted out of this channel",
          },
        });
        summary.suppressed += 1;
        continue;
      }

      const result = await deliverToChannel(
        channel,
        {
          phone: patient.user.phone ?? null,
          email: patient.user.email ?? null,
          pushToken: patient.user.pushToken ?? null,
        },
        substitutedSubject,
        substitutedBody,
      );

      if (result.ok) {
        await prisma.campaignSend.update({
          where: { id: send.id },
          data: { status: "SENT", sentAt: new Date() },
        });
        summary.sent += 1;
      } else if (result.addressMissing) {
        await prisma.campaignSend.update({
          where: { id: send.id },
          data: {
            status: "SUPPRESSED",
            failureReason: result.error ?? "address missing",
          },
        });
        summary.suppressed += 1;
      } else {
        await prisma.campaignSend.update({
          where: { id: send.id },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            failureReason: result.error ?? "channel adapter failed",
          },
        });
        summary.failed += 1;
      }
    }
  }

  return summary;
}
