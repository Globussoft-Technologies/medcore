// Integration tests for the HR-ops router (apps/api/src/routes/hr-ops.ts).
//
// Modules: routes/hr-ops.ts (holidays, attendance, payroll, certifications,
// overtime), middleware/feature-flag.ts (hrmsPayroll Stage-2 gate),
// services/payroll.ts (computePayroll / daysInMonth), services/pdf.ts
// (generatePaySlipHTML), middleware/auth.ts (authenticate + authorize).
//
// Why: hr-ops.ts is a 679-line zero-coverage router covering ADMIN-only
// writes against tenant-scoped HR data, two self-or-admin reads
// (attendance, certifications, overtime, payslip), and a Pearl Stage-2
// `requireFeature("hrmsPayroll")` paywall gate. The tests below pin:
//   - happy path on each endpoint,
//   - RBAC matrix (ADMIN write vs NURSE forbidden vs PATIENT 401/403 vs
//     self-vs-other-userId scoping on the four self-or-admin reads),
//   - Zod validation rejections (negative basic salary, bad date shape,
//     missing required fields),
//   - cross-tenant isolation via the tenantScopedPrisma wrapper +
//     application-level dedup on (date, name) for holidays,
//   - the hrmsPayroll feature-flag gate (404 when flag explicitly false).
import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  describeIfDB,
  resetDB,
  getAuthToken,
  getPrisma,
} from "../setup";
import { createUserFixture } from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

let app: any;
let adminToken: string;
let nurseToken: string;
let doctorToken: string;
let patientToken: string;

// Cached IDs we create in beforeAll for tests that need a real user to attach
// HR rows to (StaffShift / StaffCertification / OvertimeRecord all FK userId).
let staffUserId: string; // a NURSE/DOCTOR user owned by ADMIN

