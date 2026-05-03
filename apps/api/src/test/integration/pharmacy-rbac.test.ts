// Pharmacy RBAC + Rx-rejection lifecycle integration tests.
//
// Closes Gap #8 from docs/TEST_GAPS_2026-05-03.md (route handler RBAC matrix
// + dispense lifecycle) AND wires the new Prescription.status state machine
// (PENDING → DISPENSED | REJECTED | CANCELLED) introduced by migration
// 20260503000001_witness_signature_and_prescription_status.
//
// Two clusters of test:
//   1. RBAC matrix for /pharmacy/inventory, /pharmacy/dispense,
//      /pharmacy/movements, /pharmacy/inventory/:id (PATCH).
//   2. Rx-rejection lifecycle for the new POST /pharmacy/prescriptions/:id/reject
//      endpoint — happy path, state-machine guards, audit row, RBAC.
import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createMedicineFixture,
  createInventoryFixture,
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createUserFixture,
} from "../factories";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let doctorToken: string;
let receptionToken: string;
let nurseToken: string;
let patientToken: string;

async function setupRx(opts: {
  quantityOnHand?: number;
  initialStatus?: "PENDING" | "DISPENSED" | "REJECTED" | "CANCELLED";
} = {}) {
  const prisma = await getPrisma();
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const uniqueName = `Amoxi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const med = await createMedicineFixture({ name: uniqueName });
  const inv = await createInventoryFixture({
    medicineId: med.id,
    overrides: { quantity: opts.quantityOnHand ?? 100 },
  });
  const rx = await prisma.prescription.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
      diagnosis: "Throat infection",
      status: opts.initialStatus ?? "PENDING",
      items: {
        create: [
          {
            medicineName: uniqueName,
            dosage: "500mg",
            frequency: "BID",
            duration: "5 days",
          },
        ],
      },
    },
  });
  return { patient, doctor, med, inv, rx };
}

// Schedule-H/H1/X variant — same shape as setupRx but the underlying medicine
// has requiresRegister=true, which triggers the §65 witnessSignature gate on
// POST /pharmacy/dispense.
async function setupScheduleHRx(opts: { quantityOnHand?: number } = {}) {
  const prisma = await getPrisma();
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const uniqueName = `Morphine-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const med = await createMedicineFixture({
    name: uniqueName,
    isNarcotic: true,
    requiresRegister: true,
    scheduleClass: "H",
  });
  const inv = await createInventoryFixture({
    medicineId: med.id,
    overrides: { quantity: opts.quantityOnHand ?? 100 },
  });
  const rx = await prisma.prescription.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
      diagnosis: "Post-op pain",
      status: "PENDING",
      items: {
        create: [
          {
            medicineName: uniqueName,
            dosage: "10mg",
            frequency: "QID",
            duration: "3 days",
          },
        ],
      },
    },
  });
  return { patient, doctor, med, inv, rx };
}

