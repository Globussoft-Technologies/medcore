// Cross-patient BOLA regression suite — pharmacy + payment-plans, issue #511.
//
// What this file covers
// ---------------------
// Two route files were swept under the issue #511 expanded audit criterion:
//
// PHARMACY (`apps/api/src/routes/pharmacy.ts`) — four GET handlers were
// reachable by ANY authenticated user (no per-handler `authorize()`),
// exposing inventory PII, supplier pricing, refund history, and stock
// transfer history to PATIENT-role JWTs:
//   - GET /api/v1/pharmacy/inventory/barcode/:barcode  (verdict C — STAFF-ONLY)
//   - GET /api/v1/pharmacy/substitutes/:medicineId     (verdict C — STAFF-ONLY)
//   - GET /api/v1/pharmacy/returns                     (verdict C — STAFF-ONLY)
//   - GET /api/v1/pharmacy/transfers                   (verdict C — STAFF-ONLY)
//
// PAYMENT-PLANS (`apps/api/src/routes/payment-plans.ts`) — three handlers
// exposed financial PHI per patient:
//   - GET /api/v1/payment-plans/:id    (verdict A — assertPatientOwnsResource)
//   - GET /api/v1/payment-plans         (verdict B — auto-scope to caller)
//   - GET /api/v1/payment-plans/overdue (verdict C — STAFF-ONLY)
//
// The pharmacy fixes apply `authorize(Role.ADMIN, Role.PHARMACIST, ...)`
// (resources are not patient-scoped at the schema level — staff-only is
// the correct contract). The payment-plans fixes use the canonical helper
// for /:id, auto-scope the list query to the caller's patientId for
// PATIENT-role JWTs, and lock /overdue (cross-patient financial PHI) to
// staff.
//
// Per cited route the suite asserts up to three cases:
//   1. PATIENT-A's token → other patient's resource → 403 (the bug)
//   2. PATIENT-A's token → own resource → 200 (positive control, where it
//      makes sense — payment-plans only)
//   3. DOCTOR/PHARMACIST/ADMIN token → resource → 200 (staff RBAC unbroken)
// For STAFF-ONLY (verdict C) handlers there is no positive PATIENT-self
// case — PATIENT cannot reach the surface at all.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let adminToken: string;
let pharmacistToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;

// Pharmacy fixtures
let inventoryItemAId: string;
let inventoryItemBarcode: string;
let medicineId: string;
let pharmacyReturnAId: string;
let stockTransferAId: string;

