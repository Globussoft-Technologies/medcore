// Integration tests for medication router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

async function setupIpdCase() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({ wardId: ward.id });
  const admission = await createAdmissionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    bedId: bed.id,
  });
  return { admission };
}

describeIfDB("Medication API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a medication order and auto-schedules administrations", async () => {
    const { admission } = await setupIpdCase();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: admission.id,
        medicineName: "Ceftriaxone 1g",
        dosage: "1g",
        frequency: "BID",
        route: "IV",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.administrations?.length).toBeGreaterThan(0);
  });

  it("lists medication orders for admission", async () => {
    const { admission } = await setupIpdCase();
    await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: admission.id,
        medicineName: "Paracetamol 500mg",
        dosage: "500mg",
        frequency: "TID",
        route: "oral",
      });
    const res = await request(app)
      .get(`/api/v1/medication/orders?admissionId=${admission.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 when listing without admissionId", async () => {
    const res = await request(app)
      .get("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("lists administrations for admission", async () => {
    const { admission } = await setupIpdCase();
    await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: admission.id,
        medicineName: "Ibuprofen 400mg",
        dosage: "400mg",
        frequency: "QID",
        route: "oral",
      });
    const res = await request(app)
      .get(`/api/v1/medication/administrations?admissionId=${admission.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("returns administrations due list", async () => {
    const res = await request(app)
      .get("/api/v1/medication/administrations/due")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("records administration (status = ADMINISTERED)", async () => {
    const { admission } = await setupIpdCase();
    const orderRes = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: admission.id,
        medicineName: "Metoprolol 25mg",
        dosage: "25mg",
        frequency: "BID",
        route: "oral",
      });
    const firstAdmin = orderRes.body.data.administrations[0];
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${firstAdmin.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "ADMINISTERED", notes: "Given with food" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("ADMINISTERED");

    const prisma = await getPrisma();
    const refreshed = await prisma.medicationAdministration.findUnique({
      where: { id: firstAdmin.id },
    });
    expect(refreshed?.administeredAt).toBeTruthy();
  });

  it("records missed medication", async () => {
    const { admission } = await setupIpdCase();
    const orderRes = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: admission.id,
        medicineName: "Omeprazole 20mg",
        dosage: "20mg",
        frequency: "OD",
        route: "oral",
      });
    const firstAdmin = orderRes.body.data.administrations[0];
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${firstAdmin.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "MISSED", notes: "Patient NPO" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("MISSED");
  });

  it("returns MAR grid", async () => {
    const { admission } = await setupIpdCase();
    const res = await request(app)
      .get(`/api/v1/admissions/${admission.id}/mar`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects invalid medication order payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ admissionId: "x" });
    expect(res.status).toBe(400);
  });
});
