// Cross-patient BOLA regression suite — lab + billing PATIENT surfaces, issue #511.
//
// What this file covers
// ---------------------
// Issue #511's expanded audit criterion (added 2026-05-05) catches a class
// of BOLA the original "no-authorize() handler" grep missed: handlers that
// DO list `Role.PATIENT` in `authorize(...)` but never re-check that the
// PATIENT caller actually owns the row keyed by `:id` / `:patientId`.
//
// `apps/api/src/routes/lab.ts` and `apps/api/src/routes/billing.ts` both
// expose high-PHI surfaces (lab orders, results, financial invoices) that
// PATIENT can hit by URL. Before this commit, several handlers were
// reachable cross-patient: GET /lab/results/:orderItemId, GET /lab/results
// /trends, GET /lab/orders/:id/report, GET /lab/orders/:id/pdf, GET
// /billing/invoices/:id (and PDF + tax-breakdown), POST /billing/pay-online
// and POST /billing/verify-payment. All of these now require the caller's
// patientId to match the resource's patientId for PATIENT-role JWTs.
//
// Modules / routes asserted (each: cross-patient 403, self 200, doctor 200)
// -----------------------------------------------------------------------
// LAB
// - GET /api/v1/lab/orders/:id                            (was already #474)
// - GET /api/v1/lab/orders/:id/report
// - GET /api/v1/lab/orders/:id/pdf                        (response is text/html)
// - GET /api/v1/lab/results/:orderItemId
// - GET /api/v1/lab/results/trends?patientId=
// BILLING
// - GET /api/v1/billing/invoices/:id
// - GET /api/v1/billing/invoices/:id/tax-breakdown
// - GET /api/v1/billing/invoices/:id/pdf                  (response is text/html)
// - POST /api/v1/billing/pay-online
// - POST /api/v1/billing/verify-payment                   (signature path,
//   asserts the BOLA gate fires BEFORE signature verification — i.e.
//   PATIENT-A can never reach the verify code path against PATIENT-B's
//   invoice, regardless of what they paste in razorpay* fields)
//
// Why a separate file
// -------------------
// The 2026-05-05 #511 fanout has multiple agents writing concurrently;
// per-route test files (this one + cross-patient-<x>.test.ts siblings)
// avoid merge collisions on the canonical cross-patient-rbac.test.ts.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;

// Lab fixtures
let labOrderAId: string;
let labOrderBId: string;
let orderItemAId: string;
let orderItemBId: string;

// Billing fixtures
let invoiceAId: string;
let invoiceBId: string;

// Helper: create a PATIENT user + linked Patient row + JWT.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_labbill_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000003",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-LBL-${label}-${Date.now()}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

