/**
 * Integration tests — referral-commission auto-split (Pearl §4.1, gap row 101).
 *
 * What / which modules / why:
 *   - Exercises the full lifecycle of a `ReferralCommission` row:
 *     1. Auto-create on `POST /api/v1/billing/invoices` when the body
 *        carries `referralId` (Referral.commissionPercent wins) or
 *        `referringDoctorId` (Doctor.commissionPercent fallback).
 *     2. No row when neither side has a percentage (legitimate
 *        "no-commission" configuration).
 *     3. Void-cascade when a credit-note covers the full invoice.
 *     4. List + filter on `GET /api/v1/referral-commissions`.
 *     5. Mark-PAID via `PATCH /api/v1/referral-commissions/:id` + audit.
 *     6. RBAC — non-ADMIN/non-BILLING roles get 403 on list/mark-paid.
 *
 *   - Touches: apps/api/src/routes/billing.ts (POST /invoices hook +
 *     credit-note cascade) and apps/api/src/routes/referral-commissions.ts
 *     (CRUD surface). Schema models: Doctor.commissionPercent,
 *     Referral.commissionPercent, Invoice.referringDoctorId, and
 *     ReferralCommission itself (one-to-one with Invoice via @unique
 *     invoiceId).
 *
 *   - Uses the project's `safeAudit` polling helper for the PAID audit
 *     row (the PATCH handler fires-and-forgets per CLAUDE.md §1).
 */
import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let receptionToken: string;
let adminToken: string;

async function postInvoice(
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app)
    .post("/api/v1/billing/invoices")
    .set("Authorization", `Bearer ${receptionToken}`)
    .send(body);
}

/**
 * Helper — wire up a fresh patient + visit + referring doctor with a
 * specific commission % override on the Referral row.
 */
