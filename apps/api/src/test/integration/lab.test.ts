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
let labTechToken: string;

describeIfDB("Lab API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    // POST /lab/results is restricted to LAB_TECH + ADMIN (issue #14).
    // Previously these tests posted as NURSE — that path now 403s, so we
    // use a dedicated lab-tech token for result creation happy-path tests.
    labTechToken = await getAuthToken("LAB_TECH");
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
      .set("Authorization", `Bearer ${labTechToken}`)
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
      .set("Authorization", `Bearer ${labTechToken}`)
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
      .set("Authorization", `Bearer ${labTechToken}`)
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
      .set("Authorization", `Bearer ${labTechToken}`)
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

  // Issue #622: imaging / radiology orders need a file artefact (DICOM,
  // PDF report, JPEG/PNG image), not a numeric value. POST /lab/orders/:id/
  // attachments stores the artefact via services/storage and creates a
  // PatientDocument row tagged `type: IMAGING`. The endpoint is gated to
  // orders that contain at least one imaging-shaped test.
  it("accepts an imaging attachment for a radiology order (#622)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture({
      name: "Ultrasound Abdomen",
      category: "Imaging",
      unit: undefined,
      panicLow: undefined,
      panicHigh: undefined,
    });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    // 8-byte PNG signature is enough for the magic-byte sniffer.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const res = await request(app)
      .post(`/api/v1/lab/orders/${order.id}/attachments`)
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        filename: "usg-abdomen.png",
        base64Content: png.toString("base64"),
        title: "USG Abdomen final report",
        notes: "Hepatomegaly noted",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.documentId).toBeTruthy();
    expect(res.body.data?.mimeType).toBe("image/png");

    // The PatientDocument row exists, scoped to this patient + IMAGING.
    const prisma = await getPrisma();
    const doc = await prisma.patientDocument.findUnique({
      where: { id: res.body.data.documentId },
    });
    expect(doc?.patientId).toBe(patient.id);
    expect(doc?.type).toBe("IMAGING");
    expect(doc?.notes).toContain(order.orderNumber);
  });

  it("refuses imaging attachment for non-imaging orders (#622)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    // CBC = Hematology — not an imaging study.
    const test = await createLabTestFixture({
      name: "Complete Blood Count",
      category: "Hematology",
    });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const res = await request(app)
      .post(`/api/v1/lab/orders/${order.id}/attachments`)
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        filename: "cbc.png",
        base64Content: png.toString("base64"),
        title: "stray report",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imaging|radiology/i);
  });

  // Issue #624: the legacy UI mistakenly checked status === "PENDING" for
  // the Collect-Sample CTA, so the SAMPLE_COLLECTED transition never
  // triggered. The DB default is ORDERED — this test pins the canonical
  // ORDERED → SAMPLE_COLLECTED happy path used by the new UI button and
  // asserts collectedAt is stamped server-side.
  it("ORDERED → SAMPLE_COLLECTED stamps collectedAt (#624)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    expect(order.status).toBe("ORDERED");

    const res = await request(app)
      .patch(`/api/v1/lab/orders/${order.id}/status`)
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({ status: "SAMPLE_COLLECTED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("SAMPLE_COLLECTED");

    const prisma = await getPrisma();
    const refreshed = await prisma.labOrder.findUnique({
      where: { id: order.id },
    });
    expect(refreshed?.status).toBe("SAMPLE_COLLECTED");
    expect(refreshed?.collectedAt).toBeTruthy();
  });
});
