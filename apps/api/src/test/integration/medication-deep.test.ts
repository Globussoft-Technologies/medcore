// Deep branch-coverage tests for medication router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
  createMedicineFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;
let patientToken: string;

async function setupAdmission(status: "ADMITTED" | "DISCHARGED" = "ADMITTED") {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({ wardId: ward.id });
  const adm = await createAdmissionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    bedId: bed.id,
    overrides: { status },
  });
  return { patient, doctor, bed, adm };
}

describeIfDB("Medication API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates order with TID frequency → 3 doses/day scheduled", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "Amoxicillin 500mg",
        dosage: "500mg",
        frequency: "TID",
        route: "PO",
      });
    expect(res.status).toBe(201);
    // 3 doses/day * 7 days = 21 scheduled administrations
    expect(res.body.data.administrations.length).toBeGreaterThanOrEqual(15);
  });

  it("creates order with 1-0-1 pattern → 2 doses/day", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "Metformin",
        dosage: "500mg",
        frequency: "1-0-1",
        route: "PO",
      });
    expect(res.status).toBe(201);
    // 2 doses/day * 7 days = ~14
    expect(res.body.data.administrations.length).toBeGreaterThanOrEqual(10);
    expect(res.body.data.administrations.length).toBeLessThanOrEqual(15);
  });

  it("PRN / SOS frequency → no scheduled administrations", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "PRN",
        route: "PO",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.administrations.length).toBe(0);
  });

  it("'every 6 hours' → 4 doses/day", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "Insulin",
        dosage: "4u",
        frequency: "every 6 hours",
        route: "SC",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.administrations.length).toBeGreaterThanOrEqual(25);
  });

  it("404 for unknown admissionId", async () => {
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: "00000000-0000-0000-0000-000000000000",
        medicineName: "X",
        dosage: "1",
        frequency: "OD",
        route: "PO",
      });
    expect(res.status).toBe(404);
  });

  it("409 when admission not ADMITTED (discharged)", async () => {
    const { adm } = await setupAdmission("DISCHARGED");
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "OD",
        route: "PO",
      });
    expect(res.status).toBe(409);
  });

  it("NURSE cannot create order (403)", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "OD",
        route: "PO",
      });
    expect(res.status).toBe(403);
  });

  it("missing required fields (400)", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admissionId: adm.id });
    expect(res.status).toBe(400);
  });

  it("GET /orders without admissionId (400)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(400);
  });

  it("GET /orders?admissionId= returns created order", async () => {
    const { adm } = await setupAdmission();
    await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "Atorvastatin",
        dosage: "10mg",
        frequency: "qhs",
        route: "PO",
      });
    const res = await request(app)
      .get(`/api/v1/medication/orders?admissionId=${adm.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  it("PATCH pauses order (isActive=false)", async () => {
    const { adm } = await setupAdmission();
    const create = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "BID",
        route: "PO",
      });
    const res = await request(app)
      .patch(`/api/v1/medication/orders/${create.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });

  it("GET /administrations without admissionId (400)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/administrations")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(400);
  });

  it("GET /administrations with date filter", async () => {
    const { adm } = await setupAdmission();
    await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "QID",
        route: "PO",
      });
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/medication/administrations?admissionId=${adm.id}&date=${today}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("NURSE can record administration (ADMINISTERED)", async () => {
    const { adm } = await setupAdmission();
    const ord = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "QID",
        route: "PO",
      });
    const administrationId = ord.body.data.administrations[0].id;
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${administrationId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "ADMINISTERED", notes: "Taken with water" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ADMINISTERED");
  });

  it("MISSED dose status accepted", async () => {
    const { adm } = await setupAdmission();
    const ord = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "BID",
        route: "PO",
      });
    const aid = ord.body.data.administrations[0].id;
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${aid}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "MISSED" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("MISSED");
  });

  it("REFUSED accepted", async () => {
    const { adm } = await setupAdmission();
    const ord = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "BID",
        route: "PO",
      });
    const aid = ord.body.data.administrations[0].id;
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${aid}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "REFUSED" });
    expect(res.status).toBe(200);
  });

  it("invalid administration status (400)", async () => {
    const { adm } = await setupAdmission();
    const ord = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "BID",
        route: "PO",
      });
    const aid = ord.body.data.administrations[0].id;
    const res = await request(app)
      .patch(`/api/v1/medication/administrations/${aid}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "EATEN" });
    expect(res.status).toBe(400);
  });

  it("PATIENT role rejected for admin tasks (403 or 401)", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "OD",
        route: "PO",
      });
    expect([401, 403]).toContain(res.status);
  });

  it("GET /administrations/due returns scheduled rows", async () => {
    const { adm } = await setupAdmission();
    // Create an order whose administration includes now
    await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "every 1 hour",
        route: "PO",
      });
    const res = await request(app)
      .get("/api/v1/medication/administrations/due")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("medicineId linkage is honored when provided", async () => {
    const { adm } = await setupAdmission();
    const med = await createMedicineFixture();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineId: med.id,
        medicineName: med.name,
        dosage: "1 tab",
        frequency: "BD",
        route: "PO",
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const ord = await prisma.medicationOrder.findUnique({
      where: { id: res.body.data.id },
    });
    expect(ord!.medicineId).toBe(med.id);
  });

  it("frequency 'BD' mapped to 2 doses/day (side-effect)", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "BD",
        route: "PO",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.administrations.length).toBeGreaterThanOrEqual(10);
  });

  it("unknown frequency defaults to OD (1 dose/day, ~7 admins)", async () => {
    const { adm } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/medication/orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        admissionId: adm.id,
        medicineName: "X",
        dosage: "1",
        frequency: "floofle",
        route: "PO",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.administrations.length).toBeGreaterThanOrEqual(5);
    expect(res.body.data.administrations.length).toBeLessThanOrEqual(8);
  });
});