describeIfDB("Pharmacy RBAC + Rx-rejection (integration, Gap #8)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /pharmacy/inventory — RBAC matrix
  // RECEPTION + PATIENT must be denied; clinical/pharmacy roles allowed.
  // ───────────────────────────────────────────────────────

  it("GET /pharmacy/inventory: ADMIN → 200", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /pharmacy/inventory: PHARMACIST → 200", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${pharmacistToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /pharmacy/inventory: DOCTOR → 200", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /pharmacy/inventory: NURSE → 200", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /pharmacy/inventory: RECEPTION → 403 (issue #98 — stock hidden)", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /pharmacy/inventory: PATIENT → 403", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────
  // POST /pharmacy/dispense — RBAC + happy path + lifecycle
  // ───────────────────────────────────────────────────────

  it("POST /pharmacy/dispense: PHARMACIST happy path flips Rx.status to DISPENSED + decrements stock", async () => {
    const { inv, rx } = await setupRx({ quantityOnHand: 100 });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(200);
    expect(res.body.data.dispensed.length).toBeGreaterThanOrEqual(1);
    const prisma = await getPrisma();
    const after = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(after!.quantity).toBeLessThan(100);
    const refreshed = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(refreshed!.status).toBe("DISPENSED");
  });

  it("POST /pharmacy/dispense: writes PRESCRIPTION_DISPENSE audit row", async () => {
    const { rx } = await setupRx({ quantityOnHand: 100 });
    await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    const prisma = await getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PRESCRIPTION_DISPENSE", entityId: rx.id },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /pharmacy/dispense: insufficient stock → warning + Rx.status stays PENDING", async () => {
    // No stock at all → dispense returns warnings, dispensed=0, status NOT
    // flipped (only fully-dispensed Rx flip to DISPENSED).
    const { rx } = await setupRx({ quantityOnHand: 0 });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(200);
    expect(res.body.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.dispensed.length).toBe(0);
    const prisma = await getPrisma();
    const refreshed = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(refreshed!.status).toBe("PENDING");
  });

  it("POST /pharmacy/dispense: DOCTOR → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/dispense: RECEPTION → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/dispense: PATIENT → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────
  // GET /pharmacy/movements — pagination + date-range filter
  // ───────────────────────────────────────────────────────

  it("GET /pharmacy/movements: limit + offset paginate stock-movement rows", async () => {
    // Seed 5 movements via stock-movements API to ensure they are timestamped now.
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 1000 },
    });
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v1/pharmacy/stock-movements")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          inventoryItemId: inv.id,
          type: "DISPENSED",
          quantity: 1,
          reason: `pagination test #${i}`,
        });
    }
    const r1 = await request(app)
      .get("/api/v1/pharmacy/movements?limit=2&offset=0")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.data.length).toBe(2);
    const r2 = await request(app)
      .get("/api/v1/pharmacy/movements?limit=2&offset=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r2.status).toBe(200);
    expect(r2.body.data.length).toBe(2);
    // Different page = different rows
    const ids1 = new Set(r1.body.data.map((m: any) => m.id));
    const ids2 = new Set(r2.body.data.map((m: any) => m.id));
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });

  it("GET /pharmacy/movements: from/to date-range filter narrows result set", async () => {
    // The DEEP suite already covered baseline movement reads — here we only
    // check that an explicitly-future range returns zero (no movement was
    // created in the future) without 500-ing.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date();
    dayAfter.setDate(dayAfter.getDate() + 2);
    const res = await request(app)
      .get(
        `/api/v1/pharmacy/movements?from=${tomorrow.toISOString()}&to=${dayAfter.toISOString()}`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(0);
  });

  it("GET /pharmacy/movements: PATIENT → 403", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/movements")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────
  // PATCH /pharmacy/inventory/:id — RBAC (PHARMACIST + ADMIN only)
  // ───────────────────────────────────────────────────────

  it("PATCH /pharmacy/inventory/:id: PHARMACIST → 200", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: med.id });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/inventory/${inv.id}`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ location: "Shelf-X" });
    expect(res.status).toBe(200);
  });

  it("PATCH /pharmacy/inventory/:id: NURSE → 403", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: med.id });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/inventory/${inv.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ location: "Shelf-X" });
    expect(res.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────
  // POST /pharmacy/prescriptions/:id/reject — Rx rejection lifecycle
  // ───────────────────────────────────────────────────────

  it("POST /pharmacy/prescriptions/:id/reject: PHARMACIST rejecting PENDING Rx → 200 with status=REJECTED + reason + rejectedAt + rejectedBy", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Drug allergy noted in patient chart" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(res.body.data.rejectionReason).toBe(
      "Drug allergy noted in patient chart"
    );
    expect(res.body.data.rejectedAt).toBeTruthy();
    expect(res.body.data.rejectedBy).toBeTruthy();

    // Verify rejectedBy resolves to the pharmacist user id.
    const prisma = await getPrisma();
    const pharmUser = await prisma.user.findUnique({
      where: { email: "pharmacist@test.local" },
    });
    expect(res.body.data.rejectedBy).toBe(pharmUser!.id);
  });

  it("POST /pharmacy/prescriptions/:id/reject: writes PRESCRIPTION_REJECTED audit row", async () => {
    const { rx } = await setupRx();
    await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Wrong patient on chart header" });
    const prisma = await getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PRESCRIPTION_REJECTED", entityId: rx.id },
    });
    expect(audit).not.toBeNull();
    expect((audit!.details as any)?.reason).toBe("Wrong patient on chart header");
  });

  it("POST /pharmacy/prescriptions/:id/reject: rejecting already-DISPENSED Rx → 409 (state-machine guard)", async () => {
    const { rx } = await setupRx({ initialStatus: "DISPENSED" });
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Trying to reject a dispensed Rx" });
    expect(res.status).toBe(409);
    // Underlying row must remain DISPENSED, untouched.
    const prisma = await getPrisma();
    const refreshed = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(refreshed!.status).toBe("DISPENSED");
    expect(refreshed!.rejectionReason).toBeNull();
  });

  it("POST /pharmacy/prescriptions/:id/reject: rejecting already-CANCELLED Rx → 409", async () => {
    const { rx } = await setupRx({ initialStatus: "CANCELLED" });
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Already cancelled — should be blocked" });
    expect(res.status).toBe(409);
  });

  it("POST /pharmacy/prescriptions/:id/reject: empty reason → 400 (Zod min-length)", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "" });
    expect(res.status).toBe(400);
  });

  it("POST /pharmacy/prescriptions/:id/reject: reason under 10 chars → 400", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "no" });
    expect(res.status).toBe(400);
  });

  it("POST /pharmacy/prescriptions/:id/reject: DOCTOR → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ reason: "Doctor cannot reject — pharmacist-only" });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/prescriptions/:id/reject: NURSE → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ reason: "Nurse cannot reject — pharmacist-only" });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/prescriptions/:id/reject: RECEPTION → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ reason: "Reception cannot reject — pharmacist-only" });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/prescriptions/:id/reject: PATIENT → 403", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ reason: "Patient cannot reject — pharmacist-only" });
    expect(res.status).toBe(403);
  });

  it("POST /pharmacy/prescriptions/:id/reject: ADMIN can also reject (admin-or-pharmacist policy)", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .post(`/api/v1/pharmacy/prescriptions/${rx.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Admin override — pharmacist unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
  });

  it("POST /pharmacy/prescriptions/:id/reject: 404 for unknown Rx", async () => {
    const res = await request(app)
      .post(
        "/api/v1/pharmacy/prescriptions/00000000-0000-0000-0000-000000000000/reject"
      )
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Unknown prescription id" });
    expect(res.status).toBe(404);
  });

  it("POST /pharmacy/prescriptions/:id/reject: 400 for non-UUID id", async () => {
    const res = await request(app)
      .post("/api/v1/pharmacy/prescriptions/not-a-uuid/reject")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ reason: "Not a uuid path param" });
    expect(res.status).toBe(400);
  });

  // ───────────────────────────────────────────────────────
  // Full-Rx dispense — Schedule-H witness gate (§65 closure)
  // Surfaced by the Wave C controlled-substances work (e6c68e1): the full-Rx
  // dispense path auto-created ControlledSubstanceEntry rows for items where
  // medicine.requiresRegister=true WITHOUT capturing witnessSignature, so the
  // §65 gate enforced on POST /controlled-substances was bypassed when the
  // same drugs were dispensed through this route.
  // ───────────────────────────────────────────────────────

  describe("Full-Rx dispense — Schedule-H witness gate", () => {
    const VALID_WITNESS = "Dr. Vikram Kapoor / Senior Pharmacist";

    it("happy path: Schedule-H Rx + witnessSignature → 200, CSR row persists both signers", async () => {
      const { rx } = await setupScheduleHRx({ quantityOnHand: 100 });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({ prescriptionId: rx.id, witnessSignature: VALID_WITNESS });
      expect(res.status).toBe(200);
      expect(res.body.data.controlledCreated.length).toBeGreaterThanOrEqual(1);

      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0];
      expect(entry.witnessSignature).toBe(VALID_WITNESS);

      // Both signers captured: dispensedBy = pharmacist user, witness via
      // signature. (witnessUserId is optional — covered separately below.)
      expect(entry.dispensedBy).toBeTruthy();
      const pharmUser = await prisma.user.findUnique({
        where: { email: "pharmacist@test.local" },
      });
      expect(entry.dispensedBy).toBe(pharmUser!.id);
    });

    it("happy path with witnessUserId: CSR row persists FK to witness user", async () => {
      const { rx } = await setupScheduleHRx({ quantityOnHand: 100 });
      const witnessUser = await createUserFixture({ role: "PHARMACIST" });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({
          prescriptionId: rx.id,
          witnessSignature: VALID_WITNESS,
          witnessUserId: witnessUser.id,
        });
      expect(res.status).toBe(200);

      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].witnessUserId).toBe(witnessUser.id);
    });

    it("Schedule-H Rx without witnessSignature → 422 with scheduleHItems payload", async () => {
      const { rx, med } = await setupScheduleHRx({ quantityOnHand: 100 });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({ prescriptionId: rx.id });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/witnessSignature/i);
      expect(Array.isArray(res.body.scheduleHItems)).toBe(true);
      expect(res.body.scheduleHItems.length).toBeGreaterThanOrEqual(1);
      expect(
        res.body.scheduleHItems.some((it: any) => it.medicineId === med.id)
      ).toBe(true);

      // Pre-flight short-circuits: no CSR row, no stock decrement, Rx still PENDING.
      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBe(0);
      const refreshed = await prisma.prescription.findUnique({
        where: { id: rx.id },
      });
      expect(refreshed!.status).toBe("PENDING");
    });

    it("whitespace-only witnessSignature → 422 (Zod trim + min-3 catches it)", async () => {
      const { rx } = await setupScheduleHRx({ quantityOnHand: 100 });
      // Zod's .trim().min(3) on the body schema rejects "   " at the validate
      // middleware → 400. Either status is acceptable so long as the dispense
      // is blocked and no CSR row is written.
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({ prescriptionId: rx.id, witnessSignature: "   " });
      expect([400, 422]).toContain(res.status);

      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBe(0);
    });

    it("non-Schedule-H Rx → 200 even without witnessSignature (witness optional)", async () => {
      const { rx } = await setupRx({ quantityOnHand: 100 });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({ prescriptionId: rx.id });
      expect(res.status).toBe(200);
      // No CSR rows created for non-controlled meds.
      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBe(0);
    });

    it("bogus witnessUserId (UUID format, no matching user) → 400", async () => {
      const { rx } = await setupScheduleHRx({ quantityOnHand: 100 });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({
          prescriptionId: rx.id,
          witnessSignature: VALID_WITNESS,
          witnessUserId: "00000000-0000-4000-8000-000000000000",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/witness/i);

      // No CSR row — 400 short-circuits before the dispense transaction.
      const prisma = await getPrisma();
      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { prescriptionId: rx.id },
      });
      expect(entries.length).toBe(0);
    });
  });
});
