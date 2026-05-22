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
  });
});
