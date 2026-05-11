// Integration tests for the ABDM consents list endpoints.
//
// Exercises:
//   - GET /api/v1/abdm/consents?patientId=... (list by patient, 50 most recent)
//   - GET /api/v1/abdm/consents/:id             (single artefact, local DB only)
//
// These are the local-DB read endpoints; they do NOT talk to the ABDM gateway
// (that's what the existing /consent/:id singular path does).

import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import {
  describeIfDB,
  resetDB,
  getAuthToken,
  getPrisma,
} from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;
let prisma: any;

async function seedConsent(patientId: string, overrides: Partial<any> = {}) {
  return prisma.consentArtefact.create({
    data: {
      patientId,
      hiuId: overrides.hiuId ?? "hospital-1",
      purpose: overrides.purpose ?? "CAREMGT",
      status: overrides.status ?? "REQUESTED",
      artefact: overrides.artefact ?? { hiTypes: ["OPConsultation"] },
      expiresAt:
        overrides.expiresAt ??
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      grantedAt: overrides.grantedAt,
      revokedAt: overrides.revokedAt,
      createdAt: overrides.createdAt,
    },
  });
}

describeIfDB("ABDM consents list (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
    prisma = await getPrisma();
  });

  beforeEach(async () => {
    await prisma.consentArtefact.deleteMany({});
  });

  // ── 1 ─────────────────────────────────────────────────────────────────
  it("lists consents for a patient ordered newest-first", async () => {
    const patient = await createPatientFixture({});

    // Seed three consents with staggered createdAt timestamps.
    const old = await seedConsent(patient.id, {
      hiuId: "oldest",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const mid = await seedConsent(patient.id, {
      hiuId: "middle",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const fresh = await seedConsent(patient.id, {
      hiuId: "newest",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });

    const res = await request(app)
      .get(`/api/v1/abdm/consents?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].id).toBe(fresh.id);
    expect(res.body.data[1].id).toBe(mid.id);
    expect(res.body.data[2].id).toBe(old.id);
    // sanity — sorted by createdAt desc
    expect(new Date(res.body.data[0].createdAt).getTime()).toBeGreaterThan(
      new Date(res.body.data[2].createdAt).getTime()
    );
  });

  // ── 2 ─────────────────────────────────────────────────────────────────
  it("404s when the patient does not exist", async () => {
    const res = await request(app)
      .get("/api/v1/abdm/consents?patientId=550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/patient not found/i);
  });

  // ── 3 ─────────────────────────────────────────────────────────────────
  it("returns an empty array when the patient has no consents", async () => {
    const patient = await createPatientFixture({});

    const res = await request(app)
      .get(`/api/v1/abdm/consents?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // ── 4 ─────────────────────────────────────────────────────────────────
  it("rejects PATIENT role with 403", async () => {
    const patient = await createPatientFixture({});

    const res = await request(app)
      .get(`/api/v1/abdm/consents?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  // ── 5 ─────────────────────────────────────────────────────────────────
  it("validates patientId is a uuid", async () => {
    const res = await request(app)
      .get("/api/v1/abdm/consents?patientId=not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  // ── 6 ─────────────────────────────────────────────────────────────────
  it("GET /consents/:id returns the artefact from local DB", async () => {
    const patient = await createPatientFixture({});
    const row = await seedConsent(patient.id, { status: "GRANTED" });

    const res = await request(app)
      .get(`/api/v1/abdm/consents/${row.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(row.id);
    expect(res.body.data.status).toBe("GRANTED");
    expect(res.body.data.patientId).toBe(patient.id);
  });

  // ── 7 ─────────────────────────────────────────────────────────────────
  it("GET /consents/:id returns 404 for an unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/abdm/consents/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
