// Integration tests for GET /api/v1/analytics/no-show-report — the per-doctor
// no-show pivot with embedded day-of-week breakdown that closes Pearl §4.4
// row 116 ("No-show rate by doctor / day-of-week"). Distinct from the
// pre-existing /analytics/appointments/no-show-rate endpoint, which
// aggregates doctor + DOW independently (two side-by-side charts) rather
// than the cross-pivot operations needs for a monthly review.
//
// Covers: default-range aggregation + totals math, from/to filter, doctorId
// filter, CSV export (content-type + filename + audit row), zero-data edge
// case (no divide-by-zero), non-ADMIN 403, and the DOW pivot invariant
// (per-DOW totals sum to per-doctor totals).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import {
  describeIfDB,
  resetDB,
  getAuthToken,
  getPrisma,
} from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;

// Track the seeded doctors so tests can filter by id and assert per-doctor
// math without having to query the DB inside each test.
let doctorA: any;
let doctorB: any;
let patient: any;

/**
 * Build a UTC date for a specific calendar day in the current month so the
 * default `from = first-of-month` window picks it up reliably across the
 * test run, even near month boundaries. We seed across multiple DOWs so
 * the DOW-pivot assertions have real data.
 *
 * Returns midnight UTC for the requested day-of-month in the current
 * UTC month.
 */
function dayInCurrentMonth(dayOfMonth: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth, 12, 0, 0));
}

