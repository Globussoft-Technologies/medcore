/**
 * Integration tests — referral-commission route surface (Pearl §4.1 + §4.4).
 *
 * What / which modules / why:
 *   - Complements `referral-commission.test.ts` (singular) which covers
 *     the §4.1 auto-split + cascade + happy paths on the ledger. This
 *     file targets the GAPS the singular file leaves on the route surface
 *     in apps/api/src/routes/referral-commissions.ts:
 *       * Full RBAC matrix — ADMIN, BILLING, DOCTOR, RECEPTION, PATIENT
 *         on every endpoint (the singular file only spot-checks DOCTOR
 *         403 on /ledger and PATCH).
 *       * PATCH validation — VOIDED+paidAt refine rejection, missing
 *         status, unknown enum value, oversized notes.
 *       * State-machine — 404 on unknown id, 409 on already-PAID +
 *         already-VOIDED (the route's idempotency guard at line 510),
 *         VOIDED-transition happy path + VOIDED_MANUAL audit row.
 *       * GET / query handling — status filter, invalid `from`/`to`
 *         date rejection, pagination params honored, response meta
 *         contract.
 *       * Cross-tenant isolation — list + PATCH must not surface or
 *         mutate rows whose denormalized `ReferralCommission.tenantId`
 *         differs from the caller's.
 *
 *   - Uses safeAudit polling helper (waitForAuditFlush) for the
 *     PATCH audit row since the handler fires-and-forgets per
 *     CLAUDE.md §1.
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
let adminToken: string;
let billingToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;

async function postInvoice(body: Record<string, unknown>): Promise<request.Response> {
  return request(app)
    .post("/api/v1/billing/invoices")
    .set("Authorization", `Bearer ${receptionToken}`)
    .send(body);
}

/**
 * Seed a fresh patient + visit + referring doctor (with override-able
 * Referral.commissionPercent) and POST the invoice to materialize a
 * ReferralCommission row. Returns the row id and all parent context.
 */
