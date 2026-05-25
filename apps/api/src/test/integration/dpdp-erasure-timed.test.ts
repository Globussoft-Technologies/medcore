// Pearl §8.7 row 351 — DPDP delete request executes in < 60s with auditable receipt.
//
// What:    Brackets the end-to-end DPDP erasure round trip with Date.now() —
//          POST /api/v1/dpdp-workbench/requests (create PENDING) →
//          POST /api/v1/dpdp-workbench/requests/:id/execute (synchronous purge
//          + anonymize) → GET /api/v1/dpdp-workbench/requests/:id/receipt.json
//          (auditable receipt with SHA-256 hash). Asserts the wall-clock
//          execute-to-receipt span stays under the 60_000 ms budget specified by
//          Pearl PRD M7 acceptance row 351.
// Modules: routes/dpdp-workbench.ts, services/dpdp-purge.ts (synchronous
//          cross-table purge), services/dpdp-receipt.ts (canonical receipt +
//          SHA-256 hash). Mirrors the API-driven posture of
//          razorpay-webhook-timing.test.ts (`aba3fcc`),
//          appointment-whatsapp-timing.test.ts (`c3c5b54`), and
//          tenant-suspend-blocks-login.test.ts (`4edf04f`).
// Why:     dpdp-workbench.test.ts proves correctness (purge, anonymize, audit)
//          and dpdp-receipt.test.ts proves the receipt shape + reproducible
//          hash, but neither asserts latency. PEARL_STAGE1_GAP_ANALYSIS row 351
//          left the < 60 s timing claim UNTESTED. This file closes that gap by
//          executing the production code path (not seeding a fake COMPLETED
//          row) and timing it against the SLA budget.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { dpdpWorkbenchRouter } from "../../routes/dpdp-workbench";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";

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

async function seedSuperAdmin(): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `super-admin-dpdpt-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin (dpdp-timed)",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

// Seeds a Patient + linked User + Doctor/Appointment/Vitals so the purge has
// non-trivial cross-table work to perform — matches the seedPatientWithChildren
// shape used by dpdp-workbench.test.ts but inlined here so this file is
// self-contained.
async function seedPatientWithChildren(
  tenantId: string,
): Promise<{ patientId: string; userId: string; appointmentId: string }> {
  const prisma = await getPrisma();
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({
    data: {
      email: `dpdpt-patient-${Date.now()}-${suffix}@test.local`,
      name: "DPDP-Timed Erasure Target",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT",
      tenantId,
      isActive: true,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-DPDPT-${Date.now()}-${suffix}`,
      gender: "MALE",
      address: "Erasable Address",
      bloodGroup: "O+",
      tenantId,
    },
  });
  const docUser = await prisma.user.create({
    data: {
      email: `dpdpt-doc-${Date.now()}-${suffix}@test.local`,
      name: "Dr DPDP Timed",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "DOCTOR",
      tenantId,
      isActive: true,
    },
  });
  const doctor = await prisma.doctor.create({
    data: {
      userId: docUser.id,
      specialization: "General",
      consultationFee: 500,
      tenantId,
    },
  });
  const appt = await prisma.appointment.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      date: new Date(),
      slotStart: "10:00",
      slotEnd: "10:15",
      type: "SCHEDULED",
      status: "BOOKED",
      tenantId,
    },
  });
  await prisma.vitals.create({
    data: {
      appointmentId: appt.id,
      patientId: patient.id,
      nurseId: docUser.id,
      bloodPressureSystolic: 120,
      bloodPressureDiastolic: 80,
      tenantId,
    },
  });
  return { patientId: patient.id, userId: user.id, appointmentId: appt.id };
}

describeIfDB("Pearl §8.7 row 351 — DPDP erasure end-to-end latency < 60s", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    // Wipe DPDP-relevant rows + our seeded super-admins between tests so the
    // timing run isn't skewed by leftover history (mirrors dpdp-workbench.test.ts).
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
      where: { email: { startsWith: "super-admin-dpdpt-" } },
    });
    await ensureDefaultTenant();
    const seeded = await seedSuperAdmin();
    superAdminToken = seeded.token;
    superAdminUserId = seeded.userId;
  });

  it("brackets create → execute → receipt with Date.now() and asserts the round trip is under 60_000 ms", async () => {
    const tenantId = await ensureDefaultTenant();
    const { patientId } = await seedPatientWithChildren(tenantId);

    // ── 1. Create the erasure request (PENDING). Done OUTSIDE the timer
    //       because the SLA in Pearl §8.7 is about the execute step — the
    //       create/file step is operator UX, not the purge SLA.
    const createRes = await request(app)
      .post("/api/v1/dpdp-workbench/requests")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        patientId,
        reason: "Timed DPDP erasure SLA bracket (Pearl §8.7 row 351)",
        requestedByRole: "SUPER_ADMIN",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.status).toBe("PENDING");
    const requestId = createRes.body.data.id as string;

    // ── 2. Time the execute + receipt fetch — the production "delete
    //       request executes" surface the PRD measures.
    const t0 = Date.now();
    const executeRes = await request(app)
      .post(`/api/v1/dpdp-workbench/requests/${requestId}/execute`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    const receiptRes = await request(app)
      .get(`/api/v1/dpdp-workbench/requests/${requestId}/receipt.json`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    const t1 = Date.now();
    const elapsedMs = t1 - t0;

    // ── 3. SLA assertion — Pearl PRD M7 §8.7 row 351 mandates < 60 s.
    expect(executeRes.status).toBe(200);
    expect(receiptRes.status).toBe(200);
    expect(elapsedMs).toBeLessThan(60_000);

    // ── 4. Correctness invariants on the receipt — same canonical shape
    //       asserted by dpdp-receipt.test.ts but threaded through the LIVE
    //       execute path (not a seeded COMPLETED row).
    const receipt = receiptRes.body.data;
    expect(receipt.status).toBe("COMPLETED");
    expect(Array.isArray(receipt.tablesAffected)).toBe(true);
    expect(receipt.tablesAffected.length).toBeGreaterThan(0);
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.executedAt).toBeTruthy();
    expect(receipt.executedByUserId).toBe(superAdminUserId);
    expect(receipt.patientId).toBe(patientId);
    expect(receipt.requestId).toBe(requestId);

    // ── 5. Observability for CI logs — surfaces headroom vs the budget.
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §8.7 row 351] DPDP erasure end-to-end in ${elapsedMs} ms (budget: 60000 ms)`,
    );
  });
});
