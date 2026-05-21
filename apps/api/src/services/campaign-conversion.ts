// Pearl ERP Stage 1 §5.1 piece 3c — campaign conversion attribution.
//
// Called from downstream events (appointment booking, invoice
// generation) as a fire-and-forget side effect — never blocks the
// primary request path. Finds the patient's most-recent CLICKED-BUT-
// UNATTRIBUTED CampaignSend within the attribution window (default 7
// days) and stamps its convertedAt / convertedRefId / convertedType.
//
// "Most recent click wins" is deliberate: a patient clicked multiple
// campaign links recently and then converted — the freshest touchpoint
// gets credit (matches the industry-default "last-touch" attribution
// model). Multi-touch attribution is a piece 4+ concern.

import type { PrismaClient } from "@prisma/client";

export type ConversionType = "APPOINTMENT" | "INVOICE";

interface RecordConversionParams {
  patientId: string;
  type: ConversionType;
  refId: string;
  /**
   * Override the default 7-day attribution window. Pass `0` to require
   * the click to be in the same minute as the conversion (useful only
   * for synchronous flows). Negative values are ignored.
   */
  windowDays?: number;
}

const DEFAULT_WINDOW_DAYS = 7;

/**
 * Returns the CampaignSend id that was credited, or null if no eligible
 * send existed. Never throws — caller treats it as fire-and-forget.
 */
export async function recordCampaignConversion(
  prisma: PrismaClient,
  params: RecordConversionParams,
): Promise<string | null> {
  try {
    const windowDays =
      typeof params.windowDays === "number" && params.windowDays >= 0
        ? params.windowDays
        : DEFAULT_WINDOW_DAYS;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const earliest = new Date(Date.now() - windowMs);

    const send = await prisma.campaignSend.findFirst({
      where: {
        patientId: params.patientId,
        clickedAt: { gte: earliest, not: null },
        convertedAt: null,
      },
      orderBy: { clickedAt: "desc" },
      select: { id: true },
    });
    if (!send) return null;

    await prisma.campaignSend.update({
      where: { id: send.id },
      data: {
        convertedAt: new Date(),
        convertedType: params.type,
        convertedRefId: params.refId,
      },
    });
    return send.id;
  } catch (err) {
    // Fire-and-forget — log and swallow. Attribution is a stat,
    // not a correctness guarantee; a failed attribution must not
    // break the underlying appointment / invoice transaction.
    console.error("[recordCampaignConversion] failed", err);
    return null;
  }
}
