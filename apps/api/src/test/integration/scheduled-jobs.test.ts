// Integration tests for the scheduled-jobs admin API — Pearl §8.4
// (gap row 222 closure, 2026-05-22).
//
// Covers list / get / retry surfaces of /api/v1/scheduled-jobs, plus the
// super-admin authorization model (mirrored from routes/tenants.ts):
//   - Globally tenant-less ADMINs and ADMINs on the "default" tenant can
//     view + retry.
//   - ADMINs on any other tenant are 403'd.
//   - Non-ADMIN roles (PATIENT/DOCTOR) are 403'd at the authorize() layer.
//
// The retry path also asserts the audit trail (SCHEDULED_JOB_RETRIED row)
// AND that a brand new RUNNING ScheduledTaskRun row is created linked back
// to the original via retryOfRunId.
//
// We mount only the routers under test on a minimal Express app so the
// global app module's mount order / startup hooks are not exercised. This
// mirrors the tenants.test.ts pattern.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { scheduledJobsRouter } from "../../routes/scheduled-jobs";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: express.Express;
let superAdminToken: string;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/scheduled-jobs", scheduledJobsRouter);
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

async function seedSuperAdmin(tenantId: string | null): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `super-admin-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin (jobs)",
      phone: "9000000010",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenantId ?? null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, tenantId: tenantId ?? undefined },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { token, userId: user.id };
}

async function seedRuns(): Promise<{ running: string; success: string; failed: string }> {
  const prisma = await getPrisma();
  // Use the registered task name so the retry path resolves it.
  const taskName = "notification_drain_queued";
  const now = Date.now();
  const r1 = await prisma.scheduledTaskRun.create({
    data: {
      taskName,
      status: "RUNNING",
      startedAt: new Date(now - 60_000),
    },
  });
  const r2 = await prisma.scheduledTaskRun.create({
    data: {
      taskName,
      status: "SUCCESS",
      startedAt: new Date(now - 120_000),
      completedAt: new Date(now - 119_000),
      durationMs: 1_000,
      recordsProcessed: 3,
    },
  });
  const r3 = await prisma.scheduledTaskRun.create({
    data: {
      taskName,
      status: "FAILED",
      startedAt: new Date(now - 180_000),
      completedAt: new Date(now - 179_000),
      durationMs: 1_000,
      error: "Error: boom\n    at fakeStack (scheduled-tasks.ts:1:1)",
    },
  });
  return { running: r1.id, success: r2.id, failed: r3.id };
}

describeIfDB("Scheduled jobs API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.scheduledTaskRun.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: { action: "SCHEDULED_JOB_RETRIED" },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "super-admin-jobs-" } },
    });
    await ensureDefaultTenant();
    const seeded = await seedSuperAdmin(null);
    superAdminToken = seeded.token;
  });

  // ── 1. List (newest first) ────────────────────────────────
  it("GET /scheduled-jobs returns all runs newest-first to a super-admin", async () => {
    const ids = await seedRuns();
    const res = await request(app)
      .get("/api/v1/scheduled-jobs")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const runs = res.body.data.runs as Array<{ id: string; status: string; startedAt: string }>;
    expect(runs.length).toBe(3);
    // newest-first by startedAt: RUNNING (60s ago) > SUCCESS (120s ago) > FAILED (180s ago).
    expect(runs[0].id).toBe(ids.running);
    expect(runs[1].id).toBe(ids.success);
    expect(runs[2].id).toBe(ids.failed);
  });

  // ── 2. List with status filter ────────────────────────────
  it("GET /scheduled-jobs?status=FAILED returns only the FAILED row", async () => {
    const ids = await seedRuns();
    const res = await request(app)
      .get("/api/v1/scheduled-jobs?status=FAILED")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    const runs = res.body.data.runs as Array<{ id: string; status: string }>;
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe(ids.failed);
    expect(runs[0].status).toBe("FAILED");
  });

  // ── 3. Get one (full error included) ──────────────────────
  it("GET /scheduled-jobs/:id returns the full row with error message", async () => {
    const ids = await seedRuns();
    const res = await request(app)
      .get(`/api/v1/scheduled-jobs/${ids.failed}`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(ids.failed);
    expect(res.body.data.status).toBe("FAILED");
    expect(res.body.data.error).toContain("Error: boom");
  });

  // ── 4. Retry FAILED row → 200 + new RUNNING row + audit ──
  it("POST /scheduled-jobs/:id/retry on a FAILED row creates a new RUNNING row and writes an audit", async () => {
    const ids = await seedRuns();
    const prisma = await getPrisma();
    const before = await prisma.scheduledTaskRun.count();
    const res = await request(app)
      .post(`/api/v1/scheduled-jobs/${ids.failed}/retry`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.retryOfRunId).toBe(ids.failed);
    expect(res.body.data.newRun.status).toBe("RUNNING");
    expect(res.body.data.newRun.id).not.toBe(ids.failed);
    // A new row exists, linked back via retryOfRunId.
    const after = await prisma.scheduledTaskRun.count();
    expect(after).toBe(before + 1);
    const newRow = await prisma.scheduledTaskRun.findUnique({
      where: { id: res.body.data.newRun.id },
    });
    expect(newRow).not.toBeNull();
    expect(newRow?.retryOfRunId).toBe(ids.failed);
    // Audit row is written (auditLog is awaited inside the retry handler).
    const audit = await waitForAuditFlush(prisma, {
      action: "SCHEDULED_JOB_RETRIED",
      entity: "scheduled_task_run",
      entityId: res.body.data.newRun.id,
    });
    expect(audit.action).toBe("SCHEDULED_JOB_RETRIED");
  });

  // ── 5. Retry SUCCESS row → 409 ────────────────────────────
  it("POST /scheduled-jobs/:id/retry on a SUCCESS row returns 409", async () => {
    const ids = await seedRuns();
    const res = await request(app)
      .post(`/api/v1/scheduled-jobs/${ids.success}/retry`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/only failed jobs/i);
  });

  // ── 6. Tenant-bound ADMIN (non-default) → 403 ─────────────
  it("rejects a tenant-scoped ADMIN with no 'default'-tenant membership (403)", async () => {
    await seedRuns();
    const prisma = await getPrisma();
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `Other Tenant ${Date.now()}`,
        subdomain: `other-${Math.random().toString(36).slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const seeded = await seedSuperAdmin(otherTenant.id);
    const res = await request(app)
      .get("/api/v1/scheduled-jobs")
      .set("Authorization", `Bearer ${seeded.token}`);
    expect(res.status).toBe(403);
  });

  // ── 7. PATIENT → 403 ──────────────────────────────────────
  it("rejects PATIENT role (403)", async () => {
    await seedRuns();
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/scheduled-jobs")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ── 8. DOCTOR → 403 ───────────────────────────────────────
  it("rejects DOCTOR role (403)", async () => {
    await seedRuns();
    const doctorToken = await getAuthToken("DOCTOR");
    const res = await request(app)
      .get("/api/v1/scheduled-jobs")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });
});
