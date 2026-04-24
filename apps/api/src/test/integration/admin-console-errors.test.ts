// Regression for issue #8 — Admin Console's "System Health → Errors (1h)"
// card was reading the total count of audit-log entries in the last hour,
// which includes every successful login, CRUD write, etc., inflating the
// reported "errors" figure (19 in the filed report).
//
// The fix filters by `action=LOGIN_FAILED` (the only error-style audit
// action in the codebase today). This test asserts that on a freshly reset
// DB, where no LOGIN_FAILED events have been recorded, the filtered count
// is 0 while the unfiltered total is > 0.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;

describeIfDB("Admin Console errors (regression #8)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;

    // Seed a few benign audit events so the *total* count is > 0 and the
    // old (buggy) query would have reported them as errors.
    const prisma = await getPrisma();
    const admin = await prisma.user.findUnique({
      where: { email: "admin@test.local" },
    });
    const benign = [
      "AUTH_LOGIN",
      "PATIENT_CREATE",
      "APPOINTMENT_CREATE",
      "BED_STATUS_UPDATE",
      "PAYMENT_RECEIVED",
    ];
    for (const action of benign) {
      await prisma.auditLog.create({
        data: {
          userId: admin?.id,
          action,
          entity: "test",
          entityId: null,
          details: { seeded: true } as any,
          ipAddress: "127.0.0.1",
        },
      });
    }
  });

  it("total audit events in last hour > 0 (sanity check on benign seed)", async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app)
      .get(`/api/v1/audit?from=${encodeURIComponent(hourAgo)}&limit=1`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // The benign seed above produced several audit rows.
    expect(res.body.meta?.total).toBeGreaterThan(0);
  });

  it("filtered error count in last hour is 0 on a fresh DB (baseline)", async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app)
      .get(
        `/api/v1/audit?from=${encodeURIComponent(hourAgo)}&action=LOGIN_FAILED&limit=1`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.meta?.total).toBe(0);
  });

  it("filtered error count reflects newly added LOGIN_FAILED rows", async () => {
    const prisma = await getPrisma();
    const admin = await prisma.user.findUnique({
      where: { email: "admin@test.local" },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.auditLog.create({
        data: {
          userId: admin?.id,
          action: "LOGIN_FAILED",
          entity: "user",
          entityId: admin?.id,
          details: { reason: "bad password" } as any,
          ipAddress: "10.0.0.99",
        },
      });
    }
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app)
      .get(
        `/api/v1/audit?from=${encodeURIComponent(hourAgo)}&action=LOGIN_FAILED&limit=1`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.meta?.total).toBe(3);
  });
});
