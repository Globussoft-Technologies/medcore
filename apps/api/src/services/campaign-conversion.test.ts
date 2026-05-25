// Unit tests for the campaign-conversion attribution service — Pearl ERP
// Stage 1 §5.1 piece 3c.
//
// What / which modules / why:
//   - Validates `recordCampaignConversion(prisma, params)` finds the patient's
//     most-recent eligible CampaignSend within the attribution window and
//     stamps convertedAt / convertedType / convertedRefId; never throws.
//   - Prisma is mocked end-to-end — no DB hit. We assert on the
//     where/orderBy/select arg shape sent to findFirst + the update payload.
//   - COLOCATED at `services/campaign-conversion.test.ts` so the root
//     `vitest.config.ts` glob (`apps/api/src/**/*.test.ts`) picks it up
//     (mirrors `dpdp-purge.test.ts`).

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { recordCampaignConversion } from "./campaign-conversion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePrismaMock(opts: {
  findFirstResult?: { id: string } | null;
  findFirstError?: Error;
  updateError?: Error;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} = {}): { prisma: any; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  const findFirst = vi.fn();
  if (opts.findFirstError) {
    findFirst.mockRejectedValue(opts.findFirstError);
  } else {
    findFirst.mockResolvedValue(opts.findFirstResult ?? null);
  }
  const update = vi.fn();
  if (opts.updateError) {
    update.mockRejectedValue(opts.updateError);
  } else {
    update.mockResolvedValue({});
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    campaignSend: { findFirst, update },
  };
  return { prisma, findFirst, update };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Silence the console.error in the swallow-and-log branch so test output
  // stays readable; restored in afterEach.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordCampaignConversion", () => {
  describe("happy path", () => {
    it("flips a CLICKED CampaignSend to CONVERTED with the correct stamps", async () => {
      const { prisma, findFirst, update } = makePrismaMock({
        findFirstResult: { id: "send-1" },
      });

      const beforeCall = Date.now();
      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-9",
      });
      const afterCall = Date.now();

      expect(result).toBe("send-1");
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);

      const updateArgs = update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: "send-1" });
      expect(updateArgs.data.convertedType).toBe("APPOINTMENT");
      expect(updateArgs.data.convertedRefId).toBe("appt-9");
      // convertedAt is set to `new Date()` inside the function — assert it
      // lies in our [beforeCall, afterCall] window.
      const convertedAtMs = (updateArgs.data.convertedAt as Date).getTime();
      expect(convertedAtMs).toBeGreaterThanOrEqual(beforeCall);
      expect(convertedAtMs).toBeLessThanOrEqual(afterCall);
    });

    it("also handles INVOICE conversion type", async () => {
      const { prisma, update } = makePrismaMock({
        findFirstResult: { id: "send-2" },
      });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "INVOICE",
        refId: "inv-42",
      });

      expect(result).toBe("send-2");
      expect(update.mock.calls[0][0].data.convertedType).toBe("INVOICE");
      expect(update.mock.calls[0][0].data.convertedRefId).toBe("inv-42");
    });
  });

  describe("findFirst query shape", () => {
    it("scopes by patientId, filters convertedAt:null, requires clickedAt within window", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const beforeCall = Date.now();
      await recordCampaignConversion(prisma, {
        patientId: "pat-xyz",
        type: "APPOINTMENT",
        refId: "appt-1",
      });
      const afterCall = Date.now();

      expect(findFirst).toHaveBeenCalledTimes(1);
      const args = findFirst.mock.calls[0][0];
      expect(args.where.patientId).toBe("pat-xyz");
      expect(args.where.convertedAt).toBeNull();
      expect(args.where.clickedAt.not).toBeNull();
      // Default window is 7 days — `gte` must fall in [now-7d, now-7d]
      // bracketed by beforeCall/afterCall.
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const gteMs = (args.where.clickedAt.gte as Date).getTime();
      expect(gteMs).toBeGreaterThanOrEqual(beforeCall - sevenDaysMs);
      expect(gteMs).toBeLessThanOrEqual(afterCall - sevenDaysMs);
    });

    it('orders by clickedAt desc so "most recent click wins" (last-touch attribution)', async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: { id: "send-most-recent" } });

      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      const args = findFirst.mock.calls[0][0];
      expect(args.orderBy).toEqual({ clickedAt: "desc" });
    });

    it("only selects the id (no over-fetch)", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(findFirst.mock.calls[0][0].select).toEqual({ id: true });
    });
  });

  describe("no-op paths", () => {
    it("returns null and does not call update when no eligible CampaignSend exists", async () => {
      const { prisma, findFirst, update } = makePrismaMock({ findFirstResult: null });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(result).toBeNull();
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    });

    it("treats already-CONVERTED rows as ineligible via where:{convertedAt:null} (no update fired)", async () => {
      // Simulate the DB behavior: an already-CONVERTED send fails the
      // `convertedAt: null` filter, so findFirst returns null.
      const { prisma, findFirst, update } = makePrismaMock({ findFirstResult: null });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(result).toBeNull();
      expect(update).not.toHaveBeenCalled();
      // Verify the filter is in place (defense-in-depth assertion).
      expect(findFirst.mock.calls[0][0].where.convertedAt).toBeNull();
    });

    it("treats stale clicks (older than the 7-day window) as ineligible — earliest gte filter excludes them", async () => {
      // The handler builds a `gte: now-7d` bound; simulating "stale only"
      // means findFirst returns null because nothing matched.
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(result).toBeNull();
      // The `gte` boundary must be set (not undefined) — that's the stale-cutoff.
      expect(findFirst.mock.calls[0][0].where.clickedAt.gte).toBeInstanceOf(Date);
    });
  });

  describe("windowDays parameter", () => {
    it("honors a custom positive windowDays override", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const beforeCall = Date.now();
      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
        windowDays: 30,
      });
      const afterCall = Date.now();

      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const gteMs = (findFirst.mock.calls[0][0].where.clickedAt.gte as Date).getTime();
      expect(gteMs).toBeGreaterThanOrEqual(beforeCall - thirtyDaysMs);
      expect(gteMs).toBeLessThanOrEqual(afterCall - thirtyDaysMs);
    });

    it("accepts windowDays:0 (same-moment-only attribution) — gte becomes ~now", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const beforeCall = Date.now();
      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
        windowDays: 0,
      });
      const afterCall = Date.now();

      const gteMs = (findFirst.mock.calls[0][0].where.clickedAt.gte as Date).getTime();
      // windowMs = 0 → earliest = new Date(now) — must fall in the call window.
      expect(gteMs).toBeGreaterThanOrEqual(beforeCall);
      expect(gteMs).toBeLessThanOrEqual(afterCall);
    });

    it("ignores negative windowDays and falls back to the 7-day default", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const beforeCall = Date.now();
      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
        windowDays: -5,
      });
      const afterCall = Date.now();

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const gteMs = (findFirst.mock.calls[0][0].where.clickedAt.gte as Date).getTime();
      expect(gteMs).toBeGreaterThanOrEqual(beforeCall - sevenDaysMs);
      expect(gteMs).toBeLessThanOrEqual(afterCall - sevenDaysMs);
    });

    it("ignores non-number windowDays (undefined → default 7d)", async () => {
      const { prisma, findFirst } = makePrismaMock({ findFirstResult: null });

      const beforeCall = Date.now();
      await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
        // windowDays omitted on purpose
      });
      const afterCall = Date.now();

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const gteMs = (findFirst.mock.calls[0][0].where.clickedAt.gte as Date).getTime();
      expect(gteMs).toBeGreaterThanOrEqual(beforeCall - sevenDaysMs);
      expect(gteMs).toBeLessThanOrEqual(afterCall - sevenDaysMs);
    });
  });

  describe("error swallowing (fire-and-forget contract)", () => {
    it("swallows findFirst DB errors, logs to console.error, returns null", async () => {
      const { prisma } = makePrismaMock({
        findFirstError: new Error("db: connection lost"),
      });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        "[recordCampaignConversion] failed",
        expect.any(Error),
      );
    });

    it("swallows update DB errors, logs to console.error, returns null", async () => {
      const { prisma, update } = makePrismaMock({
        findFirstResult: { id: "send-1" },
        updateError: new Error("db: unique constraint"),
      });

      const result = await recordCampaignConversion(prisma, {
        patientId: "pat-1",
        type: "APPOINTMENT",
        refId: "appt-1",
      });

      expect(result).toBeNull();
      expect(update).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        "[recordCampaignConversion] failed",
        expect.any(Error),
      );
    });

    it("never throws — caller can treat it strictly as fire-and-forget", async () => {
      const { prisma } = makePrismaMock({
        findFirstError: new Error("anything"),
      });

      await expect(
        recordCampaignConversion(prisma, {
          patientId: "pat-1",
          type: "APPOINTMENT",
          refId: "appt-1",
        }),
      ).resolves.not.toThrow();
    });
  });
});
