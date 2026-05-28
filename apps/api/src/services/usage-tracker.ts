/**
 * Pearl ERP Stage 1 §8.3 piece 3e (2026-05-28) — usage-event tracker.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a thin, fire-and-forget recorder for the four billable platform
 *   actions Pearl charges hospitals for on top of the flat plan fee:
 *     - WHATSAPP_SENT  — outbound WhatsApp message (`quantity = 1`)
 *     - SMS_SENT       — outbound SMS                (`quantity = 1`)
 *     - LLM_TOKENS     — Anthropic / OpenAI inference (`quantity = tokens`)
 *     - ABDM_MESSAGE   — ABDM-bound message          (`quantity = 1`)
 * - MODULES: writes one `UsageEvent` row per call (table introduced in
 *   schema piece 3e). Reads/writes nothing else — every call site is
 *   already inside its own request context with `req.user!.tenantId`
 *   resolved.
 * - WHY: the monthly invoice generator (piece 3b → piece 3e patch below)
 *   aggregates these counters into per-tenant line items so the operator
 *   sees one invoice with both the flat plan fee AND the metered usage.
 *   Keeping a row-per-event (instead of incrementing a counter) gives the
 *   audit log granular evidence — useful when a hospital disputes a
 *   billable.
 *
 * Failure semantics
 * ─────────────────
 * Usage recording NEVER blocks the user-visible action — every write is
 * try/catch + console.error on failure. A lost row is preferable to a
 * failed WhatsApp send / failed LLM inference; the operator's monthly
 * invoice runs against whatever rows DID land. Call sites that need
 * strict accounting (e.g. ABDM with the consent receipt) should write
 * through their own audit path instead.
 */
import { prisma } from "@medcore/db";
import type { Prisma } from "@medcore/db";
import { getAllUsageUnitPaise } from "./platform-billing-config";

export type UsageKind =
  | "WHATSAPP_SENT"
  | "SMS_SENT"
  | "LLM_TOKENS"
  | "ABDM_MESSAGE";

export interface RecordUsageInput {
  tenantId: string | null | undefined;
  kind: UsageKind;
  quantity?: number;
  meta?: Record<string, unknown>;
}

/**
 * Fire-and-forget usage event writer. Returns the resolved Promise (which
 * never rejects from the caller's POV — internal errors are swallowed
 * to console.error). Callers can `await` it if they want ordering, or
 * just call it without awaiting and continue.
 */
export async function recordUsageEvent(input: RecordUsageInput): Promise<void> {
  // tenantId === null means a non-tenant context (e.g. super-admin call
  // with no tenant binding). Don't write a row in that case — it's not
  // billable to any hospital and storing it would pollute the meter.
  if (!input.tenantId) return;
  const quantity = input.quantity ?? 1;
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  try {
    await prisma.usageEvent.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        quantity,
        ...(input.meta
          ? { meta: input.meta as Prisma.InputJsonValue }
          : {}),
      },
    });
  } catch (err) {
    console.error(
      "[usage_tracker] failed to record",
      input.kind,
      "for tenant",
      input.tenantId,
      err,
    );
  }
}

/**
 * Per-kind unit-pricing is sourced entirely from `SystemConfig` via
 * `getAllUsageUnitPaise()` — see `platform-billing-config.ts` for the
 * key layout (`platform_billing:usage_price:<KIND>`). Operators can
 * change a row at runtime and the next monthly aggregation picks the
 * new price up without a deploy.
 */
export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  WHATSAPP_SENT: "WhatsApp messages",
  SMS_SENT: "SMS messages",
  LLM_TOKENS: "LLM tokens",
  ABDM_MESSAGE: "ABDM messages",
};

/**
 * Aggregate usage events for a tenant + window. Returns one row per
 * usage kind (the four enum values), each carrying the total quantity
 * and the resolved unit price in paise (SystemConfig override → default).
 * Empty kinds are NOT included in the result so the invoice line items
 * stay minimal.
 */
export interface UsageAggregateRow {
  kind: UsageKind;
  totalQuantity: number;
  unitPriceInPaise: number;
  amountInPaise: number;
}

export async function aggregateUsageForBilling(
  prismaClient: typeof prisma,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<UsageAggregateRow[]> {
  const grouped = await prismaClient.usageEvent.groupBy({
    by: ["kind"],
    where: {
      tenantId,
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    _sum: { quantity: true },
  });

  // Pricing comes from SystemConfig (see platform-billing-config.ts).
  // One batched read covers all four kinds — no per-kind round trips.
  const prices = await getAllUsageUnitPaise();

  const rows: UsageAggregateRow[] = [];
  for (const g of grouped) {
    const kind = g.kind as UsageKind;
    const totalQuantity = g._sum.quantity ?? 0;
    if (totalQuantity <= 0) continue;
    const unitPriceInPaise = prices[kind] ?? 0;
    rows.push({
      kind,
      totalQuantity,
      unitPriceInPaise,
      amountInPaise: totalQuantity * unitPriceInPaise,
    });
  }
  return rows;
}
