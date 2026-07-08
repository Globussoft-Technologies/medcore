/**
 * Department-wise reports (2026-07-07) — GET /analytics/departments and
 * GET /analytics/departments/:department, plus the parseRange date-only-`to`
 * end-of-day fix.
 *
 * What / which / why:
 *   - Covers the new admin-only department report endpoints added for the
 *     Reports → Departments tab + drill-down page (routes/analytics.ts).
 *   - Pins three behaviours that shipped/were fixed today:
 *       (a) revenue is attributed per department from BOTH appointment invoices
 *           AND prescription/pharmacy invoices (invoice.prescriptionId →
 *           prescription.doctorId → department) — the latter was invisible
 *           before and surfaced as "revenue ₹0" despite a captured payment;
 *       (b) a date-only `to` query param (e.g. "2026-07-07") is treated as
 *           END-of-day, not midnight — the fix for the header-only/empty CSV
 *           export where same-day payments were silently dropped;
 *       (c) RBAC — the endpoints are ADMIN-only (DOCTOR → 403).
 *   - Mocked Prisma (no DB), mirroring analytics-overview.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    doctor: { findMany: vi.fn(async () => []) },
    appointment: { findMany: vi.fn(async () => []) },
    prescription: { findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []) },
    labOrder: { findMany: vi.fn(async () => []) },
    consultation: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

import { analyticsRouter } from "./analytics";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/analytics", analyticsRouter);
  return app;
}

function token(role: string): string {
  return jwt.sign(
    { userId: "u-test", email: "u@test.local", role },
    "test-secret",
  );
}

function resetAll() {
  prismaMock.doctor.findMany.mockReset().mockResolvedValue([]);
  prismaMock.appointment.findMany.mockReset().mockResolvedValue([]);
  prismaMock.prescription.findMany.mockReset().mockResolvedValue([]);
  prismaMock.invoice.findMany.mockReset().mockResolvedValue([]);
  prismaMock.labOrder.findMany.mockReset().mockResolvedValue([]);
  prismaMock.consultation.findMany.mockReset().mockResolvedValue([]);
  prismaMock.auditLog.create.mockReset().mockResolvedValue({ id: "al-1" });
}

describe("GET /api/v1/analytics/departments (summary)", () => {
  beforeEach(resetAll);

  it("groups doctors by specialization and rolls up appointments/patients", async () => {
    prismaMock.doctor.findMany.mockResolvedValue([
      {
        id: "d1",
        specialization: "Cardiology",
        appointments: [
          { patientId: "p1", status: "COMPLETED", date: new Date("2026-07-01"), invoice: null },
          { patientId: "p2", status: "BOOKED", date: new Date("2026-07-02"), invoice: null },
        ],
      },
      {
        id: "d2",
        specialization: "Cardiology",
        appointments: [
          { patientId: "p1", status: "COMPLETED", date: new Date("2026-07-03"), invoice: null },
        ],
      },
      { id: "d3", specialization: "ENT", appointments: [] },
    ]);

    const res = await request(buildApp())
      .get("/api/v1/analytics/departments")
      .set("Authorization", `Bearer ${token("ADMIN")}`);

    expect(res.status).toBe(200);
    const cardio = res.body.data.find((r: any) => r.department === "Cardiology");
    expect(cardio.doctorCount).toBe(2);
    expect(cardio.appointmentCount).toBe(3);
    expect(cardio.completedCount).toBe(2);
    expect(cardio.patientCount).toBe(2); // p1 counted once across both doctors
    const ent = res.body.data.find((r: any) => r.department === "ENT");
    expect(ent.doctorCount).toBe(1);
    expect(ent.appointmentCount).toBe(0);
  });

  it("maps null/blank specialization to 'Unassigned'", async () => {
    prismaMock.doctor.findMany.mockResolvedValue([
      { id: "d1", specialization: null, appointments: [] },
      { id: "d2", specialization: "   ", appointments: [] },
    ]);
    const res = await request(buildApp())
      .get("/api/v1/analytics/departments")
      .set("Authorization", `Bearer ${token("ADMIN")}`);
    expect(res.status).toBe(200);
    const unassigned = res.body.data.find((r: any) => r.department === "Unassigned");
    expect(unassigned.doctorCount).toBe(2);
  });

  it("attributes BOTH appointment-invoice AND prescription-invoice revenue", async () => {
    // Appointment invoice → 300 paid in-window; prescription invoice → 4424 paid.
    const from = new Date("2026-07-01T00:00:00.000Z");
    const paid = new Date("2026-07-05T12:00:00.000Z");
    prismaMock.doctor.findMany.mockResolvedValue([
      {
        id: "d1",
        specialization: "Dermatology",
        appointments: [
          {
            patientId: "p1",
            status: "COMPLETED",
            date: new Date("2026-07-05"),
            invoice: { payments: [{ amount: 300, paidAt: paid }] },
          },
        ],
      },
    ]);
    // Prescription-invoice revenue path: invoice.prescriptionId → prescription.doctorId.
    prismaMock.invoice.findMany.mockResolvedValue([
      { prescriptionId: "rx1", payments: [{ amount: 4424, paidAt: paid }] },
    ]);
    prismaMock.prescription.findMany.mockResolvedValue([{ id: "rx1", doctorId: "d1" }]);

    const res = await request(buildApp())
      .get(`/api/v1/analytics/departments?from=${from.toISOString()}&to=2026-07-31`)
      .set("Authorization", `Bearer ${token("ADMIN")}`);

    expect(res.status).toBe(200);
    const derm = res.body.data.find((r: any) => r.department === "Dermatology");
    // 300 (appointment) + 4424 (prescription/pharmacy) = 4724
    expect(derm.revenue).toBe(4724);
  });

  it("does not double-count a prescription invoice for a doctor outside the set", async () => {
    prismaMock.doctor.findMany.mockResolvedValue([
      { id: "d1", specialization: "ENT", appointments: [] },
    ]);
    prismaMock.invoice.findMany.mockResolvedValue([
      { prescriptionId: "rxX", payments: [{ amount: 999, paidAt: new Date("2026-07-05") }] },
    ]);
    // rxX belongs to a doctor NOT in our doctor set → should be skipped.
    prismaMock.prescription.findMany.mockResolvedValue([{ id: "rxX", doctorId: "OTHER" }]);

    const res = await request(buildApp())
      .get("/api/v1/analytics/departments")
      .set("Authorization", `Bearer ${token("ADMIN")}`);
    expect(res.status).toBe(200);
    const ent = res.body.data.find((r: any) => r.department === "ENT");
    expect(ent.revenue).toBe(0);
  });

  it("is ADMIN-only — DOCTOR gets 403", async () => {
    const res = await request(buildApp())
      .get("/api/v1/analytics/departments")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/analytics/departments/:department (detail)", () => {
  beforeEach(resetAll);

  it("returns totals + a zero-filled daily series for a department", async () => {
    prismaMock.doctor.findMany.mockResolvedValue([
      { id: "d1", specialization: "Cardiology", user: { name: "Dr. Vikram" } },
    ]);
    prismaMock.appointment.findMany.mockResolvedValue([
      {
        patientId: "p1",
        doctorId: "d1",
        status: "COMPLETED",
        date: new Date("2026-07-05"),
        invoice: { payments: [{ amount: 500, paidAt: new Date("2026-07-05T10:00:00.000Z") }] },
      },
    ]);

    const res = await request(buildApp())
      .get("/api/v1/analytics/departments/Cardiology?from=2026-07-01&to=2026-07-07")
      .set("Authorization", `Bearer ${token("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.department).toBe("Cardiology");
    expect(res.body.data.totals.appointments).toBe(1);
    expect(res.body.data.totals.completed).toBe(1);
    expect(res.body.data.totals.revenue).toBe(500);
    // Continuous, zero-filled IST-day series. The date-only `to=2026-07-07`
    // is extended to 23:59:59.999 UTC which, shifted to IST (+5:30), lands on
    // 2026-07-08 — so the inclusive span 07-01…07-08 is 8 buckets. (This IST
    // boundary is the intended behaviour, not an off-by-one.)
    expect(res.body.data.appointmentsByDay.length).toBe(8);
    // The series must be continuous (no gaps) and cover the requested start.
    expect(res.body.data.appointmentsByDay[0].day).toBe("2026-07-01");
  });

  it("returns an empty shape (no throw) when the department has no doctors", async () => {
    prismaMock.doctor.findMany.mockResolvedValue([]);
    const res = await request(buildApp())
      .get("/api/v1/analytics/departments/Nonexistent?from=2026-07-01&to=2026-07-07")
      .set("Authorization", `Bearer ${token("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.doctorCount).toBe(0);
    expect(res.body.data.totals.appointments).toBe(0);
    expect(res.body.data.topMedicines).toEqual([]);
  });

  it("is ADMIN-only — DOCTOR gets 403", async () => {
    const res = await request(buildApp())
      .get("/api/v1/analytics/departments/Cardiology")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);
    expect(res.status).toBe(403);
  });
});

describe("parseRange date-only `to` → end-of-day (empty-CSV fix)", () => {
  beforeEach(resetAll);

  it("includes a same-day payment when `to` is a bare date (not midnight-truncated)", async () => {
    // Payment at 15:01 UTC on the `to` day. A midnight-UTC `to` would drop it;
    // the end-of-day fix must keep it.
    const sameDayLate = new Date("2026-07-07T15:01:00.000Z");
    prismaMock.doctor.findMany.mockResolvedValue([
      {
        id: "d1",
        specialization: "Dermatology",
        appointments: [
          {
            patientId: "p1",
            status: "COMPLETED",
            date: new Date("2026-07-07"),
            invoice: { payments: [{ amount: 700, paidAt: sameDayLate }] },
          },
        ],
      },
    ]);

    const res = await request(buildApp())
      .get("/api/v1/analytics/departments?from=2026-06-30&to=2026-07-07")
      .set("Authorization", `Bearer ${token("ADMIN")}`);

    expect(res.status).toBe(200);
    const derm = res.body.data.find((r: any) => r.department === "Dermatology");
    expect(derm.revenue).toBe(700); // would be 0 under the midnight-truncation bug
  });
});
