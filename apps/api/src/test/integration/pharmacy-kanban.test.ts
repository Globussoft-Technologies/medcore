// Integration tests for Pearl §4.3 (gap row 104) — Pharmacy dispensing
// Kanban. Covers the new PATCH /pharmacy/prescriptions/:id/status
// endpoint that drives the Kanban board transitions:
//   PENDING → DISPENSING → READY → DISPENSED  (forward path)
//   READY → DISPENSING                         (step-back for re-mix)
//   * → REJECTED / CANCELLED                   (terminal, handled
//                                               elsewhere — not via
//                                               this endpoint)
//
// Asserts: (1) legal forward transitions return 200 + flip the row,
// (2) illegal jumps return 409 without mutating, (3) RBAC — PHARMACY
// and ADMIN can mutate, PATIENT cannot, (4) every successful move
// writes a PRESCRIPTION_KANBAN_TRANSITION audit row with the
// from/to/prescriptionId payload.
//
// Uses the project's resetDB() once-per-file pattern + the existing
// createPrescriptionFixture factory. Test creds per CLAUDE.md:
// admin@test.local / MedCoreT3st-2026.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createPrescriptionFixture,
  createMedicineFixture,
  createInventoryFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let patientToken: string;
let prisma: any;

async function makeRx() {
  const { doctor } = await createDoctorWithToken();
  const patient = await createPatientFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return createPrescriptionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    appointmentId: appt.id,
  });
}

