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
    await request(app).post("/api/v1/leads").set("Authorization", `Bearer ${receptionToken}`).send({ name: "A", phone: "+919876543214", source: "WEB" });
    const b = await request(app).post("/api/v1/leads").set("Authorization", `Bearer ${receptionToken}`).send({ name: "B", phone: "+919876543215", source: "WEB" });
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

  // Smoke: DOCTOR + ADMIN can list (just to ensure RBAC matrix is right).
  it("DOCTOR + ADMIN can list leads", async () => {
    const a = await request(app).get("/api/v1/leads").set("Authorization", `Bearer ${doctorToken}`);
    expect(a.status).toBe(200);
    const b = await request(app).get("/api/v1/leads").set("Authorization", `Bearer ${adminToken}`);
    expect(b.status).toBe(200);
  });
});
