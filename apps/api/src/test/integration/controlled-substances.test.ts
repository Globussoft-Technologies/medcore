// Integration tests for the controlled-substances router (DEA / India narcotic
// regs Schedule H/H1/X). RBAC: ADMIN+PHARMACIST+DOCTOR for the register itself;
// the audit-report tightens to ADMIN+DOCTOR only. RECEPTION must be locked
// out of every endpoint.
//
// 2026-05-03 — gap #2 from docs/TEST_GAPS_2026-05-03.md: witnessSignature +
// witnessUserId are now wired through the dispense endpoint and required on
// any Schedule-H/H1/X medicine. The cases below assert the new gate at the
// happy-path, validation, FK-integrity, and audit-row layers.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createMedicineFixture,
  createInventoryFixture,
  createPatientFixture,
  createDoctorFixture,
  createUserFixture,
} from "../factories";

const VALID_WITNESS = "Dr. Vikram Kapoor / Senior Pharmacist";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let doctorToken: string;
let nurseToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("Controlled Substances API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Helper: a Schedule-H narcotic with on-hand stock ─────────────────
  async function seedNarcoticWithStock(qty = 100) {
    const med = await createMedicineFixture({
      isNarcotic: true,
      requiresRegister: true,
      scheduleClass: "H",
    });
    await createInventoryFixture({ medicineId: med.id, overrides: { quantity: qty } });
    return med;
  }

  // ─── POST /controlled-substances ─────────────────────────────────────
  it("POST / records an entry (201) and writes a CSR audit row", async () => {
    const med = await seedNarcoticWithStock(100);
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 5,
        patientId: patient.id,
        doctorId: doctor.id,
        notes: "Post-op pain mgmt",
        witnessSignature: VALID_WITNESS,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.entryNumber).toMatch(/^CSR\d{6}$/);
    // Running balance must derive from inventory on-hand (100) minus dispensed qty (5)
    expect(res.body.data?.balance).toBe(95);
    expect(res.body.data?.medicineId).toBe(med.id);
    expect(res.body.data?.witnessSignature).toBe(VALID_WITNESS);
  });

  it("POST / 401 without auth", async () => {
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .send({ medicineId: "abc", quantity: 1 });
    expect(res.status).toBe(401);
  });

  it("POST / 403 for RECEPTION (RBAC issue #98)", async () => {
    const med = await seedNarcoticWithStock(50);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ medicineId: med.id, quantity: 1 });
    expect(res.status).toBe(403);
  });

  it("POST / 403 for PATIENT", async () => {
    const med = await seedNarcoticWithStock(50);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ medicineId: med.id, quantity: 1 });
    expect(res.status).toBe(403);
  });

  it("POST / 404 for unknown medicine", async () => {
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: "00000000-0000-4000-8000-000000000000",
        quantity: 1,
      });
    expect(res.status).toBe(404);
  });

  it("POST / 400 on invalid payload (non-uuid medicineId, negative quantity)", async () => {
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: "not-a-uuid", quantity: -1 });
    expect(res.status).toBe(400);
  });

  // ─── GET /controlled-substances ──────────────────────────────────────
  it("GET / lists entries with pagination meta", async () => {
    const res = await request(app)
      .get("/api/v1/controlled-substances?page=1&limit=10")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
    expect(typeof res.body.meta.total).toBe("number");
  });

  it("GET / 401 without auth", async () => {
    const res = await request(app).get("/api/v1/controlled-substances");
    expect(res.status).toBe(401);
  });

  it("GET / 403 for RECEPTION", async () => {
    const res = await request(app)
      .get("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("GET / filters by medicineId", async () => {
    const med = await seedNarcoticWithStock(40);
    await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 2, witnessSignature: VALID_WITNESS });
    const res = await request(app)
      .get(`/api/v1/controlled-substances?medicineId=${med.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((e: any) => e.medicineId === med.id)).toBe(true);
  });

  // ─── GET /controlled-substances/register/:medicineId ─────────────────
  it("GET /register/:medicineId returns full chronological register", async () => {
    const med = await seedNarcoticWithStock(20);
    await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 3, witnessSignature: VALID_WITNESS });
    const res = await request(app)
      .get(`/api/v1/controlled-substances/register/${med.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.medicine?.id).toBe(med.id);
    expect(typeof res.body.data?.currentOnHand).toBe("number");
    expect(Array.isArray(res.body.data?.entries)).toBe(true);
  });

  it("GET /register/:medicineId 404 for unknown medicine", async () => {
    const res = await request(app)
      .get("/api/v1/controlled-substances/register/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /register/:medicineId 401 without auth", async () => {
    const med = await seedNarcoticWithStock(10);
    const res = await request(app).get(
      `/api/v1/controlled-substances/register/${med.id}`
    );
    expect(res.status).toBe(401);
  });

  it("GET /register/:medicineId 403 for RECEPTION", async () => {
    const med = await seedNarcoticWithStock(10);
    const res = await request(app)
      .get(`/api/v1/controlled-substances/register/${med.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /controlled-substances/audit-report ─────────────────────────
  // NB: this endpoint tightens RBAC to ADMIN + DOCTOR (PHARMACIST cannot see it).
  it("GET /audit-report returns rows + discrepancies for ADMIN", async () => {
    const med = await seedNarcoticWithStock(50);
    await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 4, witnessSignature: VALID_WITNESS });
    const res = await request(app)
      .get("/api/v1/controlled-substances/audit-report")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.rows)).toBe(true);
    expect(Array.isArray(res.body.data?.discrepancies)).toBe(true);
  });

  it("GET /audit-report 403 for PHARMACIST (only ADMIN+DOCTOR)", async () => {
    const res = await request(app)
      .get("/api/v1/controlled-substances/audit-report")
      .set("Authorization", `Bearer ${pharmacistToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /audit-report 401 without auth", async () => {
    const res = await request(app).get(
      "/api/v1/controlled-substances/audit-report"
    );
    expect(res.status).toBe(401);
  });

  // Side-effect persistence check: the route writes an Inference/AuditLog row
  // via auditLog() — verify we have at least one CONTROLLED_ENTRY_CREATE
  // entry after a successful POST.
  it("POST / writes an AuditLog row with action CONTROLLED_ENTRY_CREATE", async () => {
    const med = await seedNarcoticWithStock(30);
    const before = await (await getPrisma()).auditLog.count({
      where: { action: "CONTROLLED_ENTRY_CREATE" },
    });
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 2, witnessSignature: VALID_WITNESS });
    expect(res.status).toBe(201);
    // auditLog() is fire-and-forget — give it a tick to complete.
    await new Promise((r) => setTimeout(r, 50));
    const after = await (await getPrisma()).auditLog.count({
      where: { action: "CONTROLLED_ENTRY_CREATE" },
    });
    expect(after).toBeGreaterThan(before);
  });

  // ─── Witness co-signing (gap #2 — 2026-05-03) ────────────────────────
  // Drugs and Cosmetics Rules 1945 §65 require a witness's printed name +
  // role on every Schedule-H/H1/X dispense. The `witnessSignature` column
  // landed in migration 20260503000001; these tests exercise the route's
  // gating + persistence behaviour.

  it("POST / persists witnessSignature on the row when provided", async () => {
    const med = await seedNarcoticWithStock(80);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 1,
        witnessSignature: VALID_WITNESS,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.witnessSignature).toBe(VALID_WITNESS);
    // Confirm DB row matches the response
    const prisma = await getPrisma();
    const row = await prisma.controlledSubstanceEntry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row?.witnessSignature).toBe(VALID_WITNESS);
  });

  it("POST / links witnessUserId when a valid staff witness is provided", async () => {
    const med = await seedNarcoticWithStock(80);
    const witnessUser = await createUserFixture({
      role: "PHARMACIST",
      name: "Dr. Vikram Kapoor",
    });
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 1,
        witnessSignature: VALID_WITNESS,
        witnessUserId: witnessUser.id,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.witnessUserId).toBe(witnessUser.id);
    // Response should include the witness user's name through the relation
    expect(res.body.data?.witness?.id).toBe(witnessUser.id);
    expect(res.body.data?.witness?.name).toBe("Dr. Vikram Kapoor");
    // Subsequent GET should also include the witness on the listing
    const list = await request(app)
      .get(`/api/v1/controlled-substances?medicineId=${med.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(list.status).toBe(200);
    const matched = list.body.data.find((e: any) => e.id === res.body.data.id);
    expect(matched?.witness?.name).toBe("Dr. Vikram Kapoor");
  });

  it("POST / 422 when Schedule-H dispense omits witnessSignature", async () => {
    const med = await seedNarcoticWithStock(40);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/witnessSignature/i);
    expect(res.body.error).toMatch(/Schedule-H/);
  });

  it("POST / 400 when witnessSignature is whitespace-only on Schedule-H", async () => {
    // Zod min(3) after trim() rejects "   " at the validate() layer (400),
    // before the route's 422 gate runs. Either is acceptable for the
    // regulatory contract — what matters is that the empty signature does
    // not persist.
    const med = await seedNarcoticWithStock(40);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 1, witnessSignature: "   " });
    expect([400, 422]).toContain(res.status);
  });

  it("POST / 422 when Schedule-H1 dispense omits witnessSignature", async () => {
    // H1 carries the same witness requirement as H (the H1 sub-class is
    // narcotic + psychotropic — antibiotics-of-last-resort regs).
    const med = await createMedicineFixture({
      isNarcotic: true,
      requiresRegister: true,
      scheduleClass: "H1",
    });
    await createInventoryFixture({ medicineId: med.id, overrides: { quantity: 50 } });
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/witnessSignature/i);
  });

  it("POST / 200 for a non-controlled medicine without witnessSignature", async () => {
    // The route is reachable for any medicine, but witnessSignature is only
    // mandatory for the regulated schedule classes. A medicine with no
    // scheduleClass falls through to the optional-witness branch.
    const med = await createMedicineFixture({
      isNarcotic: false,
      requiresRegister: false,
      scheduleClass: null,
    });
    await createInventoryFixture({ medicineId: med.id, overrides: { quantity: 30 } });
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ medicineId: med.id, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data?.witnessSignature).toBeNull();
  });

  it("POST / 404 when witnessUserId is a well-formed UUID with no matching user", async () => {
    const med = await seedNarcoticWithStock(20);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 1,
        witnessSignature: VALID_WITNESS,
        witnessUserId: "00000000-0000-4000-8000-000000000099",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/witness/i);
  });

  it("POST / 400 when witnessUserId is not a UUID", async () => {
    const med = await seedNarcoticWithStock(20);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 1,
        witnessSignature: VALID_WITNESS,
        witnessUserId: "not-a-uuid",
      });
    expect(res.status).toBe(400);
  });

  // ─── RBAC matrix on witness-required dispense ────────────────────────
  // The dispense endpoint is gated to ADMIN+PHARMACIST+DOCTOR (issue #98).
  // With the witness rule layered on top, the matrix becomes:
  //   ADMIN     + witness → 201
  //   PHARMACIST+ witness → 201   (covered above)
  //   DOCTOR    + witness → 201   (prescribing role can dispense per §98)
  //   NURSE     → 403
  //   RECEPTION → 403             (covered above)
  //   PATIENT   → 403             (covered above)

  it("POST / 201 for ADMIN with witnessSignature on Schedule-H", async () => {
    const med = await seedNarcoticWithStock(50);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ medicineId: med.id, quantity: 1, witnessSignature: VALID_WITNESS });
    expect(res.status).toBe(201);
  });

  it("POST / 201 for DOCTOR with witnessSignature on Schedule-H", async () => {
    const med = await seedNarcoticWithStock(50);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ medicineId: med.id, quantity: 1, witnessSignature: VALID_WITNESS });
    expect(res.status).toBe(201);
  });

  it("POST / 403 for NURSE on Schedule-H dispense (RBAC issue #98)", async () => {
    const med = await seedNarcoticWithStock(20);
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ medicineId: med.id, quantity: 1, witnessSignature: VALID_WITNESS });
    expect(res.status).toBe(403);
  });

  it("POST / writes an AuditLog row that records the witness in details", async () => {
    const med = await seedNarcoticWithStock(40);
    const witnessUser = await createUserFixture({
      role: "PHARMACIST",
      name: "Dr. Co-Signing Witness",
    });
    const res = await request(app)
      .post("/api/v1/controlled-substances")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        medicineId: med.id,
        quantity: 1,
        witnessSignature: VALID_WITNESS,
        witnessUserId: witnessUser.id,
      });
    expect(res.status).toBe(201);
    // auditLog() is fire-and-forget — let it flush.
    await new Promise((r) => setTimeout(r, 80));
    const prisma = await getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "CONTROLLED_ENTRY_CREATE", entityId: res.body.data.id },
    });
    expect(audit).toBeTruthy();
    const details = audit!.details as any;
    expect(details?.witnessSignature).toBe(VALID_WITNESS);
    expect(details?.witnessUserId).toBe(witnessUser.id);
    expect(details?.scheduleClass).toBe("H");
  });
});
