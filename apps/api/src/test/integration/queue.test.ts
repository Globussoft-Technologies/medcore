// Integration tests for the queue router.
// Pearl ERP Stage 1 §2.1.5 mode-aware display-board assertions live at the
// bottom of the file (TOKEN nextToken / CALLING currentArrivalSeq / SLOT
// upcomingSlots + first-name-last-initial redaction). They use direct Prisma
// writes to set `Doctor.appointmentMode` since the shared fixture defaults
// every doctor to TOKEN.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let adminToken: string;
let patientToken: string;

describeIfDB("Queue API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("lists doctor queue (staff-only post #383, ADMIN allowed)", async () => {
    const doctor = await createDoctorFixture();
    const patient = await createPatientFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.queue?.length).toBeGreaterThan(0);
  });

  it("returns currentToken null when nobody in consultation", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.currentToken).toBeNull();
  });

  it("queue orders by token and status (tokenNumber set, priority normal)", async () => {
    const doctor = await createDoctorFixture();
    // Fix age + gender so both patients have identical vulnerability rank
    // (the queue route re-sorts by vulnerability flags after the DB orderBy).
    const p1 = await createPatientFixture({ age: 30, gender: "MALE" });
    const p2 = await createPatientFixture({ age: 30, gender: "MALE" });
    await createAppointmentFixture({
      patientId: p1.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 1 },
    });
    await createAppointmentFixture({
      patientId: p2.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 2 },
    });
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queue[0].tokenNumber).toBe(1);
    expect(res.body.data.queue[1].tokenNumber).toBe(2);
  });

  it("EMERGENCY priority bumps ahead of NORMAL", async () => {
    const doctor = await createDoctorFixture();
    const pNormal = await createPatientFixture();
    const pEmerg = await createPatientFixture();
    await createAppointmentFixture({
      patientId: pNormal.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 1, priority: "NORMAL" },
    });
    await createAppointmentFixture({
      patientId: pEmerg.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 2, priority: "EMERGENCY" },
    });
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queue[0].priority).toBe("EMERGENCY");
  });

  it("totalInQueue counts only waiting/in-consult statuses", async () => {
    const doctor = await createDoctorFixture();
    const p1 = await createPatientFixture();
    await createAppointmentFixture({
      patientId: p1.id,
      doctorId: doctor.id,
      overrides: { status: "BOOKED" },
    });
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalInQueue).toBe(1);
  });

  it("estimatedWaitMinutes is a non-negative number", async () => {
    const doctor = await createDoctorFixture();
    const patient = await createPatientFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const item = res.body.data.queue[0];
    expect(item.estimatedWaitMinutes).toBeGreaterThanOrEqual(0);
  });

  it("display board lists all doctors (staff-only post #383)", async () => {
    await createDoctorFixture();
    await createDoctorFixture();
    const res = await request(app)
      .get("/api/v1/queue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  // Issue #383 (CRITICAL prod RBAC bypass, Apr 29 2026): the queue exposes
  // tokens, patient names and statuses for every patient currently waiting
  // across the clinic. PATIENT role must NOT be able to read it.
  it("rejects PATIENT role from /queue display board (403, #383)", async () => {
    const res = await request(app)
      .get("/api/v1/queue")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects PATIENT role from /queue/:doctorId (403, #383)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .get(`/api/v1/queue/${doctor.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("notify-position requires auth (401)", async () => {
    const res = await request(app).post(
      "/api/v1/queue/notify-position/550e8400-e29b-41d4-a716-446655440000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role from broadcast-positions (403)", async () => {
    const res = await request(app)
      .post("/api/v1/queue/broadcast-positions")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("ADMIN can call broadcast-positions", async () => {
    const res = await request(app)
      .post("/api/v1/queue/broadcast-positions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect([200, 201]).toContain(res.status);
  });

  // Pearl ERP Stage 1 §2.1.5 — display-board feed must tag each doctor's
  // appointmentMode and include per-mode payload (nextToken for TOKEN,
  // currentArrivalSeq for CALLING, upcomingSlots for SLOT) so the
  // /display/page.tsx DoctorCard can branch its layout.
  it("display board tags TOKEN doctor with nextToken from waiting tokens", async () => {
    const prisma = await getPrisma();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "TOKEN", tokenPrefix: "T" },
    });
    const patient = await createPatientFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 7, status: "BOOKED" },
    });
    const res = await request(app)
      .get("/api/v1/queue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((d: any) => d.doctorId === doctor.id);
    expect(row).toBeDefined();
    expect(row.appointmentMode).toBe("TOKEN");
    expect(row.nextToken).toBe(7);
  });

  it("display board tags CALLING doctor and exposes currentArrivalSeq", async () => {
    const prisma = await getPrisma();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "CALLING" },
    });
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "IN_CONSULTATION" },
    });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { arrivalSeq: 3 },
    });
    const res = await request(app)
      .get("/api/v1/queue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((d: any) => d.doctorId === doctor.id);
    expect(row).toBeDefined();
    expect(row.appointmentMode).toBe("CALLING");
    expect(row.currentArrivalSeq).toBe(3);
  });

  it("display board tags SLOT doctor and redacts upcoming patient names", async () => {
    const prisma = await getPrisma();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "SLOT" },
    });
    const patient = await createPatientFixture({
      name: "Priya Sharma",
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { slotStart: "10:30", status: "BOOKED" },
    });
    const res = await request(app)
      .get("/api/v1/queue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((d: any) => d.doctorId === doctor.id);
    expect(row).toBeDefined();
    expect(row.appointmentMode).toBe("SLOT");
    expect(Array.isArray(row.upcomingSlots)).toBe(true);
    expect(row.upcomingSlots.length).toBeGreaterThan(0);
    const slot = row.upcomingSlots[0];
    expect(slot.slotStart).toBe("10:30");
    // First name + last initial — never the full surname on a public board.
    expect(slot.patientLabel).toBe("Priya S.");
    expect(slot.patientLabel).not.toContain("Sharma");
  });
});