describeIfDB("Pharmacy Kanban — gap row 104 (Pearl §4.3)", () => {
  beforeAll(async () => {
    await resetDB();
    prisma = await getPrisma();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // Each test mints a fresh prescription via makeRx() so we can assert on
  // the single PRESCRIPTION_KANBAN_TRANSITION row for that Rx without
  // racing parallel tests in the same file.

  it("PENDING → DISPENSING transitions with 200 and flips the status", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISPENSING");
    const reloaded = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(reloaded?.status).toBe("DISPENSING");
  });

  it("PENDING → DISPENSED (skipping intermediates) is rejected with 409", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSED" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid transition/i);
    const reloaded = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(reloaded?.status).toBe("PENDING");
  });

  it("DISPENSED → DISPENSING is rejected with 409 (terminal can't be un-dispensed)", async () => {
    const rx = await makeRx();
    // Set straight to DISPENSED via Prisma to avoid driving through the
    // full /pharmacy/dispense path (which mutates inventory).
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "DISPENSED" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(409);
  });

  it("READY → DISPENSING is allowed (pharmacist step-back for re-mix)", async () => {
    const rx = await makeRx();
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "READY" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISPENSING");
  });

  it("READY → DISPENSED draws down inventory (FEFO) + records a DISPENSED movement", async () => {
    // Seed a medicine + stock that matches the default Rx line
    // ("Paracetamol 500mg", duration "5 days" → qty 5). Medicine.name is
    // unique and the DB is reset once-per-file, so reuse the row if a sibling
    // test already created it.
    const med =
      (await prisma.medicine.findFirst({
        where: { name: "Paracetamol 500mg" },
      })) ?? (await createMedicineFixture({ name: "Paracetamol 500mg" }));
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 100 },
    });

    const rx = await makeRx();
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "READY" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSED" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISPENSED");

    // On-hand quantity dropped by the dispensed qty (5).
    const reloadedInv = await prisma.inventoryItem.findUnique({
      where: { id: inv.id },
    });
    expect(reloadedInv?.quantity).toBe(95);

    // A negative DISPENSED stock movement references this prescription.
    const mv = await prisma.stockMovement.findFirst({
      where: { type: "DISPENSED", referenceId: rx.id },
    });
    expect(mv?.quantity).toBe(-5);
  });

  it("dispensing is idempotent — no double-decrement if stock was already drawn down", async () => {
    // Reuse the unique-named medicine if the sibling test already created it.
    const med =
      (await prisma.medicine.findFirst({
        where: { name: "Paracetamol 500mg" },
      })) ?? (await createMedicineFixture({ name: "Paracetamol 500mg" }));
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 100 },
    });
    const rx = await makeRx();
    // Simulate a prior full dispense: a DISPENSED movement already exists.
    await prisma.stockMovement.create({
      data: {
        inventoryItemId: inv.id,
        type: "DISPENSED",
        quantity: -5,
        referenceId: rx.id,
        performedBy: (await prisma.user.findFirst({ where: { role: "PHARMACIST" } }))!.id,
        reason: "pre-existing dispense",
      },
    });
    await prisma.inventoryItem.update({
      where: { id: inv.id },
      data: { quantity: 95 },
    });

    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "READY" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSED" });
    expect(res.status).toBe(200);

    // Quantity unchanged (still 95) — the move did not decrement a second time.
    const reloadedInv = await prisma.inventoryItem.findUnique({
      where: { id: inv.id },
    });
    expect(reloadedInv?.quantity).toBe(95);
  });

  it("deducts the prescribed Qty (6), not the day-count from duration (bug 2026-07)", async () => {
    // Reported bug: an ORS line prescribed as Qty 6 (Duration "3 days") only
    // decremented 3 — the old code parsed the first integer out of `duration`
    // ("3 days" → 3) instead of the real `Qty: 6` from instructions. Pin that
    // a Qty-6 line now draws down exactly 6 units.
    const med =
      (await prisma.medicine.findFirst({ where: { name: "ORS Sachet" } })) ??
      (await createMedicineFixture({ name: "ORS Sachet" }));
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 100 },
    });

    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const rx = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
      overrides: {
        items: [
          {
            medicineName: "ORS Sachet",
            dosage: "250mg",
            frequency: "1-0-1",
            duration: "3 days", // the trap: old code would deduct 3 from this
            instructions: "Route: IV | Qty: 6", // real prescribed quantity
          },
        ],
      },
    });
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "READY" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSED" });
    expect(res.status).toBe(200);

    // 100 − 6 = 94 (NOT 97, which the "3 days" duration heuristic produced).
    const reloadedInv = await prisma.inventoryItem.findUnique({
      where: { id: inv.id },
    });
    expect(reloadedInv?.quantity).toBe(94);

    const mv = await prisma.stockMovement.findFirst({
      where: { type: "DISPENSED", referenceId: rx.id },
    });
    expect(mv?.quantity).toBe(-6);
  });

  it("ADMIN can mutate", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
  });

  it("PATIENT is rejected with 403", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(403);
  });

  it("writes PRESCRIPTION_KANBAN_TRANSITION audit row with from/to payload on success", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    // The handler uses awaited auditLog (not safeAudit), so the row
    // is guaranteed present by the time the 200 returns — but use the
    // wait helper as belt + braces per CLAUDE.md gotcha #1.
    const row = await waitForAuditFlush(prisma, {
      action: "PRESCRIPTION_KANBAN_TRANSITION",
      entity: "prescription",
      entityId: rx.id,
    });
    expect(row).toBeTruthy();
    const details = (row as any).details ?? (row as any).payload;
    // AuditLog stores details as JSON; assert shape regardless of column name.
    const flat = typeof details === "string" ? JSON.parse(details) : details;
    expect(flat?.from).toBe("PENDING");
    expect(flat?.to).toBe("DISPENSING");
    expect(flat?.prescriptionId).toBe(rx.id);
  });

  it("GET /pharmacy/kanban groups Rx by status into columns", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .get("/api/v1/pharmacy/kanban?todayOnly=true")
      .set("Authorization", `Bearer ${pharmacistToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.columns).toBeTruthy();
    expect(Array.isArray(res.body.data.columns.PENDING)).toBe(true);
    // The board is now PER-MEDICINE: each card is a prescription line item
    // (card.id === item id), keyed back to its Rx via card.prescriptionId. Our
    // just-created Rx's line should be visible in PENDING.
    const allRxIds = (Object.values(res.body.data.columns) as any[][])
      .flat()
      .map((r: any) => r.prescriptionId);
    expect(allRxIds).toContain(rx.id);
  });
});
