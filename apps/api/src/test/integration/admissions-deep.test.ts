// Deep / edge-case integration tests for the admissions router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

let app: any;
let admin: string;
let doctor: string;

async function mkAdmission(opts: { bedOverrides?: any } = {}) {
  const patient = await createPatientFixture();
  const doc = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({
    wardId: ward.id,
    overrides: opts.bedOverrides,
  });
  const adm = await createAdmissionFixture({
    patientId: patient.id,
    doctorId: doc.id,
    bedId: bed.id,
  });
  return { patient, doctor: doc, ward, bed, adm };
}

describeIfDB("Admissions API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    admin = await getAuthToken("ADMIN");
    doctor = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST / (admit) ────────────────────────────────────────
  it("admit with occupied bed returns 409", async () => {
    const { bed } = await mkAdmission();
    const patient2 = await createPatientFixture();
    const doctor2 = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        patientId: patient2.id,
        doctorId: doctor2.id,
        bedId: bed.id,
        reason: "chest pain",
      });
    expect(res.status).toBe(409);
  });

  it("admit with unknown bed returns 404", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        patientId: patient.id,
        doctorId: doc.id,
        bedId: "00000000-0000-0000-0000-000000000000",
        reason: "x",
      });
    expect(res.status).toBe(404);
  });

  it("admit success flips bed to OCCUPIED", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        patientId: patient.id,
        doctorId: doc.id,
        bedId: bed.id,
        reason: "fever",
      });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const b = await prisma.bed.findUnique({ where: { id: bed.id } });
    expect(b?.status).toBe("OCCUPIED");
  });

  // ─── Discharge guard ───────────────────────────────────────
  it("discharge blocked by outstanding invoice (400) without forceDischarge", async () => {
    const { patient, adm } = await mkAdmission();
    const ap = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: (await createDoctorFixture()).id,
    });
    await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: ap.id,
      overrides: { totalAmount: 1500, paymentStatus: "PENDING" },
    });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "stable" });
    expect(res.status).toBe(400);
    expect(res.body.outstanding).toBeGreaterThan(0);
  });

  it("discharge forceDischarge=true bypasses outstanding bill", async () => {
    const { patient, adm } = await mkAdmission();
    const ap = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: (await createDoctorFixture()).id,
    });
    await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: ap.id,
      overrides: { totalAmount: 1500, paymentStatus: "PENDING" },
    });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({
        dischargeSummary: "patient left against advice",
        forceDischarge: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISCHARGED");
  });

  it("discharge missing dischargeSummary → 400 validation", async () => {
    const { adm } = await mkAdmission();
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ forceDischarge: true });
    expect(res.status).toBe(400);
  });

  it("double discharge returns 409", async () => {
    const { adm } = await mkAdmission();
    await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "ok", forceDischarge: true });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "ok", forceDischarge: true });
    expect(res.status).toBe(409);
  });

  it("discharge releases bed to AVAILABLE", async () => {
    const { bed, adm } = await mkAdmission();
    await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "recovered", forceDischarge: true });
    const prisma = await getPrisma();
    const b = await prisma.bed.findUnique({ where: { id: bed.id } });
    expect(b?.status).toBe("AVAILABLE");
  });

  it("discharge unknown admission → 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/admissions/00000000-0000-0000-0000-000000000000/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "x" });
    expect(res.status).toBe(404);
  });

  // ─── Transfer ──────────────────────────────────────────────
  it("transfer to same ward bed works", async () => {
    const { adm, ward } = await mkAdmission();
    const b2 = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/transfer`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ newBedId: b2.id, reason: "nearer to nurse station" });
    expect(res.status).toBe(200);
  });

  it("transfer to different ward works", async () => {
    const { adm } = await mkAdmission();
    const ward2 = await createWardFixture({ type: "ICU" });
    const b2 = await createBedFixture({ wardId: ward2.id });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/transfer`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ newBedId: b2.id, reason: "escalation" });
    expect(res.status).toBe(200);
  });

  it("transfer to occupied bed returns 409", async () => {
    const { adm } = await mkAdmission();
    const other = await mkAdmission();
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/transfer`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ newBedId: other.bed.id, reason: "x" });
    expect(res.status).toBe(409);
  });

  it("transfer unknown target bed → 404", async () => {
    const { adm } = await mkAdmission();
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/transfer`)
      .set("Authorization", `Bearer ${admin}`)
      .send({
        newBedId: "00000000-0000-0000-0000-000000000000",
        reason: "x",
      });
    expect(res.status).toBe(404);
  });

  it("transfer on DISCHARGED admission returns 409", async () => {
    const { adm } = await mkAdmission();
    await request(app)
      .patch(`/api/v1/admissions/${adm.id}/discharge`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ dischargeSummary: "ok", forceDischarge: true });
    const ward2 = await createWardFixture();
    const b2 = await createBedFixture({ wardId: ward2.id });
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/transfer`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ newBedId: b2.id });
    expect(res.status).toBe(409);
  });

  // ─── Isolation ─────────────────────────────────────────────
  it("mark isolation COVID then list appears in active", async () => {
    const { adm } = await mkAdmission();
    const mark = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/isolation`)
      .set("Authorization", `Bearer ${admin}`)
      .send({
        isolationType: "COVID",
        isolationReason: "fever + cough",
        isolationStartDate: new Date().toISOString(),
      });
    expect(mark.status).toBe(200);
    const list = await request(app)
      .get("/api/v1/admissions/isolation/active")
      .set("Authorization", `Bearer ${admin}`);
    expect(list.status).toBe(200);
    const ids = (list.body.data || []).map((r: any) => r.id);
    expect(ids).toContain(adm.id);
  });

  it("clear isolation removes from active list", async () => {
    const { adm } = await mkAdmission();
    await request(app)
      .patch(`/api/v1/admissions/${adm.id}/isolation`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ isolationType: "MRSA" });
    await request(app)
      .patch(`/api/v1/admissions/${adm.id}/isolation`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ clear: true });
    const list = await request(app)
      .get("/api/v1/admissions/isolation/active")
      .set("Authorization", `Bearer ${admin}`);
    const ids = (list.body.data || []).map((r: any) => r.id);
    expect(ids).not.toContain(adm.id);
  });

  it.each(["COVID", "MRSA", "RESPIRATORY"])("isolation type %s is accepted", async (t) => {
    const { adm } = await mkAdmission();
    const res = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/isolation`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ isolationType: t });
    expect(res.status).toBe(200);
  });

  // ─── Discharge readiness ───────────────────────────────────
  it("discharge-readiness reports outstanding + not-ready", async () => {
    const { patient, adm } = await mkAdmission();
    const ap = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: (await createDoctorFixture()).id,
    });
    await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: ap.id,
      overrides: { totalAmount: 500, paymentStatus: "PENDING" },
    });
    const res = await request(app)
      .get(`/api/v1/admissions/${adm.id}/discharge-readiness`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.ready).toBe(false);
    expect(res.body.data?.outstandingAmount).toBeGreaterThan(0);
  });

  it("discharge-readiness 404 on unknown admission", async () => {
    const res = await request(app)
      .get(`/api/v1/admissions/00000000-0000-0000-0000-000000000000/discharge-readiness`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  // ─── Running bill ──────────────────────────────────────────
  it("running bill computes bed charges", async () => {
    const { adm } = await mkAdmission({ bedOverrides: { dailyRate: 2000 } });
    const res = await request(app)
      .get(`/api/v1/admissions/${adm.id}/bill`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.grandTotal).toBeGreaterThanOrEqual(2000);
  });

  // ─── Vitals ────────────────────────────────────────────────
  it("record IPD vitals returns 201", async () => {
    const { adm } = await mkAdmission();
    const res = await request(app)
      .post(`/api/v1/admissions/${adm.id}/vitals`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        admissionId: adm.id,
        bloodPressureSystolic: 130,
        bloodPressureDiastolic: 85,
        pulseRate: 78,
        spO2: 98,
        temperature: 37,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("record vitals on unknown admission → 404", async () => {
    const res = await request(app)
      .post(`/api/v1/admissions/00000000-0000-0000-0000-000000000000/vitals`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        admissionId: "00000000-0000-0000-0000-000000000000",
        pulseRate: 80,
      });
    expect(res.status).toBe(404);
  });

  // ─── Access / Get ──────────────────────────────────────────
  it("GET /:id 404 unknown", async () => {
    const res = await request(app)
      .get(`/api/v1/admissions/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  it("list admissions returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/admissions")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  it("unauthenticated get returns 401", async () => {
    const res = await request(app).get("/api/v1/admissions");
    expect(res.status).toBe(401);
  });

  // ─── Belongings ────────────────────────────────────────────
  it("belongings upsert then patch", async () => {
    const { adm } = await mkAdmission();
    const up = await request(app)
      .post(`/api/v1/admissions/${adm.id}/belongings`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ items: [{ name: "phone" }], notes: "checked in" });
    expect([200, 201]).toContain(up.status);
    const patch = await request(app)
      .patch(`/api/v1/admissions/${adm.id}/belongings`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ notes: "updated" });
    expect(patch.status).toBe(200);
  });
});
