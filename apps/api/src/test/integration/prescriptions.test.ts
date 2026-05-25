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

    const { doctor, token: doctorTok } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Use the API to create the prescription (factory may bypass relations).
    // Must create as DOCTOR (not ADMIN) so the route's doctorId lookup
    // resolves to a real Doctor row — admin has no Doctor record.
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${doctorTok}`)
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

    // Issue #897: the /share endpoint now rejects unsigned prescriptions.
    // A freshly-created Rx has signatureUrl=null — sign it (as the doctor
    // would) so this test exercises the #242 RBAC path, not the #897 gate.
    await prisma.prescription.update({
      where: { id: prescriptionId },
      data: { signatureUrl: "https://example.test/sig/doc.png" },
    });

    const patientUser = await prisma.user.findUnique({ where: { id: patient.userId } });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post(`/api/v1/prescriptions/${prescriptionId}/share`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ channel: "SMS" });

    // Issue #242: a PATIENT can SHARE their own Rx (RBAC question, not a
    // delivery question). SMS is the remaining channel gated with 501 (no
    // gateway integrated). EMAIL and WHATSAPP are now wired but would 502
    // in this test env where neither provider is configured. The 501 still
    // proves the patient passed authorize() + assertPatientOwnsResource() —
    // exactly what #242 verifies. A real BOLA breach would 403/404.
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not yet available/i);
  });

  it("forbids a PATIENT from sharing another patient's prescription (403, issue #242)", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const { doctor, token: doctorTok } = await createDoctorWithToken();
    const owner = await createPatientFixture();
    const intruder = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: owner.id,
      doctorId: doctor.id,
    });
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${doctorTok}`)
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
    // The post-#511 BOLA sweep refactored this handler onto the
    // canonical `assertPatientOwnsResource`, which emits a uniform
    // "Forbidden" envelope (was a custom message that mentioned "own").
    expect(res.body.error).toMatch(/forbidden/i);
  });

  // ─── Issue #897: unsigned prescriptions must not be shared ──────────
  it("rejects sharing an unsigned prescription with 409 (issue #897)", async () => {
    const { doctor, token: doctorTok } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${doctorTok}`)
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

    // Freshly-created Rx has signatureUrl=null — sharing it must be blocked
    // BEFORE any channel delivery (the #897 bug was sharing draft Rx to
    // patients). 409, not the 501/502 a signed Rx would reach.
    const res = await request(app)
      .post(`/api/v1/prescriptions/${created.body.data.id}/share`)
      .set("Authorization", `Bearer ${doctorTok}`)
      .send({ channel: "EMAIL" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/unsigned/i);
  });

  // ─── Issue #898: structured medicineId FK on prescription items ─────
  // The Rx schema gained a `medicineId String?` column + FK to Medicine so
  // allergy/interaction engines, FEFO pharmacy dispense, and per-SKU refill
  // quotas can resolve a real master row. The POST handler accepts an
  // optional items[].medicineId, verifies it exists, and pins
  // `medicineName` from the master so the snapshot is canonical.
  it("creates a prescription with a valid medicineId FK and pins name from master (issue #898)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const med = await createMedicineFixture({ name: "Amoxicillin 500mg" });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Bacterial pharyngitis",
        items: [
          {
            medicineId: med.id,
            // Deliberately wrong free-text — the handler should overwrite
            // this from the master so the snapshot stays canonical.
            medicineName: "amoxi (typo)",
            dosage: "500mg",
            frequency: "TID",
            duration: "7 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.items?.length).toBe(1);
    expect(res.body.data?.items?.[0]?.medicineId).toBe(med.id);
    expect(res.body.data?.items?.[0]?.medicineName).toBe("Amoxicillin 500mg");
  });

  it("rejects a prescription with an unknown medicineId (400, issue #898)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Well-formed UUID that does not exist in the medicines table.
    const ghostMedicineId = "00000000-0000-4000-8000-000000000898";

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Test",
        items: [
          {
            medicineId: ghostMedicineId,
            medicineName: "Ghost Drug",
            dosage: "1mg",
            frequency: "OD",
            duration: "1d",
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/medicineId/i);
  });

  // ─────────────────────────────────────────────────────────
  // Pearl ERP Stage 1 §2.1.4 — drug-allergy block + override
  // ─────────────────────────────────────────────────────────

  it("blocks Rx when a prescribed medicine matches a patient allergy", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prisma = await getPrisma();
    // Patient has a documented Penicillin allergy.
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Penicillin",
        severity: "SEVERE",
        reaction: "Anaphylaxis",
        notedBy: doctor.userId,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "URI",
        items: [
          {
            medicineName: "Penicillin V 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allergy/i);
    expect(Array.isArray(res.body.allergyConflicts)).toBe(true);
    expect(res.body.allergyConflicts[0].allergen).toBe("Penicillin");
  });

  it("allows Rx when overrideAllergies=true with a reason", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prisma = await getPrisma();
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Penicillin",
        severity: "MODERATE",
        reaction: "Rash",
        notedBy: doctor.userId,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "URI",
        items: [
          {
            // Same medicine as the BLOCK test above so the same
            // bidirectional-substring match in checkPatientAllergies fires
            // — that's the precondition for the override branch (and the
            // audit row) to ever execute. "Amoxicillin" → "Penicillin"
            // doesn't substring-match either way (drug-class lookup is a
            // separate, ontology-heavy follow-up).
            medicineName: "Penicillin V 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
          },
        ],
        overrideAllergies: true,
        allergyOverrideReason: "Mild past reaction; risk/benefit favours treatment",
      });
    expect([200, 201]).toContain(res.status);

    // Audit log entry should record the override. The route uses
    // .catch(console.error) on auditLog so it's fire-and-forget — poll
    // briefly instead of relying on a single sleep window.
    let auditCount = 0;
    for (let i = 0; i < 30; i++) {
      auditCount = await prisma.auditLog.count({
        where: {
          action: "PRESCRIPTION_ALLERGY_OVERRIDE",
          entity: "patient",
          entityId: patient.id,
        },
      });
      if (auditCount > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(auditCount).toBeGreaterThan(0);
  });

  it("rejects overrideAllergies=true without an allergyOverrideReason (400)", async () => {
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
        diagnosis: "URI",
        items: [
          {
            medicineName: "Amoxicillin 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
          },
        ],
        overrideAllergies: true,
        // no reason
      });
    expect(res.status).toBe(400);
  });

  it("allows Rx when patient has unrelated allergies", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prisma = await getPrisma();
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        allergen: "Sulfa",
        severity: "MODERATE",
        notedBy: doctor.userId,
      },
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
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "3 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
  });

  // ─────────────────────────────────────────────────────────
  // Pearl ERP Stage 1 §12.c (gap-doc row 388) — Schedule-X Rx
  // requires explicit prescriber acknowledgement + audit
  // ─────────────────────────────────────────────────────────

  it("rejects Schedule-X Rx without scheduleXOverrideAcknowledged (400, gap-row 388)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Seed a Schedule-X medicine. The route resolves by name OR id, so a
    // name-only POST is enough to exercise the gate. createMedicineFixture
    // doesn't forward `schedule`, so write through prisma directly here so
    // the row actually carries `schedule: "X"`. Per-test unique suffix to
    // dodge the `Medicine.name @unique` collision across re-runs.
    const prisma = await getPrisma();
    const medName = `Morphine 10mg X-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await prisma.medicine.create({
      data: {
        name: medName,
        genericName: "Morphine",
        form: "tablet",
        strength: "10mg",
        category: "opioid",
        schedule: "X",
        isNarcotic: true,
        requiresRegister: true,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Severe post-op pain",
        items: [
          {
            medicineName: medName,
            dosage: "10mg",
            frequency: "QID",
            duration: "3 days",
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Schedule-X.*acknowledgement/i);
    expect(Array.isArray(res.body.scheduleXItems)).toBe(true);
    expect(res.body.scheduleXItems).toContain(medName);
  });

  it("allows Schedule-X Rx when scheduleXOverrideAcknowledged=true and audits the override (201, gap-row 388)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prisma = await getPrisma();
    const medName = `Fentanyl 50mcg X-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await prisma.medicine.create({
      data: {
        name: medName,
        genericName: "Fentanyl",
        form: "patch",
        strength: "50mcg",
        category: "opioid",
        schedule: "X",
        isNarcotic: true,
        requiresRegister: true,
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Severe chronic pain",
        scheduleXOverrideAcknowledged: true,
        items: [
          {
            medicineName: medName,
            dosage: "50mcg",
            frequency: "QID",
            duration: "3 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);

    // Fire-and-forget auditLog — poll briefly so we don't race the
    // deferred prisma.auditLog.create() the route schedules after the
    // 201 has already been sent (mirrors the PRESCRIPTION_ALLERGY_OVERRIDE
    // poll above).
    let auditCount = 0;
    for (let i = 0; i < 30; i++) {
      auditCount = await prisma.auditLog.count({
        where: {
          action: "SCHEDULE_X_OVERRIDE_ACKNOWLEDGED",
          entity: "prescription",
          entityId: res.body.data.id,
        },
      });
      if (auditCount > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(auditCount).toBeGreaterThan(0);
  });

  it("allows non-Schedule-X Rx without acknowledgement (201, gap-row 388 unaffected baseline)", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    // Schedule H (not X) — must not trigger the gate.
    const prisma = await getPrisma();
    const medName = `Ciprofloxacin 500mg H-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await prisma.medicine.create({
      data: {
        name: medName,
        genericName: "Ciprofloxacin",
        form: "tablet",
        strength: "500mg",
        category: "antibiotic",
        schedule: "H",
      },
    });

    const res = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "UTI",
        // Deliberately no scheduleXOverrideAcknowledged — the route must
        // not require it for a Schedule-H drug.
        items: [
          {
            medicineName: medName,
            dosage: "500mg",
            frequency: "BID",
            duration: "5 days",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
  });
});
