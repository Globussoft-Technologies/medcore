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

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    systemConfig: {
      findUnique: vi.fn(async () => null),
    },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

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
});
