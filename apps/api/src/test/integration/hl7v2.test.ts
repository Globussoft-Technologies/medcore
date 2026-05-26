// Integration tests for the HL7v2 export router (apps/api/src/routes/hl7v2.ts).
//
// Modules: routes/hl7v2.ts (ADT^A04 patient export, ORM^O01 lab order export,
// ORU^R01 lab report export, inbound dispatch), middleware/feature-flag.ts
// (hl7Inbound Stage-2 gate per commit efe050d), middleware/auth.ts
// (authenticate + authorize), services/hl7v2/messages.ts (segment builders),
// services/tenant-prisma.ts (tenantScopedPrisma — cross-tenant isolation).
//
// Why: hl7v2.ts is a 417-line zero-coverage router. The inbound POST already
// has dedicated coverage in hl7v2-inbound.test.ts; this file pins the THREE
// export GETs + the feature-flag gate + the cross-tenant isolation surface:
//   - GET /patient/:id      → ADT^A04 happy path + 404 unknown + RBAC (NURSE 403)
//   - GET /lab-order/:id    → ORM^O01 happy path + 404 unknown + RBAC (DOCTOR 403)
//   - GET /lab-report/:id   → ORU^R01 happy path + 404 unknown + RBAC (PATIENT 403)
//   - feature-flag gate     → hl7Inbound=false → 404 across all 4 routes
//   - cross-tenant isolation → tenant-A user can't fetch tenant-B patient/labs
//   - Content-Type + line endings → application/hl7-v2 + CR-only segments
//   - audit row written     → HL7V2_ADT_A04_EXPORT, HL7V2_ORM_O01_EXPORT,
//                              HL7V2_ORU_R01_EXPORT entries appear in AuditLog.
//
// The export handlers use `auditLog(...)` (awaited, not safeAudit) so we can
// read AuditLog immediately after the request — but we keep waitForAuditFlush
// in place as a defensive belt-and-braces (cheap, ~one poll on success).
import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  describeIfDB,
  resetDB,
  getAuthToken,
  getPrisma,
} from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

let app: any;
let adminToken: string;
let nurseToken: string;
let doctorToken: string;
let patientToken: string;

// Cached fixture ids for the happy-path GETs.
let patientId: string;
let labOrderId: string;
let labOrderWithResultsId: string;
let unknownUuid = "00000000-0000-0000-0000-000000000000";

// Second-tenant fixtures for cross-tenant isolation.
let tenantBPatientId: string;
let tenantBLabOrderId: string;

// Default-tenant id — captured in beforeAll, used by the late
// "feature-flag toggled back on" test so it can re-mint a token tied to
// the now-stamped admin user.
let defaultTenantId: string;

