// Integration tests for the waitlist router (patient or reception joins;
// patient self-restrictions on cancel/list; admin/reception/doctor manual
// notify-next trigger).
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

// notifyNextInWaitlist hits sendNotification — stub to avoid real channels.
vi.mock("../../services/notification", async () => {
  const actual = await vi.importActual<typeof import("../../services/notification")>(
    "../../services/notification"
  );
  return {
    ...actual,
    sendNotification: vi.fn(async () => undefined),
    sendEmail: vi.fn(async () => undefined),
  };
});

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("Waitlist API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /waitlist ──────────────────────────────────
  it("reception adds a patient to the waitlist for a doctor", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        reason: "Walk-in spillover",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.patientId).toBe(patient.id);
    expect(res.body.data?.doctorId).toBe(doctor.id);
    expect(res.body.data?.status).toBe("WAITING");
  });

  it("patient can join the waitlist for themselves", async () => {
    const prisma = await getPrisma();
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });
    const selfPatient = await prisma.patient.findFirst({
      where: { userId: patientUser!.id },
    });
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ patientId: selfPatient!.id, doctorId: doctor.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.patientId).toBe(selfPatient!.id);
  });

  it("rejects a patient trying to join the waitlist on another patient's behalf (403)", async () => {
    const otherPatient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ patientId: otherPatient.id, doctorId: doctor.id });
    expect(res.status).toBe(403);
  });

  it("blocks duplicate WAITING entry for same patient + doctor (409)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const first = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    expect([200, 201]).toContain(first.status);
    const dup = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    expect(dup.status).toBe(409);
  });

  it("rejects POST /waitlist with bad payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: "not-a-uuid", doctorId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects POST /waitlist without auth (401)", async () => {
    const res = await request(app).post("/api/v1/waitlist").send({});
    expect(res.status).toBe(401);
  });

  // ─── GET /waitlist ───────────────────────────────────
  it("reception lists waitlist entries", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    const res = await request(app)
      .get("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filters waitlist by doctorId query", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    const res = await request(app)
      .get(`/api/v1/waitlist?doctorId=${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const entry of res.body.data) {
      expect(entry.doctorId).toBe(doctor.id);
    }
  });

  it("patient list is auto-scoped to the patient's own entries", async () => {
    // Seed an entry for *another* patient that the logged-in patient must
    // not see.
    const otherPatient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: otherPatient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });
    const selfPatient = await prisma.patient.findFirst({
      where: { userId: patientUser!.id },
    });

    const res = await request(app)
      .get("/api/v1/waitlist")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    for (const entry of res.body.data) {
      expect(entry.patientId).toBe(selfPatient!.id);
    }
  });

  it("rejects GET /waitlist without auth (401)", async () => {
    const res = await request(app).get("/api/v1/waitlist");
    expect(res.status).toBe(401);
  });

  // ─── PATCH /waitlist/:id/cancel ──────────────────────
  it("admin cancels a waitlist entry", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const create = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/waitlist/${id}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("patient can cancel only their own waitlist entry", async () => {
    const prisma = await getPrisma();
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });
    const selfPatient = await prisma.patient.findFirst({
      where: { userId: patientUser!.id },
    });
    const doctor = await createDoctorFixture();
    const created = await prisma.waitlistEntry.create({
      data: { patientId: selfPatient!.id, doctorId: doctor.id },
    });
    const res = await request(app)
      .patch(`/api/v1/waitlist/${created.id}/cancel`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("rejects patient cancelling someone else's entry (403)", async () => {
    const otherPatient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const create = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: otherPatient.id, doctorId: doctor.id });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/waitlist/${id}/cancel`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when cancelling an unknown entry", async () => {
    const res = await request(app)
      .patch("/api/v1/waitlist/00000000-0000-0000-0000-000000000000/cancel")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects PATCH /:id/cancel without auth (401)", async () => {
    const res = await request(app).patch(
      "/api/v1/waitlist/00000000-0000-0000-0000-000000000000/cancel"
    );
    expect(res.status).toBe(401);
  });

  // ─── POST /waitlist/notify-next/:doctorId ────────────
  it("admin can trigger notify-next for a doctor (no waitlist => still 200)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/waitlist/notify-next/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.notified).toBe(true);
  });

  it("notify-next promotes the first WAITING entry to NOTIFIED", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const created = await request(app)
      .post("/api/v1/waitlist")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    const entryId = created.body.data.id;

    const res = await request(app)
      .post(`/api/v1/waitlist/notify-next/${doctor.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);

    const prisma = await getPrisma();
    const refreshed = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
    });
    expect(refreshed?.status).toBe("NOTIFIED");
    expect(refreshed?.notifiedAt).toBeTruthy();
  });

  it("rejects notify-next without auth (401)", async () => {
    const res = await request(app).post(
      "/api/v1/waitlist/notify-next/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects notify-next from PATIENT (403)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/waitlist/notify-next/${doctor.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });
});
