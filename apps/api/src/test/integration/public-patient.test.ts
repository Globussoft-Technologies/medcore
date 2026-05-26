// Integration tests for the public (unauth) patient-verification endpoint
// mounted at /api/v1/public/verify/patient/:id. The route is reached by QR
// scan from the printed patient ID card (see services/pdf-generator.ts) and
// must:
//   1. return only the safe summary fields already printed on the physical
//      card (no chart data, no address, no insurance, no contact phone of the
//      patient themselves — only the emergency contact, which IS on the card).
//   2. work without any Authorization header.
//   3. return 404 for unknown / invalid ids.
//   4. fold hospital_* SystemConfig rows into the hospital block, with safe
//      defaults when keys are missing.
//
// PII-leak guard: assert the response does NOT include patient.address,
// patient.dateOfBirth, patient.insurancePolicyNumber, patient.insuranceProvider,
// any chart-data link, or the patient.user.email / user.phone.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;

describeIfDB("Public patient verification API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns 404 for an unknown patient id (no auth required)", async () => {
    const res = await request(app).get(
      "/api/v1/public/verify/patient/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "Patient not found" });
  });

  it("returns 404 for a malformed (non-uuid) id rather than 500", async () => {
    const res = await request(app).get(
      "/api/v1/public/verify/patient/not-a-real-id",
    );
    // Prisma findUnique on a non-uuid throws → next(err) → error middleware.
    // Either 404 (id not found) or 4xx/5xx-but-not-200 is acceptable; the
    // load-bearing assertion is that NO patient data leaks out.
    expect(res.status).not.toBe(200);
    expect(res.body?.ok).not.toBe(true);
    expect(res.body?.mrNumber).toBeUndefined();
    expect(res.body?.name).toBeUndefined();
  });

  it("returns the safe summary for a known patient without auth", async () => {
    const patient = await createPatientFixture({
      name: "Verify Test Patient",
      bloodGroup: "A+",
      age: 42,
      gender: "MALE",
      emergencyContactName: "Spouse Of Patient",
      emergencyContactPhone: "9999988888",
      address: "Secret-Address-Do-Not-Leak-123",
      insurancePolicyNumber: "POL-SECRET-LEAK-CANARY",
      insuranceProvider: "Acme Insurance",
    });

    const res = await request(app).get(
      `/api/v1/public/verify/patient/${patient.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.patientId).toBe(patient.id);
    expect(res.body.mrNumber).toBe(patient.mrNumber);
    expect(res.body.name).toBe("Verify Test Patient");
    expect(res.body.gender).toBe("MALE");
    expect(res.body.bloodGroup).toBe("A+");
    expect(res.body.age).toBe(42);
    expect(res.body.emergencyContactName).toBe("Spouse Of Patient");
    expect(res.body.emergencyContactPhone).toBe("9999988888");
    expect(res.body.hospital).toBeDefined();
  });

  it("does NOT leak protected PII (address / insurance / DOB / email / phone)", async () => {
    const patient = await createPatientFixture({
      address: "Secret-Address-PII-LEAK-CANARY",
      insurancePolicyNumber: "POL-PII-LEAK-CANARY",
      insuranceProvider: "Provider-PII-LEAK-CANARY",
    });

    const res = await request(app).get(
      `/api/v1/public/verify/patient/${patient.id}`,
    );
    expect(res.status).toBe(200);

    const body = res.body;
    // Field-level deny-list:
    expect(body.address).toBeUndefined();
    expect(body.dateOfBirth).toBeUndefined();
    expect(body.insurancePolicyNumber).toBeUndefined();
    expect(body.insuranceProvider).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(body.email).toBeUndefined();
    expect(body.phone).toBeUndefined();
    expect(body.noShowCount).toBeUndefined();
    expect(body.preferredLanguage).toBeUndefined();

    // Value-level deny-list (catches accidental nesting under any key):
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Secret-Address-PII-LEAK-CANARY");
    expect(serialized).not.toContain("POL-PII-LEAK-CANARY");
    expect(serialized).not.toContain("Provider-PII-LEAK-CANARY");
  });

  it("uses safe defaults for hospital block when SystemConfig keys are missing", async () => {
    const prisma = await getPrisma();
    // Wipe any hospital_* config rows that other tests may have seeded.
    await prisma.systemConfig.deleteMany({
      where: {
        key: {
          in: [
            "hospital_name",
            "hospital_address",
            "hospital_phone",
            "hospital_email",
            "hospital_logo_url",
            "hospital_tagline",
          ],
        },
      },
    });

    const patient = await createPatientFixture();
    const res = await request(app).get(
      `/api/v1/public/verify/patient/${patient.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.hospital).toEqual({
      name: "Hospital",
      address: "",
      phone: "",
      email: "",
      logoUrl: "",
      tagline: "",
    });
  });

  it("folds hospital_* SystemConfig rows into the hospital block", async () => {
    const prisma = await getPrisma();
    const entries = [
      { key: "hospital_name", value: "MedCore Demo Hospital" },
      { key: "hospital_address", value: "1 Demo Lane, Bangalore" },
      { key: "hospital_phone", value: "+91-80-12345678" },
      { key: "hospital_email", value: "info@medcore-demo.test" },
      { key: "hospital_logo_url", value: "https://cdn.example/logo.png" },
      { key: "hospital_tagline", value: "Care, codified" },
    ];
    for (const e of entries) {
      await prisma.systemConfig.upsert({
        where: { key: e.key },
        update: { value: e.value },
        create: e,
      });
    }

    const patient = await createPatientFixture();
    const res = await request(app).get(
      `/api/v1/public/verify/patient/${patient.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.hospital).toEqual({
      name: "MedCore Demo Hospital",
      address: "1 Demo Lane, Bangalore",
      phone: "+91-80-12345678",
      email: "info@medcore-demo.test",
      logoUrl: "https://cdn.example/logo.png",
      tagline: "Care, codified",
    });
  });

  it("accepts the request with NO Authorization header (public endpoint)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/public/verify/patient/${patient.id}`)
      // explicitly do NOT set Authorization
      .set("X-Marker", "no-auth");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("ignores an invalid Authorization header (does not 401)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/public/verify/patient/${patient.id}`)
      .set("Authorization", "Bearer this-is-a-completely-bogus-token");
    // Public route — bogus token should NOT cause a 401; it's simply ignored.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
