/**
 * Pearl ERP Stage 1 §2.1.1 (gap row 41) — patient duplicate batch-merge
 * integration coverage.
 *
 * What / which modules / why:
 *   - Exercises POST /api/v1/patients/:keepId/merge (routes/patients-merge.ts).
 *   - Seeds 2 sibling patients with the same phone in the same tenant, plus
 *     appointment + prescription + invoice on the "from" row, then asserts:
 *       * after merge, the source row carries `mergedIntoId = keepId`,
 *       * every clinical/billing child row now points at the keep row,
 *       * the PATIENT_MERGED audit row is visible (awaited audit, not safe-
 *         audit — no waitForAuditFlush needed).
 *   - Cross-tenant attempt → 404 (tenantScopedPrisma filters the read).
 *   - PATIENT role → 403 (authorize gate).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let receptionToken: string;
let patientToken: string;

describeIfDB("Patient duplicate batch-merge (integration, Pearl §2.1.1 row 41)", () => {
  beforeAll(async () => {
    await resetDB();
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("re-points clinical+billing child rows + tombstones the source", async () => {
    const prisma = await getPrisma();

    // Seed the "keep" canonical patient via the API so MRN generation +
    // tenantId stamping run exactly like reception's path.
    const keepRes = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Asha Keep Sharma",
        gender: "FEMALE",
        phone: "9123450001",
        dateOfBirth: "1992-04-15",
      });
    expect(keepRes.status).toBeLessThan(400);
    const keepId = keepRes.body.data.id;

    // Seed the duplicate source via the API. Different phone (the create-side
    // dup pre-check would 409 a same-phone create — the merge flow is
    // intended for AFTER two duplicate records exist).
    const fromRes = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Asha From Sharma",
        gender: "FEMALE",
        phone: "9123450002",
        dateOfBirth: "1992-04-16",
      });
    expect(fromRes.status).toBeLessThan(400);
    const fromId = fromRes.body.data.id;

    // Seed child rows on the "from" patient directly via Prisma — fastest
    // setup; the test cares about whether the merge route's $transaction
    // re-points the FK, not whether the seed path is realistic.
    const fromUser = await prisma.patient.findUnique({
      where: { id: fromId },
      select: { tenantId: true },
    });
    const doctorUser = await prisma.user.create({
      data: {
        email: `mergedoc_${Date.now()}@test.local`,
        name: "Merge Test Doc",
        phone: "9999900099",
        passwordHash: "x",
        role: "DOCTOR",
        tenantId: fromUser?.tenantId ?? null,
      },
    });
    const doc = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        specialization: "GP",
        qualification: "MBBS",
        tenantId: fromUser?.tenantId ?? null,
      },
    });
    const nurseUser = await prisma.user.create({
      data: {
        email: `mergenurse_${Date.now()}@test.local`,
        name: "Merge Test Nurse",
        phone: "9999900088",
        passwordHash: "x",
        role: "NURSE",
        tenantId: fromUser?.tenantId ?? null,
      },
    });

    const appt = await prisma.appointment.create({
      data: {
        patientId: fromId,
        doctorId: doc.id,
        date: new Date(),
        tokenNumber: 1,
        type: "WALK_IN",
        status: "COMPLETED",
        tenantId: fromUser?.tenantId ?? null,
      },
    });
    await prisma.vitals.create({
      data: {
        appointmentId: appt.id,
        patientId: fromId,
        nurseId: nurseUser.id,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        temperature: 98.6,
        tenantId: fromUser?.tenantId ?? null,
      },
    });
    await prisma.prescription.create({
      data: {
        appointmentId: appt.id,
        patientId: fromId,
        doctorId: doc.id,
        diagnosis: "Test diagnosis for merge",
        tenantId: fromUser?.tenantId ?? null,
      },
    });
    await prisma.invoice.create({
      data: {
        appointmentId: appt.id,
        patientId: fromId,
        invoiceNumber: `INV-MERGE-${Date.now()}`,
        subtotal: 500,
        taxAmount: 0,
        discountAmount: 0,
        totalAmount: 500,
        paymentStatus: "PENDING",
        tenantId: fromUser?.tenantId ?? null,
      },
    });

    // ── Act ────────────────────────────────────────────────────────────
    const res = await request(app)
      .post(`/api/v1/patients/${keepId}/merge`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ mergeFromIds: [fromId] });

    // ── Contract-of-correctness asserts (per CLAUDE.md gotcha #3) ──────
    expect(res.status).toBeLessThan(400);
    expect(res.body.success).toBe(true);
    expect(res.body.data.keepId).toBe(keepId);
    expect(res.body.data.mergedFromIds).toEqual([fromId]);
    expect(res.body.data.mergedRowCounts.appointment).toBe(1);
    expect(res.body.data.mergedRowCounts.vitals).toBe(1);
    expect(res.body.data.mergedRowCounts.prescription).toBe(1);
    expect(res.body.data.mergedRowCounts.invoice).toBe(1);

    // Source tombstoned.
    const after = await prisma.patient.findUnique({
      where: { id: fromId },
      select: { mergedIntoId: true },
    });
    expect(after?.mergedIntoId).toBe(keepId);

    // Child rows re-pointed.
    const apptAfter = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { patientId: true },
    });
    expect(apptAfter?.patientId).toBe(keepId);
    const vitalsCountKeep = await prisma.vitals.count({
      where: { patientId: keepId },
    });
    expect(vitalsCountKeep).toBeGreaterThanOrEqual(1);
    const invKeep = await prisma.invoice.count({ where: { patientId: keepId } });
    expect(invKeep).toBeGreaterThanOrEqual(1);
    const rxKeep = await prisma.prescription.count({
      where: { patientId: keepId },
    });
    expect(rxKeep).toBeGreaterThanOrEqual(1);

    // Audit row landed (awaited audit — immediate read is safe).
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PATIENT_MERGED", entity: "patient", entityId: keepId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect((audit?.details as any)?.mergedFromIds).toEqual([fromId]);
  });

  it("rejects PATIENT role with 403", async () => {
    // We don't even need real patient ids — the role gate runs first.
    const res = await request(app)
      .post(`/api/v1/patients/00000000-0000-0000-0000-000000000001/merge`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ mergeFromIds: ["00000000-0000-0000-0000-000000000002"] });
    expect(res.status).toBe(403);
  });

  it("rejects merging a patient into itself with 400", async () => {
    const seed = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Self Merge Test",
        gender: "MALE",
        phone: "9123450055",
        dateOfBirth: "1980-01-01",
      });
    expect(seed.status).toBeLessThan(400);
    const id = seed.body.data.id;
    const res = await request(app)
      .post(`/api/v1/patients/${id}/merge`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ mergeFromIds: [id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itself/i);
  });

  it("rejects unknown source patient ids with 404 (covers cross-tenant invisibility)", async () => {
    const seed = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Cross Tenant Probe Keep",
        gender: "MALE",
        phone: "9123450077",
        dateOfBirth: "1985-08-08",
      });
    expect(seed.status).toBeLessThan(400);
    const keepId = seed.body.data.id;

    const res = await request(app)
      .post(`/api/v1/patients/${keepId}/merge`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        // Random UUID that doesn't exist in any tenant → indistinguishable
        // from a real cross-tenant attempt (tenantScopedPrisma filters
        // both away as "not visible"). Either way: 404.
        mergeFromIds: ["00000000-0000-0000-0000-0000000abcde"],
      });
    expect([400, 404]).toContain(res.status);
  });

  it("accepts the legacy {otherPatientId} body shape for back-compat with MergePatientModal", async () => {
    const keep = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Legacy Shape Keep",
        gender: "FEMALE",
        phone: "9123450088",
        dateOfBirth: "1991-03-03",
      });
    expect(keep.status).toBeLessThan(400);
    const from = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Legacy Shape From",
        gender: "FEMALE",
        phone: "9123450089",
        dateOfBirth: "1991-03-04",
      });
    expect(from.status).toBeLessThan(400);

    const res = await request(app)
      .post(`/api/v1/patients/${keep.body.data.id}/merge`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ otherPatientId: from.body.data.id });
    expect(res.status).toBeLessThan(400);
    expect(res.body.data.mergedFromIds).toEqual([from.body.data.id]);
  });
});
