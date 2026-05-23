// Unit tests for the campaign-dispatcher sweep worker — Pearl §5.1 piece 2b.
//
// What / which modules / why:
//   - `dispatchPendingCampaigns(prisma, opts)` walks `Campaign.status =
//     SCHEDULED AND scheduledAt <= now` and either dispatches via the
//     existing `dispatchCampaign` service or cancels/defers based on
//     audience / channels / tenant-active / quiet-hours.
//   - This file is COLOCATED with the service (mirroring the
//     `whatsapp-providers.test.ts` precedent that fixed the function-coverage
//     gate in commit `b776629`) so it lands inside the `test:coverage:unit`
//     glob (`apps/api/src/services packages/shared`).
//   - Mocks `dispatchCampaign` (the heavy fan-out) so the sweep's decisions
//     are tested in isolation without touching channels, audience compiler,
//     or Prisma.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./campaign-dispatcher", () => ({
  dispatchCampaign: vi.fn(),
  isWithinSendWindow: vi.fn(),
}));

import {
  dispatchPendingCampaigns,
  __resetCampaignDispatcherForTests,
} from "./campaign-dispatcher-sweep";
import { dispatchCampaign, isWithinSendWindow } from "./campaign-dispatcher";

const dispatchCampaignMock = vi.mocked(dispatchCampaign);
const isWithinSendWindowMock = vi.mocked(isWithinSendWindow);

// Minimal Prisma shape — only the methods the sweep touches. Returning
// `any` for the mock builder keeps the test focused on behaviour, not
// PrismaClient typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePrismaMock(pending: any[]): any {
  return {
    campaign: {
      findMany: vi.fn().mockResolvedValue(pending),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

const NOW = new Date("2026-05-23T12:00:00Z");

beforeEach(() => {
  dispatchCampaignMock.mockReset();
  isWithinSendWindowMock.mockReset();
  isWithinSendWindowMock.mockReturnValue(true);
  __resetCampaignDispatcherForTests();
});

describe("dispatchPendingCampaigns", () => {
  it("returns all-zero summary when nothing is pending", async () => {
    const prisma = makePrismaMock([]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary).toEqual({
      inspected: 0,
      dispatched: 0,
      deferredQuietHours: 0,
      cancelledNoAudience: 0,
      cancelledNoChannels: 0,
      skippedInactiveTenant: 0,
      errors: 0,
    });
    expect(dispatchCampaignMock).not.toHaveBeenCalled();
  });

  it("skips campaigns whose tenant is inactive", async () => {
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: ["WHATSAPP"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: false },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.inspected).toBe(1);
    expect(summary.skippedInactiveTenant).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatchCampaignMock).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("defers campaigns outside the quiet-hour window without mutating them", async () => {
    isWithinSendWindowMock.mockReturnValue(false);
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: ["WHATSAPP"],
        sendWindowStart: 22,
        sendWindowEnd: 6,
        tenant: { active: true },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.deferredQuietHours).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(prisma.campaign.update).not.toHaveBeenCalled();
    expect(dispatchCampaignMock).not.toHaveBeenCalled();
  });

  it("cancels campaigns with no audience attached", async () => {
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: null,
        channels: ["WHATSAPP"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.cancelledNoAudience).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({
        status: "CANCELLED",
        cancelReason: expect.stringMatching(/no audience/i),
      }),
    });
    expect(dispatchCampaignMock).not.toHaveBeenCalled();
  });

  it("cancels campaigns with no channels enabled", async () => {
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: [],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.cancelledNoChannels).toBe(1);
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({
        status: "CANCELLED",
        cancelReason: expect.stringMatching(/no channels/i),
      }),
    });
  });

  it("flips ready campaigns to RUNNING, dispatches, and marks COMPLETED", async () => {
    dispatchCampaignMock.mockResolvedValue(undefined as never);
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: ["WHATSAPP", "SMS"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.dispatched).toBe(1);
    expect(summary.errors).toBe(0);
    expect(dispatchCampaignMock).toHaveBeenCalledWith(prisma, {
      campaignId: "c1",
      tenantId: "t1",
    });
    // RUNNING then COMPLETED — two updates.
    expect(prisma.campaign.update).toHaveBeenCalledTimes(2);
    expect(prisma.campaign.update).toHaveBeenNthCalledWith(1, {
      where: { id: "c1" },
      data: { status: "RUNNING", startedAt: NOW },
    });
    expect(prisma.campaign.update).toHaveBeenNthCalledWith(2, {
      where: { id: "c1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("rolls a failed dispatch back to PAUSED and counts the error", async () => {
    dispatchCampaignMock.mockRejectedValue(new Error("channel exploded"));
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: ["WHATSAPP"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.errors).toBe(1);
    expect(summary.dispatched).toBe(0);
    // RUNNING flip succeeded, then PAUSED rollback — two updates.
    expect(prisma.campaign.update).toHaveBeenCalledTimes(2);
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({
      where: { id: "c1" },
      data: { status: "PAUSED" },
    });
  });

  it("counts an error when the RUNNING-flip itself fails and never invokes dispatch", async () => {
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: "a1",
        channels: ["WHATSAPP"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    prisma.campaign.update.mockRejectedValueOnce(new Error("write conflict"));
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.errors).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatchCampaignMock).not.toHaveBeenCalled();
  });

  it("counts an error when cancel-update fails on a no-audience campaign", async () => {
    const prisma = makePrismaMock([
      {
        id: "c1",
        tenantId: "t1",
        audienceId: null,
        channels: ["WHATSAPP"],
        sendWindowStart: null,
        sendWindowEnd: null,
        tenant: { active: true },
      },
    ]);
    prisma.campaign.update.mockRejectedValueOnce(new Error("write conflict"));
    const summary = await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(summary.errors).toBe(1);
    expect(summary.cancelledNoAudience).toBe(0);
  });

  it("honours the maxCampaigns cap", async () => {
    const prisma = makePrismaMock([]);
    await dispatchPendingCampaigns(prisma, { now: NOW, maxCampaigns: 3 });
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
  });

  it("defaults to 10 campaigns per tick when no cap is provided", async () => {
    const prisma = makePrismaMock([]);
    await dispatchPendingCampaigns(prisma, { now: NOW });
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it("uses new Date() when `now` is omitted", async () => {
    const prisma = makePrismaMock([]);
    await dispatchPendingCampaigns(prisma);
    expect(prisma.campaign.findMany).toHaveBeenCalledOnce();
  });
});

describe("__resetCampaignDispatcherForTests", () => {
  it("is callable + idempotent (no module-scope state today)", () => {
    expect(() => __resetCampaignDispatcherForTests()).not.toThrow();
    expect(() => __resetCampaignDispatcherForTests()).not.toThrow();
  });
});
