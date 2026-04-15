// Integration tests for shifts + leaves routers (HR).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture, createShiftFixture } from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;
let nurseUser: any;

describeIfDB("HR (shifts + leaves) API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
    const prisma = await getPrisma();
    nurseUser = await prisma.user.findUnique({
      where: { email: "nurse@test.local" },
    });
  });

  // ─── SHIFTS ──────────────────────────────────────────
  it("creates a single shift (admin)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date: today,
        type: "MORNING",
        startTime: "08:00",
        endTime: "16:00",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.type).toBe("MORNING");
  });

  it("bulk-assigns shifts (admin)", async () => {
    const user1 = await createUserFixture({ role: "NURSE" });
    const user2 = await createUserFixture({ role: "NURSE" });
    const date = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/shifts/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        shifts: [
          {
            userId: user1.id,
            date,
            type: "MORNING",
            startTime: "08:00",
            endTime: "16:00",
          },
          {
            userId: user2.id,
            date,
            type: "MORNING",
            startTime: "08:00",
            endTime: "16:00",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.created?.length).toBeGreaterThanOrEqual(1);
  });

  it("lists shifts (admin)", async () => {
    const res = await request(app)
      .get("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("checks in on shift", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}/check-in`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
  });

  it("rejects duplicate shift creation (409)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const date = new Date().toISOString().slice(0, 10);
    await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date,
        type: "NIGHT",
        startTime: "22:00",
        endTime: "06:00",
      });
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date,
        type: "NIGHT",
        startTime: "22:00",
        endTime: "06:00",
      });
    expect([400, 409]).toContain(res.status);
  });

  // ─── LEAVES ──────────────────────────────────────────
  it("creates a leave request", async () => {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 2);
    const res = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        type: "CASUAL",
        fromDate: from.toISOString().slice(0, 10),
        toDate: to.toISOString().slice(0, 10),
        reason: "Family event",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.totalDays).toBeGreaterThanOrEqual(1);
    expect(res.body.data?.status).toBe("PENDING");
  });

  it("lists pending leaves (admin)", async () => {
    const res = await request(app)
      .get("/api/v1/leaves/pending")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("approves a leave request", async () => {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 1);
    const createRes = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        type: "SICK",
        fromDate: from.toISOString().slice(0, 10),
        toDate: to.toISOString().slice(0, 10),
        reason: "Fever",
      });
    const leaveId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/leaves/${leaveId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("APPROVED");
  });

  it("rejects a leave with reason", async () => {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 3);
    const createRes = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        type: "CASUAL",
        fromDate: from.toISOString().slice(0, 10),
        toDate: to.toISOString().slice(0, 10),
        reason: "Personal",
      });
    const leaveId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/leaves/${leaveId}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rejectionReason: "Staffing shortage" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("REJECTED");
    expect(res.body.data?.rejectionReason).toBe("Staffing shortage");
  });

  it("returns leave balance", async () => {
    const res = await request(app)
      .get("/api/v1/leaves/balance")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated leave list", async () => {
    const res = await request(app).get("/api/v1/leaves");
    expect(res.status).toBe(401);
  });

  it("rejects malformed leave payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ type: "WRONG" });
    expect(res.status).toBe(400);
  });
});
