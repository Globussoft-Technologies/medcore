// Pearl ERP Stage 1 §5.1 piece 2b — Campaign dispatcher sweep worker.
//
// What / which modules / why:
//   - Periodic sweep that finds Campaign rows in `SCHEDULED` status whose
//     `scheduledAt` has elapsed, runs each through the existing synchronous
//     fan-out (`services/campaign-dispatcher.ts:dispatchCampaign`), and
//     transitions Campaign.status to RUNNING → COMPLETED. Registered as
//     scheduled task `campaign_dispatch_sweep` (every 5 min) in
//     `services/scheduled-tasks.ts`.
//   - Implements the deferred half of Pearl §5.1: the SYNC dispatch
//     endpoint (`POST /api/v1/campaigns/:id/dispatch`, shipped in piece
//     2b/r1) handles "operator clicks Send Now"; THIS worker handles
//     "operator scheduled it for later" — i.e. DRIP/TRIGGER/scheduled
//     BROADCAST campaigns whose `scheduledAt > createdAt`.
//   - Enforces the IST quiet-hour clamp (Pearl §5.1 row 338): campaigns
//     outside their `sendWindowStart`/`sendWindowEnd` minute-of-day window
//     remain SCHEDULED and get retried on the next tick once inside.
//   - Per-tick cap: 10 campaigns per sweep; the remainder defer to the
//     next tick. Per-recipient fan-out is delegated to `dispatchCampaign`
//     (which already handles tokens, opt-out checks, A/B variant pick,
//     and channel-adapter dispatch).
//   - Skips campaigns whose tenant is inactive (tenants table `active`
//     flag) — a suspended tenant must not blast its audience.
//   - Edge: a campaign with no audience OR no channels is moved to
//     CANCELLED with a machine-readable `cancelReason` (the enum has no
//     FAILED member; CANCELLED is the closest terminal state and mirrors
//     how the operator-initiated cancel flow records the cause).
//
// Acceptance/contract reuse: every primitive used here
// (`isWithinSendWindow`, `dispatchCampaign`, channel adapters) is already
// shipped by the sync-dispatch service. This file only adds the
// scheduling shell, the tenant-active gate, and the COMPLETED/CANCELLED
// state-machine transitions for the background path.

import type { PrismaClient } from "@prisma/client";
import { dispatchCampaign, isWithinSendWindow } from "./campaign-dispatcher";

export interface SweepOptions {
  /** Hard cap on campaigns processed per tick. Default: 10. */
  maxCampaigns?: number;
  /** Override `now` for deterministic tests. Default: `new Date()`. */
  now?: Date;
}

export interface SweepSummary {
  inspected: number;
  dispatched: number;
  deferredQuietHours: number;
  cancelledNoAudience: number;
  cancelledNoChannels: number;
  skippedInactiveTenant: number;
  errors: number;
}

/**
 * Finds SCHEDULED campaigns whose `scheduledAt` has elapsed and dispatches
 * them via the existing synchronous fan-out service. Idempotent: a tick
 * with nothing due returns zero counts and no side-effects.
 */
export async function dispatchPendingCampaigns(
  prisma: PrismaClient,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    inspected: 0,
    dispatched: 0,
    deferredQuietHours: 0,
    cancelledNoAudience: 0,
    cancelledNoChannels: 0,
    skippedInactiveTenant: 0,
    errors: 0,
  };
  const now = opts.now ?? new Date();
  const maxCampaigns = opts.maxCampaigns ?? 10;

  // Pull the ready set. We DELIBERATELY skip the `tenant.active` filter
  // at the Prisma level (no easy way to express across the FK without an
  // include) and re-check below — this also lets us count the skip in
  // the summary.
  const pending = await prisma.campaign.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
    },
    select: {
      id: true,
      tenantId: true,
      audienceId: true,
      channels: true,
      sendWindowStart: true,
      sendWindowEnd: true,
      tenant: { select: { active: true } },
    },
    orderBy: { scheduledAt: "asc" },
    take: maxCampaigns,
  });

  for (const c of pending) {
    summary.inspected += 1;

    if (!c.tenant?.active) {
      summary.skippedInactiveTenant += 1;
      continue;
    }

    // Quiet-hour clamp (Pearl §5.1 row 338). Leaving the campaign in
    // SCHEDULED means the next tick re-checks once we're inside the
    // window. We do NOT advance scheduledAt — operator intent ("send
    // close to but no earlier than X") is preserved.
    if (!isWithinSendWindow(c.sendWindowStart, c.sendWindowEnd, now)) {
      summary.deferredQuietHours += 1;
      continue;
    }

    if (!c.audienceId) {
      try {
        await prisma.campaign.update({
          where: { id: c.id },
          data: {
            status: "CANCELLED",
            cancelledAt: now,
            cancelReason:
              "Auto-cancelled by dispatcher sweep: no audience attached",
          },
        });
        summary.cancelledNoAudience += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(
          "[campaign_dispatch_sweep] failed to cancel no-audience campaign",
          c.id,
          err,
        );
      }
      continue;
    }

    if (!c.channels || c.channels.length === 0) {
      try {
        await prisma.campaign.update({
          where: { id: c.id },
          data: {
            status: "CANCELLED",
            cancelledAt: now,
            cancelReason:
              "Auto-cancelled by dispatcher sweep: no channels enabled",
          },
        });
        summary.cancelledNoChannels += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(
          "[campaign_dispatch_sweep] failed to cancel no-channel campaign",
          c.id,
          err,
        );
      }
      continue;
    }

    // Flip to RUNNING BEFORE invoking the fan-out so a concurrent
    // dispatch (operator clicks Send Now from the UI mid-sweep) hits
    // the existing RUNNING guard in `routes/campaigns.ts` and 409s
    // instead of double-sending.
    try {
      await prisma.campaign.update({
        where: { id: c.id },
        data: { status: "RUNNING", startedAt: now },
      });
    } catch (err) {
      summary.errors += 1;
      console.error(
        "[campaign_dispatch_sweep] failed to flip campaign to RUNNING",
        c.id,
        err,
      );
      continue;
    }

    try {
      await dispatchCampaign(prisma, {
        campaignId: c.id,
        tenantId: c.tenantId,
      });
      await prisma.campaign.update({
        where: { id: c.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      summary.dispatched += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        "[campaign_dispatch_sweep] dispatch failed for campaign",
        c.id,
        err,
      );
      // Mirror the sync-dispatch behaviour: roll back to PAUSED so the
      // operator can investigate and resume without losing the partial
      // CampaignSend rows already written.
      try {
        await prisma.campaign.update({
          where: { id: c.id },
          data: { status: "PAUSED" },
        });
      } catch (innerErr) {
        console.error(
          "[campaign_dispatch_sweep] failed to flip campaign to PAUSED after error",
          c.id,
          innerErr,
        );
      }
    }
  }

  return summary;
}

/**
 * Singleton-state convention: no module-scope state today, but exported
 * so future caches (per-tenant timezone, audience-compile memoisation)
 * have a single reset hook to plug into.
 */
export function __resetCampaignDispatcherForTests(): void {
  // intentionally empty — placeholder for the singleton-state convention
}
