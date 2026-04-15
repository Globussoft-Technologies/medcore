// Integration tests for bloodbank router.
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
});
