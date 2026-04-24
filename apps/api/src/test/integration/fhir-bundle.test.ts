// Integration tests for FHIR Bundle ingestion guards. Focuses on the
// 2026-04-24 MEDIUM security follow-ups:
//   - F-FHIR-2 entry-count cap (100 entries per transaction bundle)
//   - the ADMIN-only role guard on POST /api/v1/fhir/Bundle
//
// The ingest service (`processBundle`) is not exercised here — we only verify
// that oversized or unauthorised bundles are rejected before they ever reach
// the prisma.$transaction layer.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

let app: any;
let adminToken: string;
let doctorToken: string;

/** Build a minimal transaction Bundle with N Patient entries. */
function oversizedBundle(entryCount: number) {
  const entry = Array.from({ length: entryCount }, (_, i) => ({
    fullUrl: `urn:uuid:${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
    resource: {
      resourceType: "Patient",
      id: `p-${i}`,
      identifier: [
        {
          system: "http://medcore.io/fhir/mr-number",
          value: `MR-${i}`,
        },
      ],
      name: [{ family: `Test${i}`, given: ["F"] }],
      gender: "female",
    },
    request: { method: "PUT", url: `Patient/p-${i}` },
  }));
  return {
    resourceType: "Bundle",
    id: "oversized-test-bundle",
    type: "transaction",
    entry,
  };
}

describeIfDB("FHIR Bundle ingest guards (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── 413 when entries exceed the 100-entry cap ────────────────────────

  it("rejects a Bundle with more than 100 entries with 413 + too-costly OperationOutcome", async () => {
    const bundle = oversizedBundle(101);

    const res = await request(app)
      .post("/api/v1/fhir/Bundle")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(bundle);

    expect(res.status).toBe(413);
    // Response is a FHIR OperationOutcome, not the MedCore envelope.
    const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue?.[0]?.severity).toBe("error");
    expect(body.issue?.[0]?.code).toBe("too-costly");
    expect(body.issue?.[0]?.diagnostics).toMatch(/101/);
    expect(body.issue?.[0]?.diagnostics).toMatch(/100/);
  });

  // ─── Role guard: DOCTOR cannot POST Bundle (admin-only) ───────────────

  it("rejects DOCTOR role with 403 on POST /Bundle (admin-only ingest)", async () => {
    const res = await request(app)
      .post("/api/v1/fhir/Bundle")
      .set("Authorization", `Bearer ${doctorToken}`)
      .set("Content-Type", "application/json")
      .send(oversizedBundle(2));

    expect(res.status).toBe(403);
  });

  // ─── Bundle.type=batch rejected as invalid ────────────────────────────

  it("rejects Bundle.type != transaction with 400", async () => {
    const bundle = oversizedBundle(2);
    bundle.type = "batch"; // the app accepts transaction only

    const res = await request(app)
      .post("/api/v1/fhir/Bundle")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(bundle);

    expect(res.status).toBe(400);
    const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue?.[0]?.diagnostics).toMatch(/transaction/);
  });

  // ─── Auth required ────────────────────────────────────────────────────

  it("requires authentication on POST /Bundle", async () => {
    const res = await request(app)
      .post("/api/v1/fhir/Bundle")
      .set("Content-Type", "application/json")
      .send(oversizedBundle(2));

    expect(res.status).toBe(401);
  });
});
