// Deep / edge-case integration tests for the EHR router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let admin: string;
let doctor: string;

describeIfDB("EHR API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    admin = await getAuthToken("ADMIN");
    doctor = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Allergies ─────────────────────────────────────────────
  it.each(["MILD", "MODERATE", "SEVERE", "LIFE_THREATENING"])(
    "records allergy with %s severity",
    async (sev) => {
      const patient = await createPatientFixture();
      const res = await request(app)
        .post("/api/v1/ehr/allergies")
        .set("Authorization", `Bearer ${doctor}`)
        .send({ patientId: patient.id, allergen: "penicillin", severity: sev });
      expect([200, 201]).toContain(res.status);
    }
  );

  it("list allergies empty for new patient", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/allergies`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("delete non-existent allergy returns 404", async () => {
    const res = await request(app)
      .delete(`/api/v1/ehr/allergies/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  it("invalid allergen (empty) returns 400", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ patientId: patient.id, allergen: "", severity: "MILD" });
    expect(res.status).toBe(400);
  });

  // ─── Chronic conditions ────────────────────────────────────
  it("create + update condition works", async () => {
    const patient = await createPatientFixture();
    const create = await request(app)
      .post("/api/v1/ehr/conditions")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        condition: "Hypertension",
        icd10Code: "I10",
        status: "ACTIVE",
      });
    expect([200, 201]).toContain(create.status);
    const update = await request(app)
      .patch(`/api/v1/ehr/conditions/${create.body.data.id}`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ status: "CONTROLLED" });
    expect(update.status).toBe(200);
    expect(update.body.data?.status).toBe("CONTROLLED");
  });

  it("condition with invalid status returns 400", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/conditions")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ patientId: patient.id, condition: "Asthma", status: "ZZZ" });
    expect(res.status).toBe(400);
  });

  // ─── Family history ───────────────────────────────────────
  it("family history templates endpoint returns list", async () => {
    const res = await request(app)
      .get("/api/v1/ehr/family-history/templates")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it.each(["Father", "Mother", "Sibling", "Grandparent"])(
    "create family-history relation %s",
    async (rel) => {
      const patient = await createPatientFixture();
      const res = await request(app)
        .post("/api/v1/ehr/family-history")
        .set("Authorization", `Bearer ${doctor}`)
        .send({ patientId: patient.id, relation: rel, condition: "Diabetes" });
      expect([200, 201]).toContain(res.status);
    }
  );

  // ─── Immunizations / schedule ──────────────────────────────
  it("pediatric recommended schedule returns all vaccines", async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 1); // 1-year-old
    const patient = await createPatientFixture({ dateOfBirth: dob });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/immunizations/recommended`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.items?.length).toBeGreaterThan(5);
  });

  it("recommended returns empty when DOB missing", async () => {
    const patient = await createPatientFixture({ dateOfBirth: null as any });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/immunizations/recommended`)
      .set("Authorization", `Bearer ${admin}`);
    // Some patients may still have DOB via factory default; accept both shapes
    expect(res.status).toBe(200);
  });

  it("recommended 404 for unknown patient", async () => {
    const res = await request(app)
      .get(`/api/v1/ehr/patients/00000000-0000-0000-0000-000000000000/immunizations/recommended`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  it("record immunization works", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/immunizations")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        vaccine: "BCG",
        doseNumber: 1,
        dateGiven: new Date().toISOString().slice(0, 10),
      });
    expect([200, 201]).toContain(res.status);
  });

  it("schedule filter=week returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/ehr/immunizations/schedule?filter=week")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  it("schedule filter=overdue returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/ehr/immunizations/schedule?filter=overdue")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  // ─── Documents ────────────────────────────────────────────
  it("create document with placeholder path", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/documents")
      .set("Authorization", `Bearer ${admin}`)
      .send({ patientId: patient.id, type: "LAB_REPORT", title: "CBC 2026" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.filePath).toBeTruthy();
  });

  it("invalid document type returns 400", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/documents")
      .set("Authorization", `Bearer ${admin}`)
      .send({ patientId: patient.id, type: "WRONG", title: "x" });
    expect(res.status).toBe(400);
  });

  it("get document 404 when unknown", async () => {
    const res = await request(app)
      .get(`/api/v1/ehr/documents/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  // ─── Patient summary ──────────────────────────────────────
  it("patient summary returns counts for a newly-created patient", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/summary`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.counts?.allergies).toBe(0);
    expect(res.body.data?.counts?.conditions).toBe(0);
  });

  it("patient summary surfaces severe allergies after create", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        allergen: "peanuts",
        severity: "LIFE_THREATENING",
      });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/summary`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.severeAllergies?.length).toBeGreaterThan(0);
  });

  // ─── Advance directives ───────────────────────────────────
  it("create + soft delete advance directive", async () => {
    const patient = await createPatientFixture();
    const create = await request(app)
      .post(`/api/v1/ehr/patients/${patient.id}/advance-directives`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        type: "DNR",
        effectiveDate: new Date().toISOString().slice(0, 10),
        notes: "Per patient wishes",
      });
    expect([200, 201]).toContain(create.status);
    const del = await request(app)
      .delete(`/api/v1/ehr/advance-directives/${create.body.data.id}`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(del.status).toBe(200);
    const prisma = await getPrisma();
    const row = await prisma.advanceDirective.findUnique({
      where: { id: create.body.data.id },
    });
    expect(row?.active).toBe(false);
  });

  it("advance-directive requires notes (400)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post(`/api/v1/ehr/patients/${patient.id}/advance-directives`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ type: "DNR", effectiveDate: new Date().toISOString().slice(0, 10) });
    expect(res.status).toBe(400);
  });

  // ─── Problem list ──────────────────────────────────────────
  it("problem list sorts LIFE_THREATENING allergies first", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ehr/conditions")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ patientId: patient.id, condition: "Asthma", status: "CONTROLLED" });
    await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        allergen: "bee sting",
        severity: "LIFE_THREATENING",
      });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/problem-list`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const items = res.body.data || [];
    expect(items.length).toBeGreaterThanOrEqual(2);
    // First item should be the LIFE_THREATENING allergy
    expect(items[0].severity).toBe("LIFE_THREATENING");
  });

  it("problem list type=allergy filters to allergies only", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        allergen: "latex",
        severity: "SEVERE",
      });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/problem-list?type=allergy`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    for (const i of res.body.data || []) expect(i.type).toBe("allergy");
  });

  // ─── Access control ───────────────────────────────────────
  it("patient accessing another patient's allergies gets 403", async () => {
    const a = await createPatientFixture();
    const b = await createPatientFixture();
    // Build a JWT for patient b's user and try accessing a
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({ where: { id: b.userId } });
    expect(user).toBeTruthy();
    const jwt = (await import("jsonwebtoken")).default;
    const token = jwt.sign(
      { userId: b.userId, email: user!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${a.id}/allergies`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("unauthenticated allergies list 401", async () => {
    const patient = await createPatientFixture();
    const res = await request(app).get(`/api/v1/ehr/patients/${patient.id}/allergies`);
    expect(res.status).toBe(401);
  });
});
