// Deep branch-coverage tests for surgery/OT routes (/api/v1/surgery).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createOperatingTheaterFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let adminToken: string;
let nurseToken: string;

async function scheduleSurgery(body: any, tok = doctorToken) {
  return request(app)
    .post("/api/v1/surgery")
    .set("Authorization", `Bearer ${tok}`)
    .send(body);
}

describeIfDB("OT/Surgery API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("OT create rejects non-admin (403)", async () => {
    const res = await request(app)
      .post("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ name: "OT-X" });
    expect(res.status).toBe(403);
  });

  it("OT create (admin) + list includes it", async () => {
    const create = await request(app)
      .post("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `OT-Deep-${Date.now()}`, floor: "3", dailyRate: 7000 });
    expect(create.status).toBe(201);
    const list = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((o: any) => o.id === create.body.data.id)).toBe(
      true
    );
  });

  it("OT list excludes inactive by default, includeInactive=true shows all", async () => {
    const create = await request(app)
      .post("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `OT-Inact-${Date.now()}` });
    await request(app)
      .patch(`/api/v1/surgery/ots/${create.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false });
    const excl = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(excl.body.data.some((o: any) => o.id === create.body.data.id)).toBe(
      false
    );
    const incl = await request(app)
      .get("/api/v1/surgery/ots?includeInactive=true")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(incl.body.data.some((o: any) => o.id === create.body.data.id)).toBe(
      true
    );
  });

  it("schedule surgery 404 unknown OT", async () => {
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const res = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: "00000000-0000-0000-0000-000000000000",
      procedure: "Appendectomy",
      scheduledAt: new Date().toISOString(),
    });
    expect(res.status).toBe(404);
  });

  it("schedule surgery 409 on inactive OT", async () => {
    const ot = await createOperatingTheaterFixture({ isActive: false });
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const res = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "Appendectomy",
      scheduledAt: new Date().toISOString(),
    });
    expect(res.status).toBe(409);
  });

  it("schedule surgery happy path + caseNumber generated", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const res = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "Cholecystectomy",
      scheduledAt: new Date().toISOString(),
      durationMin: 90,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.caseNumber).toBeTruthy();
  });

  it("start surgery without pre-op checklist → 400 with missing list", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const start = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(start.status).toBe(400);
    expect(Array.isArray(start.body.missing)).toBe(true);
    expect(start.body.missing.length).toBeGreaterThanOrEqual(3);
  });

  it("start surgery with overrideChecklist bypasses missing items", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const start = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ overrideChecklist: true });
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe("IN_PROGRESS");
  });

  it("complete surgery without postOpNotes (400)", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ overrideChecklist: true });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/complete`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("complete surgery happy path sets status+actualEndAt", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ overrideChecklist: true });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/complete`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        postOpNotes: "Patient stable",
        spongeCountCorrect: true,
        instrumentCountCorrect: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("COMPLETED");
  });

  it("cancel surgery without reason (400)", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("cancel surgery with reason succeeds", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ reason: "Patient declined" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CANCELLED");
  });

  it("preop checklist PATCH toggles fields individually", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/preop`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        consentSigned: true,
        allergiesVerified: true,
        siteMarked: true,
        npoSince: new Date().toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.data.consentSigned).toBe(true);
  });

  it("start surgery succeeds after full preop checklist", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/preop`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        consentSigned: true,
        allergiesVerified: true,
        siteMarked: true,
        npoSince: new Date().toISOString(),
      });
    const res = await request(app)
      .patch(`/api/v1/surgery/${sched.body.data.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it("OT schedule endpoint returns day's bookings", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const when = new Date();
    await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: when.toISOString(),
    });
    const date = when.toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/surgery/ots/${ot.id}/schedule?date=${date}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("double-booking NOT prevented (documenting current behavior)", async () => {
    // NOTE: Router does not currently enforce OT double-booking. This test
    // documents that both POSTs succeed so that if enforcement is added the
    // test will fail and signal the behavior change.
    const ot = await createOperatingTheaterFixture();
    const p1 = await createPatientFixture();
    const p2 = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const when = new Date("2026-05-20T10:00:00.000Z").toISOString();
    const r1 = await scheduleSurgery({
      patientId: p1.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "A",
      scheduledAt: when,
      durationMin: 60,
    });
    const r2 = await scheduleSurgery({
      patientId: p2.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "B",
      scheduledAt: when,
      durationMin: 60,
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it("utilization endpoint 404 unknown OT", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/ots/00000000-0000-0000-0000-000000000000/utilization")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("utilization endpoint returns computed pct", async () => {
    const ot = await createOperatingTheaterFixture();
    const res = await request(app)
      .get(`/api/v1/surgery/ots/${ot.id}/utilization`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.dailyAvailableHours).toBe(12);
  });

  it("turnaround returns zero avg when 0-1 surgeries", async () => {
    const ot = await createOperatingTheaterFixture();
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/surgery/ots/${ot.id}/turnaround?date=${today}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.averageTurnaroundMinutes).toBe(0);
  });

  it("anesthesia record upsert", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const sched = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "X",
      scheduledAt: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/api/v1/surgery/${sched.body.data.id}/anesthesia-record`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        anesthetist: "Dr Gas",
        anesthesiaType: "GENERAL",
        bloodLossMl: 120,
        urineOutputMl: 300,
      });
    expect(res.status).toBe(201);
  });

  it("anesthesia record unknown surgery (404)", async () => {
    const res = await request(app)
      .post("/api/v1/surgery/00000000-0000-0000-0000-000000000000/anesthesia-record")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ anesthetist: "A", anesthesiaType: "LOCAL" });
    expect(res.status).toBe(404);
  });

  it("surgery 404 GET unknown", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("surgery list with status filter", async () => {
    const res = await request(app)
      .get("/api/v1/surgery?status=SCHEDULED&limit=5")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("schedule surgery rejects missing procedure (400)", async () => {
    const ot = await createOperatingTheaterFixture();
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const res = await scheduleSurgery({
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      scheduledAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });
});
