// Integration tests for Pearl ERP Stage 1 §2.1.4 gap-item #7 —
// drug-allergy block + override-with-reason on POST /api/v1/prescriptions.
// Covers: 409 with allergyConflicts payload when an active allergy
// matches a prescribed medicine; 201 + persisted override + audit row
// when allergyOverrideReason is supplied; 201 unchanged when there is no
// conflict (regression); 201 when the only matching allergy is inactive
// (active=false rows must NOT block).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createMedicineFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;

describeIfDB("Prescription drug-allergy block (Pearl §2.1.4 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("blocks Rx with 409 + allergyConflicts when active allergy matches medicine name", async () => {
    const prisma = await getPrisma();
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createMedicineFixture({ name: "Amoxicillin", genericName: "Amoxicillin" });
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Amoxicillin",
        severity: "SEVERE",
        reaction: "Anaphylaxis",
        notedBy: doctor.userId,
        active: true,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Strep throat",
        items: [
          {
            medicineName: "Amoxicillin",
            dosage: "500mg",
            frequency: "TID",
            duration: "7 days",
          },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/allergy/i);
    expect(Array.isArray(res.body.data?.allergyConflicts)).toBe(true);
    expect(res.body.data.allergyConflicts.length).toBeGreaterThanOrEqual(1);
    const conflict = res.body.data.allergyConflicts[0];
    expect(conflict.medicineName).toBe("Amoxicillin");
    expect(conflict.allergySubstance).toBe("Amoxicillin");
    expect(conflict.allergySeverity).toBe("SEVERE");
    expect(typeof conflict.itemIndex).toBe("number");
  });

  it("allows Rx + persists override + writes audit row when allergyOverrideReason supplied", async () => {
    const prisma = await getPrisma();
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createMedicineFixture({ name: "Penicillin", genericName: "Penicillin" });
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Penicillin",
        severity: "MODERATE",
        reaction: "Rash",
        notedBy: doctor.userId,
        active: true,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Bacterial pharyngitis",
        items: [
          {
            medicineName: "Penicillin",
            dosage: "250mg",
            frequency: "QID",
            duration: "10 days",
          },
        ],
        allergyOverrideReason:
          "Prior tolerance documented; only mild rash; benefit outweighs risk",
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);
    const rxId = res.body.data.id;
    expect(typeof rxId).toBe("string");

    const row = await prisma.prescription.findUnique({ where: { id: rxId } });
    expect(row?.allergyOverrideReason).toMatch(/Prior tolerance/);
    expect(row?.allergyOverrideAt).toBeTruthy();

    // safeAudit-style fire-and-forget — must use waitForAuditFlush to avoid
    // racing the deferred AuditLog.create() (CLAUDE.md gotcha #1).
    const audit = await waitForAuditFlush(prisma, {
      action: "PRESCRIPTION_ALLERGY_OVERRIDE",
      entity: "prescription",
      entityId: rxId,
    });
    expect(audit.action).toBe("PRESCRIPTION_ALLERGY_OVERRIDE");
    const details = audit.details as any;
    expect(Array.isArray(details?.allergyConflicts)).toBe(true);
    expect(details?.reason).toMatch(/Prior tolerance/);
  });

  it("creates Rx unchanged when there are no allergy conflicts (regression)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createMedicineFixture({ name: "Ibuprofen", genericName: "Ibuprofen" });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Headache",
        items: [
          {
            medicineName: "Ibuprofen",
            dosage: "400mg",
            frequency: "BID",
            duration: "3 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.allergyOverrideReason).toBeFalsy();
    expect(res.body.data?.allergyOverrideAt).toBeFalsy();
  });

  it("does NOT block when the matching allergy is inactive (active=false)", async () => {
    const prisma = await getPrisma();
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createMedicineFixture({ name: "Cefuroxime", genericName: "Cefuroxime" });
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Cefuroxime",
        severity: "MILD",
        notedBy: doctor.userId,
        active: false, // de-listed by a clinician — should not block
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Sinusitis",
        items: [
          {
            medicineName: "Cefuroxime",
            dosage: "500mg",
            frequency: "BID",
            duration: "7 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);
  });
});
