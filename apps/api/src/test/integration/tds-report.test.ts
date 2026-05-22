/**
 * Integration tests — TDS-on-professional-fees report (Pearl §4.4, gap row 119).
 *
 * What / which modules / why:
 *   - Exercises GET /api/v1/billing/tds-report — the dedicated TDS
 *     summary the gap doc flagged as "Computable from existing data;
 *     no dedicated TDS report endpoint" for Indian accounting
 *     compliance (IT-Act §194J — 10% withholding on professional
 *     fees paid to medical consultants).
 *   - Touches: apps/api/src/routes/billing.ts (new GET /tds-report
 *     handler appended at the bottom of the router) — read-only
 *     aggregation over `Invoice` × `InvoiceItem(category=CONSULTATION)`
 *     × `Appointment.doctor`.
 *   - Uses the project's `safeAudit` polling helper for the CSV
 *     export audit row (the handler fires-and-forgets per
 *     CLAUDE.md §1, matching the §4.4 referral-commission-ledger
 *     convention).
 */
import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;

/**
 * Seed one paid (or partially-paid) invoice with a single
 * CONSULTATION line item for a freshly minted patient + doctor.
 * Returns the doctor + invoice so the test can assert against the
 * report aggregation buckets.
 */
async function seedPaidConsultation(opts: {
  unitPrice: number;
  paymentStatus?: "PAID" | "PARTIAL" | "PENDING";
}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const invoice = await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: {
      subtotal: opts.unitPrice,
      totalAmount: opts.unitPrice,
      paymentStatus: opts.paymentStatus ?? "PAID",
    },
  });
  return { patient, doctor, appt, invoice };
}