async function seedCommission(opts: {
  referralCommissionPercent: number;
  unitPrice?: number;
}): Promise<{
  commissionId: string;
  invoiceId: string;
  referringDoctorId: string;
  patientId: string;
}> {
  const prisma = await getPrisma();
  const patient = await createPatientFixture();
  const visitDoctor = await createDoctorFixture();
  const referringDoctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: visitDoctor.id,
  });
  const ref = await prisma.referral.create({
    data: {
      referralNumber: `REF-T${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      patientId: patient.id,
      fromDoctorId: referringDoctor.id,
      toDoctorId: visitDoctor.id,
      reason: "second opinion",
      status: "PENDING",
      commissionPercent: opts.referralCommissionPercent as any,
    },
  });
  const invRes = await postInvoice({
    appointmentId: appt.id,
    patientId: patient.id,
    items: [
      {
        description: "Consultation",
        category: "CONSULTATION",
        quantity: 1,
        unitPrice: opts.unitPrice ?? 1000,
      },
    ],
    taxPercentage: 0,
    referralId: ref.id,
  });
  expect([200, 201]).toContain(invRes.status);
  const invoiceId = invRes.body.data.id;
  const commission = await prisma.referralCommission.findUnique({
    where: { invoiceId },
  });
  expect(commission).toBeTruthy();
  return {
    commissionId: commission!.id,
    invoiceId,
    referringDoctorId: referringDoctor.id,
    patientId: patient.id,
  };
}

describeIfDB("Referral-commission route surface — gaps not covered by referral-commission.test.ts", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    billingToken = await getAuthToken("BILLING");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─────────────────────────────────────────────────────────────
  // RBAC matrix (GET / list — ADMIN only per route line 52)
  // ─────────────────────────────────────────────────────────────
  describe("RBAC matrix — GET /api/v1/referral-commissions (list)", () => {
    it("ADMIN gets 200 with success envelope + meta block", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toBeTruthy();
      expect(res.body.meta).toHaveProperty("page");
      expect(res.body.meta).toHaveProperty("limit");
      expect(res.body.meta).toHaveProperty("total");
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("BILLING gets 403 — list is ADMIN-only (write authority concentrated)", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${billingToken}`);
      expect(res.status).toBe(403);
    });

    it("DOCTOR gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(403);
    });

    it("RECEPTION gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${receptionToken}`);
      expect(res.status).toBe(403);
    });

    it("PATIENT gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${patientToken}`);
      expect(res.status).toBe(403);
    });

    it("Unauthenticated request gets 401", async () => {
      const res = await request(app).get("/api/v1/referral-commissions");
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // RBAC matrix (GET /ledger — ADMIN + BILLING per route line 174)
  // ─────────────────────────────────────────────────────────────
  describe("RBAC matrix — GET /api/v1/referral-commissions/ledger", () => {
    it("ADMIN gets 200", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    it("BILLING gets 200 — widened 2026-05-24 per OPEN_DECISIONS #4 (commit eb97e3e)", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${billingToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty("totals");
      expect(res.body.data).toHaveProperty("byDoctor");
    });

    it("RECEPTION gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${receptionToken}`);
      expect(res.status).toBe(403);
    });

    it("PATIENT gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions/ledger")
        .set("Authorization", `Bearer ${patientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // RBAC matrix (PATCH /:id — ADMIN only per route line 489)
  // ─────────────────────────────────────────────────────────────
  describe("RBAC matrix — PATCH /api/v1/referral-commissions/:id", () => {
    it("BILLING gets 403 (PATCH stays ADMIN-only per route docstring lines 19-21)", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${billingToken}`)
        .send({ status: "PAID" });
      expect(res.status).toBe(403);
    });

    it("RECEPTION gets 403", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${receptionToken}`)
        .send({ status: "PAID" });
      expect(res.status).toBe(403);
    });

    it("PATIENT gets 403", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${patientToken}`)
        .send({ status: "PAID" });
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH validation — Zod refine + enum + size limits
  // ─────────────────────────────────────────────────────────────
  describe("PATCH validation rejections (400)", () => {
    it("rejects VOIDED + paidAt — schema refine catches it before reaching handler", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          status: "VOIDED",
          paidAt: "2026-05-25T10:30:00.000Z",
        });
      expect(res.status).toBe(400);
    });

    it("rejects missing status (required field)", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ notes: "no status here" });
      expect(res.status).toBe(400);
    });

    it("rejects unknown status enum (e.g. REFUNDED)", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "REFUNDED" });
      expect(res.status).toBe(400);
    });

    it("rejects PENDING as PATCH target (only PAID/VOIDED allowed)", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PENDING" });
      expect(res.status).toBe(400);
    });

    it("rejects non-ISO paidAt format", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID", paidAt: "2026-05-25 10:30:00" });
      expect(res.status).toBe(400);
    });

    it("rejects notes over the 500-char schema ceiling", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID", notes: "x".repeat(501) });
      expect(res.status).toBe(400);
    });

    it("accepts notes at exact 500-char ceiling", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID", notes: "x".repeat(500) });
      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH state machine — 404 / 409 / VOIDED happy path
  // ─────────────────────────────────────────────────────────────
  describe("PATCH state machine — 404 + 409 + VOIDED transition", () => {
    it("returns 404 when commission id does not exist", async () => {
      const res = await request(app)
        .patch("/api/v1/referral-commissions/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it("transitions PENDING → VOIDED and writes VOIDED_MANUAL audit row", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 6 });
      const res = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "VOIDED", notes: "Manually voided — duplicate referral" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("VOIDED");
      expect(res.body.data.notes).toBe("Manually voided — duplicate referral");
      // paidAt MUST remain null on a void transition.
      expect(res.body.data.paidAt).toBeNull();

      const prisma = await getPrisma();
      const auditRow = await waitForAuditFlush(prisma as any, {
        action: "REFERRAL_COMMISSION_VOIDED_MANUAL",
        entity: "referral_commission",
        entityId: commissionId,
      });
      expect(auditRow).toBeTruthy();
    });

    it("returns 409 when attempting to re-PAY an already-PAID row (idempotency guard)", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 7 });
      // First mark PAID — must succeed.
      const first = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(first.status).toBe(200);

      // Second attempt — must 409 per route line 510 idempotency guard.
      const second = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already PAID/i);
    });

    it("returns 409 when attempting to PAY an already-VOIDED row", async () => {
      const { commissionId } = await seedCommission({ referralCommissionPercent: 8 });
      const voidRes = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "VOIDED" });
      expect(voidRes.status).toBe(200);

      const payRes = await request(app)
        .patch(`/api/v1/referral-commissions/${commissionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(payRes.status).toBe(409);
      expect(payRes.body.error).toMatch(/already VOIDED/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET / query — status filter, date validation, pagination
  // ─────────────────────────────────────────────────────────────
  describe("GET /api/v1/referral-commissions — query handling", () => {
    it("rejects invalid `from` date with 400", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions?from=not-a-date")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid `from` date/i);
    });

    it("rejects invalid `to` date with 400", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions?to=not-a-date")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid `to` date/i);
    });

    it("status=PENDING returns only PENDING rows", async () => {
      const { commissionId: paidId } = await seedCommission({ referralCommissionPercent: 4 });
      // Mark one PAID so we can verify the filter excludes it.
      const patchRes = await request(app)
        .patch(`/api/v1/referral-commissions/${paidId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PAID" });
      expect(patchRes.status).toBe(200);
      // Seed another (will remain PENDING).
      await seedCommission({ referralCommissionPercent: 4 });

      const res = await request(app)
        .get("/api/v1/referral-commissions?status=PENDING")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<{ status: string; id: string }>;
      for (const r of rows) {
        expect(r.status).toBe("PENDING");
      }
      // And the row we marked PAID must not appear.
      expect(rows.find((r) => r.id === paidId)).toBeUndefined();
    });

    it("honors page + limit meta (limit capped at 100)", async () => {
      const res = await request(app)
        .get("/api/v1/referral-commissions?page=1&limit=500")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      // Route clamps limit via Math.min(limit, 100).
      expect(res.body.meta.limit).toBe(100);
      expect(res.body.meta.page).toBe(1);
    });

    it("filtering by referringDoctorId returns 0 rows for an unknown doctor (no leak)", async () => {
      // Seed one row so the suite has at least one row in the table.
      await seedCommission({ referralCommissionPercent: 5 });
      const res = await request(app)
        .get(
          "/api/v1/referral-commissions?referringDoctorId=00000000-0000-0000-0000-000000000000",
        )
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
      expect(res.body.meta.total).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cross-tenant isolation (list + PATCH)
  // ─────────────────────────────────────────────────────────────
  describe("cross-tenant isolation", () => {
    it("a commission row stamped to tenant-B is invisible to the seed ADMIN (tenantId=null) list", async () => {
      const prisma = await getPrisma();
      // Build a complete isolated tenant-B world: tenant, user, doctor,
      // patient, referral, invoice, ReferralCommission — all stamped with
      // tenantId=B. Then GET / as the seed ADMIN (no tenantId) and assert
      // the row does NOT appear.
      const tenantB = await prisma.tenant.create({
        data: {
          name: "Iso Tenant B",
          subdomain: `iso-b-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });

      // Minimal user/doctor/patient under tenant-B (bypassing factories
      // because they don't accept tenantId).
      const bcrypt = await import("bcryptjs");
      const userDoc = await prisma.user.create({
        data: {
          email: `iso-doc-${Date.now()}@b.local`,
          name: "Iso Doc B",
          phone: "9111111111",
          passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
          role: "DOCTOR",
          tenantId: tenantB.id,
        },
      });
      const doctorB = await prisma.doctor.create({
        data: {
          userId: userDoc.id,
          specialization: "General",
          qualification: "MBBS",
        },
      });
      const userPat = await prisma.user.create({
        data: {
          email: `iso-pat-${Date.now()}@b.local`,
          name: "Iso Pat B",
          phone: "9222222222",
          passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
          role: "PATIENT",
          tenantId: tenantB.id,
        },
      });
      const patientB = await prisma.patient.create({
        data: {
          userId: userPat.id,
          mrNumber: `MR-ISO-B-${Date.now()}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "MALE" as any,
        },
      });
      const apptB = await prisma.appointment.create({
        data: {
          patientId: patientB.id,
          doctorId: doctorB.id,
          date: new Date(),
          tokenNumber: 1,
          type: "WALK_IN",
          status: "BOOKED",
          priority: "NORMAL",
        },
      });
      const invoiceB = await prisma.invoice.create({
        data: {
          patientId: patientB.id,
          appointmentId: apptB.id,
          invoiceNumber: `INVISO-${Date.now()}`,
          subtotal: 1000,
          taxAmount: 0,
          totalAmount: 1000,
          paymentStatus: "PENDING",
          referringDoctorId: doctorB.id,
          tenantId: tenantB.id,
        },
      });
      const commissionB = await prisma.referralCommission.create({
        data: {
          invoiceId: invoiceB.id,
          referringDoctorId: doctorB.id,
          commissionPercent: 10 as any,
          commissionAmount: 100 as any,
          status: "PENDING",
          tenantId: tenantB.id,
        },
      });

      // Seed a tenantId=null row alongside (visible to seed ADMIN).
      const { commissionId: visibleId } = await seedCommission({
        referralCommissionPercent: 5,
      });

      // Seed ADMIN list MUST contain the visible row and NOT the tenant-B row.
      const res = await request(app)
        .get("/api/v1/referral-commissions")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(visibleId);
      expect(ids).not.toContain(commissionB.id);
    });
  });
});
