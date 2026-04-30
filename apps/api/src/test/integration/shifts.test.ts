// Integration tests for the shifts router. Existing hr.test.ts touches a
// subset of these endpoints; this file is the dedicated, full-coverage suite
// for every handler in routes/shifts.ts.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture, createShiftFixture } from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;
let patientToken: string;
let nurseUser: any;

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

describeIfDB("Shifts API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
    const prisma = await getPrisma();
    nurseUser = await prisma.user.findUnique({
      where: { email: "nurse@test.local" },
    });
  });

  // ─── POST /shifts ────────────────────────────────────
  it("admin creates a single shift", async () => {
    const user = await createUserFixture({ role: "DOCTOR" });
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date: today(),
        type: "AFTERNOON",
        startTime: "14:00",
        endTime: "20:00",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.userId).toBe(user.id);
    expect(res.body.data?.type).toBe("AFTERNOON");
  });

  it("returns 404 when creating shift for unknown user", async () => {
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: "00000000-0000-0000-0000-000000000000",
        date: today(),
        type: "MORNING",
        startTime: "08:00",
        endTime: "16:00",
      });
    expect(res.status).toBe(404);
  });

  it("rejects POST /shifts without auth (401)", async () => {
    const res = await request(app).post("/api/v1/shifts").send({});
    expect(res.status).toBe(401);
  });

  it("rejects POST /shifts from non-admin (403)", async () => {
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: nurseUser.id,
        date: today(),
        type: "MORNING",
        startTime: "08:00",
        endTime: "16:00",
      });
    expect(res.status).toBe(403);
  });

  it("rejects POST /shifts with bad payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: "not-a-uuid", date: "yesterday" });
    expect(res.status).toBe(400);
  });

  // ─── POST /shifts/bulk ───────────────────────────────
  it("admin bulk-creates shifts (created + skipped split)", async () => {
    const u1 = await createUserFixture({ role: "RECEPTION" });
    const u2 = await createUserFixture({ role: "RECEPTION" });
    const res = await request(app)
      .post("/api/v1/shifts/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        shifts: [
          {
            userId: u1.id,
            date: today(),
            type: "MORNING",
            startTime: "08:00",
            endTime: "16:00",
          },
          {
            userId: u2.id,
            date: today(),
            type: "MORNING",
            startTime: "08:00",
            endTime: "16:00",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.created?.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data?.skipped)).toBe(true);
    expect(typeof res.body.meta?.createdCount).toBe("number");
  });

  it("rejects POST /shifts/bulk without auth (401)", async () => {
    const res = await request(app).post("/api/v1/shifts/bulk").send({ shifts: [] });
    expect(res.status).toBe(401);
  });

  it("rejects POST /shifts/bulk from non-admin (403)", async () => {
    const res = await request(app)
      .post("/api/v1/shifts/bulk")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ shifts: [] });
    expect(res.status).toBe(403);
  });

  it("rejects POST /shifts/bulk with empty array (400)", async () => {
    const res = await request(app)
      .post("/api/v1/shifts/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ shifts: [] });
    expect(res.status).toBe(400);
  });

  // ─── GET /shifts ─────────────────────────────────────
  it("admin lists all shifts (with pagination meta)", async () => {
    const res = await request(app)
      .get("/api/v1/shifts?page=1&limit=20")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(20);
  });

  it("non-admin can list shifts but only sees their own", async () => {
    // Seed one for the nurse + one for someone else
    const otherUser = await createUserFixture({ role: "DOCTOR" });
    await createShiftFixture({ userId: nurseUser.id });
    await createShiftFixture({ userId: otherUser.id });
    const res = await request(app)
      .get("/api/v1/shifts")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    for (const s of res.body.data) {
      expect(s.userId).toBe(nurseUser.id);
    }
  });

  it("rejects GET /shifts without auth (401)", async () => {
    const res = await request(app).get("/api/v1/shifts");
    expect(res.status).toBe(401);
  });

  // ─── GET /shifts/my ──────────────────────────────────
  it("returns the current user's shifts (next 14 days)", async () => {
    await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .get("/api/v1/shifts/my")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const s of res.body.data) {
      expect(s.userId).toBe(nurseUser.id);
    }
  });

  it("rejects GET /shifts/my without auth (401)", async () => {
    const res = await request(app).get("/api/v1/shifts/my");
    expect(res.status).toBe(401);
  });

  // ─── GET /shifts/staff ───────────────────────────────
  it("admin lists staff users", async () => {
    const res = await request(app)
      .get("/api/v1/shifts/staff")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Patients must NOT show up
    expect(res.body.data.find((u: any) => u.role === "PATIENT")).toBeFalsy();
  });

  it("rejects GET /shifts/staff without auth (401)", async () => {
    const res = await request(app).get("/api/v1/shifts/staff");
    expect(res.status).toBe(401);
  });

  it("rejects GET /shifts/staff from non-admin (403)", async () => {
    const res = await request(app)
      .get("/api/v1/shifts/staff")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /shifts/roster ──────────────────────────────
  it("admin gets roster grouped by shift type", async () => {
    await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .get(`/api/v1/shifts/roster?date=${today()}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.grouped).toBeTruthy();
    expect(res.body.data.grouped).toHaveProperty("MORNING");
    expect(res.body.data.grouped).toHaveProperty("AFTERNOON");
    expect(res.body.data.grouped).toHaveProperty("NIGHT");
    expect(res.body.data.grouped).toHaveProperty("ON_CALL");
  });

  it("returns 400 when /shifts/roster missing date param", async () => {
    const res = await request(app)
      .get("/api/v1/shifts/roster")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("rejects GET /shifts/roster without auth (401)", async () => {
    const res = await request(app).get(`/api/v1/shifts/roster?date=${today()}`);
    expect(res.status).toBe(401);
  });

  it("rejects GET /shifts/roster from PATIENT (403, Issue #174)", async () => {
    const res = await request(app)
      .get(`/api/v1/shifts/roster?date=${today()}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ─── PATCH /shifts/:id ───────────────────────────────
  it("admin updates a shift's notes/status", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "Swapped with colleague", status: "SCHEDULED" });
    expect(res.status).toBe(200);
    expect(res.body.data?.notes).toBe("Swapped with colleague");
  });

  it("returns 404 when patching unknown shift", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects PATCH /shifts/:id without auth (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000")
      .send({ notes: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects PATCH /shifts/:id from non-admin (403)", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ notes: "x" });
    expect(res.status).toBe(403);
  });

  // ─── PATCH /shifts/:id/check-in ──────────────────────
  it("user can check in to their own shift", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}/check-in`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(["PRESENT", "LATE"]).toContain(res.body.data?.status);
  });

  it("returns 404 when checking in to unknown shift", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000/check-in")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("rejects check-in by another user (403)", async () => {
    const otherUser = await createUserFixture({ role: "NURSE" });
    const shift = await createShiftFixture({ userId: otherUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}/check-in`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects check-in without auth (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000/check-in")
      .send({});
    expect(res.status).toBe(401);
  });

  // ─── PATCH /shifts/:id/check-out ─────────────────────
  it("user can check out of their own shift", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}/check-out`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ notes: "All good" });
    expect(res.status).toBe(200);
    expect(res.body.data?.notes).toMatch(/Checked out/);
  });

  it("returns 404 when checking out of unknown shift", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000/check-out")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("rejects check-out by another user (403)", async () => {
    const otherUser = await createUserFixture({ role: "DOCTOR" });
    const shift = await createShiftFixture({ userId: otherUser.id });
    const res = await request(app)
      .patch(`/api/v1/shifts/${shift.id}/check-out`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects check-out without auth (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/shifts/00000000-0000-0000-0000-000000000000/check-out")
      .send({});
    expect(res.status).toBe(401);
  });

  // ─── DELETE /shifts/:id ──────────────────────────────
  it("admin deletes a shift", async () => {
    const shift = await createShiftFixture({
      userId: nurseUser.id,
      overrides: { date: tomorrow() },
    });
    const res = await request(app)
      .delete(`/api/v1/shifts/${shift.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const row = await prisma.staffShift.findUnique({ where: { id: shift.id } });
    expect(row).toBeNull();
  });

  it("returns 404 when deleting unknown shift", async () => {
    const res = await request(app)
      .delete("/api/v1/shifts/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects DELETE /shifts/:id without auth (401)", async () => {
    const res = await request(app).delete(
      "/api/v1/shifts/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects DELETE /shifts/:id from non-admin (403)", async () => {
    const shift = await createShiftFixture({ userId: nurseUser.id });
    const res = await request(app)
      .delete(`/api/v1/shifts/${shift.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });
});
