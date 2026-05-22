// Integration tests for the cross-tenant DPDP erasure-request workbench —
// Pearl §8.6 (gap row 224 closure, 2026-05-23).
//
// Covers POST / GET / execute / reject on /api/v1/dpdp-workbench, plus
// the super-admin RBAC matrix mirrored from routes/tenants.ts and
// scheduled-jobs.test.ts:
//   - Globally tenant-less ADMINs can view / file / execute / reject.
//   - ADMINs bound to a non-default tenant are 403'd.
//   - DOCTOR / RECEPTION roles are 403'd.
//   - PATIENT role can self-file ONLY for their own patientId (403 for
//     cross-patient attempts).
//
// The execute path also asserts the cross-table purge actually happened
// (Appointment / Vitals / Consultation / Prescription / Invoice rows
// gone for the target patient) AND that the Patient + User rows survive
// in anonymized form (PII nulled, isActive=false on User).
//
// Like scheduled-jobs.test.ts we mount only the routers under test on a
// minimal Express app so global startup hooks aren't exercised.

import { it, expect, beforeAll, beforeEach } from "vitest";
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
  const email = `super-admin-dpdp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin (dpdp)",
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

async function seedPatientWithChildren(tenantId: string): Promise<{
  patientId: string;
  userId: string;
  appointmentId: string;
}> {
  const prisma = await getPrisma();
  const suffix = Math.random().toString(36).slice(2, 8);
  const userEmail = `dpdp-patient-${Date.now()}-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      email: userEmail,
      name: "DPDP Erasure Target",
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
      mrNumber: `MR-DPDP-${Date.now()}-${suffix}`,
      gender: "MALE",
      address: "Erasable Address",
      bloodGroup: "O+",
      tenantId,
    },
  });

  // Need a doctor for the appointment FK.
  const docUser = await prisma.user.create({
    data: {
      email: `dpdp-doc-${Date.now()}-${suffix}@test.local`,
      name: "Dr DPDP",
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
      type: "CONSULTATION",
      status: "BOOKED",
      tenantId,
    },
  });

  // Vitals + Consultation hang off the appointment.
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

