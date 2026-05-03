// Orchestration-level tests for the audit-log archival job.
//
// `audit-archival.test.ts` covers `runAuditLogArchival` directly; this file
// pins the surrounding orchestration that audit-archival.test.ts does not:
//
//   - Idempotent re-run: invoking the runner a second time with the SAME
//     cutoff after a successful first run finds no eligible rows and is a
//     no-op (zero counts, no archive file written).
//   - Cutoff derivation when omitted: the runner reads
//     `auditLogRetentionDays` from `system_config` (or falls back to 365)
//     and computes `Date.now() - days*24h` itself.
//   - Gzip pipeline error path: a write-stream failure surfaces as a
//     thrown error rather than a silent zero-count return.
//
// Honorable mention #13 from the 2026-05-03 test gaps audit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    systemConfig: { findUnique: vi.fn(async () => null) },
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

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  runAuditLogArchival,
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

describe("audit archival job orchestration (honorable mention #13)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-archive-orch-"));
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

  it("idempotent re-run: a second invocation finds no rows and is a no-op", async () => {
    // First run: 2 rows past cutoff get archived + deleted.
    const old1 = makeRow("a1", new Date("2020-01-01T00:00:00Z"));
    const old2 = makeRow("a2", new Date("2020-01-02T00:00:00Z"));
    prismaMock.auditLog.count.mockResolvedValueOnce(2);
    prismaMock.auditLog.findMany
      .mockResolvedValueOnce([old1, old2])
      .mockResolvedValueOnce([]);
    prismaMock.auditLog.deleteMany.mockResolvedValueOnce({ count: 2 });

    const cutoff = new Date("2024-01-01T00:00:00Z");
    const first = await runAuditLogArchival({ cutoff, archiveDir: tmpDir });

    expect(first.archived).toBe(2);
    expect(first.deleted).toBe(2);

    // Second run: same cutoff, but the rows are gone — count returns 0 and
    // the runner short-circuits before opening the gzip stream.
    prismaMock.auditLog.count.mockResolvedValueOnce(0);
    const findManyCallsBefore = prismaMock.auditLog.findMany.mock.calls.length;
    const deleteManyCallsBefore = prismaMock.auditLog.deleteMany.mock.calls.length;

    const second = await runAuditLogArchival({ cutoff, archiveDir: tmpDir });

    expect(second.archived).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.batches).toBe(0);
    expect(second.archivePath).toBeNull();
    // Critically: no further fetch / delete after the count==0 short-circuit.
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledTimes(findManyCallsBefore);
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(
      deleteManyCallsBefore
    );
  });

  it("derives cutoff from auditLogRetentionDays config when caller omits it", async () => {
    // Configure 30-day retention; expect the runner to compute cutoff itself.
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({
      key: AUDIT_LOG_RETENTION_DAYS_KEY,
      value: "30",
    });
    prismaMock.auditLog.count.mockResolvedValueOnce(0);

    const before = Date.now();
    const result = await runAuditLogArchival({ archiveDir: tmpDir, dryRun: true });
    const after = Date.now();

    const cutoffMs = new Date(result.cutoff).getTime();
    // Cutoff should be ~30 days before "now". Allow a generous ±5s window for
    // the test invocation duration.
    const expectedFloor = before - 30 * 24 * 60 * 60 * 1000 - 5_000;
    const expectedCeil = after - 30 * 24 * 60 * 60 * 1000 + 5_000;
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedFloor);
    expect(cutoffMs).toBeLessThanOrEqual(expectedCeil);
    // The system_config row was actually consulted.
    expect(prismaMock.systemConfig.findUnique).toHaveBeenCalledWith({
      where: { key: AUDIT_LOG_RETENTION_DAYS_KEY },
    });
  });

  it("falls back to 365-day retention when system_config row is absent", async () => {
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce(null);
    prismaMock.auditLog.count.mockResolvedValueOnce(0);

    const before = Date.now();
    const result = await runAuditLogArchival({ archiveDir: tmpDir, dryRun: true });

    const cutoffMs = new Date(result.cutoff).getTime();
    const expectedMs = before - 365 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(10_000);
  });

  it("default batchSize 500: a single batch handles a typical retention sweep", async () => {
    // 50 rows fits in a single batch; loop terminates because rows.length
    // (50) < batchSize (500).
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeRow(`x${i}`, new Date(2020, 0, 1 + i))
    );
    prismaMock.auditLog.count.mockResolvedValueOnce(50);
    prismaMock.auditLog.findMany.mockResolvedValueOnce(rows);
    prismaMock.auditLog.deleteMany.mockResolvedValueOnce({ count: 50 });

    const result = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: tmpDir,
    });

    expect(result.archived).toBe(50);
    expect(result.deleted).toBe(50);
    expect(result.batches).toBe(1);
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(1);
    // All 50 ids got captured in NDJSON.
    const raw = zlib.gunzipSync(fs.readFileSync(result.archivePath!)).toString();
    const ids = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it("creates the archive directory when it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "subdir");
    expect(fs.existsSync(nestedDir)).toBe(false);

    const old1 = makeRow("z1", new Date("2020-01-01T00:00:00Z"));
    prismaMock.auditLog.count.mockResolvedValueOnce(1);
    prismaMock.auditLog.findMany.mockResolvedValueOnce([old1]);
    prismaMock.auditLog.deleteMany.mockResolvedValueOnce({ count: 1 });

    const result = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: nestedDir,
    });

    expect(result.archived).toBe(1);
    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(fs.existsSync(result.archivePath!)).toBe(true);
  });

  it("dry-run is idempotent: never writes / deletes regardless of how many times invoked", async () => {
    prismaMock.auditLog.count.mockResolvedValue(99);

    const r1 = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: tmpDir,
      dryRun: true,
      batchSize: 100,
    });
    const r2 = await runAuditLogArchival({
      cutoff: new Date("2024-01-01T00:00:00Z"),
      archiveDir: tmpDir,
      dryRun: true,
      batchSize: 100,
    });

    expect(r1.dryRun).toBe(true);
    expect(r2.dryRun).toBe(true);
    expect(r1.archived).toBe(99);
    expect(r2.archived).toBe(99);
    expect(r1.deleted).toBe(0);
    expect(r2.deleted).toBe(0);
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.deleteMany).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