describeIfDB(
  "Cross-patient BOLA — lab + billing PATIENT surfaces (issue #511)",
  () => {
    beforeAll(async () => {
      await resetDB();
      doctorToken = await getAuthToken("DOCTOR");

      const a = await createPatientWithToken("A");
      const b = await createPatientWithToken("B");
      patientAToken = a.token;
      patientBToken = b.token;
      patientAId = a.patientId;
      patientBId = b.patientId;

      const doctor = await createDoctorFixture();
      doctorId = doctor.id;

      // ── Lab fixtures ──
      const test = await createLabTestFixture();
      const orderA = await createLabOrderFixture({
        patientId: patientAId,
        doctorId,
        testIds: [test.id],
      });
      labOrderAId = orderA.id;
      orderItemAId = (orderA as any).items[0].id;

      const orderB = await createLabOrderFixture({
        patientId: patientBId,
        doctorId,
        testIds: [test.id],
      });
      labOrderBId = orderB.id;
      orderItemBId = (orderB as any).items[0].id;

      // ── Billing fixtures ──
      const apptA = await createAppointmentFixture({
        patientId: patientAId,
        doctorId,
      });
      const apptB = await createAppointmentFixture({
        patientId: patientBId,
        doctorId,
      });
      const invA = await createInvoiceFixture({
        patientId: patientAId,
        appointmentId: apptA.id,
      });
      const invB = await createInvoiceFixture({
        patientId: patientBId,
        appointmentId: apptB.id,
      });
      invoiceAId = invA.id;
      invoiceBId = invB.id;

      // patientBToken kept for future inverse cases; suppress lint.
      void patientBToken;

      const mod = await import("../../app");
      app = mod.app;
    });

    // ───────────────────────────────────────────────────────
    // LAB — /lab/orders/:id (already gated post-#474; re-asserted)
    // ───────────────────────────────────────────────────────

    it("lab/orders/:id: PATIENT-A cannot GET PATIENT-B's order (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("lab/orders/:id: PATIENT-A CAN GET own order (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(labOrderAId);
    });

    it("lab/orders/:id: DOCTOR can GET any order (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // LAB — /lab/orders/:id/report
    // ───────────────────────────────────────────────────────

    it("lab/orders/:id/report: PATIENT-A cannot GET PATIENT-B's report (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}/report`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("lab/orders/:id/report: PATIENT-A CAN GET own report (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderAId}/report`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("lab/orders/:id/report: DOCTOR can GET any report (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}/report`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // LAB — /lab/orders/:id/pdf (HTML response; gate is what we care about)
    // ───────────────────────────────────────────────────────

    it("lab/orders/:id/pdf: PATIENT-A cannot GET PATIENT-B's PDF (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}/pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("lab/orders/:id/pdf: PATIENT-A CAN GET own PDF (never 403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderAId}/pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).not.toBe(403);
    });

    it("lab/orders/:id/pdf: DOCTOR can GET any PDF (never 403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/orders/${labOrderBId}/pdf`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).not.toBe(403);
    });

    // ───────────────────────────────────────────────────────
    // LAB — /lab/results/:orderItemId
    // ───────────────────────────────────────────────────────

    it("lab/results/:orderItemId: PATIENT-A cannot GET PATIENT-B's results (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/${orderItemBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("lab/results/:orderItemId: PATIENT-A CAN GET own results (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/${orderItemAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("lab/results/:orderItemId: DOCTOR can GET any results (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/${orderItemBId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // LAB — /lab/results/trends?patientId=
    // ───────────────────────────────────────────────────────

    it("lab/results/trends: PATIENT-A cannot GET PATIENT-B's trends (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/trends?patientId=${patientBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("lab/results/trends: PATIENT-A CAN GET own trends (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/trends?patientId=${patientAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("lab/results/trends: DOCTOR can GET any patient's trends (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/lab/results/trends?patientId=${patientBId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // BILLING — /billing/invoices/:id
    // ───────────────────────────────────────────────────────

    it("billing/invoices/:id: PATIENT-A cannot GET PATIENT-B's invoice (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("billing/invoices/:id: PATIENT-A CAN GET own invoice (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(invoiceAId);
    });

    it("billing/invoices/:id: ADMIN can GET any invoice (200)", async () => {
      const adminToken = await getAuthToken("ADMIN");
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // BILLING — /billing/invoices/:id/tax-breakdown
    // ───────────────────────────────────────────────────────

    it("billing/invoices/:id/tax-breakdown: PATIENT-A cannot GET PATIENT-B's breakdown (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}/tax-breakdown`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("billing/invoices/:id/tax-breakdown: PATIENT-A CAN GET own breakdown (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceAId}/tax-breakdown`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("billing/invoices/:id/tax-breakdown: ADMIN can GET any breakdown (200)", async () => {
      const adminToken = await getAuthToken("ADMIN");
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}/tax-breakdown`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // BILLING — /billing/invoices/:id/pdf (HTML response; gate is what we care about)
    // ───────────────────────────────────────────────────────

    it("billing/invoices/:id/pdf: PATIENT-A cannot GET PATIENT-B's invoice PDF (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}/pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("billing/invoices/:id/pdf: PATIENT-A CAN GET own invoice PDF (never 403)", async () => {
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceAId}/pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).not.toBe(403);
    });

    it("billing/invoices/:id/pdf: ADMIN can GET any invoice PDF (never 403)", async () => {
      const adminToken = await getAuthToken("ADMIN");
      const res = await request(app)
        .get(`/api/v1/billing/invoices/${invoiceBId}/pdf`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).not.toBe(403);
    });

    // ───────────────────────────────────────────────────────
    // BILLING — POST /billing/pay-online
    // ───────────────────────────────────────────────────────

    it("billing/pay-online: PATIENT-A cannot create order for PATIENT-B's invoice (403)", async () => {
      const res = await request(app)
        .post(`/api/v1/billing/pay-online`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ invoiceId: invoiceBId });
      expect(res.status).toBe(403);
    });

    it("billing/pay-online: PATIENT-A can initiate own pay-online (never 403)", async () => {
      // Razorpay creds are not configured in CI; the route either succeeds
      // (mock mode) or 5xx on the gateway. The point of this assertion is
      // that the BOLA gate does NOT fire on the patient's own invoice.
      const res = await request(app)
        .post(`/api/v1/billing/pay-online`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ invoiceId: invoiceAId });
      expect(res.status).not.toBe(403);
    });

    // ───────────────────────────────────────────────────────
    // BILLING — POST /billing/verify-payment
    // ───────────────────────────────────────────────────────

    it("billing/verify-payment: PATIENT-A cannot verify against PATIENT-B's invoice (403)", async () => {
      // The handler's first body-validation step (400 missing fields) runs
      // BEFORE the ownership check, so we send all 4 fields with bogus
      // values. The 403 must come from the BOLA gate, not signature
      // verification (which would 400) — i.e. ownership is checked first
      // for any caller that supplies a complete body.
      const res = await request(app)
        .post(`/api/v1/billing/verify-payment`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({
          invoiceId: invoiceBId,
          razorpayOrderId: "order_FAKE",
          razorpayPaymentId: "pay_FAKE",
          razorpaySignature: "sig_FAKE",
        });
      expect(res.status).toBe(403);
    });
  }
);
