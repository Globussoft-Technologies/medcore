// Integration tests for bloodbank router.
//
// Issue #511 (BOLA sweep, 2026-05-05): four /:id handlers in this router
// were flagged as missing per-patient or staff-only gating —
//   - GET /requests/:id          (patient-owned, now uses assertPatientOwnsResource)
//   - GET /donations/:id/screening (staff-only — donor PII)
//   - GET /donors/:id/eligibility (staff-only — donor PII)
//   - GET /donors/:id/deferrals  (staff-only — donor medical reasons)
// Regression cases at the bottom of this file pin the new behaviour.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createBloodDonorFixture,
  createBloodUnitFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

describeIfDB("BloodBank API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("registers a blood donor", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        name: "John Donor",
        phone: "9123456789",
        bloodGroup: "O_POS",
        gender: "MALE",
        weight: 70,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.donorNumber).toBeTruthy();
  });

  it("lists donors", async () => {
    await createBloodDonorFixture();
    const res = await request(app)
      .get("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("records a blood donation", async () => {
    const donor = await createBloodDonorFixture();
    const res = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: donor.id, volumeMl: 450 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.unitNumber).toBeTruthy();

    const prisma = await getPrisma();
    const donorRefreshed = await prisma.bloodDonor.findUnique({
      where: { id: donor.id },
    });
    expect(donorRefreshed?.totalDonations).toBe(1);
  });

  it("approves a donation (creates blood units)", async () => {
    const donor = await createBloodDonorFixture();
    const donationRes = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: donor.id });
    const donationId = donationRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/bloodbank/donations/${donationId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approved: true });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const units = await prisma.bloodUnit.findMany({
      where: { donationId },
    });
    expect(units.length).toBeGreaterThan(0);
  });

  it("creates a blood request", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/bloodbank/requests")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        unitsRequested: 2,
        reason: "Pre-op for CABG",
        urgency: "ROUTINE",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.requestNumber).toBeTruthy();
  });

  it("returns inventory summary", async () => {
    await createBloodUnitFixture({ bloodGroup: "A_POS" });
    await createBloodUnitFixture({ bloodGroup: "O_POS" });
    const res = await request(app)
      .get("/api/v1/bloodbank/inventory/summary")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("lists inventory (blood units)", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/inventory")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("records temperature log", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/temperature-logs")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        location: "Fridge-A",
        temperature: 4.2,
        inRange: true,
      });
    expect(res.status).toBeLessThan(500);
  });

  it("reserves a unit", async () => {
    const unit = await createBloodUnitFixture({ bloodGroup: "O_POS" });
    const patient = await createPatientFixture();
    // Create a request first
    const reqRes = await request(app)
      .post("/api/v1/bloodbank/requests")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        bloodGroup: "O_POS",
        component: "WHOLE_BLOOD",
        unitsRequested: 1,
        reason: "Transfusion",
        urgency: "URGENT",
      });
    const requestId = reqRes.body.data?.id;
    const res = await request(app)
      .patch(`/api/v1/bloodbank/units/${unit.id}/reserve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ requestId, reservationHours: 4 });
    expect(res.status).toBeLessThan(500);
  });

  it("returns compatibility matrix", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/compatibility-matrix")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects bad donor payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/bloodbank/donors");
    expect(res.status).toBe(401);
  });

  // Regression guard for Issue #49 (2026-04-24): summary strip and
  // per-group cards disagreed on "Expiring in 7 days" because each widget
  // did its own date math over different unit sets. The fix is a single
  // server-side helper exposed as `expiringByBloodGroup` — this test pins
  // the invariant that summary.expiringSoon === Σ expiringByBloodGroup.
  it("Issue #49: inventory summary's expiringSoon equals sum of per-group expiring", async () => {
    // Seed units across groups with varied expiry dates to exercise the
    // "< 7 days" boundary.
    const soon1 = new Date();
    soon1.setDate(soon1.getDate() + 3);
    const soon2 = new Date();
    soon2.setDate(soon2.getDate() + 6);
    const far = new Date();
    far.setDate(far.getDate() + 40);
    const alreadyExpired = new Date();
    alreadyExpired.setDate(alreadyExpired.getDate() - 1);

    await createBloodUnitFixture({
      bloodGroup: "A_NEG",
      expiresAt: soon1,
    });
    await createBloodUnitFixture({
      bloodGroup: "A_NEG",
      expiresAt: soon2,
    });
    await createBloodUnitFixture({
      bloodGroup: "AB_NEG",
      expiresAt: soon1,
    });
    // Not expiring soon — must not count.
    await createBloodUnitFixture({
      bloodGroup: "AB_NEG",
      expiresAt: far,
    });
    // Already expired — must not count either (bug mode would double-count
    // these into the per-group card but not the summary).
    await createBloodUnitFixture({
      bloodGroup: "A_NEG",
      expiresAt: alreadyExpired,
    });

    const res = await request(app)
      .get("/api/v1/bloodbank/inventory/summary")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const data = res.body.data as {
      expiringSoon: number;
      expiringByBloodGroup: Record<string, number>;
    };

    expect(typeof data.expiringSoon).toBe("number");
    expect(data.expiringByBloodGroup).toBeTruthy();

    const sum = Object.values(data.expiringByBloodGroup).reduce(
      (a: number, b) => a + (Number(b) || 0),
      0
    );
    // THE invariant: summary count === Σ of per-group counts, regardless
    // of implementation details.
    expect(data.expiringSoon).toBe(sum);

    // Sanity: the three "soon" units we seeded must be reflected
    // (there may be other units from earlier tests, so use >=).
    expect(data.expiringSoon).toBeGreaterThanOrEqual(3);
    expect(data.expiringByBloodGroup["A_NEG"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(data.expiringByBloodGroup["AB_NEG"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Issue #511 regression — BOLA / authorization gaps on 4 /:id handlers
  // ─────────────────────────────────────────────────────────────────────
  // GET /requests/:id had no `assertPatientOwnsResource` — PATIENT-A could
  // read PATIENT-B's transfusion request by UUID. The donations/donors
  // /:id sub-resources had no `authorize()` at all — any authenticated
  // user (incl. PATIENT) could fetch donor PII (HIV/HCV/HBsAg results,
  // weight, deferral reasons). These tests pin the new gating: PATIENT
  // is denied where appropriate; staff still pass.
  it("Issue #511: PATIENT cannot GET another patient's blood request (BOLA)", async () => {
    const jwt = await import("jsonwebtoken");
    const bcrypt = await import("bcryptjs");
    const prisma = await getPrisma();

    // Build two PATIENT users + Patient rows directly (the shared
    // `getAuthToken("PATIENT")` only ever yields one canonical patient).
    const mkPatient = async (label: string) => {
      const email = `bb511_${label}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}@test.local`;
      const user = await prisma.user.create({
        data: {
          email,
          name: `BB511 ${label}`,
          phone: "9000000000",
          passwordHash: await bcrypt.default.hash("MedCoreT3st-2026", 4),
          role: "PATIENT" as any,
        },
      });
      const p = await prisma.patient.create({
        data: {
          userId: user.id,
          mrNumber: `MR-BB511-${label}-${Date.now()}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "MALE" as any,
        },
      });
      const token = jwt.default.sign(
        { userId: user.id, email, role: "PATIENT" },
        process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
        { expiresIn: "1h" }
      );
      return { patientId: p.id, token };
    };

    const a = await mkPatient("A");
    const b = await mkPatient("B");
    const patientAToken = a.token;
    const patientBToken = b.token;

    // Staff creates a blood request owned by PATIENT-B.
    const reqB = await request(app)
      .post("/api/v1/bloodbank/requests")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: b.patientId,
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        unitsRequested: 1,
        reason: "Transfusion",
        urgency: "ROUTINE",
      });
    expect([200, 201]).toContain(reqB.status);
    const requestId = reqB.body.data.id as string;

    // (1) PATIENT-A → PATIENT-B's request → 403 (the bug)
    const cross = await request(app)
      .get(`/api/v1/bloodbank/requests/${requestId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(cross.status).toBe(403);

    // (2) PATIENT-B → own request → 200 (positive control)
    const own = await request(app)
      .get(`/api/v1/bloodbank/requests/${requestId}`)
      .set("Authorization", `Bearer ${patientBToken}`);
    expect(own.status).toBe(200);

    // (3) Staff → any request → 200 (RBAC unbroken)
    const staff = await request(app)
      .get(`/api/v1/bloodbank/requests/${requestId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(staff.status).toBe(200);
  });

  it("Issue #511: PATIENT cannot GET donation screening (donor PII)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const donor = await createBloodDonorFixture();
    const donationRes = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: donor.id });
    const donationId = donationRes.body.data.id as string;

    const denied = await request(app)
      .get(`/api/v1/bloodbank/donations/${donationId}/screening`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`/api/v1/bloodbank/donations/${donationId}/screening`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
  });

  it("Issue #511: PATIENT cannot GET donor eligibility (donor PII)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const donor = await createBloodDonorFixture();

    const denied = await request(app)
      .get(`/api/v1/bloodbank/donors/${donor.id}/eligibility`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`/api/v1/bloodbank/donors/${donor.id}/eligibility`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
  });

  it("Issue #511: PATIENT cannot GET donor deferrals (donor medical history)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const donor = await createBloodDonorFixture();

    const denied = await request(app)
      .get(`/api/v1/bloodbank/donors/${donor.id}/deferrals`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`/api/v1/bloodbank/donors/${donor.id}/deferrals`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
  });
});
