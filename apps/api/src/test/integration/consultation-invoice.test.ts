import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let token: string;

async function completeAppointment(appointmentId: string) {
  return request(app)
    .patch(`/api/v1/appointments/${appointmentId}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "COMPLETED" });
}

describeIfDB("Consultation invoice auto-generation (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a PENDING consultation invoice from the doctor's fee on COMPLETED", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { consultationFee: 600 },
    });
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    const res = await completeAppointment(appt.id);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("COMPLETED");

    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId: appt.id },
      include: { items: true },
    });
    expect(invoice).toBeTruthy();
    expect(invoice?.patientId).toBe(patient.id);
    expect(invoice?.paymentStatus).toBe("PENDING");
    expect(Number(invoice?.subtotal)).toBe(600);
    expect(Number(invoice?.totalAmount)).toBe(600); // GST 0 by default
    expect(invoice?.items).toHaveLength(1);
    expect(invoice?.items[0].category).toBe("CONSULTATION");
    expect(Number(invoice?.items[0].amount)).toBe(600);
  });

  it("does NOT double-bill when an appointment is re-completed (idempotent)", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { consultationFee: 400 },
    });
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    await completeAppointment(appt.id);
    // Bounce away and back to COMPLETED.
    await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "IN_CONSULTATION" });
    const second = await completeAppointment(appt.id);
    expect([200, 201]).toContain(second.status);

    const invoices = await prisma.invoice.findMany({
      where: { appointmentId: appt.id },
    });
    expect(invoices).toHaveLength(1);
  });

  it("does NOT create a separate consult invoice while the patient is admitted (IPD bills it)", async () => {
    const prisma = await getPrisma();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { consultationFee: 500 },
    });
    // Patient is currently ADMITTED.
    await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    const res = await completeAppointment(appt.id);
    expect([200, 201]).toContain(res.status);

    // No standalone appointment invoice — the consult is billed on the
    // admission running bill instead.
    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId: appt.id },
    });
    expect(invoice).toBeNull();
  });

  it("creates NO invoice when the doctor has no consultation fee", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture(); // consultationFee null
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    const res = await completeAppointment(appt.id);
    expect([200, 201]).toContain(res.status); // status update still succeeds

    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId: appt.id },
    });
    expect(invoice).toBeNull();
  });

  it("auto-bills when the consult is COMPLETED by SIGNING the consultation", async () => {
    // Signing a consultation advances the appointment to COMPLETED on a path
    // that bypasses PATCH /:id/status — the invoice must still be raised.
    const prisma = await getPrisma();
    const adminToken = await getAuthToken("ADMIN");
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { consultationFee: 600 },
    });
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "CHECKED_IN" },
    });

    // Lazy-create the draft consultation, then sign it.
    const draft = await request(app)
      .get(`/api/v1/consultations/by-appointment/${appt.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(draft.status).toBe(200);
    const consultId = draft.body.data.id;

    const signed = await request(app)
      .post(`/api/v1/consultations/${consultId}/sign`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(signed.status).toBe(200);

    // Appointment advanced + invoice raised.
    const refreshed = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { status: true },
    });
    expect(refreshed?.status).toBe("COMPLETED");

    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId: appt.id },
      include: { items: true },
    });
    expect(invoice).toBeTruthy();
    expect(Number(invoice?.totalAmount)).toBe(600);
    expect(invoice?.items[0].category).toBe("CONSULTATION");
  });

  it("raises a GST-free consult invoice (no tax line)", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { consultationFee: 1000 },
    });
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    await completeAppointment(appt.id);

    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId: appt.id },
      include: { items: true },
    });
    expect(invoice).toBeTruthy();
    expect(Number(invoice?.subtotal)).toBe(1000);
    expect(Number(invoice?.taxAmount)).toBe(0);
    expect(Number(invoice?.cgstAmount)).toBe(0);
    expect(Number(invoice?.sgstAmount)).toBe(0);
    expect(Number(invoice?.totalAmount)).toBe(1000);
    expect(Number(invoice?.items[0].gstRate)).toBe(0);
  });
});