describeIfDB("TDS-on-professional-fees report (Pearl §4.4 row 119)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  describe("GET /api/v1/billing/tds-report", () => {
    it("aggregates paid consultation fees with the default 10% TDS rate", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1000 });
      const b = await seedPaidConsultation({ unitPrice: 2000 });
      void a;
      void b;

      const res = await request(app)
        .get("/api/v1/billing/tds-report")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.tdsRate).toBe(10);
      expect(data.dateRange.from).toBeTruthy();
      expect(data.dateRange.to).toBeTruthy();

      // Each per-doctor row's tdsAmount must equal gross × 10 / 100,
      // and netPayable = gross − tdsAmount. Cross-checks the math.
      for (const row of data.byDoctor as Array<{
        totalGrossFees: string;
        tdsRate: number;
        tdsAmount: string;
        netPayable: string;
      }>) {
        const gross = parseFloat(row.totalGrossFees);
        const tds = parseFloat(row.tdsAmount);
        const net = parseFloat(row.netPayable);
        expect(row.tdsRate).toBe(10);
        expect(tds).toBeCloseTo(gross * 0.1, 2);
        expect(net).toBeCloseTo(gross - tds, 2);
      }

      // Top-level totals roll up to the per-doctor buckets.
      const totalGrossSum = (
        data.byDoctor as Array<{ totalGrossFees: string }>
      ).reduce((s, r) => s + parseFloat(r.totalGrossFees), 0);
      expect(parseFloat(data.totals.totalGross)).toBeCloseTo(totalGrossSum, 2);
      expect(parseFloat(data.totals.totalTds)).toBeCloseTo(
        totalGrossSum * 0.1,
        2,
      );
      expect(parseFloat(data.totals.totalNet)).toBeCloseTo(
        totalGrossSum * 0.9,
        2,
      );
      expect(data.totals.doctorCount).toBe(data.byDoctor.length);
    });

    it("honours a custom tdsRate=5", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1000 });
      void a;

      const res = await request(app)
        .get("/api/v1/billing/tds-report?tdsRate=5")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tdsRate).toBe(5);

      for (const row of res.body.data.byDoctor as Array<{
        totalGrossFees: string;
        tdsRate: number;
        tdsAmount: string;
        netPayable: string;
      }>) {
        const gross = parseFloat(row.totalGrossFees);
        expect(row.tdsRate).toBe(5);
        expect(parseFloat(row.tdsAmount)).toBeCloseTo(gross * 0.05, 2);
        expect(parseFloat(row.netPayable)).toBeCloseTo(gross * 0.95, 2);
      }
    });

    it("filters out invoices outside the from/to window", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1000 });
      void a;

      // Window in the far past — must contain zero invoices.
      const res = await request(app)
        .get("/api/v1/billing/tds-report?from=2020-01-01&to=2020-01-31")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.totals.invoiceCount).toBe(0);
      expect(parseFloat(res.body.data.totals.totalGross)).toBe(0);
      expect(res.body.data.byDoctor.length).toBe(0);
    });

    it("filters by doctorId — only that doctor's bucket appears", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1500 });
      const b = await seedPaidConsultation({ unitPrice: 2500 });

      const res = await request(app)
        .get(`/api/v1/billing/tds-report?doctorId=${a.doctor.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const buckets = res.body.data.byDoctor as Array<{
        doctorId: string;
      }>;
      // Every returned bucket must be doctor A — and doctor B must NOT appear.
      for (const bucket of buckets) {
        expect(bucket.doctorId).toBe(a.doctor.id);
      }
      const bShows = buckets.find((d) => d.doctorId === b.doctor.id);
      expect(bShows).toBeUndefined();
    });

    it("excludes invoices whose paymentStatus is PENDING (unpaid)", async () => {
      const a = await seedPaidConsultation({
        unitPrice: 1000,
        paymentStatus: "PENDING",
      });

      const res = await request(app)
        .get(`/api/v1/billing/tds-report?doctorId=${a.doctor.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      // The PENDING invoice should not appear in the aggregation —
      // accountants only withhold TDS on amounts actually received.
      const bucket = (
        res.body.data.byDoctor as Array<{ doctorId: string }>
      ).find((d) => d.doctorId === a.doctor.id);
      expect(bucket).toBeUndefined();
    });

    it("returns text/csv + attachment Content-Disposition on format=csv + writes audit row", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1000 });
      void a;

      const res = await request(app)
        .get("/api/v1/billing/tds-report?format=csv")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/i);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment;\s*filename="tds-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"/,
      );
      const body = res.text as string;
      const firstLine = body.split(/\r\n|\n/)[0];
      expect(firstLine).toContain("Doctor");
      expect(firstLine).toContain("TDS Amount");
      expect(body).toContain("TOTAL");

      // Audit row eventually lands (fire-and-forget).
      const prisma = await getPrisma();
      const auditRow = await waitForAuditFlush(prisma as any, {
        action: "TDS_REPORT_EXPORTED",
        entity: "invoice",
      });
      expect(auditRow).toBeTruthy();
    });

    it("rejects a non-ADMIN caller with 403", async () => {
      const doctorToken = await getAuthToken("DOCTOR");
      const res = await request(app)
        .get("/api/v1/billing/tds-report")
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects an out-of-range tdsRate with 400", async () => {
      const res = await request(app)
        .get("/api/v1/billing/tds-report?tdsRate=99")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/tdsRate/);
    });

    // ─── Pearl §4.4 row 120: branchId filter ───────────────────
    // The 3 newly-shipped reports added a branchId query param so
    // multi-branch tenants can narrow the rollup. Validation: the
    // branchId must resolve to a Branch in the caller's tenant.

    it("CSV header carries the new Branch column", async () => {
      const a = await seedPaidConsultation({ unitPrice: 1000 });
      void a;
      const res = await request(app)
        .get("/api/v1/billing/tds-report?format=csv")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const firstLine = (res.text as string).split(/\r\n|\n/)[0];
      expect(firstLine).toContain("Branch");
      // Doctor must still be the first column (preserves spreadsheet
      // muscle-memory for ops users).
      expect(firstLine.startsWith("Doctor,Branch,")).toBe(true);
    });

    it("rejects a non-existent branchId with 400", async () => {
      const res = await request(app)
        .get("/api/v1/billing/tds-report?branchId=00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Branch not found/i);
    });

    it("narrows results to a single branch when branchId is supplied", async () => {
      const prisma = await getPrisma();
      // Two branches in the (null-tenant) admin scope. The seeded admin
      // user has tenantId=null so the cross-tenant probe in the route
      // matches on { id: branchId } alone — both branches resolve.
      const tenant = await prisma.tenant.create({
        data: {
          name: "TDS Branch Filter Tenant",
          subdomain: `tds-branch-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });
      const branchA = await prisma.branch.create({
        data: { tenantId: tenant.id, name: "Branch Alpha (TDS)", isDefault: true, active: true },
      });
      const branchB = await prisma.branch.create({
        data: { tenantId: tenant.id, name: "Branch Beta (TDS)", isDefault: false, active: true },
      });

      // Two invoices: one stamped Branch A, one Branch B.
      const a = await seedPaidConsultation({ unitPrice: 1500 });
      const b = await seedPaidConsultation({ unitPrice: 2500 });
      await prisma.invoice.update({
        where: { id: a.invoice.id },
        data: { branchId: branchA.id },
      });
      await prisma.invoice.update({
        where: { id: b.invoice.id },
        data: { branchId: branchB.id },
      });

      const res = await request(app)
        .get(`/api/v1/billing/tds-report?branchId=${branchA.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.branchId).toBe(branchA.id);
      expect(res.body.data.branchName).toBe("Branch Alpha (TDS)");

      // Only doctor A's invoice should be aggregated.
      const buckets = res.body.data.byDoctor as Array<{
        doctorId: string;
      }>;
      const aShows = buckets.find((d) => d.doctorId === a.doctor.id);
      const bShows = buckets.find((d) => d.doctorId === b.doctor.id);
      expect(aShows).toBeTruthy();
      expect(bShows).toBeUndefined();
    });

    it("rejects a cross-tenant branchId with 400 when caller has a tenant", async () => {
      // Provision a fresh tenant + branch + a fresh admin user pinned
      // to that tenant — then mint a JWT that carries the tenant claim
      // and probe with another tenant's branchId.
      const prisma = await getPrisma();
      const jwt = await import("jsonwebtoken");
      const bcrypt = await import("bcryptjs");

      const tenantX = await prisma.tenant.create({
        data: {
          name: "TDS XTenant X",
          subdomain: `tds-xt-x-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });
      const tenantY = await prisma.tenant.create({
        data: {
          name: "TDS XTenant Y",
          subdomain: `tds-xt-y-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });
      const branchInY = await prisma.branch.create({
        data: { tenantId: tenantY.id, name: "Branch Y", isDefault: true, active: true },
      });

      // Admin pinned to tenant X — request branchInY (which belongs to Y).
      const xAdmin = await prisma.user.create({
        data: {
          email: `tds-xadmin-${Date.now()}@test.local`,
          name: "TDS XAdmin",
          phone: "9000000001",
          passwordHash: await bcrypt.default.hash("MedCoreT3st-2026", 4),
          role: "ADMIN",
          tenantId: tenantX.id,
        },
      });
      const xToken = jwt.default.sign(
        {
          userId: xAdmin.id,
          email: xAdmin.email,
          role: xAdmin.role,
          tenantId: tenantX.id,
        },
        process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
        { expiresIn: "1h" },
      );

      const res = await request(app)
        .get(`/api/v1/billing/tds-report?branchId=${branchInY.id}`)
        .set("Authorization", `Bearer ${xToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Branch not found/i);
    });
  });
});
