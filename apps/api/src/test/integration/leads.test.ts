// Pearl ERP Stage 1 §3.3 (gap item #3) — CRM lead pipeline integration
// tests. Covers create + list filter + status-change auto-activity +
// activity log + conversion → patient + idempotent MarketingEnquiry
// promotion.
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let receptionToken: string;
let adminToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("Lead pipeline API (Pearl §3.3 — integration)", () => {
  beforeEach(async () => {
    await resetDB();
    receptionToken = await getAuthToken("RECEPTION");
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST /leads creates a lead (RECEPTION)", async () => {
    const res = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Jane Curious",
        phone: "+919876543210",
        email: "jane@example.com",
        source: "WHATSAPP",
        notes: "Asked about pediatric package",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Jane Curious");
    expect(res.body.data.status).toBe("NEW");
    expect(res.body.data.source).toBe("WHATSAPP");
  });

  it("PATIENT cannot create or list leads (403)", async () => {
    const c = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: "Hax0r" });
    expect(c.status).toBe(403);
    const l = await request(app)
      .get("/api/v1/leads")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(l.status).toBe(403);
  });

  it("PATCH /leads/:id status change auto-creates a STATUS_CHANGE activity", async () => {
    const created = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "John Booked", phone: "+919876543211", source: "PHONE" });
    const id = created.body.data.id;

    await request(app)
      .patch(`/api/v1/leads/${id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ status: "QUALIFIED" });

    const detail = await request(app)
      .get(`/api/v1/leads/${id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(detail.body.data.status).toBe("QUALIFIED");
    const statusActivities = detail.body.data.activities.filter(
      (a: any) => a.type === "STATUS_CHANGE",
    );
    expect(statusActivities.length).toBeGreaterThan(0);
    expect(statusActivities[0].data.fromStatus).toBe("NEW");
    expect(statusActivities[0].data.toStatus).toBe("QUALIFIED");
  });

  it("POST /leads/:id/activities logs a CALL activity", async () => {
    const created = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "Test Caller", phone: "+919876543212", source: "PHONE" });
    const id = created.body.data.id;
    const act = await request(app)
      .post(`/api/v1/leads/${id}/activities`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ type: "CALL", body: "Spoke for 3 min; sending pricing PDF" });
    expect(act.status).toBe(201);
    expect(act.body.data.type).toBe("CALL");
    expect(act.body.data.body).toContain("3 min");
  });

  it("POST /leads/:id/convert creates a Patient and flips status to CONVERTED", async () => {
    const prisma = await getPrisma();
    const created = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "Convert Me", phone: "+919876543213", source: "WEB" });
    const id = created.body.data.id;

    const conv = await request(app)
      .post(`/api/v1/leads/${id}/convert`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ gender: "FEMALE", age: 32 });
    expect(conv.status).toBe(201);
    expect(conv.body.data.status).toBe("CONVERTED");
    expect(conv.body.data.convertedPatient?.mrNumber).toMatch(/^MR\d+$/);

    // DB has the patient + the lead is linked.
    const patient = await prisma.patient.findUnique({
      where: { id: conv.body.data.convertedPatientId },
      include: { user: true },
    });
    expect(patient).toBeTruthy();
    expect(patient?.user.name).toBe("Convert Me");

    // Re-convert is rejected.
    const reConv = await request(app)
      .post(`/api/v1/leads/${id}/convert`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ gender: "FEMALE" });
    expect(reConv.status).toBe(409);
  });

  it("GET /leads?status=NEW filters correctly", async () => {
    // createLeadSchema requires name ≥ 2 chars; use real names.
    await request(app).post("/api/v1/leads").set("Authorization", `Bearer ${receptionToken}`).send({ name: "Alice Filter", phone: "+919876543214", source: "WEB" });
    const b = await request(app).post("/api/v1/leads").set("Authorization", `Bearer ${receptionToken}`).send({ name: "Bob Filter", phone: "+919876543215", source: "WEB" });
    // Move B out of NEW.
    await request(app).patch(`/api/v1/leads/${b.body.data.id}`).set("Authorization", `Bearer ${receptionToken}`).send({ status: "QUALIFIED" });

    const onlyNew = await request(app)
      .get("/api/v1/leads?status=NEW")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(onlyNew.status).toBe(200);
    expect(onlyNew.body.data.every((l: any) => l.status === "NEW")).toBe(true);
  });

  it("duplicate MarketingEnquiry → 409 on second promotion", async () => {
    const prisma = await getPrisma();
    const enq = await prisma.marketingEnquiry.create({
      data: {
        fullName: "Web Lead",
        email: "weblead@example.com",
        phone: "+919876543216",
        hospitalName: "Foo Hospital",
        hospitalSize: "1-10",
        role: "Administrator",
      },
    });

    const first = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "Web Lead", phone: "+919876543216", marketingEnquiryId: enq.id });
    expect(first.status).toBe(201);
    const dup = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "Web Lead Dupe", phone: "+919876543217", marketingEnquiryId: enq.id });
    expect(dup.status).toBe(409);
  });

  // Issue #1001 — exact-match (name + phone + email all match) dup
  // detection. Reporter saw the SAME lead row created repeatedly. Per
  // product decision the rule is strict: only block when all three
  // user-supplied fields are populated AND match an existing lead
  // exactly (case-insensitive name + email, exact phone). A typo in
  // any single field lets the new row through (false negatives are
  // acceptable; the goal is stopping the obvious "double-click /
  // duplicate-import" path).
  it("#1001 POST /leads with same name + phone + email → 409 on second attempt", async () => {
    const first = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Dup Detect One",
        phone: "+919876541001",
        email: "dup1001@example.com",
        source: "PHONE",
      });
    expect(first.status).toBe(201);

    // Identical triple → blocked.
    const second = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Dup Detect One",
        phone: "+919876541001",
        email: "dup1001@example.com",
        source: "PHONE",
      });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already exists/i);

    // Case-insensitive on name + email; different casing still blocks.
    const thirdCase = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "dup detect ONE",
        phone: "+919876541001",
        email: "DUP1001@example.com",
        source: "PHONE",
      });
    expect(thirdCase.status).toBe(409);

    // Different phone → allowed (typo escapes the gate, by design).
    const fourthPhoneTypo = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Dup Detect One",
        phone: "+919876541002", // last digit changed
        email: "dup1001@example.com",
        source: "PHONE",
      });
    expect(fourthPhoneTypo.status).toBe(201);

    // Missing email → falls outside the gate (only 2 of 3 fields).
    const fifthMissingEmail = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        name: "Dup Detect One",
        phone: "+919876541001",
        source: "PHONE",
      });
    expect(fifthMissingEmail.status).toBe(201);
  });

  // RBAC matrix: reads on the pipeline (list + detail) are restricted to
  // ADMIN + RECEPTION — they own the CRM pipeline and the Leads nav
  // entry. DOCTOR can still CREATE a lead (e.g. from a patient profile)
  // but must NOT be able to browse the pipeline. PATIENT is excluded
  // everywhere. See LEAD_READ_ROLES in apps/api/src/routes/leads.ts.
  it("ADMIN + RECEPTION can list leads; DOCTOR cannot (403)", async () => {
    const admin = await request(app)
      .get("/api/v1/leads")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);

    const reception = await request(app)
      .get("/api/v1/leads")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(reception.status).toBe(200);

    const doctor = await request(app)
      .get("/api/v1/leads")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(doctor.status).toBe(403);
  });

  it("DOCTOR can create a lead but cannot read its detail (403)", async () => {
    // DOCTOR keeps write access (the patient-profile "Create lead"
    // action), so creation succeeds…
    const created = await request(app)
      .post("/api/v1/leads")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ name: "Doctor Made", phone: "+919876500011", source: "REFERRAL" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    // …but the detail read is pipeline-scoped and must reject DOCTOR.
    const detail = await request(app)
      .get(`/api/v1/leads/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(detail.status).toBe(403);

    // ADMIN can still read the same lead.
    const adminDetail = await request(app)
      .get(`/api/v1/leads/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.data.id).toBe(id);
  });
});
