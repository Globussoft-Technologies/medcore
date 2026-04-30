// Integration tests for the controlled-substances router (DEA / India narcotic
// regs Schedule H/H1/X). RBAC: ADMIN+PHARMACIST+DOCTOR for the register itself;
// the audit-report tightens to ADMIN+DOCTOR only. RECEPTION must be locked
// out of every endpoint.
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
} from "../factories";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("Controlled Substances API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    doctorToken = await getAuthToken("DOCTOR");
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
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.entryNumber).toMatch(/^CSR\d{6}$/);
    // Running balance must derive from inventory on-hand (100) minus dispensed qty (5)
    expect(res.body.data?.balance).toBe(95);
    expect(res.body.data?.medicineId).toBe(med.id);
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
      .send({ medicineId: med.id, quantity: 2 });
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
      .send({ medicineId: med.id, quantity: 3 });
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
      .send({ medicineId: med.id, quantity: 4 });
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
      .send({ medicineId: med.id, quantity: 2 });
    expect(res.status).toBe(201);
    // auditLog() is fire-and-forget — give it a tick to complete.
    await new Promise((r) => setTimeout(r, 50));
    const after = await (await getPrisma()).auditLog.count({
      where: { action: "CONTROLLED_ENTRY_CREATE" },
    });
    expect(after).toBeGreaterThan(before);
  });
});
