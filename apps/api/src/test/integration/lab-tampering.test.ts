// Integration tests for the LabTech result-tampering guards.
//
// Closes:
//   - #609 (finalised orders accept new results) — POST /lab/results and
//     POST /lab/results/batch must 409 when the parent LabOrder is in a
//     COMPLETED or CANCELLED state. NABL/CLIA forbids silent appends to
//     issued reports; an amendment workflow is the legal path.
//   - #611 (no clinical/sanity validation on numeric values) — server
//     must reject biologically-impossible negatives and auto-elevate the
//     persisted flag to CRITICAL when value is outside the test's
//     panic range, even if the LabTech submitted NORMAL.
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
let labTechToken: string;
let doctorToken: string;

describeIfDB("Lab — result tampering guards (#609, #611)", () => {
  beforeAll(async () => {
    await resetDB();
    labTechToken = await getAuthToken("LAB_TECH");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── #609: finalised orders reject new results ────────────────
  it("rejects POST /lab/results with 409 once parent order is COMPLETED", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
      // Force COMPLETED at fixture-time so we don't depend on the
      // auto-COMPLETION transition closing the order before our second POST.
      overrides: { status: "COMPLETED" },
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "14.2",
        unit: "g/dL",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalised/i);

    // Confirm no row was actually created.
    const prisma = await getPrisma();
    const rows = await prisma.labResult.findMany({
      where: { orderItemId: order.items[0].id },
    });
    expect(rows.length).toBe(0);
  });

  it("rejects POST /lab/results/batch with 409 once parent order is COMPLETED", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
      overrides: { status: "COMPLETED" },
    });

    const res = await request(app)
      .post("/api/v1/lab/results/batch")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderId: order.id,
        results: [
          {
            orderItemId: order.items[0].id,
            parameter: "Hemoglobin",
            value: "14.2",
            unit: "g/dL",
          },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalised/i);
  });

  // ─── #611: clinical-sanity guards on numeric values ───────────
  it("rejects negative values for numeric tests with 400", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    // Numeric test (has unit + panic thresholds — biologically non-negative).
    const test = await createLabTestFixture({
      name: "Serum Creatinine",
      unit: "mg/dL",
      normalRange: "0.6-1.3",
      panicLow: 0.2,
      panicHigh: 5,
    });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Creatinine",
        value: "-99999",
        unit: "mg/dL",
        flag: "NORMAL",
      });
    expect(res.status).toBe(400);
    expect(res.body.details?.[0]?.field).toBe("value");
    expect(res.body.details?.[0]?.message).toMatch(/biologically|≥ 0|negative/i);
  });

  it("auto-elevates submitted NORMAL to CRITICAL when value exceeds panicHigh", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    // Mirrors the bug report: Serum Creatinine, panicHigh=5, value=39, flag=NORMAL.
    const test = await createLabTestFixture({
      name: "Serum Creatinine",
      unit: "mg/dL",
      normalRange: "0.6-1.3",
      panicLow: 0.2,
      panicHigh: 5,
    });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Creatinine",
        value: "39",
        unit: "mg/dL",
        flag: "NORMAL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.flag).toBe("CRITICAL");
  });

  it("auto-elevates batch NORMAL submissions to CRITICAL on panic-range violations", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture({
      name: "TSH",
      unit: "mIU/L",
      normalRange: "0.4-4.0",
      panicLow: 0.1,
      panicHigh: 10,
    });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results/batch")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderId: order.id,
        results: [
          {
            orderItemId: order.items[0].id,
            parameter: "TSH",
            value: "15", // > panicHigh=10 — must elevate even though flag=NORMAL
            unit: "mIU/L",
            flag: "NORMAL",
          },
        ],
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.criticalCount).toBe(1);
    expect(res.body.data?.results?.[0]?.flag).toBe("CRITICAL");
  });

  // Sanity: non-tampering POST still works on non-finalised orders.
  it("allows normal result POST on an in-progress order (regression guard)", async () => {
    const patient = await createPatientFixture();
    const doc = await createDoctorFixture();
    const test = await createLabTestFixture({ unit: "g/dL", panicLow: 5, panicHigh: 20 });
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doc.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "13.2",
        unit: "g/dL",
        flag: "NORMAL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.flag).toBe("NORMAL");
    // Touch doctorToken so eslint doesn't flag it as unused — it's reserved
    // for follow-up suites that exercise verify/reject as DOCTOR.
    expect(typeof doctorToken).toBe("string");
  });
});