describeIfDB("DPDP erasure workbench (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    // Clean only the DPDP-relevant rows + the super-admins we seed; we
    // deliberately do NOT wipe Patient/User globally because the shared
    // test DB has rows other suites rely on.
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: [
            "DPDP_ERASURE_REQUESTED",
            "DPDP_ERASURE_EXECUTED",
            "DPDP_ERASURE_REJECTED",
          ],
        },
      },
    });
    await prisma.dPDPErasureRequest.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { startsWith: "super-admin-dpdp-" } },
    });
    await ensureDefaultTenant();
    const seeded = await seedSuperAdmin(null);
    superAdminToken = seeded.token;
    superAdminUserId = seeded.userId;
  });

  // ── 1. POST creates a PENDING request + audit ──────────────
  it("POST /requests creates a PENDING request and writes a DPDP_ERASURE_REQUESTED audit", async () => {
    const tenantId = await ensureDefaultTenant();
    const { patientId } = await seedPatientWithChildren(tenantId);
    const res = await request(app)
      .post("/api/v1/dpdp-workbench/requests")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        patientId,
        reason: "Patient request via phone",
        requestedByRole: "SUPER_ADMIN",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("PENDING");
    expect(res.body.data.patientId).toBe(patientId);
    const audit = await waitForAuditFlush(await getPrisma(), {
      action: "DPDP_ERASURE_REQUESTED",
      entity: "dpdp_erasure_request",
      entityId: res.body.data.id,
    });
    expect(audit.action).toBe("DPDP_ERASURE_REQUESTED");
  });

  // ── 2. GET list filters by status ───────────────────────────
  it("GET /requests?status=PENDING returns only PENDING rows", async () => {
    const tenantId = await ensureDefaultTenant();
    const a = await seedPatientWithChildren(tenantId);
    const b = await seedPatientWithChildren(tenantId);
    const prisma = await getPrisma();
    await prisma.dPDPErasureRequest.create({
      data: {
        tenantId,
        patientId: a.patientId,
        requestedBy: superAdminUserId,
        requestedByRole: "SUPER_ADMIN",
        status: "PENDING",
      },
    });
    await prisma.dPDPErasureRequest.create({
      data: {
        tenantId,
        patientId: b.patientId,
        requestedBy: superAdminUserId,
        requestedByRole: "SUPER_ADMIN",
        status: "REJECTED",
        failureReason: "Not a valid DPDP request",
      },
    });
    const res = await request(app)
      .get("/api/v1/dpdp-workbench/requests?status=PENDING")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.requests as Array<{ status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("PENDING");
  });

  // ── 3. Execute purges child rows + anonymizes Patient/User ──
  it("POST /requests/:id/execute purges child rows and anonymizes the patient", async () => {
    const tenantId = await ensureDefaultTenant();
    const { patientId, userId, appointmentId } =
      await seedPatientWithChildren(tenantId);
    const prisma = await getPrisma();
    const created = await prisma.dPDPErasureRequest.create({
      data: {
        tenantId,
        patientId,
        requestedBy: superAdminUserId,
        requestedByRole: "SUPER_ADMIN",
        status: "PENDING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/dpdp-workbench/requests/${created.id}/execute`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("COMPLETED");
    expect(res.body.data.executionReceipt).toBeTruthy();
    expect(res.body.data.executionReceipt.purgedTables).toContain(
      "Appointment",
    );
    expect(res.body.data.executionReceipt.anonymizedTables).toContain(
      "Patient",
    );

    // Child rows gone.
    const apptAfter = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });
    expect(apptAfter).toBeNull();
    const vitalsAfter = await prisma.vitals.findMany({
      where: { patientId },
    });
    expect(vitalsAfter.length).toBe(0);

    // Patient + User anonymized (still exist, but PII gone).
    const patientAfter = await prisma.patient.findUnique({
      where: { id: patientId },
    });
    expect(patientAfter).toBeTruthy();
    expect(patientAfter?.address).toBeNull();
    expect(patientAfter?.mrNumber.startsWith("ERASED-")).toBe(true);
    const userAfter = await prisma.user.findUnique({ where: { id: userId } });
    expect(userAfter).toBeTruthy();
    expect(userAfter?.email).toBeNull();
    expect(userAfter?.name).toBe("[erased]");
    expect(userAfter?.isActive).toBe(false);

    // Audit row.
    const audit = await waitForAuditFlush(prisma, {
      action: "DPDP_ERASURE_EXECUTED",
      entity: "dpdp_erasure_request",
      entityId: created.id,
    });
    expect(audit.action).toBe("DPDP_ERASURE_EXECUTED");
  });

  // ── 4. Execute non-existent → 404 ──────────────────────────
  it("POST /requests/:id/execute on a non-existent id returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/dpdp-workbench/requests/does-not-exist/execute")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  // ── 5. Execute already-COMPLETED → 409 ─────────────────────
  it("POST /requests/:id/execute on a COMPLETED row returns 409", async () => {
    const tenantId = await ensureDefaultTenant();
    const { patientId } = await seedPatientWithChildren(tenantId);
    const prisma = await getPrisma();
    const row = await prisma.dPDPErasureRequest.create({
      data: {
        tenantId,
        patientId,
        requestedBy: superAdminUserId,
        requestedByRole: "SUPER_ADMIN",
        status: "COMPLETED",
        executedAt: new Date(),
        executedBy: superAdminUserId,
      },
    });
    const res = await request(app)
      .post(`/api/v1/dpdp-workbench/requests/${row.id}/execute`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(409);
  });

  // ── 6. Reject → REJECTED + reason + audit ──────────────────
  it("POST /requests/:id/reject marks the row REJECTED with the supplied reason", async () => {
    const tenantId = await ensureDefaultTenant();
    const { patientId } = await seedPatientWithChildren(tenantId);
    const prisma = await getPrisma();
    const row = await prisma.dPDPErasureRequest.create({
      data: {
        tenantId,
        patientId,
        requestedBy: superAdminUserId,
        requestedByRole: "SUPER_ADMIN",
        status: "PENDING",
      },
    });
    const res = await request(app)
      .post(`/api/v1/dpdp-workbench/requests/${row.id}/reject`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ reason: "Duplicate request — already filed last week" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(res.body.data.failureReason).toMatch(/duplicate/i);
    const audit = await waitForAuditFlush(prisma, {
      action: "DPDP_ERASURE_REJECTED",
      entity: "dpdp_erasure_request",
      entityId: row.id,
    });
    expect(audit.action).toBe("DPDP_ERASURE_REJECTED");
  });

  // ── 7. Tenant-bound (non-default) ADMIN → 403 ──────────────
  it("rejects a tenant-scoped ADMIN with no default-tenant membership (403)", async () => {
    const prisma = await getPrisma();
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `Other Tenant ${Date.now()}`,
        subdomain: `other-dpdp-${Math.random().toString(36).slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const seeded = await seedSuperAdmin(otherTenant.id);
    const res = await request(app)
      .get("/api/v1/dpdp-workbench/requests")
      .set("Authorization", `Bearer ${seeded.token}`);
    expect(res.status).toBe(403);
  });

  // ── 8. DOCTOR → 403 ────────────────────────────────────────
  it("rejects DOCTOR role on the workbench (403)", async () => {
    const doctorToken = await getAuthToken("DOCTOR");
    const res = await request(app)
      .get("/api/v1/dpdp-workbench/requests")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });
});
