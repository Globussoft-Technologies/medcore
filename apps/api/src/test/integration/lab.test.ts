// Integration tests for lab router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

describeIfDB("Lab API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a lab test (admin)", async () => {
    const res = await request(app)
      .post("/api/v1/lab/tests")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `TST${Date.now() % 100000}`,
        name: "Thyroid Panel",
        category: "Biochemistry",
        price: 600,
        sampleType: "Blood",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.name).toBe("Thyroid Panel");
  });

  it("lists lab tests", async () => {
    await createLabTestFixture({ name: "CBC-X" });
    const res = await request(app)
      .get("/api/v1/lab/tests")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("creates a lab order with multiple tests + auto order number", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test1 = await createLabTestFixture();
    const test2 = await createLabTestFixture({ name: "Urine Routine" });
    const res = await request(app)
      .post("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        testIds: [test1.id, test2.id],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.orderNumber).toMatch(/^LAB\d+/);
    expect(res.body.data?.items?.length).toBe(2);
  });

  it("updates order status (ORDERED -> SAMPLE_COLLECTED)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .patch(`/api/v1/lab/orders/${order.id}/status`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "SAMPLE_COLLECTED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("SAMPLE_COLLECTED");
    expect(res.body.data?.collectedAt).toBeTruthy();
  });

  it("records a result with NORMAL flag", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const orderItem = order.items[0];
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: orderItem.id,
        parameter: "Hemoglobin",
        value: "14.5",
        unit: "g/dL",
        normalRange: "13-17",
        flag: "NORMAL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.flag).toBe("NORMAL");
  });

  it("records a critical result", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "4.2",
        unit: "g/dL",
        flag: "CRITICAL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.flag).toBe("CRITICAL");
  });

  it("creates a STAT order with priority flag", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const res = await request(app)
      .post("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        testIds: [test.id],
        priority: "STAT",
      });
    if (res.status >= 400) {
      console.log("[STAT lab order] response:", res.status, JSON.stringify(res.body));
    }
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.stat).toBe(true);
    expect(res.body.data?.priority).toBe("STAT");
  });

  it("records delta-flag for significant change vs previous result", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const firstOrder = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    // First result — baseline
    await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: firstOrder.items[0].id,
        parameter: "Creatinine",
        value: "1.0",
        unit: "mg/dL",
      });

    const secondOrder = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    // Second result — >25% change
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: secondOrder.items[0].id,
        parameter: "Creatinine",
        value: "2.5",
        unit: "mg/dL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.deltaFlag).toBe(true);
  });

  it("rejects sample (SAMPLE_REJECTED state)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .patch(`/api/v1/lab/orders/${order.id}/reject-sample`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ reason: "HEMOLYZED", notes: "Recollect" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("SAMPLE_REJECTED");

    const prisma = await getPrisma();
    const refreshed = await prisma.labOrder.findUnique({
      where: { id: order.id },
    });
    expect(refreshed?.rejectedAt).toBeTruthy();
    expect(refreshed?.rejectionReason).toBe("HEMOLYZED");
  });

  it("lists orders filtered by patientId", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .get(`/api/v1/lab/orders?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/lab/orders");
    expect(res.status).toBe(401);
  });
});
