// Pearl Stage-1 verification audit fix-up #3 (2026-05-25) — integration
// coverage that every Stage-2 paid surface wired in this tick actually
// honours its tenant feature flag. Companion to the per-route coverage in
// ai-fraud-feature-flag.test.ts + surgery-feature-flag.test.ts + implants.test.ts.
//
// Modules: middleware/feature-flag.ts (requireFeature gate),
//   routes/{hl7v2,ai-coaching,ai-followup,ai-capacity,ai-roster,ai-scribe,
//   ai-predictions,hr-ops,leaves,expenses}.ts (the gated routers),
//   services/feature-flags.ts (cache + resolution).
//
// Contract per flag:
//   (a) tenant with flag=true (or unset → default true) → non-404 response on
//       a representative endpoint (any handler-level status is fine; we only
//       care that the gate let the request through),
//   (b) tenant with flag=false → 404 with the canonical error shape.
//
// Test runs a minimal Express app per route so each gate is exercised in
// isolation against the same admin token / tenant. resetDB + cache reset in
// beforeAll bring us to a known state; afterAll re-resets the flag cache so
// subsequent test files don't see stale resolution.
import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";
import type { FeatureKey } from "@medcore/shared";

interface RouteProbe {
  flag: FeatureKey;
  mountPath: string;
  importRouter: () => Promise<express.Router>;
  // representative endpoint that requires no body fixture — typically the
  // shallowest GET. Doesn't need to succeed at the handler level; we only
  // assert the gate's verdict (200/4xx/5xx ≠ 404 vs ===404).
  probeMethod: "get" | "post";
  probePath: string;
  // when probeMethod === "post", payload sent (kept minimal — handler may
  // reject it 400, that's still "gate let it through" → not 404).
  probeBody?: Record<string, unknown>;
}

const ROUTES: RouteProbe[] = [
  {
    // Probes POST /inbound with no body. Avoid GET /patient/:id /
    // GET /lab-order/:id — those handlers `sendError(res, 404, …)` when
    // the row doesn't exist, which is indistinguishable from the gate's
    // 404 and causes the "flag=true → non-404" assertion to flake even
    // when the gate is wired correctly. POST /inbound on an empty body
    // returns 415 (unsupported content-type) — clearly non-404 — so the
    // gate's verdict is the only way the response can be 404.
    flag: "hl7Inbound",
    mountPath: "/api/v1/hl7v2",
    importRouter: async () => (await import("../../routes/hl7v2")).hl7v2Router,
    probeMethod: "post",
    probePath: "/inbound",
  },
  {
    flag: "aiCoaching",
    mountPath: "/api/v1/ai/coaching",
    importRouter: async () => (await import("../../routes/ai-coaching")).aiCoachingRouter,
    probeMethod: "get",
    probePath: "/plans/00000000-0000-0000-0000-000000000000",
  },
  {
    flag: "aiFollowup",
    mountPath: "/api/v1/ai/followup",
    importRouter: async () => (await import("../../routes/ai-followup")).aiFollowupRouter,
    probeMethod: "get",
    probePath: "/consultations",
  },
  {
    flag: "aiCapacity",
    mountPath: "/api/v1/ai/capacity",
    importRouter: async () => (await import("../../routes/ai-capacity")).aiCapacityRouter,
    probeMethod: "get",
    probePath: "/beds?horizon=24",
  },
  {
    flag: "aiRoster",
    mountPath: "/api/v1/ai/roster",
    importRouter: async () => (await import("../../routes/ai-roster")).aiRosterRouter,
    probeMethod: "get",
    probePath: "/history",
  },
  {
    flag: "voiceRx",
    mountPath: "/api/v1/ai/scribe",
    importRouter: async () => (await import("../../routes/ai-scribe")).aiScribeRouter,
    probeMethod: "get",
    probePath: "/",
  },
  {
    flag: "predictiveCds",
    mountPath: "/api/v1/ai/predictions",
    importRouter: async () => (await import("../../routes/ai-predictions")).aiPredictionsRouter,
    probeMethod: "get",
    probePath: "/no-show/batch?date=2026-05-25",
  },
  {
    flag: "hrmsPayroll",
    mountPath: "/api/v1/hr-ops",
    importRouter: async () => (await import("../../routes/hr-ops")).hrOpsRouter,
    probeMethod: "get",
    probePath: "/holidays",
  },
  {
    flag: "hrmsPayroll",
    mountPath: "/api/v1/leaves",
    importRouter: async () => (await import("../../routes/leaves")).leaveRouter,
    probeMethod: "get",
    probePath: "/my",
  },
  {
    flag: "hrmsPayroll",
    mountPath: "/api/v1/expenses",
    importRouter: async () => (await import("../../routes/expenses")).expenseRouter,
    probeMethod: "get",
    probePath: "/",
  },
];

