/**
 * Pearl ERP Stage 1 §8.3 (gap row 214 closure, 2026-05-24) — per-tenant
 * daily usage metering collector.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: nightly aggregation of the prior UTC day's `Notification` rows
 *   per (tenantId, channel), upserted into `TenantUsageDaily`.
 * - MODULES: reads the `Notification` model (filter: deliveryStatus in
 *   SENT/DELIVERED/READ — `QUEUED`/`FAILED`/etc. don't count as "used"
 *   for billing), writes the `TenantUsageDaily` model.
 * - WHY: the Plan side of "Per-tenant subscription (Plan + usage
 *   components)" was already modelled via `Tenant.plan`; this closes
 *   the usage-metering half so Pearl operators can later show
 *   plan-quota vs actual usage at billing time. The super-admin UI
 *   consumer that displays these counters is a separate piece.
 *
 * Schedule
 * ────────
 * Registered in `scheduled-tasks.ts` as `tenant_usage_daily_collector`
 * — daily at `runAtHour: 1` (host time; production runs in IST so this
 * lands ~01:00 IST = 19:30 UTC prior day. The "yesterday" computation
 * here uses UTC explicitly so the date boundary stays stable regardless
 * of host TZ).
 *
 * Idempotency
 * ───────────
 * Each (tenantId, date) row is upserted, not inserted — a re-run for
 * the same date overwrites the counts atomically without duplicating
 * rows (gated by the `@@unique([tenantId, date])` constraint on the
 * Prisma model). Safe to run twice if the cron flaps.
 */
import { NotificationChannel } from "@medcore/shared";
import { NotificationDeliveryStatus } from "@medcore/db";
import type { PrismaClient } from "@medcore/db";

/**
 * Compute the [startOfYesterday, startOfToday) UTC window for a given
 * "now" instant. Both bounds are at midnight UTC. The collector uses
 * a half-open interval so a notification created exactly at
 * 00:00:00.000 UTC today is NOT counted for yesterday.
 */
export function computeYesterdayUtcWindow(now: Date): {
  startOfYesterday: Date;
  startOfToday: Date;
} {
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  return { startOfYesterday, startOfToday };
}

export interface CollectYesterdayUsageOptions {
  /** Override "now" for tests + ad-hoc back-fills. Defaults to `new Date()`. */
  now?: Date;
}

export interface CollectYesterdayUsageResult {
  tenantsProcessed: number;
  totalRowsWritten: number;
  /** ISO date string (YYYY-MM-DD) of the day that was rolled up — useful for log lines / audit details. */
  date: string;
}

/**
 * Walk every `Notification` row created in the prior UTC day with a
 * non-failed delivery status, group by (tenantId, channel), and upsert
 * a `TenantUsageDaily` row per tenant for that date.
 *
 * Notifications with `tenantId = null` (system-wide rows — these exist
 * because the Notification schema marks `tenantId` as optional) are
 * skipped: they don't belong to any billable tenant.
 *
 * Returns `{ tenantsProcessed, totalRowsWritten, date }`. `tenantsProcessed`
 * counts distinct tenants that had ≥1 qualifying notification yesterday;
 * tenants with zero notifications are NOT upserted (no need to write a
 * row of zeros — the absence of a row reads as "no usage").
 */
export async function collectYesterdayUsage(
  prisma: PrismaClient,
  opts: CollectYesterdayUsageOptions = {}
): Promise<CollectYesterdayUsageResult> {
  const now = opts.now ?? new Date();
  const { startOfYesterday, startOfToday } = computeYesterdayUtcWindow(now);

  // Prisma `groupBy` over (tenantId, channel) gives us one row per
  // (tenant, channel) pair plus the count — the most efficient way to
  // get per-channel totals in a single round-trip.
  const groups = await prisma.notification.groupBy({
    by: ["tenantId", "channel"],
    where: {
      tenantId: { not: null },
      createdAt: { gte: startOfYesterday, lt: startOfToday },
      deliveryStatus: {
        in: [
          NotificationDeliveryStatus.SENT,
          NotificationDeliveryStatus.DELIVERED,
          NotificationDeliveryStatus.READ,
        ],
      },
    },
    _count: { _all: true },
  });

  // Fold the per-channel rows into per-tenant counters.
  type PerTenantCounters = {
    whatsappCount: number;
    smsCount: number;
    emailCount: number;
    pushCount: number;
  };
  const perTenant = new Map<string, PerTenantCounters>();
  for (const g of groups) {
    if (!g.tenantId) continue;
    const counters =
      perTenant.get(g.tenantId) ?? {
        whatsappCount: 0,
        smsCount: 0,
        emailCount: 0,
        pushCount: 0,
      };
    const count = g._count?._all ?? 0;
    switch (g.channel) {
      case NotificationChannel.WHATSAPP:
        counters.whatsappCount += count;
        break;
      case NotificationChannel.SMS:
        counters.smsCount += count;
        break;
      case NotificationChannel.EMAIL:
        counters.emailCount += count;
        break;
      case NotificationChannel.PUSH:
        counters.pushCount += count;
        break;
      default:
        // Future channels — ignore until the schema's enum and our
        // counter fields grow in lockstep.
        break;
    }
    perTenant.set(g.tenantId, counters);
  }

  let totalRowsWritten = 0;
  for (const [tenantId, counters] of perTenant) {
    await prisma.tenantUsageDaily.upsert({
      where: { tenantId_date: { tenantId, date: startOfYesterday } },
      create: { tenantId, date: startOfYesterday, ...counters },
      update: { ...counters },
    });
    totalRowsWritten += 1;
  }

  return {
    tenantsProcessed: perTenant.size,
    totalRowsWritten,
    date: startOfYesterday.toISOString().slice(0, 10),
  };
}