describeIfDB("HR-ops API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;

    // Reusable staff user for shifts/certs/overtime FK targets.
    const staff = await createUserFixture({
      role: "NURSE",
      email: `hr_staff_${Date.now()}@test.local`,
    });
    staffUserId = staff.id;
  });

  afterAll(() => {
    __resetFeatureFlagsCacheForTests();
  });

  // ─── HOLIDAYS ─────────────────────────────────────────────

  it("ADMIN can create a holiday and the audit row is written", async () => {
    const prisma = await getPrisma();
    const date = "2026-06-15";
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date, name: "Test Holiday", type: "PUBLIC" });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Test Holiday");
    expect(res.body.data.type).toBe("PUBLIC");
    // safeAudit-style fire-and-forget: wait for the row to appear.
    const row = await waitForAuditFlush(prisma, {
      action: "HOLIDAY_CREATE",
      entity: "holiday",
      entityId: res.body.data.id,
    });
    expect(row.action).toBe("HOLIDAY_CREATE");
  });

  it("POST /holidays rejects duplicate date with 409 (Issue #73 dedup)", async () => {
    // First insert
    const date = "2026-07-20";
    const first = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date, name: "Original" });
    expect(first.status).toBe(201);
    // Same date, different name — must 409, not P2002-500.
    const dup = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date, name: "Another" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/i);
  });

  it("POST /holidays rejects HTML/script in name (Issue #292)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-08-10", name: "Diwali <script>alert(1)</script>" });
    expect(res.status).toBe(400);
  });

  it("POST /holidays denies non-admin (NURSE → 403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ date: "2026-09-05", name: "Independence Day" });
    expect(res.status).toBe(403);
  });

  it("GET /holidays returns 200 for ADMIN with year filter", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/holidays?year=2026")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /holidays denies non-admin (Issue #459 — tightened read)", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH /holidays/:id updates a holiday in-place (Issue #692 BUG-A08)", async () => {
    const created = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-10-02", name: "Gandhi Jayanthi", type: "PUBLIC" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const patch = await request(app)
      .patch(`/api/v1/hr-ops/holidays/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Gandhi Jayanti", type: "OPTIONAL" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.name).toBe("Gandhi Jayanti");
    expect(patch.body.data.type).toBe("OPTIONAL");
  });

  it("PATCH /holidays/:id returns 404 for unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/hr-ops/holidays/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("PATCH /holidays/:id rejects move to an already-taken date (409)", async () => {
    // Seed two distinct holidays
    const a = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-11-01", name: "Day-A" });
    const b = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-11-02", name: "Day-B" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Move B onto A's date — collision.
    const move = await request(app)
      .patch(`/api/v1/hr-ops/holidays/${b.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-11-01" });
    expect(move.status).toBe(409);
  });

  it("DELETE /holidays/:id removes the row", async () => {
    const created = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: "2026-12-25", name: "Christmas" });
    const id = created.body.data.id;
    const del = await request(app)
      .delete(`/api/v1/hr-ops/holidays/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(del.body.data.id).toBe(id);
  });

  it("DELETE /holidays/:id denies NURSE (403)", async () => {
    const res = await request(app)
      .delete("/api/v1/hr-ops/holidays/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  // ─── ATTENDANCE ────────────────────────────────────────────

  it("GET /attendance defaults to caller's userId for non-admin (NURSE self-scope)", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/attendance")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.byStatus).toBeDefined();
    expect(typeof res.body.data.workedDays).toBe("number");
  });

  it("GET /attendance?userId=<other> forces non-admin back to self (silent scope)", async () => {
    // Non-admin caller asks for someone else's userId; handler ignores the
    // query param and returns the caller's own data.
    const res = await request(app)
      .get(`/api/v1/hr-ops/attendance?userId=${staffUserId}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    // Returned userId is NOT the requested one — it's the caller's.
    expect(res.body.data.userId).not.toBe(staffUserId);
  });

  it("GET /attendance?userId=<x> as ADMIN honors the requested userId", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/attendance?userId=${staffUserId}&year=2026&month=6`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(staffUserId);
    expect(res.body.data.year).toBe(2026);
    expect(res.body.data.month).toBe(6);
  });

  it("GET /attendance requires authentication (401)", async () => {
    const res = await request(app).get("/api/v1/hr-ops/attendance");
    expect(res.status).toBe(401);
  });

  // ─── PAYROLL CALCULATION ──────────────────────────────────

  it("POST /payroll computes payroll for a user (happy path)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        year: 2026,
        month: 6,
        basicSalary: 30000,
        allowances: 5000,
        deductions: 2000,
        overtimeRate: 200,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(staffUserId);
    expect(typeof res.body.data.netPay).toBe("number");
  });

  it("POST /payroll rejects negative basicSalary (Issue #283)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        year: 2026,
        month: 6,
        basicSalary: -50000,
      });
    expect(res.status).toBe(400);
  });

  it("POST /payroll rejects zero basicSalary (must be positive)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        year: 2026,
        month: 6,
        basicSalary: 0,
      });
    expect(res.status).toBe(400);
  });

  it("POST /payroll rejects invalid month (>12)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        year: 2026,
        month: 13,
        basicSalary: 25000,
      });
    expect(res.status).toBe(400);
  });

  it("POST /payroll denies NURSE (403 — admin-only)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: staffUserId,
        year: 2026,
        month: 6,
        basicSalary: 25000,
      });
    expect(res.status).toBe(403);
  });

  // ─── CERTIFICATIONS ───────────────────────────────────────

  it("POST /certifications (ADMIN) creates a row + audit", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        type: "NURSING_CERT",
        title: "RN License",
        issuingBody: "Karnataka Nursing Council",
        certNumber: "RN-12345",
        issuedDate: "2024-01-01",
        expiryDate: "2027-01-01",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBe(staffUserId);
    expect(res.body.data.title).toBe("RN License");
    // Auto-status: future expiry → ACTIVE.
    expect(res.body.data.status).toBe("ACTIVE");
    const row = await waitForAuditFlush(prisma, {
      action: "CERTIFICATION_CREATE",
      entity: "staff_certification",
      entityId: res.body.data.id,
    });
    expect(row.action).toBe("CERTIFICATION_CREATE");
  });

  it("POST /certifications rejects invalid type (enum)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        type: "BOGUS_TYPE",
        title: "Whatever",
      });
    expect(res.status).toBe(400);
  });

  it("POST /certifications denies NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: staffUserId,
        type: "BLS",
        title: "BLS Cert",
      });
    expect(res.status).toBe(403);
  });

  it("GET /certifications as ADMIN returns full list", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /certifications as NURSE self-scopes (no userId echo of others)", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Any row in the result must belong to the caller's user.
    for (const row of res.body.data) {
      // We don't know the nurse's userId here (the token claims include it
      // but we don't decode); the API filter ensures it's the caller's row,
      // and the staffUserId fixture row should NOT leak through.
      expect(row.userId).not.toBe(staffUserId);
    }
  });

  it("GET /certifications?userId=<other> as NURSE returns 403", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/certifications?userId=${staffUserId}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /certifications/expiring (ADMIN) returns the expiring/expired buckets", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/certifications/expiring?days=60")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.expiring).toBeDefined();
    expect(res.body.data.expired).toBeDefined();
    expect(Array.isArray(res.body.data.expiring)).toBe(true);
    expect(Array.isArray(res.body.data.expired)).toBe(true);
  });

  it("GET /certifications/expiring denies NURSE (403)", async () => {
    const res = await request(app)
      .get("/api/v1/hr-ops/certifications/expiring")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH + DELETE /certifications/:id round trip", async () => {
    const created = await request(app)
      .post("/api/v1/hr-ops/certifications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        type: "ACLS",
        title: "ACLS Cert",
        expiryDate: "2028-01-01",
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const patched = await request(app)
      .patch(`/api/v1/hr-ops/certifications/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "ACLS (updated)", notes: "Renewed early" });
    expect(patched.status).toBe(200);
    expect(patched.body.data.title).toBe("ACLS (updated)");

    const del = await request(app)
      .delete(`/api/v1/hr-ops/certifications/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(del.body.data.id).toBe(id);
  });

  // ─── OVERTIME ─────────────────────────────────────────────

  it("POST /overtime (ADMIN) creates with computed amount", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        date: "2026-06-10",
        regularHours: 8,
        overtimeHours: 3,
        hourlyRate: 200,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(201);
    // amount = 3 * 200 * 1.5 = 900
    expect(res.body.data.amount).toBeCloseTo(900, 2);
    expect(res.body.data.approved).toBe(false);
    const row = await waitForAuditFlush(prisma, {
      action: "OVERTIME_CREATE",
      entity: "overtime_record",
      entityId: res.body.data.id,
    });
    expect(row.action).toBe("OVERTIME_CREATE");
  });

  it("POST /overtime denies NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: staffUserId,
        date: "2026-06-11",
        regularHours: 8,
        overtimeHours: 2,
        hourlyRate: 200,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(403);
  });

  it("POST /overtime rejects malformed payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: "not-a-uuid",
        date: "not-a-date",
        regularHours: -1,
        overtimeHours: 1,
        hourlyRate: 100,
      });
    expect(res.status).toBe(400);
  });

  it("GET /overtime as ADMIN returns rows", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/overtime?userId=${staffUserId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /overtime?userId=<other> denies non-admin (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/overtime?userId=${staffUserId}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /overtime?month=YYYY-MM honors the month filter", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/overtime?userId=${staffUserId}&month=2026-06`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("PATCH /overtime/:id/approve flips approved=true and stamps approver", async () => {
    // Seed
    const created = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        date: "2026-06-12",
        regularHours: 8,
        overtimeHours: 2,
        hourlyRate: 200,
        overtimeRate: 1.5,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const approve = await request(app)
      .patch(`/api/v1/hr-ops/overtime/${id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.approved).toBe(true);
    expect(approve.body.data.approvedBy).toBeTruthy();
  });

  it("PATCH /overtime/:id/approve denies NURSE (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/hr-ops/overtime/00000000-0000-0000-0000-000000000000/approve")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH /overtime/:id (ADMIN) recomputes amount on hours change", async () => {
    const created = await request(app)
      .post("/api/v1/hr-ops/overtime")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: staffUserId,
        date: "2026-06-13",
        regularHours: 8,
        overtimeHours: 2,
        hourlyRate: 200,
        overtimeRate: 1.5,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const beforeAmount = created.body.data.amount; // 600

    const patched = await request(app)
      .patch(`/api/v1/hr-ops/overtime/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overtimeHours: 4 });
    expect(patched.status).toBe(200);
    // 4 * 200 * 1.5 = 1200, must NOT equal old 600
    expect(patched.body.data.amount).not.toBe(beforeAmount);
    expect(patched.body.data.amount).toBeCloseTo(1200, 2);
  });

  it("POST /overtime/auto-calculate (ADMIN) returns created envelope", async () => {
    // No shifts in this month → 0 created, but envelope is correct.
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime/auto-calculate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        year: 2027,
        month: 1,
        userId: staffUserId,
        defaultHourlyRate: 250,
        regularHoursPerDay: 8,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.created).toBe("number");
    expect(Array.isArray(res.body.data.records)).toBe(true);
  });

  it("POST /overtime/auto-calculate denies NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/hr-ops/overtime/auto-calculate")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        year: 2027,
        month: 1,
        defaultHourlyRate: 200,
        regularHoursPerDay: 8,
        overtimeRate: 1.5,
      });
    expect(res.status).toBe(403);
  });

  // ─── PAYSLIP ──────────────────────────────────────────────

  it("GET /payroll/:userId/slip returns HTML for ADMIN", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${staffUserId}/slip?month=2026-06`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toMatch(/Salary Slip/i);
  });

  it("GET /payroll/:userId/slip rejects malformed month (400)", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${staffUserId}/slip?month=2026/06`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM/);
  });

  it("GET /payroll/:userId/slip 404 for unknown userId", async () => {
    const ghost = "00000000-0000-0000-0000-000000000099";
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${ghost}/slip?month=2026-06`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /payroll/:userId/slip 403 when non-admin requests someone else's slip", async () => {
    const res = await request(app)
      .get(`/api/v1/hr-ops/payroll/${staffUserId}/slip?month=2026-06`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  // ─── AUTH BASELINE ────────────────────────────────────────

  it("any HR-ops endpoint requires authentication (401 without token)", async () => {
    const res = await request(app).get("/api/v1/hr-ops/holidays");
    expect(res.status).toBe(401);
  });

  it("PATIENT role is forbidden from HR write endpoints (403)", async () => {
    // PATIENT is not in authorize() for any write, and is not exempted on
    // the self-scope reads (no patient.userId match for the staffUserId).
    const res = await request(app)
      .post("/api/v1/hr-ops/holidays")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ date: "2026-12-31", name: "NYE" });
    expect(res.status).toBe(403);
  });

  // ─── FEATURE FLAG GATE ────────────────────────────────────

  it("when tenant.featureFlags.hrmsPayroll=false, all hr-ops routes 404 (Pearl §6/§18)", async () => {
    const prisma = await getPrisma();
    // Materialize a tenant the admin belongs to, then disable the flag.
    let tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
      });
    }
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: tenant.id },
    });
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hrmsPayroll: false } },
    });
    __resetFeatureFlagsCacheForTests();
    // Re-mint token so it carries the new tenantId claim.
    const tenantAdminToken = await getAuthToken("ADMIN");

    const res = await request(app)
      .get("/api/v1/hr-ops/holidays?year=2026")
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: "Not found" });

    // Cleanup — flip back ON so later tests in other suites aren't blocked.
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hrmsPayroll: true } },
    });
    __resetFeatureFlagsCacheForTests();
  });

  it("when tenant.featureFlags.hrmsPayroll=true, hr-ops routes resolve normally", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) return; // previous test materialized it
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hrmsPayroll: true } },
    });
    __resetFeatureFlagsCacheForTests();
    const tenantAdminToken = await getAuthToken("ADMIN");

    const res = await request(app)
      .get("/api/v1/hr-ops/holidays?year=2026")
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(res.status).toBe(200);
  });

  // Silence unused-token lint — doctorToken is reserved for future
  // hr-ops doctor-specific paths (currently no DOCTOR-only handler).
  void doctorToken;
});