async function buildAppFor(route: RouteProbe): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  // Mount the tenant context resolver BEFORE the gated router. Without it,
  // `req.tenantId` stays undefined and `isFeatureEnabled(undefined, …)`
  // short-circuits to `true` (see services/feature-flags.ts:54) — every
  // request slips past the gate and the test sees 200 where 404 was
  // expected. The full app wires this in app.ts; the per-route mini-app
  // here must do the same.
  //
  // CodeQL false-positive note: `js/missing-rate-limiting` flags this
  // because the production router we mount carries `authorize(...)` calls
  // and the test app does not also mount rate-limiting. Rate limiting in a
  // throw-away vitest fixture that never binds to a port and never accepts
  // real traffic serves no security purpose; production rate limiting
  // lives in app.ts where it actually matters.
  const { tenantContextMiddleware } = await import("../../middleware/tenant");
  app.use(tenantContextMiddleware); // lgtm[js/missing-rate-limiting]
  app.use(route.mountPath, await route.importRouter());
  const { errorHandler } = await import("../../middleware/error");
  app.use(errorHandler);
  return app;
}

let adminToken: string;
let tenantId: string;

async function setFlag(flag: FeatureKey, value: boolean): Promise<void> {
  const prisma = await getPrisma();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const existing =
    (tenant.featureFlags as Record<string, unknown> | null) ?? {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { featureFlags: { ...existing, [flag]: value } },
  });
  __resetFeatureFlagsCacheForTests();
}

describeIfDB("Stage-2 feature-flag coverage (Pearl audit fix-up #3 — 2026-05-25)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();
    const prisma = await getPrisma();
    let tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
      });
    }
    tenantId = tenant.id;
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: tenant.id },
    });
    adminToken = await getAuthToken("ADMIN");
  });

  afterAll(async () => {
    __resetFeatureFlagsCacheForTests();
    // Restore default-true state so later test files don't see lingering
    // false overrides on shared tenant row.
    const prisma = await getPrisma();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { featureFlags: {} },
    });
    __resetFeatureFlagsCacheForTests();
  });

  for (const route of ROUTES) {
    const label = `${route.mountPath} (${route.flag})`;

    it(`${label}: returns non-404 when ${route.flag}=true (gate lets request through)`, async () => {
      await setFlag(route.flag, true);
      const app = await buildAppFor(route);
      const req = request(app)[route.probeMethod](route.mountPath + route.probePath).set(
        "Authorization",
        `Bearer ${adminToken}`,
      );
      const res = route.probeBody ? await req.send(route.probeBody) : await req;
      // Handler-level status may be 200/400/403/422/500 etc. — anything other
      // than 404 proves the requireFeature gate passed. 404 here would mean
      // the gate rejected against the flag=true tenant: a real regression.
      expect(res.status).not.toBe(404);
    });

    it(`${label}: returns 404 with canonical error envelope when ${route.flag}=false`, async () => {
      await setFlag(route.flag, false);
      const app = await buildAppFor(route);
      const req = request(app)[route.probeMethod](route.mountPath + route.probePath).set(
        "Authorization",
        `Bearer ${adminToken}`,
      );
      const res = route.probeBody ? await req.send(route.probeBody) : await req;
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: "Not found" });
    });
  }
});
