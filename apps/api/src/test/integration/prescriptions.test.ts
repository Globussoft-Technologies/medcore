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

  // ─── Issue #243: ?search=<diagnosis> narrows the list ──────────────
  // The adherence enrollment EntityPicker sends `?search=<text>`; the GET
  // used to ignore the param entirely so the dropdown was unfiltered. The
  // route now matches `diagnosis ILIKE %text%`.
  it("filters prescriptions by ?search=<diagnosis> (issue #243)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const apptA = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const apptB = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: apptA.id,
        patientId: patient.id,
        diagnosis: "Type 2 Diabetes Mellitus",
        items: [
          {
            medicineName: "Metformin",
            dosage: "500mg",
            frequency: "BID",
            duration: "30d",
          },
        ],
      });
    await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: apptB.id,
        patientId: patient.id,
        diagnosis: "Acute Gastroenteritis",
        items: [
          {
            medicineName: "ORS",
            dosage: "1 sachet",
            frequency: "PRN",
            duration: "3d",
          },
        ],
      });

    const res = await request(app)
      .get(`/api/v1/prescriptions?search=diabetes&patientId=${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const diagnoses = (res.body.data as Array<{ diagnosis: string }>).map(
      (r) => r.diagnosis
    );
    expect(diagnoses.length).toBeGreaterThanOrEqual(1);
    // Every returned row must contain "diabetes" (case-insensitive); the
    // gastroenteritis row must be filtered out.
    for (const d of diagnoses) {
      expect(d.toLowerCase()).toContain("diabetes");
    }
    expect(diagnoses).not.toContain("Acute Gastroenteritis");
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

  // ─── Issue #242: PATIENT can share their own prescription ───────────
  // The /:id/share endpoint records WHATSAPP/EMAIL/SMS channels. Previously
  // it was DOCTOR/ADMIN-only, so the "Share via WhatsApp/Email" buttons on
  // /dashboard/prescriptions always 403'd for PATIENT.

  it("allows the owning PATIENT to share their own prescription via WhatsApp (issue #242)", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Use the API to create the prescription (factory may bypass relations).
    const adminTok = await getAuthToken("ADMIN");
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Viral fever",
        items: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "3d",
          },
        ],
      });
    expect([200, 201]).toContain(created.status);
    const prescriptionId = created.body.data.id;

    const patientUser = await prisma.user.findUnique({ where: { id: patient.userId } });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post(`/api/v1/prescriptions/${prescriptionId}/share`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ channel: "WHATSAPP" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((res.body.data.sharedVia ?? "")).toContain("WHATSAPP");
  });

  it("forbids a PATIENT from sharing another patient's prescription (403, issue #242)", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const { doctor } = await createDoctorWithToken();
    const owner = await createPatientFixture();
    const intruder = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: owner.id,
      doctorId: doctor.id,
    });
    const adminTok = await getAuthToken("ADMIN");
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({
        appointmentId: appt.id,
        patientId: owner.id,
        diagnosis: "URTI",
        items: [
          {
            medicineName: "Cetirizine",
            dosage: "10mg",
            frequency: "OD",
            duration: "5d",
          },
        ],
      });
    expect([200, 201]).toContain(created.status);
    const prescriptionId = created.body.data.id;

    const intruderUser = await prisma.user.findUnique({ where: { id: intruder.userId } });
    const intruderToken = jwt.sign(
      { userId: intruderUser!.id, email: intruderUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post(`/api/v1/prescriptions/${prescriptionId}/share`)
      .set("Authorization", `Bearer ${intruderToken}`)
      .send({ channel: "EMAIL" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own/i);
  });
});
