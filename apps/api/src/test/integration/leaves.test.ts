// Integration tests for the leaves router (balance, calendar, letter, cancel).
// Note: basic create/list/approve/reject paths are covered in hr.test.ts.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture } from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;
let nurseUser: any;

describeIfDB("Leaves API (integration)", () => {
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

  async function createLeave(token: string, override: Partial<any> = {}) {
    const from = override.fromDate || new Date();
    const to = override.toDate || new Date(Date.now() + 86400000);
    return request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: override.type || "CASUAL",
        fromDate: from.toISOString().slice(0, 10),
        toDate: to.toISOString().slice(0, 10),
        reason: override.reason || "Personal",
      });
  }

  it("creates a leave request (happy path)", async () => {
    const res = await createLeave(nurseToken);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("PENDING");
    expect(res.body.data?.totalDays).toBeGreaterThanOrEqual(1);
  });

  it("lists my leaves via /my with yearly summary", async () => {
    await createLeave(nurseToken);
    const res = await request(app)
      .get("/api/v1/leaves/my")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.summary).toBeTruthy();
    expect(Array.isArray(res.body.data?.leaves)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/leaves");
    expect(res.status).toBe(401);
  });

  it("rejects malformed payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ type: "INVALID" });
    expect(res.status).toBe(400);
  });

  it("returns leave balance with defaults for all types", async () => {
    const res = await request(app)
      .get("/api/v1/leaves/balance")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    const types = res.body.data?.balances?.map((b: any) => b.type);
    expect(types).toContain("CASUAL");
    expect(types).toContain("SICK");
  });

  it("admin upserts a leave balance (side-effect persisted)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .post("/api/v1/leaves/balance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        type: "CASUAL",
        year: 2026,
        entitled: 15,
        carried: 2,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.entitled).toBe(15);
  });

  it("non-admin cannot upsert balance (403)", async () => {
    const res = await request(app)
      .post("/api/v1/leaves/balance")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: nurseUser.id,
        type: "CASUAL",
        year: 2026,
        entitled: 20,
      });
    expect(res.status).toBe(403);
  });

  it("calendar returns APPROVED leaves in window", async () => {
    const res = await request(app)
      .get("/api/v1/leaves/calendar")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.leaves).toBeTruthy();
  });

  it("owner cancels own PENDING leave request (status -> CANCELLED)", async () => {
    const create = await createLeave(nurseToken, { reason: "maybe" });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/leaves/${id}/cancel`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("cannot cancel another user's leave (403)", async () => {
    // Second nurse (new user) creates a leave; first nurse tries to cancel it
    const other = await createUserFixture({ role: "NURSE" });
    const prisma = await getPrisma();
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: other.id,
        type: "CASUAL",
        fromDate: new Date(),
        toDate: new Date(Date.now() + 86400000),
        totalDays: 2,
        reason: "x",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/cancel`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("cannot cancel a non-PENDING leave (400)", async () => {
    const prisma = await getPrisma();
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: nurseUser.id,
        type: "CASUAL",
        fromDate: new Date(),
        toDate: new Date(Date.now() + 86400000),
        totalDays: 2,
        reason: "already approved",
        status: "APPROVED",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/cancel`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("letter endpoint 404s on unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/leaves/00000000-0000-0000-0000-000000000000/letter")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // Regression: issue #19 / #32 — the nurse-facing leave form previously
  // accepted a reversed range (To earlier than From) and the backend
  // silently persisted it. Now the Zod schema refines this and the
  // error is keyed to the `toDate` field so the UI can render it inline.
  it("rejects reversed date range with a toDate field-level error (issue #19)", async () => {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86_400_000);
    const res = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        type: "CASUAL",
        // Swapped: fromDate is LATER than toDate.
        fromDate: tomorrow.toISOString().slice(0, 10),
        toDate: today.toISOString().slice(0, 10),
        reason: "Reversed range should fail",
      });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
    const toDateIssue = res.body.details.find(
      (d: { field: string }) => d.field === "toDate"
    );
    expect(toDateIssue).toBeTruthy();
    expect(String(toDateIssue.message).toLowerCase()).toMatch(/on or after/);
  });

  it("accepts a single-day range (fromDate === toDate) as valid", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/leaves")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        type: "CASUAL",
        fromDate: today,
        toDate: today,
        reason: "One-day leave",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.totalDays).toBe(1);
  });
});
