// Integration tests for Pearl ERP Stage 1 §2.1.7 — threaded appointment
// remarks. Covers the AppointmentRemark CRUD lifecycle, visibility
// scoping (ALL_STAFF / DOCTOR_ONLY / RECEPTION_ONLY / PRIVATE), reply
// visibility-inheritance, pin/unpin, and DELETE authorization. Skipped
// unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let nurseToken: string;
let receptionToken: string;

describeIfDB("AppointmentRemark API (Pearl §2.1.7 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  async function newAppointment(): Promise<string> {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    return appt.id;
  }

  it("creates an ALL_STAFF remark and returns it via GET", async () => {
    const apptId = await newAppointment();

    const created = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "Patient asked about parking validation" });
    expect(created.status).toBe(201);
    expect(created.body.data.body).toBe("Patient asked about parking validation");
    expect(created.body.data.visibility).toBe("ALL_STAFF");
    expect(created.body.data.author?.role).toBe("RECEPTION");

    const list = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(created.body.data.id);
  });

  it("DOCTOR_ONLY remark is invisible to RECEPTION but visible to DOCTOR + ADMIN", async () => {
    const apptId = await newAppointment();

    await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        body: "Suspect IBS — keep this off RECEPTION's view",
        visibility: "DOCTOR_ONLY",
      });

    const asReception = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(asReception.status).toBe(200);
    expect(asReception.body.data).toHaveLength(0);

    const asDoctor = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(asDoctor.body.data).toHaveLength(1);

    const asAdmin = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.body.data).toHaveLength(1);
  });

  it("PRIVATE remark is invisible to NURSE but visible to author + ADMIN", async () => {
    const apptId = await newAppointment();

    await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ body: "Self-note: revisit imaging plan", visibility: "PRIVATE" });

    const asNurse = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(asNurse.body.data).toHaveLength(0);

    const asAuthor = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(asAuthor.body.data).toHaveLength(1);

    const asAdmin = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.body.data).toHaveLength(1);
  });

  it("reply inherits parent's PRIVATE visibility (no leak via reply)", async () => {
    const apptId = await newAppointment();
    const parent = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ body: "Parent (private)", visibility: "PRIVATE" });

    // Reply tries to use ALL_STAFF — should be COERCED to PRIVATE.
    const child = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        body: "Reply (tries to broaden)",
        visibility: "ALL_STAFF",
        parentRemarkId: parent.body.data.id,
      });
    expect(child.status).toBe(201);
    expect(child.body.data.visibility).toBe("PRIVATE");

    // RECEPTION should see neither.
    const asReception = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(asReception.body.data).toHaveLength(0);
  });

  it("pinned remark appears first in the list", async () => {
    const apptId = await newAppointment();
    const oldRemark = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "Older remark" });

    // Brief delay so the newer remark gets a strictly later createdAt.
    await new Promise((r) => setTimeout(r, 30));
    const newer = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "Newer remark" });

    // Initially newer-first (desc by createdAt).
    const before = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(before.body.data[0].id).toBe(newer.body.data.id);

    // Pin the older one.
    const pinRes = await request(app)
      .patch(`/api/v1/appointments/${apptId}/remarks/${oldRemark.body.data.id}/pin`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ isPinned: true });
    expect(pinRes.status).toBe(200);
    expect(pinRes.body.data.isPinned).toBe(true);

    const after = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(after.body.data[0].id).toBe(oldRemark.body.data.id);
  });

  it("PIN endpoint is DOCTOR/ADMIN only (RECEPTION rejected)", async () => {
    const apptId = await newAppointment();
    const remark = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "Routine note" });

    const pinAttempt = await request(app)
      .patch(`/api/v1/appointments/${apptId}/remarks/${remark.body.data.id}/pin`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ isPinned: true });
    expect(pinAttempt.status).toBe(403);
  });

  it("edit body is author-only (DOCTOR cannot edit RECEPTION's remark)", async () => {
    const apptId = await newAppointment();
    const remark = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "RECEPTION's note" });

    const editAttempt = await request(app)
      .patch(`/api/v1/appointments/${apptId}/remarks/${remark.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ body: "DOCTOR rewrite" });
    expect(editAttempt.status).toBe(403);

    const editByAuthor = await request(app)
      .patch(`/api/v1/appointments/${apptId}/remarks/${remark.body.data.id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "RECEPTION revised note" });
    expect(editByAuthor.status).toBe(200);
    expect(editByAuthor.body.data.body).toBe("RECEPTION revised note");
    expect(editByAuthor.body.data.editedAt).toBeTruthy();
  });

  it("DELETE is author OR ADMIN (other roles 403)", async () => {
    const apptId = await newAppointment();
    const remark1 = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "First note" });
    const remark2 = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ body: "Second note" });

    // DOCTOR (not author, not ADMIN) → 403
    const docDelete = await request(app)
      .delete(`/api/v1/appointments/${apptId}/remarks/${remark1.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(docDelete.status).toBe(403);

    // Author RECEPTION → 204
    const authorDelete = await request(app)
      .delete(`/api/v1/appointments/${apptId}/remarks/${remark1.body.data.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(authorDelete.status).toBe(204);

    // ADMIN deletes RECEPTION's other remark → 204
    const adminDelete = await request(app)
      .delete(`/api/v1/appointments/${apptId}/remarks/${remark2.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminDelete.status).toBe(204);
  });

  it("rejects PATIENT role from any remark surface", async () => {
    const apptId = await newAppointment();
    const patientToken = await getAuthToken("PATIENT");

    const create = await request(app)
      .post(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ body: "Patient should not write here" });
    expect(create.status).toBe(403);

    const list = await request(app)
      .get(`/api/v1/appointments/${apptId}/remarks`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(list.status).toBe(403);
  });
});