async function seedReferralScenario(opts: {
  doctorCommissionPercent?: number | null;
  referralCommissionPercent?: number | null;
  createReferralRow?: boolean;
}) {
  const prisma = await getPrisma();
  const patient = await createPatientFixture();
  const visitDoctor = await createDoctorFixture();
  const referringDoctor = await createDoctorFixture();
  if (opts.doctorCommissionPercent !== undefined) {
    await prisma.doctor.update({
      where: { id: referringDoctor.id },
      data: { commissionPercent: opts.doctorCommissionPercent as any },
    });
  }
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: visitDoctor.id,
  });
  let referralId: string | undefined;
  if (opts.createReferralRow) {
    const ref = await prisma.referral.create({
      data: {
        referralNumber: `REF-T${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        patientId: patient.id,
        fromDoctorId: referringDoctor.id,
        toDoctorId: visitDoctor.id,
        reason: "second opinion",
        status: "PENDING",
        commissionPercent:
          opts.referralCommissionPercent === undefined
            ? null
            : (opts.referralCommissionPercent as any),
      },
    });
    referralId = ref.id;
  }
  return { patient, visitDoctor, referringDoctor, appt, referralId };
}

describeIfDB("Referring-doctor commission auto-split (Pearl §4.1)", () => {
  beforeAll(async () => {
    await resetDB();
    receptionToken = await getAuthToken("RECEPTION");
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  describe("auto-create on invoice POST", () => {
    it("creates a ReferralCommission row when Referral.commissionPercent=10", async () => {
      const { patient, appt, referringDoctor, referralId } =
        await seedReferralScenario({
          createReferralRow: true,
          referralCommissionPercent: 10,
        });

      const res = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 1000,
          },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(res.status);
      const invoiceId = res.body.data.id;

      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId },
      });
      expect(commission).toBeTruthy();
      expect(commission!.referringDoctorId).toBe(referringDoctor.id);
      expect(commission!.referralId).toBe(referralId);
      expect(Number(commission!.commissionPercent)).toBeCloseTo(10, 2);
      // 10% of subtotal 1000 = 100
      expect(Number(commission!.commissionAmount)).toBeCloseTo(100, 2);
      expect(commission!.status).toBe("PENDING");
    });

    it("falls back to Doctor.commissionPercent=15 when Referral.commissionPercent is null", async () => {
      const { patient, appt, referringDoctor, referralId } =
        await seedReferralScenario({
          createReferralRow: true,
          referralCommissionPercent: null,
          doctorCommissionPercent: 15,
        });

      const res = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 2000,
          },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(res.status);
      const invoiceId = res.body.data.id;

      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId },
      });
      expect(commission).toBeTruthy();
      expect(commission!.referringDoctorId).toBe(referringDoctor.id);
      expect(Number(commission!.commissionPercent)).toBeCloseTo(15, 2);
      // 15% of 2000 = 300
      expect(Number(commission!.commissionAmount)).toBeCloseTo(300, 2);
    });

    it("creates NO commission row when both Doctor and Referral commissionPercent are null", async () => {
      const { patient, appt, referralId } = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: null,
        doctorCommissionPercent: null,
      });

      const res = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 500,
          },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(res.status);
      const invoiceId = res.body.data.id;

      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId },
      });
      expect(commission).toBeNull();
    });
  });

  describe("void cascade", () => {
    it("marks ReferralCommission VOIDED when a credit-note covers the full invoice", async () => {
      const { patient, appt, referralId } = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 5,
      });

      const invRes = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 1000,
          },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(invRes.status);
      const invoice = invRes.body.data;
      const invoiceTotal = Number(invoice.totalAmount);

      // Issue a credit-note for the FULL invoice total — the cascade
      // should void the linked ReferralCommission.
      const cnRes = await request(app)
        .post("/api/v1/billing/credit-notes")
        .set("Authorization", `Bearer ${receptionToken}`)
        .send({
          invoiceId: invoice.id,
          amount: invoiceTotal,
          reason: "service not rendered",
        });
      expect([200, 201]).toContain(cnRes.status);

      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId: invoice.id },
      });
      expect(commission).toBeTruthy();
      expect(commission!.status).toBe("VOIDED");
    });
  });

  describe("GET /api/v1/referral-commissions filtering", () => {
    it("filters by referringDoctorId — returns only that doctor's rows", async () => {
      const a = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 7,
      });
      const aInv = await postInvoice({
        appointmentId: a.appt.id,
        patientId: a.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 600 },
        ],
        taxPercentage: 0,
        referralId: a.referralId,
      });
      expect([200, 201]).toContain(aInv.status);

      const b = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 9,
      });
      const bInv = await postInvoice({
        appointmentId: b.appt.id,
        patientId: b.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 600 },
        ],
        taxPercentage: 0,
        referralId: b.referralId,
      });
      expect([200, 201]).toContain(bInv.status);

      // List filtered by doctor A — must not include doctor B's row.
      const listRes = await request(app)
        .get(`/api/v1/referral-commissions?referringDoctorId=${a.referringDoctor.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(listRes.status).toBe(200);
      const rows = listRes.body.data as Array<{
        referringDoctorId: string;
        invoiceId: string;
      }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(r.referringDoctorId).toBe(a.referringDoctor.id);
      }
      // And explicitly: doctor B's invoice id is not in the list.
      const bInvoiceIds = rows.filter((r) => r.invoiceId === bInv.body.data.id);
      expect(bInvoiceIds.length).toBe(0);
    });
  });

  describe("PATCH /api/v1/referral-commissions/:id", () => {
    it("marks PAID with audit row + paidAt timestamp", async () => {
      const { patient, appt, referralId } = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 8,
      });
      const invRes = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1500 },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(invRes.status);
      const invoiceId = invRes.body.data.id;

      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId },
      });
      expect(commission).toBeTruthy();

      const patchRes = await request(app)
        .patch(`/api/v1/referral-commissions/${commission!.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID", notes: "Bank transfer ref 12345" });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.status).toBe("PAID");
      expect(patchRes.body.data.paidAt).toBeTruthy();
      expect(patchRes.body.data.notes).toBe("Bank transfer ref 12345");

      // safeAudit fire-and-forget — poll with the project's helper.
      const auditRow = await waitForAuditFlush(prisma as any, {
        action: "REFERRAL_COMMISSION_PAID",
        entity: "referral_commission",
        entityId: commission!.id,
      });
      expect(auditRow).toBeTruthy();
    });

    it("GET /ledger with default range aggregates totals + byDoctor (Pearl §4.4)", async () => {
      // Seed two commissions for one doctor (one PAID, one PENDING) and
      // one for a second doctor (PENDING) so the aggregation has shape to
      // verify.
      const a = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 10,
      });
      const aInv1 = await postInvoice({
        appointmentId: a.appt.id,
        patientId: a.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: 0,
        referralId: a.referralId,
      });
      expect([200, 201]).toContain(aInv1.status);

      const a2 = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 10,
      });
      // Reuse doctor A by overriding the referringDoctor on a fresh referral.
      const prisma = await getPrisma();
      await prisma.referral.update({
        where: { id: a2.referralId! },
        data: { fromDoctorId: a.referringDoctor.id },
      });
      const aInv2 = await postInvoice({
        appointmentId: a2.appt.id,
        patientId: a2.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 2000 },
        ],
        taxPercentage: 0,
        referralId: a2.referralId,
      });
      expect([200, 201]).toContain(aInv2.status);

      const b = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 5,
      });
      const bInv = await postInvoice({
        appointmentId: b.appt.id,
        patientId: b.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 4000 },
        ],
        taxPercentage: 0,
        referralId: b.referralId,
      });
      expect([200, 201]).toContain(bInv.status);

      // Mark one of doctor A's commissions PAID via the existing PATCH.
      const aFirst = await prisma.referralCommission.findUnique({
        where: { invoiceId: aInv1.body.data.id },
      });
      const paidRes = await request(app)
        .patch(`/api/v1/referral-commissions/${aFirst!.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(paidRes.status).toBe(200);

      // Hit the ledger with no filters — default range = current month.
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.dateRange.from).toBeTruthy();
      expect(data.dateRange.to).toBeTruthy();

      // Totals sanity: totalAmount must equal sum of paid+pending+voided.
      const totals = data.totals;
      const sum =
        parseFloat(totals.paidAmount) +
        parseFloat(totals.pendingAmount) +
        parseFloat(totals.voidedAmount);
      expect(sum).toBeCloseTo(parseFloat(totals.totalAmount), 2);

      // byDoctor sums must roll up to top-level totalAmount.
      const byDoctorSum = (data.byDoctor as Array<{ totalAmount: string }>).reduce(
        (acc, b) => acc + parseFloat(b.totalAmount),
        0,
      );
      expect(byDoctorSum).toBeCloseTo(parseFloat(totals.totalAmount), 2);

      // Doctor A bucket exists; has 2 rows; totalAmount = 100 (10% of 1000) + 200 (10% of 2000) = 300.
      const aBucket = (data.byDoctor as Array<{
        referringDoctorId: string;
        count: number;
        totalAmount: string;
        paidAmount: string;
        pendingAmount: string;
      }>).find((d) => d.referringDoctorId === a.referringDoctor.id);
      expect(aBucket).toBeTruthy();
      expect(aBucket!.count).toBe(2);
      expect(parseFloat(aBucket!.totalAmount)).toBeCloseTo(300, 2);
      expect(parseFloat(aBucket!.paidAmount)).toBeCloseTo(100, 2);
      expect(parseFloat(aBucket!.pendingAmount)).toBeCloseTo(200, 2);
    });

    it("GET /ledger?referringDoctorId=X filters to just that doctor", async () => {
      const a = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 6,
      });
      const aInv = await postInvoice({
        appointmentId: a.appt.id,
        patientId: a.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: 0,
        referralId: a.referralId,
      });
      expect([200, 201]).toContain(aInv.status);

      const b = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 6,
      });
      const bInv = await postInvoice({
        appointmentId: b.appt.id,
        patientId: b.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: 0,
        referralId: b.referralId,
      });
      expect([200, 201]).toContain(bInv.status);

      const res = await request(app)
        .get(`/api/v1/referral-commissions/ledger?referringDoctorId=${a.referringDoctor.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const buckets = res.body.data.byDoctor as Array<{
        referringDoctorId: string;
      }>;
      // Either no buckets (nothing this month) or exactly one bucket = A.
      for (const b of buckets) {
        expect(b.referringDoctorId).toBe(a.referringDoctor.id);
      }
      // And the b doctor MUST NOT appear.
      const bShows = buckets.find(
        (d) => d.referringDoctorId === b.referringDoctor.id,
      );
      expect(bShows).toBeUndefined();
    });

    it("GET /ledger?from=&to= filters out commissions outside the window", async () => {
      const a = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 8,
      });
      const aInv = await postInvoice({
        appointmentId: a.appt.id,
        patientId: a.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: 0,
        referralId: a.referralId,
      });
      expect([200, 201]).toContain(aInv.status);

      // Window in the far past — must contain zero commissions.
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger?from=2020-01-01&to=2020-01-31")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.totals.totalCommissions).toBe(0);
      expect(parseFloat(res.body.data.totals.totalAmount)).toBe(0);
      expect(res.body.data.byDoctor.length).toBe(0);
    });

    it("GET /ledger?format=csv returns text/csv + attachment Content-Disposition", async () => {
      const a = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 11,
      });
      const aInv = await postInvoice({
        appointmentId: a.appt.id,
        patientId: a.patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: 0,
        referralId: a.referralId,
      });
      expect([200, 201]).toContain(aInv.status);

      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger?format=csv")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/i);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment;\s*filename="referral-commissions-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"/,
      );
      // Body must include the header row + at least one summary row.
      const body = res.text as string;
      expect(body.split(/\r\n|\n/)[0]).toContain("Doctor");
      expect(body).toContain("TOTAL");

      // Audit row eventually lands (fire-and-forget).
      const prisma = await getPrisma();
      const auditRow = await waitForAuditFlush(prisma as any, {
        action: "REFERRAL_COMMISSION_LEDGER_EXPORTED",
        entity: "referral_commission",
      });
      expect(auditRow).toBeTruthy();
    });

    it("GET /ledger rejected for non-ADMIN role (403)", async () => {
      const doctorToken = await getAuthToken("DOCTOR");
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects PATCH from a non-ADMIN role (403)", async () => {
      const { patient, appt, referralId } = await seedReferralScenario({
        createReferralRow: true,
        referralCommissionPercent: 12,
      });
      const invRes = await postInvoice({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          { description: "Consultation", category: "CONSULTATION", quantity: 1, unitPrice: 500 },
        ],
        taxPercentage: 0,
        referralId,
      });
      expect([200, 201]).toContain(invRes.status);
      const invoiceId = invRes.body.data.id;
      const prisma = await getPrisma();
      const commission = await prisma.referralCommission.findUnique({
        where: { invoiceId },
      });

      const doctorToken = await getAuthToken("DOCTOR");
      const patchRes = await request(app)
        .patch(`/api/v1/referral-commissions/${commission!.id}`)
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({ status: "PAID" });
      expect(patchRes.status).toBe(403);

      const listRes = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(listRes.status).toBe(403);
    });
  });
});
