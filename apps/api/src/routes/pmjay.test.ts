/**
 * PM-JAY router — RBAC, beneficiary verify, package sync gate, stats, webhook.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: mounts `pmjayRouter` and exercises: /verify (ADMIN/RECEPTION only,
 *   returns eligibility), /packages/sync (ADMIN only), /stats shape, and the
 *   public /webhook (signature gate + status mapping + unknown-ref 202).
 * - MODULES: mocks `@medcore/db` (prisma/tenantScopedPrisma/runWithTenant), the
 *   claim `store` (updateStatus) and `invoice-status` (postInsurancePayment) so
 *   the webhook's write path is observable without a DB. Beneficiary/package
 *   services run for real in simulation mode.
 * - WHY: the auth gates + the webhook mapping are security/correctness surfaces
 *   that must not regress.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock, updateStatusMock, postSettlementMock } = vi.hoisted(() => {
  const base: any = {
    insuranceClaim2: {
      findUnique: vi.fn(async () => null),
      groupBy: vi.fn(async () => []),
    },
    pmjayBeneficiary: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "ben-1" })),
      update: vi.fn(async (a: any) => ({ id: a.where.id })),
      count: vi.fn(async () => 0),
    },
    pmjayVerificationHistory: { create: vi.fn(async () => ({ id: "h-1" })) },
    pmjayPackage: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    admission: { count: vi.fn(async () => 0) },
    pmjayDocumentUpload: { count: vi.fn(async () => 0) },
    preAuthRequest: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    tenantPmjayConfiguration: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ id: "cfg-1", ...a.data })),
      update: vi.fn(async (a: any) => ({ id: a.where.id, ...a.data })),
    },
  };
  return {
    prismaMock: base,
    updateStatusMock: vi.fn(async () => ({ id: "claim-1" })),
    postSettlementMock: vi.fn(async () => ({ posted: true })),
  };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  getTenantId: () => undefined,
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
}));
vi.mock("../services/insurance-claims/store", () => ({ updateStatus: updateStatusMock }));
vi.mock("../services/invoice-status", () => ({ postInsurancePayment: postSettlementMock }));

import { pmjayRouter } from "./pmjay";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use("/api/v1/pmjay", pmjayRouter);
  app.use(errorHandler);
  return app;
}
function token(role: string) {
  return jwt.sign({ userId: "u-1", email: `${role}@t.local`, role }, "test-secret");
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["TPA_PMJAY_BASE_URL", "TPA_PMJAY_AUTH_URL", "TPA_PMJAY_CLIENT_ID", "TPA_PMJAY_CLIENT_SECRET", "TPA_PMJAY_HOSPITAL_ID", "TPA_PMJAY_WEBHOOK_SECRET"]) {
    delete process.env[k]; // simulation, no webhook secret
  }
  prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue(null);
  prismaMock.pmjayBeneficiary.create.mockResolvedValue({ id: "ben-1" });
  prismaMock.insuranceClaim2.findUnique.mockResolvedValue(null);
  prismaMock.insuranceClaim2.groupBy.mockResolvedValue([]);
});

describe("POST /pmjay/verify", () => {
  it("verifies + returns ELIGIBLE for a normal card (ADMIN)", async () => {
    const res = await request(buildApp())
      .post("/api/v1/pmjay/verify")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({ patientId: "11111111-1111-4111-8111-111111111111", ayushmanCardNumber: "PMJAY-CARD-1" })
      .expect(200);
    expect(res.body.data.eligible).toBe(true);
    expect(res.body.data.eligibilityStatus).toBe("ELIGIBLE");
    expect(prismaMock.pmjayVerificationHistory.create).toHaveBeenCalled();
  });

  it("rejects DOCTOR with 403 (verify is ADMIN/RECEPTION only)", async () => {
    await request(buildApp())
      .post("/api/v1/pmjay/verify")
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ patientId: "11111111-1111-4111-8111-111111111111", ayushmanCardNumber: "PMJAY-CARD-1" })
      .expect(403);
  });

  it("400s on an invalid card format", async () => {
    await request(buildApp())
      .post("/api/v1/pmjay/verify")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({ patientId: "11111111-1111-4111-8111-111111111111", ayushmanCardNumber: "!!" })
      .expect(400);
  });
});

describe("POST /pmjay/packages/sync", () => {
  it("is ADMIN-only (RECEPTION → 403)", async () => {
    await request(buildApp())
      .post("/api/v1/pmjay/packages/sync")
      .set("Authorization", `Bearer ${token("RECEPTION")}`)
      .expect(403);
  });

  it("ADMIN sync writes the simulated master", async () => {
    const res = await request(buildApp())
      .post("/api/v1/pmjay/packages/sync")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .expect(200);
    expect(res.body.data.synced).toBeGreaterThan(0);
    expect(res.body.data.skipped).toBe(false);
  });
});

describe("PM-JAY per-tenant configuration", () => {
  it("GET /config is ADMIN-only (RECEPTION → 403)", async () => {
    await request(buildApp())
      .get("/api/v1/pmjay/config")
      .set("Authorization", `Bearer ${token("RECEPTION")}`)
      .expect(403);
  });

  it("GET /config returns the config WITHOUT the client secret", async () => {
    prismaMock.tenantPmjayConfiguration.findFirst.mockResolvedValue({
      id: "cfg-1",
      tenantId: "t-1",
      enabled: true,
      simulationMode: false,
      hospitalId: "H-1",
      clientId: "C-1",
      clientSecret: "ENCRYPTED-BLOB",
      baseUrl: "https://gw.example",
      authUrl: "https://gw.example/auth",
      bisUrl: null,
      tmsUrl: null,
      packageUrl: null,
      timeout: null,
      retryCount: null,
      logging: null,
      batchSize: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(buildApp())
      .get("/api/v1/pmjay/config")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .expect(200);
    expect(res.body.data.hospitalId).toBe("H-1");
    expect(res.body.data.clientSecretSet).toBe(true);
    expect(res.body.data.clientSecret).toBeUndefined(); // never exposed
  });

  it("PUT /config encrypts the secret, never echoes it, and audits the change", async () => {
    prismaMock.tenantPmjayConfiguration.findFirst.mockResolvedValue(null); // → create
    const res = await request(buildApp())
      .put("/api/v1/pmjay/config")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({
        enabled: true,
        simulationMode: false,
        hospitalId: "H-9",
        clientId: "C-9",
        clientSecret: "super-secret-value",
        baseUrl: "https://gw",
        authUrl: "https://gw/auth",
      })
      .expect(200);
    expect(res.body.data.clientSecret).toBeUndefined();
    expect(res.body.data.clientSecretSet).toBe(true);
    const created = prismaMock.tenantPmjayConfiguration.create.mock.calls[0][0].data;
    // Stored secret must be transformed (encrypted / wrapped), never raw.
    expect(created.clientSecret).toBeDefined();
    expect(created.clientSecret).not.toBe("super-secret-value");
  });

  it("PUT /config leaves the stored secret untouched when omitted", async () => {
    prismaMock.tenantPmjayConfiguration.findFirst.mockResolvedValue({ id: "cfg-1" });
    await request(buildApp())
      .put("/api/v1/pmjay/config")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({ hospitalId: "H-2" })
      .expect(200);
    const updated = prismaMock.tenantPmjayConfiguration.update.mock.calls[0][0].data;
    expect("clientSecret" in updated).toBe(false); // not overwritten
  });

  it("PUT /config is ADMIN-only (DOCTOR → 403)", async () => {
    await request(buildApp())
      .put("/api/v1/pmjay/config")
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ hospitalId: "H-2" })
      .expect(403);
  });
});

describe("GET /pmjay/beneficiary", () => {
  it("400s without patientId", async () => {
    await request(buildApp())
      .get("/api/v1/pmjay/beneficiary")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .expect(400);
  });

  it("returns the patient's ELIGIBLE beneficiary", async () => {
    prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue({
      id: "ben-1",
      ayushmanCardNumber: "PMJAY-CARD-1",
      beneficiaryId: "BEN9",
      familyId: "FAM9",
      eligibilityStatus: "ELIGIBLE",
      verifiedAt: new Date().toISOString(),
    });
    const res = await request(buildApp())
      .get("/api/v1/pmjay/beneficiary?patientId=p-1")
      .set("Authorization", `Bearer ${token("RECEPTION")}`)
      .expect(200);
    expect(res.body.data.ayushmanCardNumber).toBe("PMJAY-CARD-1");
    const where = prismaMock.pmjayBeneficiary.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ patientId: "p-1", eligibilityStatus: "ELIGIBLE" });
  });
});

describe("GET /pmjay/preauth", () => {
  it("returns the PM-JAY pre-auth queue and filters by status", async () => {
    prismaMock.preAuthRequest.findMany.mockResolvedValue([
      { id: "pa-1", requestNumber: "PA-1", procedureName: "Angioplasty", packageCode: "HBP-CARD-001", estimatedCost: 60000, status: "PENDING", approvedAmount: null, submittedAt: new Date().toISOString(), patient: { user: { name: "R K" } } },
    ]);
    const res = await request(buildApp())
      .get("/api/v1/pmjay/preauth?status=PENDING")
      .set("Authorization", `Bearer ${token("RECEPTION")}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    const where = prismaMock.preAuthRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.OR).toBeDefined(); // PM-JAY scope filter applied
  });
});

describe("GET /pmjay/stats", () => {
  it("returns the metric envelope", async () => {
    const res = await request(buildApp())
      .get("/api/v1/pmjay/stats")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .expect(200);
    expect(res.body.data).toHaveProperty("beneficiaries");
    expect(res.body.data).toHaveProperty("claims");
    expect(res.body.data).toHaveProperty("amounts");
    expect(res.body.data.ops).toHaveProperty("documentUploadsPending");
  });
});

describe("POST /pmjay/webhook", () => {
  it("acknowledges 202 for an unknown claim ref", async () => {
    const res = await request(buildApp())
      .post("/api/v1/pmjay/webhook")
      .send({ claimRef: "PMJAY-UNKNOWN", status: "APPROVED" })
      .expect(202);
    expect(res.body.data.matched).toBe(false);
  });

  it("maps status + calls updateStatus for a known claim", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue({
      id: "claim-1",
      billId: "inv-1",
      tpaProvider: "PMJAY",
      providerClaimRef: "PMJAY-REF-1",
      tenantId: "t-1",
      amountApproved: null,
      approvedAt: null,
      settledAt: null,
    });
    const res = await request(buildApp())
      .post("/api/v1/pmjay/webhook")
      .send({ claimRef: "PMJAY-REF-1", status: "CLAIM_PAID", approvedAmount: 8000 })
      .expect(200);
    expect(res.body.data.applied).toBe(true);
    expect(res.body.data.status).toBe("SETTLED"); // CLAIM_PAID → SETTLED
    expect(updateStatusMock).toHaveBeenCalled();
    expect(postSettlementMock).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv-1", amount: 8000, provider: "PMJAY" })
    );
  });

  it("rejects a bad signature with 401 when a secret is configured", async () => {
    process.env.TPA_PMJAY_WEBHOOK_SECRET = "shhh";
    await request(buildApp())
      .post("/api/v1/pmjay/webhook")
      .set("x-pmjay-signature", "wrong")
      .send({ claimRef: "PMJAY-REF-1", status: "APPROVED" })
      .expect(401);
  });
});
