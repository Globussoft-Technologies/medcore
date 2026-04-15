// Deep / edge-case integration tests for the lab router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

let app: any;
let admin: string;
let doctor: string;
let labTech: string;

async function mkOrder(
  opts: { priority?: "ROUTINE" | "URGENT" | "STAT" } = {}
) {
  const patient = await createPatientFixture();
  const doc = await createDoctorFixture();
  const test = await createLabTestFixture();
  const order = await createLabOrderFixture({
    patientId: patient.id,
    doctorId: doc.id,
    testIds: [test.id],
    overrides: { priority: opts.priority ?? "ROUTINE" },
  });
  return { patient, doctor: doc, test, order };
}

describeIfDB("Lab API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    admin = await getAuthToken("ADMIN");
    doctor = await getAuthToken("DOCTOR");
    labTech = await getAuthToken("LAB_TECH");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Orders ────────────────────────────────────────────────
  it("create STAT order marks stat=true", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture();
    const res = await request(app)
      .post("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        doctorId: doc.id,
        testIds: [test.id],
        priority: "STAT",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.stat).toBe(true);
    expect(res.body.data?.priority).toBe("STAT");
  });

  it("URGENT order stored with URGENT priority", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture();
    const res = await request(app)
      .post("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        doctorId: doc.id,
        testIds: [test.id],
        priority: "URGENT",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.priority).toBe("URGENT");
  });

  it("order with empty testIds returns 400", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ patientId: patient.id, doctorId: doc.id, testIds: [] });
    expect(res.status).toBe(400);
  });

  // ─── Result recording ─────────────────────────────────────
  it("record result on unknown orderItem returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({
        orderItemId: "00000000-0000-0000-0000-000000000000",
        parameter: "Hb",
        value: "12",
      });
    expect(res.status).toBe(404);
  });

  it("recording all results marks order COMPLETED", async () => {
    const { order } = await mkOrder();
    const item = order.items[0];
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({
        orderItemId: item.id,
        parameter: "Hemoglobin",
        value: "13.5",
        unit: "g/dL",
        normalRange: "13-17",
      });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const o = await prisma.labOrder.findUnique({ where: { id: order.id } });
    expect(o?.status).toBe("COMPLETED");
  });

  // ─── Delta-check ───────────────────────────────────────────
  it("delta-flag fires when second result is >25% different", async () => {
    // Create two distinct orders for same patient + same test, record baseline + big delta
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture();
    const ord1 = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });
    const ord2 = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });
    await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({ orderItemId: ord1.items[0].id, parameter: "Hb", value: "12" });
    const second = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({ orderItemId: ord2.items[0].id, parameter: "Hb", value: "20" });
    expect([200, 201]).toContain(second.status);
    expect(second.body.data?.deltaFlag).toBe(true);
  });

  it("delta-check endpoint returns per-parameter results", async () => {
    const { order } = await mkOrder();
    const item = order.items[0];
    await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({ orderItemId: item.id, parameter: "Hb", value: "14" });
    const res = await request(app)
      .get(`/api/v1/lab/results/${item.id}/delta-check`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(200);
  });

  it("delta-check 404 unknown orderItem", async () => {
    const res = await request(app)
      .get(`/api/v1/lab/results/00000000-0000-0000-0000-000000000000/delta-check`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  // ─── Sample rejection ─────────────────────────────────────
  it.each([
    "HEMOLYZED",
    "CLOTTED",
    "INSUFFICIENT_SAMPLE",
    "LIPEMIC",
    "CONTAMINATED",
  ])("reject sample reason %s", async (reason) => {
    const { order } = await mkOrder();
    const res = await request(app)
      .patch(`/api/v1/lab/orders/${order.id}/reject-sample`)
      .set("Authorization", `Bearer ${labTech}`)
      .send({ reason });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("SAMPLE_REJECTED");
  });

  it("reject sample with invalid reason returns 400", async () => {
    const { order } = await mkOrder();
    const res = await request(app)
      .patch(`/api/v1/lab/orders/${order.id}/reject-sample`)
      .set("Authorization", `Bearer ${labTech}`)
      .send({ reason: "BOGUS" });
    expect(res.status).toBe(400);
  });

  // ─── Batch results + critical values ──────────────────────
  it("batch results with CRITICAL value triggers notification", async () => {
    const { order } = await mkOrder();
    const item = order.items[0];
    const res = await request(app)
      .post("/api/v1/lab/results/batch")
      .set("Authorization", `Bearer ${labTech}`)
      .send({
        orderId: order.id,
        results: [
          {
            orderItemId: item.id,
            parameter: "K+",
            value: "7.2",
            flag: "CRITICAL",
            unit: "mmol/L",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.criticalCount).toBe(1);
  });

  it("batch results empty array returns 400", async () => {
    const { order } = await mkOrder();
    const res = await request(app)
      .post("/api/v1/lab/results/batch")
      .set("Authorization", `Bearer ${labTech}`)
      .send({ orderId: order.id, results: [] });
    expect(res.status).toBe(400);
  });

  // ─── Result verification ──────────────────────────────────
  it("verify a result by a doctor", async () => {
    const { order } = await mkOrder();
    const item = order.items[0];
    const created = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTech}`)
      .send({ orderItemId: item.id, parameter: "Hb", value: "13" });
    const resultId = created.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/lab/results/${resultId}/verify`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data?.verifiedAt).toBeTruthy();
  });

  it("non-doctor verify returns 403", async () => {
    const res = await request(app)
      .patch(`/api/v1/lab/results/00000000-0000-0000-0000-000000000000/verify`)
      .set("Authorization", `Bearer ${labTech}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("pending-verification endpoint 200", async () => {
    const res = await request(app)
      .get("/api/v1/lab/results/pending-verification")
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(200);
  });

  // ─── QC ────────────────────────────────────────────────────
  it("QC entry (fail) is recorded", async () => {
    const test = await createLabTestFixture();
    const res = await request(app)
      .post("/api/v1/lab/qc")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        testId: test.id,
        qcLevel: "NORMAL",
        meanValue: 10,
        recordedValue: 20,
        withinRange: false,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("QC summary returns pass-rates", async () => {
    const res = await request(app)
      .get("/api/v1/lab/qc/summary")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  // ─── Share link ────────────────────────────────────────────
  it("share link generates token with future expiry", async () => {
    const { order } = await mkOrder();
    const res = await request(app)
      .post(`/api/v1/lab/orders/${order.id}/share-link`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ resource: "lab_order", days: 14 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.token?.length).toBeGreaterThan(10);
    const exp = new Date(res.body.data.expiresAt);
    expect(exp.getTime()).toBeGreaterThan(Date.now());
  });

  it("share link 404 unknown order", async () => {
    const res = await request(app)
      .post(`/api/v1/lab/orders/00000000-0000-0000-0000-000000000000/share-link`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ resource: "lab_order", days: 7 });
    expect(res.status).toBe(404);
  });

  it("share link days=0 rejected 400", async () => {
    const { order } = await mkOrder();
    const res = await request(app)
      .post(`/api/v1/lab/orders/${order.id}/share-link`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ resource: "lab_order", days: 0 });
    expect(res.status).toBe(400);
  });

  // ─── TAT breaches + reports ────────────────────────────────
  it("tat-breaches endpoint returns list", async () => {
    const res = await request(app)
      .get("/api/v1/lab/tat-breaches")
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(200);
  });

  it("PDF report on unknown order returns 404", async () => {
    const res = await request(app)
      .get(`/api/v1/lab/orders/00000000-0000-0000-0000-000000000000/pdf`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  // ─── Applicable range ─────────────────────────────────────
  it("applicable-range requires patientId", async () => {
    const test = await createLabTestFixture();
    const res = await request(app)
      .get(`/api/v1/lab/tests/${test.id}/applicable-range`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(400);
  });

  it("applicable-range 404 on unknown patient", async () => {
    const test = await createLabTestFixture();
    const res = await request(app)
      .get(
        `/api/v1/lab/tests/${test.id}/applicable-range?patientId=00000000-0000-0000-0000-000000000000`
      )
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  // ─── Access ────────────────────────────────────────────────
  it("unauthenticated orders list 401", async () => {
    const res = await request(app).get("/api/v1/lab/orders");
    expect(res.status).toBe(401);
  });

  it("GET /orders/:id 404 on unknown", async () => {
    const res = await request(app)
      .get("/api/v1/lab/orders/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });
});