describeIfDB("Analytics no-show report (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;

    patient = await createPatientFixture();
    doctorA = await createDoctorFixture({ name: "Dr. Alpha Aggregator" });
    doctorB = await createDoctorFixture({ name: "Dr. Beta Benchmark" });

    // Doctor A: 4 appointments, 2 no-shows → 50% rate.
    // Spread across 2 distinct DOWs (days 1 & 2 of current month).
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorA.id,
      overrides: { status: "NO_SHOW", date: dayInCurrentMonth(1), tokenNumber: 1 },
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorA.id,
      overrides: { status: "COMPLETED", date: dayInCurrentMonth(1), tokenNumber: 2 },
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorA.id,
      overrides: { status: "NO_SHOW", date: dayInCurrentMonth(2), tokenNumber: 3 },
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorA.id,
      overrides: { status: "BOOKED", date: dayInCurrentMonth(2), tokenNumber: 4 },
    });

    // Doctor B: 2 appointments, 1 no-show → 50% rate.
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorB.id,
      overrides: { status: "NO_SHOW", date: dayInCurrentMonth(3), tokenNumber: 1 },
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctorB.id,
      overrides: { status: "COMPLETED", date: dayInCurrentMonth(3), tokenNumber: 2 },
    });
  });

  it("aggregates per-doctor totals + overall rate over default window", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/no-show-report")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { totals, byDoctor, dateRange } = res.body.data;
    expect(dateRange.from).toBeTruthy();
    expect(dateRange.to).toBeTruthy();

    expect(totals.totalAppointments).toBe(6);
    expect(totals.totalNoShows).toBe(3);
    expect(totals.overallRate).toBeCloseTo(0.5, 4);
    expect(totals.doctorCount).toBe(2);

    expect(byDoctor).toHaveLength(2);
    const a = byDoctor.find((d: any) => d.doctorId === doctorA.id);
    const b = byDoctor.find((d: any) => d.doctorId === doctorB.id);
    expect(a.totalAppointments).toBe(4);
    expect(a.noShowCount).toBe(2);
    expect(a.noShowRate).toBeCloseTo(0.5, 4);
    expect(b.totalAppointments).toBe(2);
    expect(b.noShowCount).toBe(1);
    expect(b.noShowRate).toBeCloseTo(0.5, 4);
  });

  it("DOW pivot per-doctor: byDow entries sum to per-doctor totals", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/no-show-report")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    for (const d of res.body.data.byDoctor) {
      expect(d.byDow).toHaveLength(7);
      const dowTotal = d.byDow.reduce(
        (s: number, x: any) => s + x.totalAppointments,
        0,
      );
      const dowNoShow = d.byDow.reduce(
        (s: number, x: any) => s + x.noShowCount,
        0,
      );
      expect(dowTotal).toBe(d.totalAppointments);
      expect(dowNoShow).toBe(d.noShowCount);
      // dow values fixed 0..6 in order
      expect(d.byDow.map((x: any) => x.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it("filters by doctorId", async () => {
    const res = await request(app)
      .get(`/api/v1/analytics/no-show-report?doctorId=${doctorA.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.doctorCount).toBe(1);
    expect(res.body.data.byDoctor).toHaveLength(1);
    expect(res.body.data.byDoctor[0].doctorId).toBe(doctorA.id);
    expect(res.body.data.totals.totalAppointments).toBe(4);
    expect(res.body.data.totals.totalNoShows).toBe(2);
  });

  it("narrows window with from/to filters", async () => {
    // Window covers ONLY day 3 of current month → only doctor B's 2 rows.
    const day3 = dayInCurrentMonth(3);
    const dayStart = new Date(Date.UTC(day3.getUTCFullYear(), day3.getUTCMonth(), 3, 0, 0, 0));
    const dayEnd = new Date(Date.UTC(day3.getUTCFullYear(), day3.getUTCMonth(), 3, 23, 59, 59));
    const res = await request(app)
      .get(
        `/api/v1/analytics/no-show-report?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`,
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.totalAppointments).toBe(2);
    expect(res.body.data.totals.totalNoShows).toBe(1);
    expect(res.body.data.byDoctor).toHaveLength(1);
    expect(res.body.data.byDoctor[0].doctorId).toBe(doctorB.id);
  });

  it("handles empty window without divide-by-zero", async () => {
    // 5 years in the past — no appointments seeded there.
    const past = new Date();
    past.setFullYear(past.getFullYear() - 5);
    const pastStart = new Date(past.getFullYear(), past.getMonth(), 1).toISOString();
    const pastEnd = new Date(past.getFullYear(), past.getMonth(), 28).toISOString();
    const res = await request(app)
      .get(`/api/v1/analytics/no-show-report?from=${pastStart}&to=${pastEnd}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({
      totalAppointments: 0,
      totalNoShows: 0,
      overallRate: 0,
      doctorCount: 0,
    });
    expect(res.body.data.byDoctor).toEqual([]);
  });

  it("exports CSV with attachment + audit row (NO_SHOW_REPORT_EXPORTED)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/no-show-report?format=csv")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment;/);
    expect(res.headers["content-disposition"]).toMatch(
      /filename="no-show-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    // CSV header must include the DOW columns + the Branch column
    // (Pearl §4.4 row 120 added Branch as the 2nd column).
    const text = res.text;
    expect(text).toContain("Doctor,Branch,Total,No-Shows,Rate %");
    expect(text).toMatch(/Sun Total.*Sat Rate %/);
    // The doctor names from the fixtures should appear as data rows.
    expect(text).toContain("Dr. Alpha Aggregator");
    expect(text).toContain("Dr. Beta Benchmark");
    // Summary row prefix.
    expect(text).toMatch(/TOTAL \(\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}\)/);

    // Audit row is written fire-and-forget — poll until it lands.
    const prisma = await getPrisma();
    const row = await waitForAuditFlush(prisma, {
      action: "NO_SHOW_REPORT_EXPORTED",
      entity: "appointment",
    });
    expect(row).toBeTruthy();
    const details = row.details as any;
    expect(details.format).toBe("csv");
    expect(typeof details.doctorCount).toBe("number");
  });

  it("rejects non-ADMIN callers (DOCTOR → 403, RECEPTION → 403)", async () => {
    const doctorRes = await request(app)
      .get("/api/v1/analytics/no-show-report")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(doctorRes.status).toBe(403);

    const recRes = await request(app)
      .get("/api/v1/analytics/no-show-report")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(recRes.status).toBe(403);
  });

  it("rejects invalid `from` date with 400", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/no-show-report?from=not-a-date")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/from/i);
  });

  // ─── Pearl §4.4 row 120: branchId filter ─────────────────────────────
  // The 3 newly-shipped reports added a branchId query param so multi-
  // branch tenants can narrow the rollup. Validation: the branchId must
  // resolve to a Branch in the caller's tenant (cross-tenant or non-
  // existent → 400 with `Branch not found in current tenant`).

  it("rejects a non-existent branchId with 400", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/no-show-report?branchId=00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Branch not found/i);
  });

  it("narrows results to a single branch when branchId is supplied", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.create({
      data: {
        name: "No-Show Branch Filter Tenant",
        subdomain: `ns-branch-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const branchA = await prisma.branch.create({
      data: { tenantId: tenant.id, name: "Branch Alpha (NS)", isDefault: true, active: true },
    });
    const branchB = await prisma.branch.create({
      data: { tenantId: tenant.id, name: "Branch Beta (NS)", isDefault: false, active: true },
    });

    // Stamp doctorA's appointments into Branch A and doctorB's into B.
    await prisma.appointment.updateMany({
      where: { doctorId: doctorA.id },
      data: { branchId: branchA.id },
    });
    await prisma.appointment.updateMany({
      where: { doctorId: doctorB.id },
      data: { branchId: branchB.id },
    });

    const res = await request(app)
      .get(`/api/v1/analytics/no-show-report?branchId=${branchA.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.branchId).toBe(branchA.id);
    expect(res.body.data.branchName).toBe("Branch Alpha (NS)");
    // Only doctor A's 4 appointments should appear.
    expect(res.body.data.totals.totalAppointments).toBe(4);
    expect(res.body.data.byDoctor).toHaveLength(1);
    expect(res.body.data.byDoctor[0].doctorId).toBe(doctorA.id);

    // Restore so following tests (none after this in current ordering,
    // but defensive) don't see Branch-stamped state.
    await prisma.appointment.updateMany({
      where: { doctorId: { in: [doctorA.id, doctorB.id] } },
      data: { branchId: null },
    });
  });
});
