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
