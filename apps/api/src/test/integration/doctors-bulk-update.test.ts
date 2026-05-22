// Integration tests for Pearl ERP Stage 1 §3.1 (gap row 74) — the
// `POST /api/v1/doctors/bulk-update` admin surface.
//
// What this file covers:
//   - happy path: ADMIN can apply one knob across 3 doctors (200 + row count)
//   - Zod allowlist: unknown field in `updates` → 400 (mass-assignment guard)
//   - Zod cardinality: empty `doctorIds` → 400, >100 `doctorIds` → 400
//   - RBAC: DOCTOR + RECEPTION tokens → 403 (authorize is ADMIN-only)
//   - tenant scoping: a doctorId from another tenant in the batch → 403
//     AND the cross-tenant doctor row stays untouched (DB-assert atomicity)
//   - audit trail: DOCTORS_BULK_UPDATE row written for the action
//   - transaction atomicity: invalid id mid-batch → no rows modified at all
//
// Pairs with the per-row `PATCH /:id/appointment-mode` suite in
// doctors.test.ts — both endpoints converge on the same Doctor columns
// so the bulk surface inherits the per-knob validation tests there.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("Doctors bulk-update (Pearl §3.1 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("ADMIN can bulk-update 3 doctors' appointmentMode in one call", async () => {
    const prisma = await getPrisma();
    const d1 = await createDoctorFixture();
    const d2 = await createDoctorFixture();
    const d3 = await createDoctorFixture();

    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id, d2.id, d3.id],
        updates: { appointmentMode: "SLOT", tokenPrefix: "O" },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.updatedCount).toBe(3);
    expect(res.body.data.updatedDoctorIds.sort()).toEqual([d1.id, d2.id, d3.id].sort());
    expect(res.body.data.updates).toMatchObject({
      appointmentMode: "SLOT",
      tokenPrefix: "O",
    });

    // DB-side check — all 3 doctors actually carry the new values.
    const rows = await prisma.doctor.findMany({
      where: { id: { in: [d1.id, d2.id, d3.id] } },
      select: { id: true, appointmentMode: true, tokenPrefix: true },
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.appointmentMode).toBe("SLOT");
      expect(r.tokenPrefix).toBe("O");
    }
  });

  it("rejects unknown field in updates (mass-assignment guard, 400)", async () => {
    const d1 = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id],
        // `consultationFee` is NOT in the BULK_UPDATE_ALLOWED_FIELDS allowlist;
        // .strict() in the Zod schema must reject before the handler runs.
        updates: { appointmentMode: "TOKEN", consultationFee: 999 },
      });
    expect(res.status).toBe(400);
  });

  it("rejects empty doctorIds array (400)", async () => {
    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorIds: [], updates: { appointmentMode: "TOKEN" } });
    expect(res.status).toBe(400);
  });

  it("rejects >100 doctorIds (400)", async () => {
    // 101 fake UUIDs is fine — Zod cardinality check runs before we ever
    // look up rows, so we don't need real fixture doctors here.
    const ids = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorIds: ids, updates: { appointmentMode: "TOKEN" } });
    expect(res.status).toBe(400);
  });

  it("rejects empty updates object (400 — at least one field required)", async () => {
    const d1 = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorIds: [d1.id], updates: {} });
    expect(res.status).toBe(400);
  });

  it("DOCTOR role is forbidden (403)", async () => {
    const d1 = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        doctorIds: [d1.id],
        updates: { appointmentMode: "SLOT" },
      });
    expect(res.status).toBe(403);
  });

  it("RECEPTION + PATIENT roles are forbidden (403)", async () => {
    const d1 = await createDoctorFixture();
    for (const tok of [receptionToken, patientToken]) {
      const res = await request(app)
        .post("/api/v1/doctors/bulk-update")
        .set("Authorization", `Bearer ${tok}`)
        .send({
          doctorIds: [d1.id],
          updates: { appointmentMode: "SLOT" },
        });
      expect(res.status).toBe(403);
    }
  });

  it("cross-tenant doctorId rejects the batch (403) and modifies NO rows", async () => {
    const prisma = await getPrisma();

    // d1 is in the seeded ADMIN's tenant (null tenantId — admin@test.local
    // has no tenant set, see setup.ts). For the foreign-tenant doctor we
    // mint a fresh tenant row, attach a User+Doctor to it, then attempt
    // a bulk update that mixes the legit d1.id with the foreign d2.id.
    const foreignTenant = await prisma.tenant.create({
      data: {
        name: "Foreign Tenant",
        subdomain: `foreign-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const foreignUser = await prisma.user.create({
      data: {
        email: `foreign-doc-${Date.now()}@test.local`,
        name: "Foreign Dr",
        phone: "9000111222",
        passwordHash: "x",
        role: "DOCTOR",
        tenantId: foreignTenant.id,
      },
    });
    const foreignDoctor = await prisma.doctor.create({
      data: {
        userId: foreignUser.id,
        specialization: "General Medicine",
        qualification: "MBBS",
        tenantId: foreignTenant.id,
        appointmentMode: "TOKEN",
        tokenPrefix: "FOREIGN-PREFIX",
      },
    });

    const d1 = await createDoctorFixture();
    // Snapshot the legit doctor's pre-call values so we can prove the
    // failed batch didn't half-write before bailing out.
    const beforeD1 = await prisma.doctor.findUnique({
      where: { id: d1.id },
      select: { appointmentMode: true, tokenPrefix: true },
    });

    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id, foreignDoctor.id],
        updates: { appointmentMode: "CALLING", tokenPrefix: "X" },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not in your tenant/i);

    // Legit doctor in our tenant — must be UNCHANGED.
    const afterD1 = await prisma.doctor.findUnique({
      where: { id: d1.id },
      select: { appointmentMode: true, tokenPrefix: true },
    });
    expect(afterD1).toEqual(beforeD1);

    // Foreign doctor — must also be unchanged. Read via raw prisma
    // (unscoped) since tenantScopedPrisma would filter it out.
    const foreignAfter = await prisma.doctor.findUnique({
      where: { id: foreignDoctor.id },
      select: { appointmentMode: true, tokenPrefix: true },
    });
    expect(foreignAfter?.appointmentMode).toBe("TOKEN");
    expect(foreignAfter?.tokenPrefix).toBe("FOREIGN-PREFIX");
  });

  it("writes a DOCTORS_BULK_UPDATE audit row", async () => {
    const prisma = await getPrisma();
    const d1 = await createDoctorFixture();
    const d2 = await createDoctorFixture();

    const before = await prisma.auditLog.count({
      where: { action: "DOCTORS_BULK_UPDATE", entity: "doctor" },
    });

    await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id, d2.id],
        updates: { dailyAppointmentLimit: 50 },
      })
      .expect(200);

    // auditLog is awaited (not safeAudit) so the row is durable before
    // the 200 lands — no need for the audit-wait helper here.
    const after = await prisma.auditLog.count({
      where: { action: "DOCTORS_BULK_UPDATE", entity: "doctor" },
    });
    expect(after).toBeGreaterThan(before);

    const row = await prisma.auditLog.findFirst({
      where: { action: "DOCTORS_BULK_UPDATE", entity: "doctor" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    expect((row?.details as any)?.updatedCount).toBe(2);
    expect((row?.details as any)?.doctorIds).toEqual(
      expect.arrayContaining([d1.id, d2.id]),
    );
  });

  it("transaction atomicity: a non-existent doctorId stops the whole batch", async () => {
    const prisma = await getPrisma();
    const d1 = await createDoctorFixture();

    const beforeD1 = await prisma.doctor.findUnique({
      where: { id: d1.id },
      select: { nearTurnAlertThreshold: true, lastHourPolicy: true },
    });

    const bogusId = "00000000-0000-4000-8000-deadbeefcafe";

    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id, bogusId],
        updates: { nearTurnAlertThreshold: 7, lastHourPolicy: "BLOCK_NEW" },
      });

    // bogus id is "not in our tenant" (it's in no tenant) → 403 + 0 rows
    expect(res.status).toBe(403);

    const afterD1 = await prisma.doctor.findUnique({
      where: { id: d1.id },
      select: { nearTurnAlertThreshold: true, lastHourPolicy: true },
    });
    expect(afterD1).toEqual(beforeD1);
  });

  it("happy-path with multiple knobs at once persists all of them", async () => {
    const prisma = await getPrisma();
    const d1 = await createDoctorFixture();
    const d2 = await createDoctorFixture();

    const res = await request(app)
      .post("/api/v1/doctors/bulk-update")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorIds: [d1.id, d2.id],
        updates: {
          appointmentMode: "TOKEN",
          tokenPrefix: "Z",
          tokenStartNumber: 100,
          dailyAppointmentLimit: 25,
          nearTurnAlertThreshold: 5,
          lastHourPolicy: "WALK_IN_ONLY",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedCount).toBe(2);

    const rows = await prisma.doctor.findMany({
      where: { id: { in: [d1.id, d2.id] } },
      select: {
        appointmentMode: true,
        tokenPrefix: true,
        tokenStartNumber: true,
        dailyAppointmentLimit: true,
        nearTurnAlertThreshold: true,
        lastHourPolicy: true,
      },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.appointmentMode).toBe("TOKEN");
      expect(r.tokenPrefix).toBe("Z");
      expect(r.tokenStartNumber).toBe(100);
      expect(r.dailyAppointmentLimit).toBe(25);
      expect(r.nearTurnAlertThreshold).toBe(5);
      expect(r.lastHourPolicy).toBe("WALK_IN_ONLY");
    }
  });
});
