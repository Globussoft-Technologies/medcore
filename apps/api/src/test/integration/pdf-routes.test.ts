// Integration tests for the PDF/HTML document routes.
//
// Confirms that:
//   1. ?format=pdf returns application/pdf with a valid PDF buffer
//   2. Default (no format param) returns text/html (backward compatibility)
//   3. Content-Disposition is set on the PDF branch
//
// Skipped automatically when DATABASE_URL_TEST is not set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createDoctorWithToken,
  createAppointmentFixture,
  createInvoiceFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let adminToken: string;

function isPdfBuffer(buf: Buffer): boolean {
  return (
    buf.length > 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  );
}

describeIfDB("PDF routes (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("GET /prescriptions/:id/pdf?format=pdf returns application/pdf", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Acute pharyngitis",
        items: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
            instructions: "After food",
            refills: 0,
          },
        ],
      });
    expect([200, 201]).toContain(created.status);
    const rxId = created.body.data.id;

    const res = await request(app)
      .get(`/api/v1/prescriptions/${rxId}/pdf?format=pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename=prescription-/
    );
    expect(isPdfBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(2000);
  });

  it("GET /prescriptions/:id/pdf (default) keeps returning text/html", async () => {
    const { doctor, token } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const created = await request(app)
      .post("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        diagnosis: "Acute pharyngitis",
        items: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
            instructions: "",
            refills: 0,
          },
        ],
      });
    const rxId = created.body.data.id;

    const res = await request(app)
      .get(`/api/v1/prescriptions/${rxId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Backward-compat: real PNG QR is now embedded.
    expect(res.text).toContain("data:image/png;base64");
  });

  it("GET /billing/invoices/:id/pdf?format=pdf returns application/pdf", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const inv = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });

    const res = await request(app)
      .get(`/api/v1/billing/invoices/${inv.id}/pdf?format=pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename=invoice-/
    );
    expect(isPdfBuffer(res.body)).toBe(true);
  });

  it("GET /admissions/:id/discharge-summary-pdf?format=pdf returns application/pdf", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const adm = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });

    const res = await request(app)
      .get(`/api/v1/admissions/${adm.id}/discharge-summary-pdf?format=pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename=discharge-summary-/
    );
    expect(isPdfBuffer(res.body)).toBe(true);
  });

  it("GET /prescriptions/:id/pdf?format=pdf returns 404 for unknown id", async () => {
    const res = await request(app)
      .get(`/api/v1/prescriptions/nonexistent/pdf?format=pdf`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
