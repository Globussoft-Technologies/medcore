// Deep branch-coverage tests for hr-ops router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture, createShiftFixture } from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;
let doctorToken: string;

describeIfDB("HR-Ops API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("holiday create (ADMIN) + list filter by year", async () => {
    const create = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-08-15", name: "Independence Day" });
    expect(create.status).toBe(201);
    const list = await request(app)
      .get("/api/v1/hr-ops/holidays?year=2026")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((h: any) => h.name === "Independence Day")).toBe(
      true
    );
  });

  it("holiday create as NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ date: "2026-08-16", name: "X" });
    expect(res.status).toBe(403);
  });

  it("holiday create with malformed date (400)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "Aug 1", name: "X" });
    expect(res.status).toBe(400);
  });

  it("holiday delete round-trip", async () => {
    const c = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-10-02", name: "Gandhi Jayanti" });
    const del = await request(app)
      .delete(`/api/v1/hr-ops/holidays/${c.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
  });

  // Issue #73 — duplicate holidays on the same date must be rejected at the
  // application layer (the schema's @@unique([date, name]) is too lax).
  it("holiday duplicate on same date returns 409 (Issue #73)", async () => {
    const first = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-11-08", name: "Diwali" });
    expect(first.status).toBe(201);

    // Different name, same date — must 409.
    const second = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-11-08", name: "Lakshmi Puja" });
    expect(second.status).toBe(409);
    expect(String(second.body.error || "")).toMatch(/already exists/i);
  });

  it("attendance summary for self (non-admin) scoped to caller", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/attendance")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("workedDays");
    expect(res.body.data).toHaveProperty("leaveDays");
  });

  it("attendance summary counts PRESENT+LATE as worked", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const d1 = new Date();
    d1.setDate(1);
    await createShiftFixture({
      userId: user.id,
      overrides: { date: d1, status: "PRESENT" },
    });
    const d2 = new Date();
    d2.setDate(2);
    await createShiftFixture({
      userId: user.id,
      overrides: { date: d2, status: "LATE" },
    });
    const d3 = new Date();
    d3.setDate(3);
    await createShiftFixture({
      userId: user.id,
      overrides: { date: d3, status: "ABSENT" },
    });
    const y = new Date().getFullYear();
    const m = new Date().getMonth() + 1;
    const res = await request(app)
      .get(`/api/v1/hr-ops/attendance?userId=${user.id}&year=${y}&month=${m}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workedDays).toBe(2);
    expect(res.body.data.absentDays).toBe(1);
  });

  it("payroll calc: absent penalty deducted from net", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const d = new Date();
    d.setDate(1);
    await createShiftFixture({
      userId: user.id,
      overrides: { date: d, status: "ABSENT" },
    });
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        year: y,
        month: m,
        basicSalary: 30000,
        allowances: 2000,
        deductions: 1000,
        overtimeRate: 100,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.absentPenalty).toBeGreaterThan(0);
    expect(res.body.data.net).toBeLessThan(31000);
  });

  it("payroll calc: NIGHT shift worked counted as overtime", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const d = new Date();
    d.setDate(5);
    await createShiftFixture({
      userId: user.id,
      overrides: { date: d, type: "NIGHT", status: "PRESENT" },
    });
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        basicSalary: 20000,
        overtimeRate: 150,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.overtimeShifts).toBe(1);
    expect(res.body.data.overtimePay).toBeGreaterThan(0);
  });

  it("payroll calc rejects non-admin (403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: "00000000-0000-0000-0000-000000000000",
        year: 2026,
        month: 4,
        basicSalary: 10000,
      });
    expect(res.status).toBe(403);
  });

  it("payroll calc with negative basicSalary (400)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        year: 2026,
        month: 4,
        basicSalary: -1000,
      });
    expect(res.status).toBe(400);
  });

  it("certification create + list + update + delete", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const create = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        type: "BLS",
        title: "Basic Life Support",
        expiryDate: "2027-12-31",
      });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    const patch = await request(app)
      .patch(`/api/v1/hr-ops/certifications/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issuingBody: "AHA" });
    expect(patch.status).toBe(200);

    const list = await request(app)
      .get(`/api/v1/hr-ops/certifications?userId=${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);

    const del = await request(app)
      .delete(`/api/v1/hr-ops/certifications/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
  });

  it("certification create with invalid type (400)", async () => {
    const user = await createUserFixture();
    const res = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id, type: "NONSENSE", title: "X" });
    expect(res.status).toBe(400);
  });

  it("certifications/expiring requires ADMIN (403)", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/certifications/expiring?days=60")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("certifications list scoped to self for non-admin", async () => {
    const other = await createUserFixture({ role: "DOCTOR" });
    const res = await request(app)
      .get(`/api/v1/hr-ops/certifications?userId=${other.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("overtime record create and amount computed", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date: "2026-04-10",
        regularHours: 8,
        overtimeHours: 4,
        hourlyRate: 100,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBeCloseTo(600, 2);
  });

  it("overtime record create with zero hourly rate allowed", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date: "2026-04-11",
        regularHours: 8,
        overtimeHours: 2,
        hourlyRate: 0,
        overtimeRate: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(0);
  });

  it("overtime approve flips approved=true", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const create = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: user.id,
        date: "2026-04-12",
        regularHours: 8,
        overtimeHours: 3,
        hourlyRate: 200,
        overtimeRate: 1.5,
      });
    const approve = await request(app)
      .patch(`/api/v1/hr-ops/overtime/${create.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.approved).toBe(true);
  });

  it("overtime auto-calculate picks up >8h shifts", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const d = new Date();
    d.setDate(6);
    await createShiftFixture({
      userId: user.id,
      overrides: {
        date: d,
        status: "PRESENT",
        startTime: "08:00",
        endTime: "20:00", // 12h
      },
    });
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime/auto-calculate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        userId: user.id,
        defaultHourlyRate: 150,
        regularHoursPerDay: 8,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBeGreaterThanOrEqual(1);
  });

  it("overtime GET scoped to own user when non-admin", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("overtime GET forbidden for non-admin on other user", async () => {
    const other = await createUserFixture({ role: "DOCTOR" });
    const res = await request(app)
      .get(`/api/v1/hr-ops/overtime?userId=${other.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("payroll slip month validation (400 on bad month format)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${user.id}/slip?month=2026`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("payroll slip forbidden for other users (403)", async () => {
    const other = await createUserFixture({ role: "DOCTOR" });
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${other.id}/slip?month=2026-04`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });
});
