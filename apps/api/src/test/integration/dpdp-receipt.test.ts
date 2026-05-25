// Integration tests for the DPDP §17 right-to-erasure auditable receipt —
// Pearl ERP Stage 1 §12 (gap row 382 closure, 2026-05-23).
//
// What / which modules / why:
//   - Covers GET /api/v1/dpdp-workbench/requests/:id/receipt.{json,pdf}
//     against an EXECUTED erasure-request row (status=COMPLETED with a
//     persisted executionReceipt JSON blob — produced by the workbench
//     execute path in production; seeded directly here for test isolation).
//   - Asserts the JSON receipt shape, that the receiptHash is reproducible
//     (re-deriving the canonical hash on the response payload matches),
//     that the PDF response carries `application/pdf` + `%PDF-` magic
//     bytes + bytes > 1024, and that DPDP_RECEIPT_DOWNLOADED audit rows
//     land. RBAC matrix mirrors dpdp-workbench.test.ts:
//       - non-default-tenant ADMIN → 403
//       - PATIENT → 403
//       - super-admin (tenant-less ADMIN) → 200
//
// Pattern lifted from dpdp-workbench.test.ts (same buildTestApp shape,
// same seedSuperAdmin, same waitForAuditFlush flow).

import { it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { dpdpWorkbenchRouter } from "../../routes/dpdp-workbench";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: express.Express;
let superAdminToken: string;
let superAdminUserId: string;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/dpdp-workbench", dpdpWorkbenchRouter);
  a.use(errorHandler);
  return a;
}

async function ensureDefaultTenant(): Promise<string> {
  const prisma = await getPrisma();
  const existing = await prisma.tenant.findUnique({
    where: { subdomain: "default" },
  });
  if (existing) return existing.id;
  const t = await prisma.tenant.create({
    data: {
      name: "Default Tenant",
      subdomain: "default",
      plan: "BASIC",
      active: true,
    },
  });
  return t.id;
}

async function seedSuperAdmin(
  tenantId: string | null,
): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `super-admin-dpdpr-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin (dpdp-receipt)",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenantId ?? null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: tenantId ?? undefined,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

async function seedExecutedErasureRequest(
  tenantId: string,
  executedByUserId: string,
): Promise<{ requestId: string; patientId: string }> {
  const prisma = await getPrisma();
  const suffix = Math.random().toString(36).slice(2, 8);
  const userEmail = `dpdpr-patient-${Date.now()}-${suffix}@test.local`;
  const u = await prisma.user.create({
    data: {
      email: userEmail,
      name: "DPDP-Receipt Target",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT",
      tenantId,
      isActive: true,
    },
  });
  const p = await prisma.patient.create({
    data: {
      userId: u.id,
      mrNumber: `MR-DPDPR-${Date.now()}-${suffix}`,
      gender: "MALE",
      tenantId,
    },
  });
  // Mirror the receipt shape produced by services/dpdp-purge.ts so the
  // receipt builder has realistic data to render.
  const row = await prisma.dPDPErasureRequest.create({
    data: {
      tenantId,
      patientId: p.id,
      requestedBy: executedByUserId,
      requestedByRole: "SUPER_ADMIN",
      reason: "Patient request via phone",
      status: "COMPLETED",
      executedAt: new Date(),
      executedBy: executedByUserId,
      executionReceipt: {
        purgedTables: ["Vitals", "Appointment", "PatientDocument"],
        purgedRows: { Vitals: 1, Appointment: 1, PatientDocument: 0 },
        anonymizedTables: ["Patient", "User"],
        retainedTables: ["AuditLog", "DPDPErasureRequest"],
        notes: "Test fixture receipt",
        executedAt: new Date().toISOString(),
      },
    },
  });
  // Persist the REQUESTED + EXECUTED audit rows so the audit-trail
  // section of the receipt is non-empty (production path writes both).
  await prisma.auditLog.create({
    data: {
      userId: executedByUserId,
      action: "DPDP_ERASURE_REQUESTED",
      entity: "dpdp_erasure_request",
      entityId: row.id,
      details: { patientId: p.id, tenantId },
    },
  });
  await prisma.auditLog.create({
    data: {
      userId: executedByUserId,
      action: "DPDP_ERASURE_EXECUTED",
      entity: "dpdp_erasure_request",
      entityId: row.id,
      details: { patientId: p.id, tenantId },
    },
  });
  return { requestId: row.id, patientId: p.id };
}

// Re-derives the canonical hash on the response body the same way the
// service does — sorted keys at every level, hash field excluded.
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
    .join(",")}}`;
}