// Payment-plan fixtures
let planAId: string;
let planBId: string;

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_pharmpp_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000004",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-PPP-${label}-${Date.now()}`,
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
  "Cross-patient BOLA — pharmacy + payment-plans (issue #511)",
  () => {
    beforeAll(async () => {
      await resetDB();
      const prisma = await getPrisma();
      doctorToken = await getAuthToken("DOCTOR");
      adminToken = await getAuthToken("ADMIN");
      pharmacistToken = await getAuthToken("PHARMACIST");

      const a = await createPatientWithToken("A");
      const b = await createPatientWithToken("B");
      patientAToken = a.token;
      patientBToken = b.token;
      patientAId = a.patientId;
      patientBId = b.patientId;
      void patientBToken; // reserved for future inverse cases

      const doctor = await createDoctorFixture();

      // ── Pharmacy fixtures ──
      const medicine = await prisma.medicine.create({
        data: {
          name: `TestMed-${Date.now()}`,
          genericName: "Paracetamol",
          form: "TABLET",
          strength: "500mg",
        },
      });
      medicineId = medicine.id;
      inventoryItemBarcode = `BC${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const inv = await prisma.inventoryItem.create({
        data: {
          medicineId: medicine.id,
          batchNumber: `BATCH${Date.now()}`,
          quantity: 100,
          unitCost: 5,
          sellingPrice: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
          reorderLevel: 10,
          barcode: inventoryItemBarcode,
        },
      });
      inventoryItemAId = inv.id;

      const pharmReturn = await prisma.pharmacyReturn.create({
        data: {
          returnNumber: `PR${Date.now()}`,
          inventoryItemId: inv.id,
          quantity: 1,
          reason: "PATIENT_RETURNED",
          refundAmount: 10,
          performedBy: (await prisma.user.findFirst({ where: { role: "ADMIN" as any } }))!.id,
        },
      });
      pharmacyReturnAId = pharmReturn.id;

      const stockTransfer = await prisma.stockTransfer.create({
        data: {
          transferNumber: `ST${Date.now()}`,
          inventoryItemId: inv.id,
          fromLocation: "PharmacyA",
          toLocation: "PharmacyB",
          quantity: 5,
          performedBy: (await prisma.user.findFirst({ where: { role: "ADMIN" as any } }))!.id,
        },
      });
      stockTransferAId = stockTransfer.id;

      // ── Payment-plan fixtures: one plan per patient ──
      const apptA = await createAppointmentFixture({
        patientId: patientAId,
        doctorId: doctor.id,
      });
      const apptB = await createAppointmentFixture({
        patientId: patientBId,
        doctorId: doctor.id,
      });
      const invA = await createInvoiceFixture({
        patientId: patientAId,
        appointmentId: apptA.id,
        overrides: { totalAmount: 6000, subtotal: 6000 },
      });
      const invB = await createInvoiceFixture({
        patientId: patientBId,
        appointmentId: apptB.id,
        overrides: { totalAmount: 6000, subtotal: 6000 },
      });

      const planA = await prisma.paymentPlan.create({
        data: {
          planNumber: `PP${Date.now()}A${Math.floor(Math.random() * 1000)}`,
          invoiceId: invA.id,
          patientId: patientAId,
          totalAmount: 6000,
          downPayment: 0,
          installments: 3,
          installmentAmount: 2000,
          frequency: "MONTHLY",
          startDate: new Date(),
        },
      });
      planAId = planA.id;
      const planB = await prisma.paymentPlan.create({
        data: {
          planNumber: `PP${Date.now()}B${Math.floor(Math.random() * 1000)}`,
          invoiceId: invB.id,
          patientId: patientBId,
          totalAmount: 6000,
          downPayment: 0,
          installments: 3,
          installmentAmount: 2000,
          frequency: "MONTHLY",
          startDate: new Date(),
        },
      });
      planBId = planB.id;

      // Suppress unused-token lint flags — values are referenced individually below.
      void inventoryItemAId;
      void medicineId;
      void pharmacyReturnAId;
      void stockTransferAId;

      const mod = await import("../../app");
      app = mod.app;
    });

    // ──────────────────────────────────────────────────────────
    // PHARMACY — STAFF-ONLY surfaces (verdict C)
    // PATIENT must be denied (403); pharmacy/admin staff must succeed.
    // ──────────────────────────────────────────────────────────

    it("pharmacy/inventory/barcode/:barcode: PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/inventory/barcode/${inventoryItemBarcode}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("pharmacy/inventory/barcode/:barcode: PHARMACIST 200", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/inventory/barcode/${inventoryItemBarcode}`)
        .set("Authorization", `Bearer ${pharmacistToken}`);
      expect(res.status).toBe(200);
    });

    it("pharmacy/substitutes/:medicineId: PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/substitutes/${medicineId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("pharmacy/substitutes/:medicineId: DOCTOR 200", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/substitutes/${medicineId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    it("pharmacy/returns: PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/returns`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("pharmacy/returns: PHARMACIST 200", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/returns`)
        .set("Authorization", `Bearer ${pharmacistToken}`);
      expect(res.status).toBe(200);
    });

    it("pharmacy/transfers: PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/transfers`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("pharmacy/transfers: PHARMACIST 200", async () => {
      const res = await request(app)
        .get(`/api/v1/pharmacy/transfers`)
        .set("Authorization", `Bearer ${pharmacistToken}`);
      expect(res.status).toBe(200);
    });

    // ──────────────────────────────────────────────────────────
    // PAYMENT-PLANS — per-row + list scoping
    // ──────────────────────────────────────────────────────────

    it("payment-plans/:id: PATIENT-A cannot GET PATIENT-B's plan (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans/${planBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("payment-plans/:id: PATIENT-A CAN GET own plan (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans/${planAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(planAId);
    });

    it("payment-plans/:id: DOCTOR 200 (staff control)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans/${planBId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    it("payment-plans (list): PATIENT auto-scoped to own rows even with ?patientId=B", async () => {
      // Even when PATIENT-A passes ?patientId=<patientBId> trying to fish for
      // PATIENT-B's plans, the handler must override the filter and only
      // return rows where patientId === caller's own patientId.
      const res = await request(app)
        .get(`/api/v1/payment-plans?patientId=${patientBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids: string[] = (res.body.data ?? []).map((p: any) => p.id);
      expect(ids).not.toContain(planBId);
      // PATIENT-A only ever sees own row
      for (const p of res.body.data ?? []) {
        expect(p.patientId).toBe(patientAId);
      }
    });

    it("payment-plans (list): ADMIN sees all plans across patients (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids: string[] = (res.body.data ?? []).map((p: any) => p.id);
      expect(ids).toEqual(expect.arrayContaining([planAId, planBId]));
    });

    it("payment-plans/overdue: PATIENT denied (403, STAFF-ONLY)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans/overdue`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("payment-plans/overdue: ADMIN 200 (staff control)", async () => {
      const res = await request(app)
        .get(`/api/v1/payment-plans/overdue`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });
  }
);
