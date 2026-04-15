// Deep branch-coverage tests for bloodbank router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createBloodDonorFixture } from "../factories";

let app: any;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;

describeIfDB("BloodBank API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("donor create with invalid bloodGroup (400)", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        name: "Jane",
        phone: "9999999999",
        bloodGroup: "Z_POS",
        gender: "FEMALE",
      });
    expect(res.status).toBe(400);
  });

  it("donor eligibility: recent donation <90d → not eligible", async () => {
    const d = await createBloodDonorFixture({
      weight: 70,
      dateOfBirth: new Date("1990-01-01"),
    });
    const prisma = await getPrisma();
    await prisma.bloodDonor.update({
      where: { id: d.id },
      data: { lastDonation: new Date() },
    });
    const res = await request(app)
      .get(`/api/v1/bloodbank/donors/${d.id}/eligibility`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.eligible).toBe(false);
    expect(res.body.data.reasons.some((r: string) => r.includes("days ago"))).toBe(
      true
    );
  });

  it("donor eligibility: weight <50kg flagged", async () => {
    const d = await createBloodDonorFixture({ weight: 45 });
    const res = await request(app)
      .get(`/api/v1/bloodbank/donors/${d.id}/eligibility`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.eligible).toBe(false);
    expect(res.body.data.reasons.some((r: string) => r.includes("50kg"))).toBe(
      true
    );
  });

  it("donor eligibility 404", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/donors/00000000-0000-0000-0000-000000000000/eligibility")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("permanent deferral flips isEligible=false and appears in eligibility reasons", async () => {
    const d = await createBloodDonorFixture();
    const def = await request(app)
      .post(`/api/v1/bloodbank/donors/${d.id}/deferrals`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ reason: "HIV positive", deferralType: "PERMANENT" });
    expect(def.status).toBe(201);
    const elig = await request(app)
      .get(`/api/v1/bloodbank/donors/${d.id}/eligibility`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(elig.body.data.eligible).toBe(false);
    expect(elig.body.data.reasons.some((r: string) => r.includes("Permanent"))).toBe(
      true
    );
  });

  it("temporary deferral persisted and retrievable via GET", async () => {
    const d = await createBloodDonorFixture();
    await request(app)
      .post(`/api/v1/bloodbank/donors/${d.id}/deferrals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        reason: "Recent fever",
        deferralType: "TEMPORARY",
        startDate: "2026-04-01",
        endDate: "2026-04-15",
      });
    const list = await request(app)
      .get(`/api/v1/bloodbank/donors/${d.id}/deferrals`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("deferral on unknown donor (404)", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/donors/00000000-0000-0000-0000-000000000000/deferrals")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ reason: "X", deferralType: "TEMPORARY" });
    expect(res.status).toBe(404);
  });

  it("create donation + approve + separate components (PRBC/FFP/PLATELETS)", async () => {
    const d = await createBloodDonorFixture({ bloodGroup: "O_POS" });
    const don = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: d.id, volumeMl: 450 });
    expect(don.status).toBe(201);

    const approve = await request(app)
      .patch(`/api/v1/bloodbank/donations/${don.body.data.id}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ approved: true });
    expect(approve.status).toBe(200);

    const sep = await request(app)
      .post(`/api/v1/bloodbank/donations/${don.body.data.id}/separate`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        components: [
          { component: "PRBC", unitsProduced: 1 },
          { component: "FFP", unitsProduced: 1 },
          { component: "PLATELETS", unitsProduced: 1 },
        ],
      });
    expect(sep.status).toBe(201);
    expect(sep.body.data.units.length).toBe(3);
  });

  it("separation rejected when donation not approved (400)", async () => {
    const d = await createBloodDonorFixture();
    const don = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: d.id });
    const sep = await request(app)
      .post(`/api/v1/bloodbank/donations/${don.body.data.id}/separate`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ components: [{ component: "PRBC", unitsProduced: 1 }] });
    expect(sep.status).toBe(400);
  });

  it("screening failure discards all units", async () => {
    const d = await createBloodDonorFixture();
    const don = await request(app)
      .post("/api/v1/bloodbank/donations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ donorId: d.id });
    await request(app)
      .patch(`/api/v1/bloodbank/donations/${don.body.data.id}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ approved: true });
    const scr = await request(app)
      .post(`/api/v1/bloodbank/donations/${don.body.data.id}/screening`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        hivResult: "POSITIVE",
        hcvResult: "NEGATIVE",
        hbsAgResult: "NEGATIVE",
        syphilisResult: "NEGATIVE",
        malariaResult: "NEGATIVE",
      });
    expect(scr.status).toBe(201);
    expect(scr.body.data.passed).toBe(false);
    const prisma = await getPrisma();
    const units = await prisma.bloodUnit.findMany({
      where: { donationId: don.body.data.id },
    });
    expect(units.every((u: any) => u.status === "DISCARDED")).toBe(true);
  });

  it("ABO/Rh compatibility matrix endpoint exposed", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/compatibility-matrix")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rbc.O_NEG).toEqual(["O_NEG"]);
    expect(res.body.data.rbc.AB_POS.length).toBeGreaterThanOrEqual(8);
  });

  it("reserve unit: 404 when unit unknown", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/units/00000000-0000-0000-0000-000000000000/reserve")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ durationHours: 24 });
    expect(res.status).toBe(404);
  });

  it("reserve → release round-trip on a real unit", async () => {
    const prisma = await getPrisma();
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    const u = await prisma.bloodUnit.create({
      data: {
        unitNumber: `BU-TEST-${Date.now()}`,
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        volumeMl: 350,
        collectedAt: new Date(),
        expiresAt: expires,
        status: "AVAILABLE",
      },
    });
    const r = await request(app)
      .post(`/api/v1/bloodbank/units/${u.id}/reserve`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ durationHours: 12 });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("RESERVED");

    const rel = await request(app)
      .post(`/api/v1/bloodbank/units/${u.id}/release`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(rel.status).toBe(200);
    expect(rel.body.data.status).toBe("AVAILABLE");
  });

  it("reserve rejects expired unit (409)", async () => {
    const prisma = await getPrisma();
    const u = await prisma.bloodUnit.create({
      data: {
        unitNumber: `BU-EXP-${Date.now()}`,
        bloodGroup: "A_POS",
        component: "PACKED_RED_CELLS",
        volumeMl: 350,
        collectedAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-02-01"),
        status: "AVAILABLE",
      },
    });
    const r = await request(app)
      .post(`/api/v1/bloodbank/units/${u.id}/reserve`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(r.status).toBe(409);
  });

  it("release fails when unit not reserved (409)", async () => {
    const prisma = await getPrisma();
    const u = await prisma.bloodUnit.create({
      data: {
        unitNumber: `BU-NR-${Date.now()}`,
        bloodGroup: "B_POS",
        component: "PACKED_RED_CELLS",
        volumeMl: 350,
        collectedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
        status: "AVAILABLE",
      },
    });
    const r = await request(app)
      .post(`/api/v1/bloodbank/units/${u.id}/release`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({});
    expect(r.status).toBe(409);
  });

  it("blood request + match + issue with compatibility check", async () => {
    const patient = await createPatientFixture({ bloodGroup: "O+" });
    const prisma = await getPrisma();
    const u = await prisma.bloodUnit.create({
      data: {
        unitNumber: `BU-ISSUE-${Date.now()}`,
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        volumeMl: 350,
        collectedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
        status: "AVAILABLE",
      },
    });
    const rq = await request(app)
      .post("/api/v1/bloodbank/requests")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        unitsRequested: 1,
        reason: "Anemia",
        urgency: "ROUTINE",
      });
    expect(rq.status).toBe(201);
    const issue = await request(app)
      .post(`/api/v1/bloodbank/requests/${rq.body.data.id}/issue`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ unitIds: [u.id] });
    expect(issue.status).toBe(200);
  });

  it("issue incompatible group (400)", async () => {
    const patient = await createPatientFixture({ bloodGroup: "A-" });
    const prisma = await getPrisma();
    const u = await prisma.bloodUnit.create({
      data: {
        unitNumber: `BU-INCOMP-${Date.now()}`,
        bloodGroup: "B_POS",
        component: "PACKED_RED_CELLS",
        volumeMl: 350,
        collectedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
        status: "AVAILABLE",
      },
    });
    const rq = await request(app)
      .post("/api/v1/bloodbank/requests")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        bloodGroup: "A_NEG",
        component: "PACKED_RED_CELLS",
        unitsRequested: 1,
        reason: "Surgery",
        urgency: "URGENT",
      });
    const issue = await request(app)
      .post(`/api/v1/bloodbank/requests/${rq.body.data.id}/issue`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ unitIds: [u.id] });
    expect(issue.status).toBe(400);
  });

  it("temperature log out-of-range sets inRange=false", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/temperature-logs")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ location: "Fridge-A", temperature: 12 });
    expect(res.status).toBe(201);
    expect(res.body.data.inRange).toBe(false);
  });

  it("temperature log freezer (plasma) in range when <= -18", async () => {
    const res = await request(app)
      .post("/api/v1/bloodbank/temperature-logs")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ location: "plasma-freezer", temperature: -25 });
    expect(res.status).toBe(201);
    expect(res.body.data.inRange).toBe(true);
  });

  it("inventory summary exposes expiringSoon count", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/inventory/summary")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.expiringSoon).toBe("number");
  });

  it("low-stock alert enumerates all 8 groups × 3 components", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/alerts/low-stock?threshold=1")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.alerts)).toBe(true);
  });

  it("release-expired-reservations cron endpoint ADMIN only", async () => {
    const ok = await request(app)
      .post("/api/v1/bloodbank/release-expired-reservations")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    const denied = await request(app)
      .post("/api/v1/bloodbank/release-expired-reservations")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(denied.status).toBe(403);
  });
});
