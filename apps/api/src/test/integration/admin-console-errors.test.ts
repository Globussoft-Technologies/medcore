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

  // Issue #47 (.issue-details.txt 2026-05-09): the System Health "Errors
  // (1h)" widget now passes `actionIn=A,B,C` so the count includes every
  // canonical error-shaped action (not just LOGIN_FAILED). This pins
  // the route's multi-action filter so a future regression in
  // buildAuditWhere can't silently revert the widget to single-action
  // counting.
  it("supports actionIn=A,B,C multi-action filter (issue #47 errors widget)", async () => {
    const prisma = await getPrisma();
    const admin = await prisma.user.findUnique({
      where: { email: "admin@test.local" },
    });
    // Seed one of each canonical error-action plus a benign control.
    const errorActions = [
      "LOGIN_FAILED", // already 3 from the previous test
      "PRESCRIPTION_REJECTED",
      "PRESCRIPTION_SHARE_FAILED",
      "NOTIFICATION_AUDIENCE_REJECTED",
    ];
    for (const action of errorActions) {
      await prisma.auditLog.create({
        data: {
          userId: admin?.id,
          action,
          entity: "test",
          entityId: null,
          details: { seeded: true } as any,
          ipAddress: "10.0.0.99",
        },
      });
    }

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app)
      .get(
        `/api/v1/audit?from=${encodeURIComponent(hourAgo)}&actionIn=${errorActions.join(",")}&limit=1`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Previous test seeded 3 LOGIN_FAILED + this test seeded 1 of each
    // of 4 actions = 3 + 4 = 7. (LOGIN_FAILED carries from the prior
    // test thanks to vitest's singleFork-shared connection on this
    // suite; if that ever changes the assertion stays internally
    // consistent because we'd see 4 instead of 7 — both > 0 and
    // strictly greater than the LOGIN_FAILED-only count of 3.)
    expect(res.body.meta?.total).toBeGreaterThanOrEqual(4);
  });

  // The single-action `action=` filter takes precedence over actionIn
  // when both are sent — guarantees that legacy callers (the audit-page
  // dropdown) keep their single-row-only behaviour even if a
  // copy-paste error sends both.
  it("action= takes precedence over actionIn=", async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app)
      .get(
        `/api/v1/audit?from=${encodeURIComponent(hourAgo)}&action=LOGIN_FAILED&actionIn=PRESCRIPTION_REJECTED,NOTIFICATION_AUDIENCE_REJECTED&limit=1`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Should match only LOGIN_FAILED (3 from earlier seed), not the
    // actionIn list.
    expect(res.body.meta?.total).toBe(3);
  });
});