describeIfDB("HL7 v2 export endpoints + feature-flag gate (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();

    // ─── Materialize the "default" tenant up front and bind the seed
    // admin to it BEFORE getAuthToken mints the JWT.
    //
    // Without this, admin@test.local has tenantId=null, which means
    // `req.tenantId` stays undefined on every request and
    // `tenantScopedPrisma` is a no-op — so the cross-tenant isolation
    // assertions further down ("default-tenant ADMIN cannot read
    // tenant-B …") would 200 instead of 404 because the wrapper never
    // adds a tenant filter for a tenant-less caller. Pinning admin to
    // "default" stamps every JWT with that tenantId, which the wrapper
    // then injects into every query → tenant-B rows become invisible.
    const prisma = await getPrisma();
    const defaultTenant = await prisma.tenant.upsert({
      where: { subdomain: "default" },
      update: { featureFlags: { hl7Inbound: true } },
      create: {
        name: "Default Test Tenant",
        subdomain: "default",
        featureFlags: { hl7Inbound: true },
      },
    });
    defaultTenantId = defaultTenant.id;
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: defaultTenantId },
    });

    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");

    const mod = await import("../../app");
    app = mod.app;

    // ─── Default-tenant fixtures (every row stamped with tenantId so
    // tenantScopedPrisma can find them under the admin's tenant context).

    // Patient → owned User → backing Doctor → Bed → Admission, so
    // /patient/:id can include the latest admission row.
    const patUser = await prisma.user.create({
      data: {
        email: "hl7export_pat@test.local",
        name: "HL7 Export Patient",
        phone: "9000010001",
        passwordHash: "x",
        role: "PATIENT",
        tenantId: defaultTenantId,
      },
    });
    const patient = await prisma.patient.create({
      data: {
        userId: patUser.id,
        mrNumber: "MR-HL7E-001",
        gender: "MALE",
        dateOfBirth: new Date("1985-06-15"),
        address: "12 Park Street, Kolkata, WB",
        tenantId: defaultTenantId,
      },
    });
    patientId = patient.id;

    const docUser = await prisma.user.create({
      data: {
        email: "hl7export_doc@test.local",
        name: "Dr. HL7 Export",
        phone: "9000010002",
        passwordHash: "x",
        role: "DOCTOR",
        tenantId: defaultTenantId,
      },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: docUser.id,
        specialization: "General",
        qualification: "MBBS",
        tenantId: defaultTenantId,
      },
    });

    const ward = await prisma.ward.create({
      data: {
        name: "HL7 Export Ward",
        type: "GENERAL",
        floor: "1",
        tenantId: defaultTenantId,
      },
    });
    const bed = await prisma.bed.create({
      data: {
        wardId: ward.id,
        bedNumber: "HL7E-01",
        status: "OCCUPIED",
        dailyRate: 100,
        tenantId: defaultTenantId,
      },
    });
    await prisma.admission.create({
      data: {
        admissionNumber: "ADM-HL7E-001",
        patientId: patient.id,
        doctorId: doctor.id,
        bedId: bed.id,
        reason: "HL7 export test",
        status: "ADMITTED",
        admittedAt: new Date("2026-05-01T09:00:00Z"),
        tenantId: defaultTenantId,
      },
    });

    // Lab test → Lab order (no results) → Lab order WITH results.
    // LabTest is a catalog table — NOT tenant-scoped — so no tenantId here.
    const cbc = await prisma.labTest.create({
      data: { code: "CBCEXP", name: "Complete Blood Count Export", price: 350 },
    });
    const order = await prisma.labOrder.create({
      data: {
        orderNumber: "ORDHL7E001",
        patientId: patient.id,
        doctorId: doctor.id,
        status: "ORDERED",
        orderedAt: new Date("2026-05-02T10:00:00Z"),
        notes: "HL7 export test order",
        tenantId: defaultTenantId,
        items: { create: [{ testId: cbc.id }] },
      },
      include: { items: true },
    });
    labOrderId = order.id;

    const orderWithRes = await prisma.labOrder.create({
      data: {
        orderNumber: "ORDHL7E002",
        patientId: patient.id,
        doctorId: doctor.id,
        status: "COMPLETED",
        orderedAt: new Date("2026-05-02T11:00:00Z"),
        completedAt: new Date("2026-05-02T13:00:00Z"),
        notes: "HL7 export test report",
        tenantId: defaultTenantId,
        items: { create: [{ testId: cbc.id }] },
      },
      include: { items: true },
    });
    labOrderWithResultsId = orderWithRes.id;
    // Two OBX results so the OBX flatten path is exercised.
    await prisma.labResult.create({
      data: {
        orderItemId: orderWithRes.items[0].id,
        parameter: "Hemoglobin",
        value: "13.5",
        unit: "g/dL",
        normalRange: "12-16",
        flag: "NORMAL",
        enteredBy: "test-suite",
        reportedAt: new Date("2026-05-02T13:00:00Z"),
        tenantId: defaultTenantId,
      },
    });
    await prisma.labResult.create({
      data: {
        orderItemId: orderWithRes.items[0].id,
        parameter: "WBC",
        value: "11.2",
        unit: "10^3/uL",
        normalRange: "4-11",
        flag: "HIGH",
        enteredBy: "test-suite",
        reportedAt: new Date("2026-05-02T13:00:00Z"),
        tenantId: defaultTenantId,
      },
    });

    // ─── Second tenant — distinct rows the default tenant must not see ────
    const tenantB = await prisma.tenant.create({
      data: { name: "HL7 Tenant B", subdomain: "hl7-tenant-b" },
    });
    const otherUser = await prisma.user.create({
      data: {
        email: "hl7export_pat_b@test.local",
        name: "HL7 Patient B",
        phone: "9000020001",
        passwordHash: "x",
        role: "PATIENT",
        tenantId: tenantB.id,
      },
    });
    const otherPatient = await prisma.patient.create({
      data: {
        userId: otherUser.id,
        mrNumber: "MR-HL7E-T2-001",
        gender: "FEMALE",
        dateOfBirth: new Date("1990-01-01"),
        tenantId: tenantB.id,
      },
    });
    tenantBPatientId = otherPatient.id;

    const otherDocUser = await prisma.user.create({
      data: {
        email: "hl7export_doc_b@test.local",
        name: "Dr. Tenant B",
        phone: "9000020002",
        passwordHash: "x",
        role: "DOCTOR",
        tenantId: tenantB.id,
      },
    });
    const otherDoctor = await prisma.doctor.create({
      data: {
        userId: otherDocUser.id,
        specialization: "General",
        qualification: "MBBS",
        tenantId: tenantB.id,
      },
    });
    const otherOrder = await prisma.labOrder.create({
      data: {
        orderNumber: "ORDHL7E-TB-001",
        patientId: otherPatient.id,
        doctorId: otherDoctor.id,
        status: "ORDERED",
        orderedAt: new Date("2026-05-03T10:00:00Z"),
        notes: "Tenant-B private order",
        tenantId: tenantB.id,
        items: { create: [{ testId: cbc.id }] },
      },
    });
    tenantBLabOrderId = otherOrder.id;
  });

  afterAll(() => {
    __resetFeatureFlagsCacheForTests();
  });

  // ─── GET /patient/:id — ADT^A04 ────────────────────────────────────────

  it("ADMIN GET /patient/:id returns an HL7 v2.5.1 ADT^A04 message with CR-only segments + audit row", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${patientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/hl7-v2/);
    expect(res.text.startsWith("MSH|")).toBe(true);
    // ADT^A04 message-type token is required somewhere in MSH-9.
    expect(res.text).toMatch(/ADT\^A04/);
    // CR-only line endings — no LF allowed per HL7 v2 §2.3.
    expect(res.text.includes("\n")).toBe(false);
    expect(res.text.includes("\r")).toBe(true);
    // MR number from the seeded patient must be in the PID segment.
    expect(res.text).toMatch(/MR-HL7E-001/);

    const row = await waitForAuditFlush(prisma, {
      action: "HL7V2_ADT_A04_EXPORT",
      entity: "Patient",
      entityId: patientId,
    });
    expect(row.action).toBe("HL7V2_ADT_A04_EXPORT");
  });

  it("GET /patient/:id returns 404 when the patient does not exist", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${unknownUuid}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toMatch(/not found/i);
  });

  it("GET /patient/:id denies NURSE (403 — ADMIN-only)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${patientId}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /patient/:id denies DOCTOR (403 — ADMIN-only)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${patientId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /patient/:id requires authentication (401 without token)", async () => {
    const res = await request(app).get(`/api/v1/hl7v2/patient/${patientId}`);
    expect(res.status).toBe(401);
  });

  // ─── GET /lab-order/:id — ORM^O01 ─────────────────────────────────────

  it("ADMIN GET /lab-order/:id returns an ORM^O01 message + audit row", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${labOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/hl7-v2/);
    expect(res.text.startsWith("MSH|")).toBe(true);
    expect(res.text).toMatch(/ORM\^O01/);
    // Order number must appear in ORC/OBR-2 placer.
    expect(res.text).toMatch(/ORDHL7E001/);
    // CBCEXP test code must appear in OBR-4.
    expect(res.text).toMatch(/CBCEXP/);
    expect(res.text.includes("\n")).toBe(false);

    const row = await waitForAuditFlush(prisma, {
      action: "HL7V2_ORM_O01_EXPORT",
      entity: "LabOrder",
      entityId: labOrderId,
    });
    expect(row.action).toBe("HL7V2_ORM_O01_EXPORT");
  });

  it("GET /lab-order/:id returns 404 when the order does not exist", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${unknownUuid}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/not found/i);
  });

  it("GET /lab-order/:id denies DOCTOR (403 — ADMIN-only)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${labOrderId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /lab-order/:id denies NURSE (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${labOrderId}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /lab-order/:id requires authentication (401)", async () => {
    const res = await request(app).get(`/api/v1/hl7v2/lab-order/${labOrderId}`);
    expect(res.status).toBe(401);
  });

  // ─── GET /lab-report/:id — ORU^R01 ────────────────────────────────────

  it("ADMIN GET /lab-report/:id returns an ORU^R01 message with OBX results + audit row", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${labOrderWithResultsId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/hl7-v2/);
    expect(res.text.startsWith("MSH|")).toBe(true);
    expect(res.text).toMatch(/ORU\^R01/);
    // OBX rows for both results.
    expect(res.text).toMatch(/Hemoglobin/);
    expect(res.text).toMatch(/WBC/);
    // CR-only line endings invariant.
    expect(res.text.includes("\n")).toBe(false);

    const row = await waitForAuditFlush(prisma, {
      action: "HL7V2_ORU_R01_EXPORT",
      entity: "LabOrder",
      entityId: labOrderWithResultsId,
    });
    expect(row.action).toBe("HL7V2_ORU_R01_EXPORT");
  });

  it("GET /lab-report/:id returns 404 when the order does not exist", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${unknownUuid}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/not found/i);
  });

  it("GET /lab-report/:id denies PATIENT (403 — ADMIN-only)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${labOrderWithResultsId}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /lab-report/:id denies DOCTOR (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${labOrderWithResultsId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /lab-report/:id requires authentication (401)", async () => {
    const res = await request(app).get(
      `/api/v1/hl7v2/lab-report/${labOrderWithResultsId}`
    );
    expect(res.status).toBe(401);
  });

  // ─── Cross-tenant isolation (tenantScopedPrisma surface) ──────────────

  it("default-tenant ADMIN cannot read tenant-B patient via /patient/:id (404, not 200)", async () => {
    // admin@test.local is stamped with `defaultTenantId` in beforeAll, so
    // every JWT carries that tenantId; `tenantScopedPrisma` then injects
    // `where: { tenantId: defaultTenantId }` on the Patient.findUnique,
    // and the tenant-B patient row is invisible → handler 404s.
    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${tenantBPatientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("default-tenant ADMIN cannot read tenant-B lab order via /lab-order/:id (404)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${tenantBLabOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("default-tenant ADMIN cannot read tenant-B lab report via /lab-report/:id (404)", async () => {
    const res = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${tenantBLabOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // ─── Feature-flag gate (hl7Inbound, Pearl §6/§18 — commit efe050d) ────
  //
  // The whole router runs `requireFeature("hl7Inbound")`. Pearl-branded
  // tenants set the flag false and EVERY HL7v2 route MUST 404 before the
  // authorize middleware runs — that's why we assert 404 for the export
  // routes too, not just /inbound.

  it("when tenant.featureFlags.hl7Inbound=false, all HL7v2 routes 404 (Pearl §6/§18)", async () => {
    const prisma = await getPrisma();
    // Materialize a tenant the admin belongs to (the "default" subdomain).
    let tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
      });
    }
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: tenant.id },
    });
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hl7Inbound: false } },
    });
    __resetFeatureFlagsCacheForTests();
    const tenantAdminToken = await getAuthToken("ADMIN");

    // GET /patient/:id — 404 with the gate's standard "Not found" envelope.
    const patRes = await request(app)
      .get(`/api/v1/hl7v2/patient/${patientId}`)
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(patRes.status).toBe(404);
    expect(patRes.body).toMatchObject({ success: false, error: "Not found" });

    // GET /lab-order/:id
    const ordRes = await request(app)
      .get(`/api/v1/hl7v2/lab-order/${labOrderId}`)
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(ordRes.status).toBe(404);
    expect(ordRes.body).toMatchObject({ success: false, error: "Not found" });

    // GET /lab-report/:id
    const repRes = await request(app)
      .get(`/api/v1/hl7v2/lab-report/${labOrderWithResultsId}`)
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(repRes.status).toBe(404);
    expect(repRes.body).toMatchObject({ success: false, error: "Not found" });

    // POST /inbound — also gated; we hit it with a valid Content-Type so a
    // pass-through would otherwise return 200/415/400 (anything but the
    // gate's 404 envelope). 404 with the gate body confirms requireFeature
    // ran BEFORE authorize and BEFORE the body parser.
    const inRes = await request(app)
      .post("/api/v1/hl7v2/inbound")
      .set("Authorization", `Bearer ${tenantAdminToken}`)
      .set("Content-Type", "application/hl7-v2")
      .send("MSH|^~\\&|LAB|LAB_FAC|MEDCORE|MEDCORE_HIS|20260423100000||ADT^A04^ADT_A01|CTL|P|2.5.1");
    expect(inRes.status).toBe(404);
    expect(inRes.body).toMatchObject({ success: false, error: "Not found" });

    // Cleanup — flip the flag back on so later suites aren't blocked.
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hl7Inbound: true } },
    });
    __resetFeatureFlagsCacheForTests();
  });

  it("when tenant.featureFlags.hl7Inbound=true, HL7v2 export routes resolve normally", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) return; // previous test materialized it
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { hl7Inbound: true } },
    });
    __resetFeatureFlagsCacheForTests();
    const tenantAdminToken = await getAuthToken("ADMIN");

    const res = await request(app)
      .get(`/api/v1/hl7v2/patient/${patientId}`)
      .set("Authorization", `Bearer ${tenantAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.text.startsWith("MSH|")).toBe(true);
  });

  // Silence unused-token lint — patientToken is exercised on /lab-report;
  // nurseToken on /patient/:id; doctorToken across all three RBAC denials.
  void nurseToken;
  void doctorToken;
  void patientToken;
});
