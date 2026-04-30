// Integration tests for the scheduled-reports router (ADMIN-only CRUD over
// scheduled report definitions + history + manual run-now). The cron firing
// loop itself is exercised by the services tests; here we cover route handlers
// only.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

// Stub e-mail / notification side-effects of POST /:id/run-now so we don't
// touch a real SMTP/SendGrid sandbox during tests.
vi.mock("../../services/notification", async () => {
  const actual = await vi.importActual<typeof import("../../services/notification")>(
    "../../services/notification"
  );
  return {
    ...actual,
    sendEmail: vi.fn(async () => undefined),
    sendNotification: vi.fn(async () => undefined),
  };
});

let app: any;
let adminToken: string;
let receptionToken: string;

async function createSchedulePayload(overrides: Record<string, any> = {}) {
  return {
    name: overrides.name || `Daily Census ${Date.now()}`,
    reportType: overrides.reportType || "DAILY_CENSUS",
    frequency: overrides.frequency || "DAILY",
    timeOfDay: overrides.timeOfDay || "09:00",
    recipients: overrides.recipients || ["ops@hospital.test"],
    active: overrides.active ?? true,
    ...(overrides.dayOfWeek !== undefined ? { dayOfWeek: overrides.dayOfWeek } : {}),
    ...(overrides.dayOfMonth !== undefined ? { dayOfMonth: overrides.dayOfMonth } : {}),
    ...(overrides.config ? { config: overrides.config } : {}),
  };
}

async function createSchedule(token: string, overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/v1/scheduled-reports")
    .set("Authorization", `Bearer ${token}`)
    .send(await createSchedulePayload(overrides));
  expect([200, 201]).toContain(res.status);
  return res.body.data;
}

describeIfDB("Scheduled Reports API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /scheduled-reports ─────────────────────────
  it("creates a DAILY scheduled report (admin)", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(await createSchedulePayload({ name: "Acme Daily Census" }));
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.name).toBe("Acme Daily Census");
    expect(res.body.data?.frequency).toBe("DAILY");
    expect(res.body.data?.nextRunAt).toBeTruthy();
    expect(res.body.data?.active).toBe(true);
  });

  it("creates a WEEKLY scheduled report with dayOfWeek", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(
        await createSchedulePayload({
          name: "Weekly Revenue",
          reportType: "WEEKLY_REVENUE",
          frequency: "WEEKLY",
          dayOfWeek: 1,
          timeOfDay: "08:30",
        })
      );
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.dayOfWeek).toBe(1);
  });

  it("rejects POST with missing required fields (400)", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Broken", frequency: "DAILY" });
    expect(res.status).toBe(400);
  });

  it("rejects POST without auth (401)", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .send(await createSchedulePayload());
    expect(res.status).toBe(401);
  });

  it("rejects POST from non-admin role (403)", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send(await createSchedulePayload());
    expect(res.status).toBe(403);
  });

  // ─── GET /scheduled-reports ──────────────────────────
  it("lists scheduled reports", async () => {
    await createSchedule(adminToken);
    const res = await request(app)
      .get("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filters scheduled reports by active=true", async () => {
    const res = await request(app)
      .get("/api/v1/scheduled-reports?active=true")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const r of res.body.data) {
      expect(r.active).toBe(true);
    }
  });

  it("rejects GET / without auth (401)", async () => {
    const res = await request(app).get("/api/v1/scheduled-reports");
    expect(res.status).toBe(401);
  });

  it("rejects GET / from non-admin (403)", async () => {
    const res = await request(app)
      .get("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /scheduled-reports/runs ─────────────────────
  it("lists run history with pagination meta", async () => {
    const res = await request(app)
      .get("/api/v1/scheduled-reports/runs?page=1&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(10);
  });

  it("rejects GET /runs without auth (401)", async () => {
    const res = await request(app).get("/api/v1/scheduled-reports/runs");
    expect(res.status).toBe(401);
  });

  it("rejects GET /runs from non-admin (403)", async () => {
    const res = await request(app)
      .get("/api/v1/scheduled-reports/runs")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /scheduled-reports/:id ──────────────────────
  it("fetches one scheduled report by id (with runs)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .get(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(created.id);
    expect(Array.isArray(res.body.data?.runs)).toBe(true);
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects GET /:id without auth (401)", async () => {
    const res = await request(app).get(
      "/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects GET /:id from non-admin (403)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .get(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── PATCH /scheduled-reports/:id ────────────────────
  it("updates a scheduled report (name + recipients)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .patch(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Renamed Census",
        recipients: ["new@hospital.test", "ops@hospital.test"],
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.name).toBe("Renamed Census");
  });

  it("recomputes nextRunAt when frequency or schedule fields change", async () => {
    const created = await createSchedule(adminToken, { frequency: "DAILY", timeOfDay: "09:00" });
    const before = created.nextRunAt;
    const res = await request(app)
      .patch(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ frequency: "WEEKLY", dayOfWeek: 3, timeOfDay: "10:00" });
    expect(res.status).toBe(200);
    expect(res.body.data?.frequency).toBe("WEEKLY");
    // nextRunAt should have been recomputed (very likely a different timestamp)
    expect(res.body.data?.nextRunAt).toBeTruthy();
    expect(res.body.data?.nextRunAt).not.toBe(before);
  });

  it("returns 404 when patching unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects PATCH without auth (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000")
      .send({ name: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects PATCH from non-admin (403)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .patch(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "x" });
    expect(res.status).toBe(403);
  });

  // ─── DELETE /scheduled-reports/:id ───────────────────
  it("deletes a scheduled report", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .delete(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const row = await prisma.scheduledReport.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
  });

  it("rejects DELETE without auth (401)", async () => {
    const res = await request(app).delete(
      "/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects DELETE from non-admin (403)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .delete(`/api/v1/scheduled-reports/${created.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── POST /scheduled-reports/:id/run-now ─────────────
  it("runs a scheduled report on-demand (records a ReportRun)", async () => {
    const created = await createSchedule(adminToken, {
      reportType: "DAILY_CENSUS",
      name: "RunNow Census",
    });
    const res = await request(app)
      .post(`/api/v1/scheduled-reports/${created.id}/run-now`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBeDefined();
    expect(["SUCCESS", "FAILED"]).toContain(res.body.data?.status);
  });

  it("returns 404 when running unknown schedule id", async () => {
    const res = await request(app)
      .post("/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000/run-now")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects POST /run-now without auth (401)", async () => {
    const res = await request(app).post(
      "/api/v1/scheduled-reports/00000000-0000-0000-0000-000000000000/run-now"
    );
    expect(res.status).toBe(401);
  });

  it("rejects POST /run-now from non-admin (403)", async () => {
    const created = await createSchedule(adminToken);
    const res = await request(app)
      .post(`/api/v1/scheduled-reports/${created.id}/run-now`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });
});
