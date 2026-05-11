/**
 * Issue #79 — regression for the audit log User column + entity-case fixes.
 *
 *   1. Every audit row now ships a `userName` + `userEmail` derived from a
 *      User-table join; previously the table column was blank because the
 *      /search no-term branch returned the raw rows without enrichment, and
 *      callers that relied on it (the page hits /search whenever a free-text
 *      filter was typed and then cleared) saw an empty User column.
 *   2. Entity filters are now case-insensitive so the dropdown's canonical
 *      "Patient" label matches both "patient" (legacy lowercase writes) and
 *      "Patient" (newer capitalised writes) — previously selecting
 *      "Patient" returned 0 entries despite known patient creations.
 *
 * These tests pin both with a mocked Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  // Issue #456 (May 2026): routes/audit.ts now reads via tenantScopedPrisma
  // (the $extends-wrapper from services/tenant-prisma.ts) so every
  // findMany / count is auto-filtered by tenantId. The wrapper is built
  // by calling `prisma.$extends({...})` at module-load time; a mock that
  // doesn't expose `$extends` crashes the import chain. We add a self-
  // returning `$extends` so `tenantScopedPrisma` resolves to the same
  // mock object that the existing assertions hook into.
  const mock: any = {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    // Issue #192 (Apr 30 2026): the audit handler now resolves entity UUIDs
    // to human-readable labels. Each resolver is wrapped in try/catch so a
    // missing mock returns no labels rather than crashing — but the common
    // resolvers are stubbed here so tests can opt in to label assertions.
    patient: { findMany: vi.fn().mockResolvedValue([]) },
    appointment: { findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    prescription: { findMany: vi.fn().mockResolvedValue([]) },
    admission: { findMany: vi.fn().mockResolvedValue([]) },
    holiday: { findMany: vi.fn().mockResolvedValue([]) },
    systemConfig: {
      findUnique: vi.fn(async () => null),
    },
  };
  // The `tenantScopedPrisma = prisma.$extends({...})` call returns a new
  // client. For the test we collapse the wrapper — `tenantScopedPrisma`
  // ends up referencing the SAME mock, so all the existing
  // `prismaMock.auditLog.findMany.mockResolvedValueOnce(...)` setups still
  // apply regardless of which client the route reaches for.
  mock.$extends = () => mock;
  return { prismaMock: mock };
});

// Issue #456 (May 2026, follow-up): A10 lifted the tenant wrapper into
// `@medcore/db`, and routes/audit.ts imports `tenantScopedPrisma` from the
// re-export shim at `apps/api/src/services/tenant-prisma`. The shim
// resolves to `@medcore/db` as well, so a single mock that exposes BOTH
// `prisma` (for resolver lookups) and `tenantScopedPrisma` (for the
// auditLog.findMany / count calls) keeps the test in sync with the
// runtime import graph. Without this, `tenantScopedPrisma` resolves to
// undefined and the handler 500s on `tenantScopedPrisma.auditLog.findMany`.
vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import { auditRouter } from "./audit";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/audit", auditRouter);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "admin@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #79 — audit log User column + entity-case", () => {
  beforeEach(() => {
    prismaMock.auditLog.findMany.mockReset();
    prismaMock.auditLog.count.mockReset();
    prismaMock.user.findMany.mockReset();
  });

  it("/audit joins users — userName + userEmail are populated, never blank", async () => {
    const userId = "u-1";
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-1",
        createdAt: new Date("2026-04-26T10:00:00Z"),
        userId,
        action: "PATIENT_CREATE",
        entity: "patient",
        entityId: "p-1",
        ipAddress: "127.0.0.1",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(1);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: userId, name: "Dr Smith", email: "smith@test.local" },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].userName).toBe("Dr Smith");
    expect(res.body.data[0].userEmail).toBe("smith@test.local");
    expect(prismaMock.user.findMany).toHaveBeenCalledOnce();
  });

  it("/audit/search (no term) also joins users — Issue #79 fix", async () => {
    const userId = "u-2";
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-2",
        createdAt: new Date("2026-04-26T10:00:00Z"),
        userId,
        action: "PATIENT_DELETE",
        entity: "patient",
        entityId: "p-1",
        ipAddress: "127.0.0.1",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(1);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: userId, name: "Reception Bob", email: "bob@test.local" },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit/search")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // BEFORE the fix: this would be undefined / missing. AFTER: populated.
    expect(res.body.data[0].userName).toBe("Reception Bob");
    expect(res.body.data[0].userEmail).toBe("bob@test.local");
  });

  it("entity filter uses case-insensitive matching (Issue #79)", async () => {
    prismaMock.auditLog.findMany.mockResolvedValueOnce([]);
    prismaMock.auditLog.count.mockResolvedValueOnce(0);
    prismaMock.user.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit?entity=Patient")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // The where clause sent to Prisma must use the case-insensitive shape so
    // that historical lowercase rows ("patient") match the canonical
    // dropdown value ("Patient").
    const findArgs = prismaMock.auditLog.findMany.mock.calls[0][0];
    expect(findArgs.where.entity).toEqual({
      equals: "Patient",
      mode: "insensitive",
    });
  });

  // Issue #192 (Apr 30 2026)
  it("resolves entityId UUIDs to a human-readable entityLabel", async () => {
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-1",
        createdAt: new Date("2026-04-30T10:00:00Z"),
        userId: "u-admin",
        action: "USER_REGISTER",
        entity: "user",
        entityId: "u-new",
        ipAddress: "127.0.0.1",
        details: null,
      },
      {
        id: "log-2",
        createdAt: new Date("2026-04-30T10:01:00Z"),
        userId: "u-admin",
        action: "PATIENT_CREATE",
        entity: "patient",
        entityId: "p-new",
        ipAddress: "127.0.0.1",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(2);
    // The actor lookup (admin user) + the resolver lookup (new user) hit
    // the same `user.findMany`, so we return both rows here.
    prismaMock.user.findMany
      .mockResolvedValueOnce([
        { id: "u-admin", name: "System Admin", email: "admin@test.local" },
      ])
      .mockResolvedValueOnce([
        { id: "u-new", name: "Dr Vikram Kapoor", email: "v@test.local" },
      ]);
    prismaMock.patient.findMany.mockResolvedValueOnce([
      {
        id: "p-new",
        mrNumber: "MR-1234",
        user: { name: "Anita Sharma" },
      },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const userRow = res.body.data.find((d: any) => d.id === "log-1");
    const patientRow = res.body.data.find((d: any) => d.id === "log-2");
    expect(userRow.entityLabel).toBe("User: Dr Vikram Kapoor");
    expect(patientRow.entityLabel).toBe(
      "Patient: Anita Sharma (MR: MR-1234)"
    );
    // UUID is still preserved alongside the label.
    expect(userRow.entityId).toBe("u-new");
    expect(patientRow.entityId).toBe("p-new");
  });

  it("falls back to '—' for system rows that have no userId", async () => {
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-sys",
        createdAt: new Date(),
        userId: null,
        action: "SCHEDULED_TASK_RUN",
        entity: "system",
        entityId: null,
        ipAddress: null,
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(1);
    prismaMock.user.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].userName).toBe("—");
    expect(res.body.data[0].userEmail).toBe("");
  });

  // ─── Issue #690 — inverted-date range guard ───────────────────────────
  // The Audit Log filter UI accepted From > To and the server quietly
  // applied the inverted range, returning zero rows with no indication
  // anything was wrong. Now the server returns 400 with a clear field-
  // shaped error so the form can render an inline message.
  it("#690 GET /audit returns 400 when from > to (inverted date range)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit?from=2026-05-08&to=2026-05-01")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/from.*before.*to/i);
    // Prisma was never reached — the guard short-circuits before the query.
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("#690 GET /audit accepts equal from/to (single-day range)", async () => {
    prismaMock.auditLog.findMany.mockResolvedValueOnce([]);
    prismaMock.auditLog.count.mockResolvedValueOnce(0);
    prismaMock.user.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit?from=2026-05-08&to=2026-05-08")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it("#690 GET /audit/export.csv also rejects inverted range", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit/export.csv?from=2026-05-31&to=2026-05-01")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from.*before.*to/i);
  });

  // ─── Issue #336 — duplicate audit-row collapsing (5s window) ────────
  // Some routes wrote two near-simultaneous audit rows for the same
  // (action, entity, entityId, userId) tuple — usually because the
  // route called both an awaited `auditLog(...)` and a fire-and-forget
  // `safeAudit(...)` for the same event, or because of a retry. The
  // /audit endpoint now collapses near-duplicate rows within a 5-second
  // window down to the earliest, so compliance reviews don't drown in
  // history that doesn't reflect distinct user activity.
  it("#336 GET /audit collapses duplicate rows in the same 5s window", async () => {
    const userId = "u-staff";
    const t0 = new Date("2026-05-03T10:00:00.000Z");
    const t1 = new Date("2026-05-03T10:00:01.500Z"); // +1.5s — within window
    const t2 = new Date("2026-05-03T10:00:30.000Z"); // +30s — new bucket
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-c",
        createdAt: t2,
        userId,
        action: "AI_SCRIBE_READ",
        entity: "ai_scribe",
        entityId: "scribe-1",
        ipAddress: "1.2.3.4",
        details: null,
      },
      {
        id: "log-b",
        createdAt: t1,
        userId,
        action: "AI_SCRIBE_READ",
        entity: "ai_scribe",
        entityId: "scribe-1",
        ipAddress: "1.2.3.4",
        details: null,
      },
      {
        id: "log-a",
        createdAt: t0,
        userId,
        action: "AI_SCRIBE_READ",
        entity: "ai_scribe",
        entityId: "scribe-1",
        ipAddress: "1.2.3.4",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(3);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: userId, name: "Dr Mehta", email: "mehta@test.local" },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // log-a (earliest in the t0..t1 window) is kept; log-b is dropped
    // as its dup. log-c starts a new window 30s later — also kept.
    const keptIds = res.body.data.map((d: any) => d.id).sort();
    expect(keptIds).toEqual(["log-a", "log-c"]);
    expect(res.body.data).toHaveLength(2);
  });

  it("#336 GET /audit preserves rows with different actions even <5s apart", async () => {
    const userId = "u-staff";
    const t0 = new Date("2026-05-03T10:00:00.000Z");
    const t1 = new Date("2026-05-03T10:00:00.500Z"); // +500ms
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-read",
        createdAt: t1,
        userId,
        action: "PATIENT_READ",
        entity: "patient",
        entityId: "p-1",
        ipAddress: "1.2.3.4",
        details: null,
      },
      {
        id: "log-update",
        createdAt: t0,
        userId,
        action: "PATIENT_UPDATE",
        entity: "patient",
        entityId: "p-1",
        ipAddress: "1.2.3.4",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(2);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: userId, name: "Dr Mehta", email: "mehta@test.local" },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // Both kept — different actions never dedup against each other.
    expect(res.body.data).toHaveLength(2);
  });

  // ─── Issue #318 — entity-label fallback for missing entities ────────
  // When the referenced entity row has been deleted (or there's no
  // resolver for the entity type), labelFor() now falls back to a
  // 12-char abbreviation prefixed with the entity name so the audit
  // table still surfaces something a human can scan, rather than the
  // raw 36-char UUID.
  it("#318 falls back to a 12-char abbreviation when entity row was deleted", async () => {
    const deletedPatientId = "abcdef12-3456-7890-abcd-ef1234567890";
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "log-d",
        createdAt: new Date("2026-05-03T10:00:00Z"),
        userId: "u-admin",
        action: "PATIENT_DELETE",
        entity: "patient",
        entityId: deletedPatientId,
        ipAddress: "1.2.3.4",
        details: null,
      },
    ]);
    prismaMock.auditLog.count.mockResolvedValueOnce(1);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: "u-admin", name: "Admin", email: "admin@test.local" },
    ]);
    // Resolver returns no matches — the patient row is gone.
    prismaMock.patient.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // Abbreviation = title-cased entity + first 8-4 chars of UUID.
    expect(res.body.data[0].entityLabel).toBe("Patient: abcdef12-3456");
    // Full UUID is still preserved on entityId for forensic deep-dives.
    expect(res.body.data[0].entityId).toBe(deletedPatientId);
  });
});
