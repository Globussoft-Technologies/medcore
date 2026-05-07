// Integration tests for the canonical Visitors-Today KPI endpoint
// introduced for Issue #746. The admin-console card, /dashboard/visitors
// stats tile, and the reports page all consume this endpoint so they can
// never disagree on what "today" means. The test pins:
//
//   - "today" is anchored to Asia/Kolkata, NOT the server's host TZ. A
//     visitor that checked in at IST midnight + 1 minute is counted as
//     today even when the host runs in UTC.
//   - currentlyActive is a strict subset of totalToday (Inside ⊆ Today).
//   - byPurpose buckets sum to totalToday for the seeded fixtures.
//   - non-staff roles are denied (mirrors /api/v1/visitors authorize set).

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;
let patientToken: string;

describeIfDB("Issue #746 — /api/v1/visitors-stats canonical KPI", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns today's count + active subset with IST day anchor", async () => {
    const prisma = await getPrisma();
    // Seed three visitors that check in just after IST midnight today.
    // We compute the IST-day window the same way the route does so the
    // test pins the contract regardless of the host TZ.
    const IST_OFFSET_MIN = 5 * 60 + 30;
    const now = new Date();
    const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
    const startUTC = new Date(
      Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate(),
        0,
        0,
        0,
        0
      ) -
        IST_OFFSET_MIN * 60 * 1000
    );
    const justAfterIstMidnight = new Date(startUTC.getTime() + 60 * 1000);

    await prisma.visitor.create({
      data: {
        passNumber: `VIS_TEST_${Date.now()}_1`,
        name: "Today Visitor 1",
        purpose: "PATIENT_VISIT",
        checkInAt: justAfterIstMidnight,
        checkOutAt: null,
      },
    });
    await prisma.visitor.create({
      data: {
        passNumber: `VIS_TEST_${Date.now()}_2`,
        name: "Today Visitor 2",
        purpose: "DELIVERY",
        checkInAt: justAfterIstMidnight,
        // already checked out — counts toward totalToday but not active.
        checkOutAt: new Date(justAfterIstMidnight.getTime() + 30 * 60 * 1000),
      },
    });

    const res = await request(app)
      .get("/api/v1/visitors-stats?period=today")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data?.timezone).toBe("Asia/Kolkata");
    expect(typeof res.body.data?.totalToday).toBe("number");
    expect(typeof res.body.data?.currentlyActive).toBe("number");
    expect(res.body.data.totalToday).toBeGreaterThanOrEqual(2);
    // Inside ⊆ Today: the route computes both from the same row set so
    // the active count can never exceed the total.
    expect(res.body.data.currentlyActive).toBeLessThanOrEqual(
      res.body.data.totalToday
    );
    // byPurpose buckets sum exactly to totalToday.
    const sum = Object.values(res.body.data.byPurpose as Record<string, number>).reduce(
      (a: number, b: number) => a + b,
      0
    );
    expect(sum).toBe(res.body.data.totalToday);
  });

  it("rejects PATIENT role (mirrors /api/v1/visitors authorize)", async () => {
    const res = await request(app)
      .get("/api/v1/visitors-stats?period=today")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated", async () => {
    const res = await request(app).get("/api/v1/visitors-stats?period=today");
    expect(res.status).toBe(401);
  });

  it("rejects unsupported period values with 400 (not 500)", async () => {
    const res = await request(app)
      .get("/api/v1/visitors-stats?period=last7days")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// Issue #744 — friendly tenant resolver for the dashboard chrome.
describeIfDB("Issue #744 — /api/v1/me/tenant friendly tenant resolver", () => {
  beforeAll(async () => {
    if (!app) {
      await resetDB();
      adminToken = await getAuthToken("ADMIN");
      const mod = await import("../../app");
      app = mod.app;
    } else if (!adminToken) {
      adminToken = await getAuthToken("ADMIN");
    }
  });

  it("returns 200 with tenant data when caller has a tenant", async () => {
    const prisma = await getPrisma();
    // Pin a tenant on the admin user so the resolver has something to load.
    const tenant = await prisma.tenant.upsert({
      where: { subdomain: "test-744" },
      update: {},
      create: {
        name: "Test Hospital 744",
        subdomain: "test-744",
        plan: "BASIC",
        active: true,
      },
    });
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: tenant.id },
    });
    // Re-mint token so the JWT carries the new tenantId claim.
    const tokenWithTenant = await getAuthToken("ADMIN");

    const res = await request(app)
      .get("/api/v1/me/tenant")
      .set("Authorization", `Bearer ${tokenWithTenant}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.name).toBe("Test Hospital 744");
    expect(res.body.data?.subdomain).toBe("test-744");
    // The raw `tenantId` UUID is still in the payload (callers may want
    // it for deep links), but the FRIENDLY fields are what the dashboard
    // chrome renders. Issue #744 was about presentation, not exposure.
    expect(res.body.data?.id).toBe(tenant.id);
  });

  it("rejects unauthenticated", async () => {
    const res = await request(app).get("/api/v1/me/tenant");
    expect(res.status).toBe(401);
  });
});
