/**
 * Test-cron tick (2026-05-25) — feature-flag middleware tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pin the runtime contract of `requireFeature(key)` — the Express
 *   middleware (Pearl ERP Stage 1 §6 + §18, gap item #9) that gates routes
 *   on the per-tenant feature flag map. Covers every branch:
 *     - flag enabled → `next()` (no res write, no error)
 *     - flag disabled → 404 + canonical `{success:false, data:null, error}`
 *       envelope, `next()` NOT called
 *     - missing tenantId (single-tenant deploy / legacy path) → enabled by
 *       default per `isFeatureEnabled` contract → `next()` called
 *     - unknown / arbitrary flag key against an undefined flag map →
 *       enabled by default → `next()` called
 *     - `isFeatureEnabled` throws → forward to `next(err)` so the global
 *       error handler returns 500, NOT a silent 404
 *
 * - MODULES: hoisted mock of `../services/feature-flags` (the middleware's
 *   only external dep). Pure-unit — no Postgres, no Prisma, no shared
 *   in-process LRU. The shared resolver (`@medcore/shared`) is also stubbed
 *   in case the mocked module transitively pulls it.
 *
 * - WHY: this middleware is the SINGLE chokepoint that hides Pearl-excluded
 *   surfaces (IPD, OT, telemedicine, voiceRx, …) from disabled tenants.
 *   A regression that (a) returns 403 instead of 404, (b) leaks a different
 *   envelope shape, or (c) calls `next()` on a disabled feature, re-opens
 *   the surface to a tenant that explicitly turned it off — direct PRD
 *   compliance break. 404-not-403 is intentional: a Pearl tenant should
 *   not even learn the route exists.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isFeatureEnabledMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
}));

vi.mock("../services/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// `@medcore/shared` is only used for the `FeatureKey` type by the middleware,
// but the service module the middleware imports pulls runtime symbols from
// it. Stub a minimal surface so the mocked module loads cleanly.
vi.mock("@medcore/shared", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@medcore/shared",
  );
  return actual;
});

import { requireFeature } from "./feature-flag";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(tenantId: string | undefined): any {
  return { tenantId } as any;
}

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
});

// ─── Enabled flag → next() ────────────────────────────────────────────────

describe("requireFeature — flag enabled on tenant", () => {
  it("calls next() with no arguments when the feature is enabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq("tenant-a");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("does NOT write a response when the feature is enabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq("tenant-a");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("telemedicine");
    await mw(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("forwards the supplied tenantId and key into isFeatureEnabled verbatim", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq("tenant-pearl-pilot");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ot");
    await mw(req, res, next);

    expect(isFeatureEnabledMock).toHaveBeenCalledTimes(1);
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "tenant-pearl-pilot",
      "ot",
    );
  });
});

// ─── Disabled flag → 404 + canonical envelope ─────────────────────────────

describe("requireFeature — flag disabled on tenant (Pearl exclusion)", () => {
  it("writes 404 (NOT 403) when the feature is disabled", async () => {
    // 404 vs 403 is intentional per the source comment: a Pearl-branded
    // tenant should not even learn the route exists.
    isFeatureEnabledMock.mockResolvedValue(false);
    const req = makeReq("tenant-pearl");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("writes the canonical {success:false, data:null, error} envelope on disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const req = makeReq("tenant-pearl");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("voiceRx");
    await mw(req, res, next);

    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: "Not found",
    });
  });

  it("does NOT call next() when the feature is disabled (gate must terminate the chain)", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const req = makeReq("tenant-pearl");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("returns once the 404 envelope is written (short-circuits before next())", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const req = makeReq("tenant-pearl");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("aiRadiology");
    const result = await mw(req, res, next);

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Missing tenant context (single-tenant / legacy) ──────────────────────

describe("requireFeature — missing tenant context", () => {
  it("calls next() when req.tenantId is undefined (isFeatureEnabled returns true by contract)", async () => {
    // The resolver returns true when tenantId is falsy (single-tenant
    // deploy / legacy path). Pin that the middleware respects that
    // contract and never 404s a tenantless request.
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("forwards undefined tenantId into the resolver (does not invent a fallback)", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("hl7Inbound");
    await mw(req, res, next);

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(undefined, "hl7Inbound");
  });

  it("404s when tenantId is undefined but the resolver still returns false (defence-in-depth)", async () => {
    // If a future refactor makes the resolver stricter, the middleware
    // must still honour the false verdict and 404 — it doesn't second-
    // guess the resolver.
    isFeatureEnabledMock.mockResolvedValue(false);
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Arbitrary/unknown flag key (delegated to resolver) ───────────────────

describe("requireFeature — arbitrary flag key delegated to resolver", () => {
  it("passes the key through unchanged regardless of value (no client-side allowlist)", async () => {
    // The middleware does not maintain its own list of valid keys — that
    // is the resolver's job. So an unknown key follows whatever the
    // resolver returns (true → next, false → 404).
    isFeatureEnabledMock.mockResolvedValue(true);
    const req = makeReq("tenant-a");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("nabhDashboard");
    await mw(req, res, next);

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "tenant-a",
      "nabhDashboard",
    );
    expect(next).toHaveBeenCalledWith();
  });
});

// ─── Resolver errors → next(err) ──────────────────────────────────────────

describe("requireFeature — resolver errors propagate to next(err)", () => {
  it("forwards a thrown error to next(err) instead of 404ing", async () => {
    // A DB blip in the resolver must NOT silently 404 — that would hide
    // the outage AND wrongly tell the tenant the feature doesn't exist.
    const dbError = new Error("Postgres connection refused");
    isFeatureEnabledMock.mockRejectedValue(dbError);
    const req = makeReq("tenant-a");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ipd");
    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("does NOT swallow the error (no 200 / no 404 on resolver failure)", async () => {
    isFeatureEnabledMock.mockRejectedValue(new Error("boom"));
    const req = makeReq("tenant-a");
    const res = makeRes();
    const next = vi.fn();

    const mw = requireFeature("ot");
    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── Factory shape contract ───────────────────────────────────────────────

describe("requireFeature — factory returns an Express-shaped middleware", () => {
  it("returns a function with arity 3 (req, res, next)", () => {
    const mw = requireFeature("ipd");
    expect(typeof mw).toBe("function");
    expect(mw.length).toBe(3);
  });

  it("each call returns an independent middleware instance", () => {
    const mw1 = requireFeature("ipd");
    const mw2 = requireFeature("ipd");
    expect(mw1).not.toBe(mw2);
  });
});
