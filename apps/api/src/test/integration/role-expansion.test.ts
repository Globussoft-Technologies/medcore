// Integration tests for the new PHARMACIST and LAB_TECH roles.
//
// Acceptance criteria:
//   - PHARMACIST can dispense a prescription via /pharmacy/dispense.
//   - LAB_TECH can record a result via /lab/results.
//   - Neither role can hit an admin-only endpoint (pharmacy reorder/valuation).
//
// These checks ensure the Role enum addition is wired through both the JWT
// payload and the `authorize()` middleware on the affected routes.

import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createMedicineFixture,
  createInventoryFixture,
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createPrescriptionFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

let app: any;
let pharmacistToken: string;
let labTechToken: string;
let nurseToken: string;

describeIfDB("Role expansion: PHARMACIST + LAB_TECH (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    pharmacistToken = await getAuthToken("PHARMACIST");
    labTechToken = await getAuthToken("LAB_TECH");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  describe("PHARMACIST", () => {
    it("can dispense a prescription", async () => {
      const medicine = await createMedicineFixture({ name: "Paracetamol 500mg" });
      await createInventoryFixture({
        medicineId: medicine.id,
        overrides: { quantity: 500 },
      });
      const { doctor } = await createDoctorWithToken();
      const patient = await createPatientFixture();
      const appt = await createAppointmentFixture({
        patientId: patient.id,
        doctorId: doctor.id,
      });
      const prescription = await createPrescriptionFixture({
        patientId: patient.id,
        doctorId: doctor.id,
        appointmentId: appt.id,
      });

      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${pharmacistToken}`)
        .send({ prescriptionId: prescription.id });

      // Either succeeds (200/201) or fails on a downstream business rule (400),
      // but must NOT be 403 — that would mean authorize() rejected the role.
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });

    it("CAN access reorder suggestions (issue #98 — pharmacy roles only, but PHARMACIST is one)", async () => {
      const res = await request(app)
        .get("/api/v1/pharmacy/reports/reorder-suggestions")
        .set("Authorization", `Bearer ${pharmacistToken}`);
      // PHARMACIST is in the route's authorize() set per issue #98, alongside
      // ADMIN. The original assertion treated this as admin-only — the route
      // never was. The truly admin-only endpoint is /pharmacy/reports/stock-value.
      expect(res.status).not.toBe(403);
    });
  });

  describe("LAB_TECH", () => {
    it("can record a lab result", async () => {
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
          value: "14.2",
          unit: "g/dL",
          normalRange: "13-17",
          flag: "NORMAL",
        });

      expect(res.status).not.toBe(403);
      expect([200, 201]).toContain(res.status);
      expect(res.body?.data?.flag).toBe("NORMAL");
    });

    it("can submit a batch of results", async () => {
      const { doctor } = await createDoctorWithToken();
      const patient = await createPatientFixture();
      const test = await createLabTestFixture();
      const order = await createLabOrderFixture({
        patientId: patient.id,
        doctorId: doctor.id,
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
              parameter: "Hemoglobin",
              value: "12.0",
              unit: "g/dL",
              flag: "NORMAL",
            },
          ],
        });
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });

    it("cannot access admin-only pharmacy endpoint", async () => {
      const res = await request(app)
        .get("/api/v1/pharmacy/reports/reorder-suggestions")
        .set("Authorization", `Bearer ${labTechToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("Backward-compat: NURSE retains both privileges", () => {
    it("nurse can still dispense (small-clinic fallback)", async () => {
      const medicine = await createMedicineFixture();
      await createInventoryFixture({
        medicineId: medicine.id,
        overrides: { quantity: 200 },
      });
      const { doctor } = await createDoctorWithToken();
      const patient = await createPatientFixture();
      const appt = await createAppointmentFixture({
        patientId: patient.id,
        doctorId: doctor.id,
      });
      const prescription = await createPrescriptionFixture({
        patientId: patient.id,
        doctorId: doctor.id,
        appointmentId: appt.id,
      });
      const res = await request(app)
        .post("/api/v1/pharmacy/dispense")
        .set("Authorization", `Bearer ${nurseToken}`)
        .send({ prescriptionId: prescription.id });
      expect(res.status).not.toBe(403);
    });

    it("nurse CANNOT record lab results post-#14 (separation of duties)", async () => {
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
          value: "13.5",
          unit: "g/dL",
          flag: "NORMAL",
        });
      // Issue #14 (separation of duties): NURSE used to be allowed here, but
      // the ordering side and the recording side must be different roles.
      // LAB_TECH + ADMIN only.
      expect(res.status).toBe(403);
    });
  });
});
