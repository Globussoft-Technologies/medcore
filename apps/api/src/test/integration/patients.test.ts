// Integration test for the patients router. Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let token: string;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;
let patientToken: string;

describeIfDB("Patients API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a patient", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Integration Patient",
        gender: "FEMALE",
        phone: "9000000001",
      });
    expect(res.status).toBeLessThan(400);
    // #895: defense-in-depth at the write site — the route now passes
    // req.tenantId explicitly to both tx.user.create and tx.patient.create.
    // patient.tenantId === user.tenantId is the invariant (both may be
    // null in test setup where the JWT doesn't carry tenantId — that's
    // fine; the invariant is agreement, not non-null).
    const prisma = await getPrisma();
    const created = await prisma.patient.findUnique({
      where: { id: res.body.data.id },
      include: { user: { select: { tenantId: true } } },
    });
    expect(created?.tenantId).toBe(created?.user?.tenantId);
  });

  it("issues a per-tenant MR number: <tenant prefix> + zero-padded sequence", async () => {
    // MR scheme is per-tenant (services/mr-number.ts): the prefix is the
    // operator-set tenant CODE (SystemConfig key `tenant:<id>:code`), else the
    // tenant SUBDOMAIN slug, else "MR" — slugified to UPPERCASE alphanumerics
    // (capped 12). The suffix is a zero-padded sequence counted within the
    // tenant. So a tenant coded "PG-01" issues PG01000001, PG01000002, …;
    // a tenant with no code/subdomain match falls back to MR000001, …
    const prisma = await getPrisma();

    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "MR Scheme Patient", gender: "MALE", phone: "9000000202" });
    expect(res.status).toBeLessThan(400);

    const mr: string = res.body.data.mrNumber;
    // Derive the expected prefix the SAME way the production helper does:
    // tenant code → subdomain → "MR", uppercased + alphanumerics only.
    const slug = (s: string) =>
      s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const created = await prisma.patient.findUnique({
      where: { id: res.body.data.id },
      select: { tenantId: true },
    });
    let expectedPrefix = "MR";
    if (created?.tenantId) {
      const codeRow = await prisma.systemConfig.findUnique({
        where: { key: `tenant:${created.tenantId}:code` },
      });
      const fromCode = codeRow?.value ? slug(codeRow.value) : "";
      if (fromCode) {
        expectedPrefix = fromCode;
      } else {
        const tenant = await prisma.tenant.findUnique({
          where: { id: created.tenantId },
          select: { subdomain: true },
        });
        const fromSub = tenant?.subdomain ? slug(tenant.subdomain) : "";
        if (fromSub) expectedPrefix = fromSub;
      }
    }

    // Format: <prefix><6+ digits>.
    expect(mr).toMatch(new RegExp(`^${expectedPrefix}\\d{6,}$`));
  });

  it("registers successfully even when the per-tenant counter has drifted below existing data (self-heals)", async () => {
    // Reproduces the "A patient with this MR number already exists" 409:
    // seeders/imports create rows without advancing the counter, so the
    // next registration regenerates an already-taken number. The handler
    // now derives the sequence from max(counter, real max for this prefix)
    // and retries on a clash, so this must succeed even with a stale counter.
    const prisma = await getPrisma();

    // First registration establishes the tenant + its current sequence.
    const first = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Drift First", gender: "MALE", phone: "9000000203" });
    expect(first.status).toBeLessThan(400);
    const created = await prisma.patient.findUnique({
      where: { id: first.body.data.id },
      select: { tenantId: true },
    });
    const counterKey = `next_mr_number:${created?.tenantId ?? "global"}`;

    // Force the per-tenant counter BACKWARDS to simulate drift.
    await prisma.systemConfig.upsert({
      where: { key: counterKey },
      update: { value: "1" },
      create: { key: counterKey, value: "1" },
    });

    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Drift Heal Patient", gender: "MALE", phone: "9000000204" });

    // Must NOT 409 on a stale counter — the handler self-heals past real data.
    expect(res.status).toBeLessThan(400);

    // The counter was advanced past the row it just created.
    const cfg = await prisma.systemConfig.findUnique({ where: { key: counterKey } });
    const issuedSeq = parseInt(res.body.data.mrNumber.replace(/^\D+/, ""), 10);
    expect(parseInt(cfg!.value, 10)).toBe(issuedSeq + 1);
  });

  it("lists patients", async () => {
    const res = await request(app)
      .get("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthorised request", async () => {
    const res = await request(app).get("/api/v1/patients");
    expect(res.status).toBe(401);
  });

  it("rejects invalid create payload", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  // Issue #892: name + DOB exact match is a near-certain duplicate.
  it("rejects a duplicate patient with the same name + date of birth (409, #892)", async () => {
    const dob = "1990-06-15";
    const first = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Rohan Duplicate Mehta",
        gender: "MALE",
        phone: "9100000011",
        dateOfBirth: dob,
      });
    expect(first.status).toBeLessThan(400);

    // Same name + same DOB, DIFFERENT phone — the exact gap #892 reports.
    const dup = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Rohan Duplicate Mehta",
        gender: "MALE",
        phone: "9100000022",
        dateOfBirth: dob,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.existingPatient?.mrNumber).toBeTruthy();
  });

  it("allows two distinct patients with the same name but different DOB (#892 — no false positive)", async () => {
    const a = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Common Name Sharma",
        gender: "FEMALE",
        phone: "9100000033",
        dateOfBirth: "1985-03-10",
      });
    expect(a.status).toBeLessThan(400);
    const b = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Common Name Sharma",
        gender: "FEMALE",
        phone: "9100000044",
        dateOfBirth: "2014-11-22",
      });
    // Different birth date → genuinely different people → must be allowed.
    expect(b.status).toBeLessThan(400);
  });

  it("allows the SAME phone with a DIFFERENT name (duplicate phones permitted)", async () => {
    const phone = "9100000061";
    const a = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Family Parent", gender: "MALE", phone });
    expect(a.status).toBeLessThan(400);
    // Same phone, different name → a different person on a shared number →
    // allowed (identity is keyed on phone + name).
    const b = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Family Child", gender: "FEMALE", phone });
    expect(b.status).toBeLessThan(400);
  });

  it("blocks the SAME phone with the SAME name (true duplicate, 409)", async () => {
    const phone = "9100000062";
    const a = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Exact Duplicate Roy", gender: "MALE", phone });
    expect(a.status).toBeLessThan(400);
    const dup = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Exact Duplicate Roy", gender: "MALE", phone });
    expect(dup.status).toBe(409);
    expect(dup.body.existingPatient?.mrNumber).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────
  // PATCH /api/v1/patients/:id  (Issue #39)
  // ─────────────────────────────────────────────────────────

  it("PATCH: doctor can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        name: "Updated Name",
        phone: "9999999999",
        address: "New Address",
        bloodGroup: "B+",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Updated Name");
    expect(res.body.data.user.phone).toBe("9999999999");
    expect(res.body.data.bloodGroup).toBe("B+");
    // MR number must be unchanged.
    expect(res.body.data.mrNumber).toBe(patient.mrNumber);
  });

  it("PATCH: nurse can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ address: "Corrected Street 12" });
    expect(res.status).toBe(200);
    expect(res.body.data.address).toBe("Corrected Street 12");
  });

  it("PATCH: reception can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Reception Edit" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Reception Edit");
  });

  it("PATCH: allows editing a patient's phone to one a DIFFERENT-named patient already uses", async () => {
    // Edit-side phone policy mirrors create: same phone + different name is a
    // shared family/guardian number and is allowed. Seed an owner, then edit
    // a second (differently-named) patient onto the same phone.
    const sharedPhone = "9100000071";
    const owner = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Shared Owner", gender: "MALE", phone: sharedPhone });
    expect(owner.status).toBeLessThan(400);

    const other = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${other.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: sharedPhone });
    expect(res.status).toBe(200);
    expect(res.body.data.user.phone).toBe(sharedPhone);
  });

  it("PATCH: blocks editing a patient onto another patient's phone AND name (true duplicate, 409)", async () => {
    const phone = "9100000072";
    const original = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Twin Collision", gender: "MALE", phone });
    expect(original.status).toBeLessThan(400);

    // A second patient with the SAME name but a different phone…
    const second = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Twin Collision", gender: "MALE", phone: "9100000073" });
    expect(second.status).toBeLessThan(400);

    // …editing the second onto the first's phone makes (phone+name) collide.
    const res = await request(app)
      .patch(`/api/v1/patients/${second.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phone });
    expect(res.status).toBe(409);
    expect(res.body.details?.[0]?.field).toBe("phone");
  });

  it("PATCH: PATIENT role is forbidden (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("PATCH: invalid payload returns 400", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        // name too short, phone too short, gender invalid
        name: "x",
        phone: "123",
        gender: "INVALID",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH: MR number cannot be changed even if passed in body", async () => {
    const patient = await createPatientFixture();
    const originalMr = patient.mrNumber;
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Still Valid",
        mrNumber: "MR-HACKED",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.mrNumber).toBe(originalMr);
  });

  it("PATCH: writes an audit log entry", async () => {
    const patient = await createPatientFixture();
    const prisma = await getPrisma();
    const before = await prisma.auditLog.count({
      where: { entity: "patient", entityId: patient.id, action: "PATIENT_UPDATE" },
    });
    await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ phone: "9000011111" })
      .expect(200);
    // auditLog is fire-and-forget; allow a brief window for the insert.
    await new Promise((r) => setTimeout(r, 50));
    const after = await prisma.auditLog.count({
      where: { entity: "patient", entityId: patient.id, action: "PATIENT_UPDATE" },
    });
    expect(after).toBeGreaterThan(before);
  });

  // ─────────────────────────────────────────────────────────
  // Pearl §2.1.1 — Patient source tagging (gap-analysis row 42).
  // The `source` field on Patient captures registration attribution
  // (WEB / PWA / WALK_IN / REFERRAL / WHATSAPP / PHONE / OTHER) for
  // marketing + CRM analytics. Schema DEFAULT is WALK_IN; the staff
  // POST /patients route layer defaults to WEB when the body omits a
  // value (because that endpoint IS the staff web-panel surface).
  // ─────────────────────────────────────────────────────────

  it("POST: persists explicit source value (Pearl §2.1.1)", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Source Referral Patient",
        gender: "MALE",
        phone: "9100000051",
        source: "REFERRAL",
      });
    expect(res.status).toBeLessThan(400);
    const prisma = await getPrisma();
    const created = await prisma.patient.findUnique({
      where: { id: res.body.data.id },
      select: { source: true },
    });
    expect(created?.source).toBe("REFERRAL");
  });

  it("POST: defaults source to WEB when body omits it (staff dashboard surface)", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Source Defaulted Patient",
        gender: "FEMALE",
        phone: "9100000052",
      });
    expect(res.status).toBeLessThan(400);
    const prisma = await getPrisma();
    const created = await prisma.patient.findUnique({
      where: { id: res.body.data.id },
      select: { source: true },
    });
    // Route layer pins WEB when omitted — the schema DEFAULT (WALK_IN)
    // only kicks in for non-route callers (seeders, fixtures).
    expect(created?.source).toBe("WEB");
  });

  it("POST: rejects an invalid source value (Zod 400)", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Bad Source Patient",
        gender: "MALE",
        phone: "9100000053",
        source: "INSTAGRAM",
      });
    expect(res.status).toBe(400);
  });

  it("Patient rows created outside the route layer (e.g. fixtures / seeders) get the schema DEFAULT of WALK_IN", async () => {
    // createPatientFixture() goes through prisma.patient.create() without
    // an explicit `source`, so the Prisma-level @default(WALK_IN) must
    // populate the column. This pins the "PWA self-registration via a
    // future code path that uses prisma directly will default to WALK_IN
    // unless it explicitly passes PWA" invariant.
    const patient = await createPatientFixture();
    const prisma = await getPrisma();
    const row = await prisma.patient.findUnique({
      where: { id: patient.id },
      select: { source: true },
    });
    expect(row?.source).toBe("WALK_IN");
  });

  // 2026-06 profile update: gender became patient-self-editable (was
  // staff-only). The PWA profile form PATCHes it through /patients/me.
  it("PATIENT can update their own gender via PATCH /patients/me", async () => {
    const res = await request(app)
      .patch("/api/v1/patients/me")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ gender: "FEMALE" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.gender).toBe("FEMALE");
  });

  it("rejects an invalid gender on PATCH /patients/me (schema enum guard)", async () => {
    const res = await request(app)
      .patch("/api/v1/patients/me")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ gender: "NOPE" });
    expect(res.status).toBe(400);
  });
});
