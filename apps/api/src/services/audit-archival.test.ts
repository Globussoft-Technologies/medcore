import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    systemConfig: {
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));

import {
  runAuditLogArchival,
  getAuditLogRetentionDays,
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  AUDIT_LOG_RETENTION_DAYS_KEY,
} from "./audit-archival";

function makeRow(id: string, createdAt: Date) {
  return {
    id,
    userId: "u1",
    action: "PATIENT_CREATE",
    entity: "Patient",
    entityId: "p1",
    details: { foo: "bar" },
    ipAddress: "127.0.0.1",
    createdAt,
  };
}

describe("audit-archival", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-archive-test-"));
    // Full reset (clears call history AND the mockResolvedValueOnce queue,
    // which clearAllMocks() would not). Then reinstall defaults.
    prismaMock.systemConfig.findUnique.mockReset();
    prismaMock.auditLog.count.mockReset();
    prismaMock.auditLog.findMany.mockReset();
    prismaMock.auditLog.deleteMany.mockReset();
    prismaMock.systemConfig.findUnique.mockResolvedValue(null);
    prismaMock.auditLog.count.mockResolvedValue(0);
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("getAuditLogRetentionDays falls back to 365 when config is missing or invalid", async () => {
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce(null);
    expect(await getAuditLogRetentionDays()).toBe(
      DEFAULT_AUDIT_LOG_RETENTION_DAYS
    );

    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({
      key: AUDIT_LOG_RETENTION_DAYS_KEY,
      value: "not-a-number",
    });
    expect(await getAuditLogRetentionDays()).toBe(
      DEFAULT_AUDIT_LOG_RETENTION_DAYS
    );

    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({
      key: AUDIT_LOG_RETENTION_DAYS_KEY,
      value: "90",
    });
    expect(await getAuditLogRetentionDays()).toBe(90);
  });

  it("archives rows past threshold and deletes them", async () => {
    const old1 = makeRow("a1", new Date("2020-01-01T00:00:00Z"));
    const old2 = makeRow("a2", new Date("2020-01-02T00:00:00Z"));
    prismaMock.auditLog.count.mockResolvedValueOnce(2);
    // First fetch returns the two rows, second fetch returns [] to end loop.
    prismaMock.auditLog.findMany
      .mockResolvedValueOnce([old1, old2])
      .mockResolvedValueOnce([]);
    prismaMock.auditLog.deleteMany.mockResolvedValueOnce({ count: 2 });

    const cutoff = new Date("2024-01-01T00:00:00Z");
    const result = await runAuditLogArchival({
      cutoff,
      batchSize: 500,
      archiveDir: tmpDir,
    });

    expect(result.dryRun).toBe(false);
    expect(result.archived).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.batches).toBe(1);
    expect(result.archivePath).toMatch(/audit-archive-\d{8}\.jsonl\.gz$/);
    expect(result.archivePath && fs.existsSync(result.archivePath)).toBe(true);

    // Roundtrip the archive: gunzip and check NDJSON contains both ids.
    const raw = zlib.gunzipSync(fs.readFileSync(result.archivePath!)).toString();
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => JSON.parse(l).id).sort();
    expect(ids).toEqual(["a1", "a2"]);

    // Delete was called with the specific ids (not a createdAt range), and
    // rows were fetched in asc order by createdAt.
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] } },
    });
    const findArgs = prismaMock.auditLog.findMany.mock.calls[0][0];
    expect(findArgs.where.createdAt.lt).toEqual(cutoff);
    expect(findArgs.orderBy).toEqual({ createdAt: "asc" });
  });

  it("leaves recent rows alone (returns zero counts when nothing is past cutoff)", async () => {
    prismaMock.auditLog.count.mockResolvedValueOnce(0);

    const result = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: tmpDir,
    });

    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.archivePath).toBeNull();
    expect(result.batches).toBe(0);
    // Must NOT invoke findMany / deleteMany when there are zero eligible rows.
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.deleteMany).not.toHaveBeenCalled();
    // And the archive file must not exist.
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("deletes in batches to avoid long transactions", async () => {
    // 3 batches of size 2 (total 6 rows). The loop should stop after the
    // batch that returns fewer than `batchSize` rows.
    const batch1 = [
      makeRow("a1", new Date("2020-01-01T00:00:00Z")),
      makeRow("a2", new Date("2020-01-02T00:00:00Z")),
    ];
    const batch2 = [
      makeRow("a3", new Date("2020-01-03T00:00:00Z")),
      makeRow("a4", new Date("2020-01-04T00:00:00Z")),
    ];
    const batch3 = [makeRow("a5", new Date("2020-01-05T00:00:00Z"))]; // partial → end
    prismaMock.auditLog.count.mockResolvedValueOnce(5);
    prismaMock.auditLog.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce(batch3);
    prismaMock.auditLog.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      batchSize: 2,
      archiveDir: tmpDir,
    });

    expect(result.archived).toBe(5);
    expect(result.deleted).toBe(5);
    expect(result.batches).toBe(3);
    // deleteMany must have been called once per batch — NOT a single mass
    // delete. This is the important invariant for long-transaction safety.
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(3);
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledTimes(3);

    // Archive file contains 5 NDJSON lines (all rows from all batches).
    const raw = zlib.gunzipSync(fs.readFileSync(result.archivePath!)).toString();
    expect(raw.trim().split("\n")).toHaveLength(5);
  });

  it("dry-run counts rows but does not write or delete", async () => {
    prismaMock.auditLog.count.mockResolvedValueOnce(42);

    const result = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: tmpDir,
      dryRun: true,
      batchSize: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.archived).toBe(42);
    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(Math.ceil(42 / 10));
    expect(result.archivePath).toMatch(/audit-archive-\d{8}\.jsonl\.gz$/);
    // No file was written, nothing was deleted.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});
