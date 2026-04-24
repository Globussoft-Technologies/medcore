// Integration tests for prescriptions router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createMedicineFixture,
} from "../factories";

let app: any;
let adminToken: string;

describeIfDB("Prescriptions API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a prescription with valid items", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Acute pharyngitis",
        items: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
            instructions: "After food",
            refills: 0,
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.diagnosis).toBe("Acute pharyngitis");
    expect(res.body.data?.items?.length).toBe(1);
  });

  it("check-interactions returns no warnings for empty medicine set", async () => {
    const { token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/prescriptions/check-interactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, items: [] });
    expect(res.status).toBe(200);
    expect(res.body.data?.warnings).toEqual([]);
    expect(res.body.data?.hasBlocking).toBe(false);
  });

  it("blocks SEVERE interaction without overrideWarnings", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Seed two medicines and an interaction
    const prisma = await getPrisma();
    const medA = await createMedicineFixture({ name: "Warfarin" });
    const medB = await createMedicineFixture({ name: "Aspirin" });
    await prisma.drugInteraction.create({
      data: {
        drugAId: medA.id,
        drugBId: medB.id,
        severity: "SEVERE",
        description: "Increased bleeding risk",
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "AF",
        items: [
          {
            medicineName: "Warfarin",
            dosage: "5mg",
            frequency: "OD",
            duration: "30d",
          },
          {
            medicineName: "Aspirin",
            dosage: "75mg",
            frequency: "OD",
            duration: "30d",
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("allows SEVERE interaction when overrideWarnings=true", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prisma = await getPrisma();
    const medA = await createMedicineFixture({ name: "Heparin" });
    const medB = await createMedicineFixture({ name: "Clopidogrel" });
    await prisma.drugInteraction.create({
      data: {
        drugAId: medA.id,
        drugBId: medB.id,
        severity: "SEVERE",
        description: "Increased bleeding risk",
      },
    });
    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "PCI",
        overrideWarnings: true,
        items: [
          {
            medicineName: "Heparin",
            dosage: "5000U",
            frequency: "BID",
            duration: "3d",
          },
          {
            medicineName: "Clopidogrel",
            dosage: "75mg",
            frequency: "OD",
            duration: "90d",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
  });

  it("lists prescriptions", async () => {
    const res = await request(app)
      .get("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filters prescriptions by patientId", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Cold",
        items: [
          {
            medicineName: "Cetirizine",
            dosage: "10mg",
            frequency: "OD",
            duration: "5d",
          },
        ],
      });
    const res = await request(app)
      .get(`/api/v1/prescriptions?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/prescriptions");
    expect(res.status).toBe(401);
  });

  it("rejects invalid create payload (400)", async () => {
    const { token } = await createDoctorWithToken();
    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ appointmentId: "x", items: [] });
    expect(res.status).toBe(400);
  });

  // ─── Issue #9: negative dosage rejected server-side ─────────────────
  it("rejects negative dosage '-100mg' (400, issue #9)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Pain",
        items: [
          {
            medicineName: "Paracetamol",
            dosage: "-100mg",
            frequency: "TID",
            duration: "3d",
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  // ─── Issue #17: non-UUID appointmentId rejected ─────────────────────
  it("rejects non-UUID appointmentId (400, issue #17)", async () => {
    const { token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: "abc",
        patientId: patient.id,
        diagnosis: "x",
        items: [
          {
            medicineName: "Paracetamol",
            dosage: "500mg",
            frequency: "OD",
            duration: "1d",
          },
        ],
      });
    expect(res.status).toBe(400);
  });
});