describeIfDB("DPDP erasure receipt (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: [
            "DPDP_ERASURE_REQUESTED",
            "DPDP_ERASURE_EXECUTED",
            "DPDP_ERASURE_REJECTED",
            "DPDP_RECEIPT_DOWNLOADED",
          ],
        },
      },
    });
    await prisma.dPDPErasureRequest.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { startsWith: "super-admin-dpdpr-" } },
    });
    await ensureDefaultTenant();
    const seeded = await seedSuperAdmin(null);
    superAdminToken = seeded.token;
    superAdminUserId = seeded.userId;
  });

  // ── 1. JSON receipt — shape + reproducible hash ────────────
  it("GET /requests/:id/receipt.json returns the structured receipt with a reproducible SHA-256 hash", async () => {
    const tenantId = await ensureDefaultTenant();
    const { requestId, patientId } = await seedExecutedErasureRequest(
      tenantId,
      superAdminUserId,
    );
    const res = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.json`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const receipt = res.body.data;
    expect(receipt.requestId).toBe(requestId);
    expect(receipt.patientId).toBe(patientId);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.receiptVersion).toBe(1);
    expect(Array.isArray(receipt.tablesAffected)).toBe(true);
    expect(receipt.tablesAffected.length).toBeGreaterThan(0);
    expect(Array.isArray(receipt.auditTrail)).toBe(true);
    expect(receipt.auditTrail.length).toBeGreaterThanOrEqual(2);
    expect(typeof receipt.receiptHash).toBe("string");
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);

    // Reproducibility: strip receiptHash, canonicalize, re-derive, compare.
    const { receiptHash, ...rest } = receipt;
    const canonical = canonicalJsonStringify(rest);
    const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(receiptHash).toBe(expected);

    // Audit row landed.
    const audit = await waitForAuditFlush(await getPrisma(), {
      action: "DPDP_RECEIPT_DOWNLOADED",
      entity: "dpdp_erasure_request",
      entityId: requestId,
    });
    expect(audit.action).toBe("DPDP_RECEIPT_DOWNLOADED");
  });

  // ── 2. PDF receipt — content-type + magic bytes + size ─────
  it("GET /requests/:id/receipt.pdf returns an application/pdf body with PDF magic bytes", async () => {
    const tenantId = await ensureDefaultTenant();
    const { requestId } = await seedExecutedErasureRequest(
      tenantId,
      superAdminUserId,
    );
    const res = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.pdf`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const data: Buffer[] = [];
        response.on("data", (chunk: Buffer) => data.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(data)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/dpdp-receipt-/);
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(1024);
    // %PDF- magic bytes.
    expect(body.slice(0, 5).toString("ascii")).toBe("%PDF-");

    const audit = await waitForAuditFlush(await getPrisma(), {
      action: "DPDP_RECEIPT_DOWNLOADED",
      entity: "dpdp_erasure_request",
      entityId: requestId,
    });
    expect(audit.action).toBe("DPDP_RECEIPT_DOWNLOADED");
  });

  // ── 3. Non-existent id → 404 ───────────────────────────────
  it("GET /requests/:id/receipt.json on a non-existent id returns 404", async () => {
    const res = await request(app)
      .get("/api/v1/dpdp-workbench/requests/does-not-exist/receipt.json")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(404);
  });

  // ── 4. Tenant-bound ADMIN → 403 ────────────────────────────
  it("rejects a tenant-scoped ADMIN with no default-tenant membership (403)", async () => {
    const prisma = await getPrisma();
    const tenantId = await ensureDefaultTenant();
    const { requestId } = await seedExecutedErasureRequest(
      tenantId,
      superAdminUserId,
    );
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `Other Tenant ${Date.now()}`,
        subdomain: `other-dpdpr-${Math.random().toString(36).slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const seeded = await seedSuperAdmin(otherTenant.id);
    const res = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.json`)
      .set("Authorization", `Bearer ${seeded.token}`);
    expect(res.status).toBe(403);
  });

  // ── 5. PATIENT role → 403 ──────────────────────────────────
  it("rejects PATIENT role on the receipt endpoints (403)", async () => {
    const tenantId = await ensureDefaultTenant();
    const { requestId } = await seedExecutedErasureRequest(
      tenantId,
      superAdminUserId,
    );
    const patientToken = await getAuthToken("PATIENT");
    const resJson = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.json`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(resJson.status).toBe(403);
    const resPdf = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.pdf`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(resPdf.status).toBe(403);
  });
});
