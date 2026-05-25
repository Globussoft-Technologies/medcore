// Unit tests for the DPDP erasure receipt service — Pearl §12 row 382.
//
// What / which modules / why:
//   - Validates `generateErasureReceipt(requestId, prisma)` returns the
//     canonical shape + a deterministic SHA-256 receiptHash that re-derives
//     identically on a fresh call.
//   - Validates `renderErasureReceiptPdf(receipt)` emits a valid PDF buffer
//     (magic bytes + non-trivial size).
//   - COLOCATED with the service (`services/dpdp-receipt.test.ts`) so the
//     `test:coverage:unit` glob picks it up — mirrors the canonical
//     `whatsapp-providers.test.ts` precedent (commit `b776629`) that fixed
//     the function-coverage gate after a new service was shipped.
//   - Prisma is mocked entirely; nothing hits the DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import {
  generateErasureReceipt,
  renderErasureReceiptPdf,
  ErasureReceiptNotFoundError,
} from "./dpdp-receipt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePrismaMock(opts: { row?: any; auditRows?: any[] } = {}): any {
  return {
    dPDPErasureRequest: {
      findUnique: vi.fn().mockResolvedValue(opts.row ?? null),
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue(opts.auditRows ?? []),
    },
  };
}

const REQUESTED_AT = new Date("2026-05-20T08:00:00Z");
const EXECUTED_AT = new Date("2026-05-20T08:00:05Z");

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    patientId: "pat-1",
    tenantId: "ten-1",
    requestedAt: REQUESTED_AT,
    requestedBy: "user-req",
    requestedByRole: "ADMIN",
    executedAt: EXECUTED_AT,
    executedBy: "user-exec",
    status: "COMPLETED",
    executionReceipt: {
      purgedTables: ["Appointment", "Prescription"],
      purgedRows: { Appointment: 3, Prescription: 5 },
      anonymizedTables: ["Patient", "User"],
      retainedTables: [],
      notes: "Cleanly executed",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateErasureReceipt", () => {
  it("throws ErasureReceiptNotFoundError when no request matches", async () => {
    const prisma = makePrismaMock({ row: null });
    await expect(generateErasureReceipt("missing", prisma)).rejects.toBeInstanceOf(
      ErasureReceiptNotFoundError,
    );
  });

  it("returns the full receipt shape for a COMPLETED request", async () => {
    const prisma = makePrismaMock({
      row: baseRow(),
      auditRows: [
        {
          action: "DPDP_ERASURE_REQUESTED",
          createdAt: REQUESTED_AT,
          userId: "user-req",
        },
        {
          action: "DPDP_ERASURE_EXECUTED",
          createdAt: EXECUTED_AT,
          userId: "user-exec",
        },
      ],
    });

    const receipt = await generateErasureReceipt("req-1", prisma);

    expect(receipt.requestId).toBe("req-1");
    expect(receipt.patientId).toBe("pat-1");
    expect(receipt.tenantId).toBe("ten-1");
    expect(receipt.requestedByUserId).toBe("user-req");
    expect(receipt.executedByUserId).toBe("user-exec");
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.receiptVersion).toBe(1);

    // Tables merged: purged (with rowsDeleted) + anonymized (with fields).
    const tables = receipt.tablesAffected;
    expect(tables.find((t) => t.table === "Appointment")?.rowsDeleted).toBe(3);
    expect(tables.find((t) => t.table === "Prescription")?.rowsDeleted).toBe(5);

    const patientEntry = tables.find((t) => t.table === "Patient");
    expect(patientEntry?.rowsDeleted).toBe(0);
    expect(patientEntry?.anonymizedFields).toContain("mrNumber");
    expect(patientEntry?.anonymizedFields).toContain("abhaId");

    const userEntry = tables.find((t) => t.table === "User");
    expect(userEntry?.anonymizedFields).toContain("email");
    expect(userEntry?.anonymizedFields).toContain("phone");

    expect(receipt.auditTrail).toHaveLength(2);
    expect(receipt.auditTrail[0].action).toBe("DPDP_ERASURE_REQUESTED");
    expect(receipt.auditTrail[1].action).toBe("DPDP_ERASURE_EXECUTED");

    // Hash is non-empty, hex, deterministic SHA-256 → 64 chars.
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("re-derives an identical hash on a second call (deterministic)", async () => {
    const prisma1 = makePrismaMock({
      row: baseRow(),
      auditRows: [
        { action: "DPDP_ERASURE_REQUESTED", createdAt: REQUESTED_AT, userId: "u1" },
      ],
    });
    const prisma2 = makePrismaMock({
      row: baseRow(),
      auditRows: [
        { action: "DPDP_ERASURE_REQUESTED", createdAt: REQUESTED_AT, userId: "u1" },
      ],
    });
    const a = await generateErasureReceipt("req-1", prisma1);
    const b = await generateErasureReceipt("req-1", prisma2);
    expect(a.receiptHash).toBe(b.receiptHash);
  });

  it("changes the hash if any field changes (tamper-evident)", async () => {
    const prisma1 = makePrismaMock({
      row: baseRow(),
      auditRows: [],
    });
    const prisma2 = makePrismaMock({
      row: baseRow({ status: "PARTIAL" }),
      auditRows: [],
    });
    const a = await generateErasureReceipt("req-1", prisma1);
    const b = await generateErasureReceipt("req-1", prisma2);
    expect(a.receiptHash).not.toBe(b.receiptHash);
  });

  it("verifiable hash matches an external SHA-256 over the canonical-sorted JSON minus the hash field", async () => {
    const prisma = makePrismaMock({
      row: baseRow(),
      auditRows: [],
    });
    const r = await generateErasureReceipt("req-1", prisma);
    // Strip the hash field and re-canonicalize the same way the service does.
    const { receiptHash, ...rest } = r;
    void receiptHash;
    const canonical = canonicalize(rest);
    const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(r.receiptHash).toBe(expected);
  });

  it("falls back to a default notes string when executionReceipt is empty", async () => {
    const prisma = makePrismaMock({
      row: baseRow({ executionReceipt: null, status: "REJECTED" }),
      auditRows: [],
    });
    const r = await generateErasureReceipt("req-1", prisma);
    expect(r.notes).toMatch(/DPDP Act 2023/i);
    expect(r.tablesAffected).toHaveLength(0);
    expect(r.executedAt).toBe(EXECUTED_AT.toISOString());
  });

  it("handles null executedAt + null executedBy gracefully", async () => {
    const prisma = makePrismaMock({
      row: baseRow({ executedAt: null, executedBy: null, status: "PENDING" }),
      auditRows: [
        { action: "DPDP_ERASURE_REQUESTED", createdAt: REQUESTED_AT, userId: null },
      ],
    });
    const r = await generateErasureReceipt("req-1", prisma);
    expect(r.executedAt).toBeNull();
    expect(r.executedByUserId).toBeNull();
    expect(r.auditTrail[0].userId).toBeNull();
  });

  it("ignores unknown table names in anonymizedTables (no crash)", async () => {
    const prisma = makePrismaMock({
      row: baseRow({
        executionReceipt: {
          purgedTables: [],
          purgedRows: {},
          anonymizedTables: ["MysteryTable"],
        },
      }),
      auditRows: [],
    });
    const r = await generateErasureReceipt("req-1", prisma);
    const mystery = r.tablesAffected.find((t) => t.table === "MysteryTable");
    expect(mystery?.anonymizedFields).toEqual([]);
  });
});

describe("renderErasureReceiptPdf", () => {
  it("emits a valid PDF buffer with magic bytes + non-trivial size", async () => {
    const prisma = makePrismaMock({
      row: baseRow(),
      auditRows: [
        {
          action: "DPDP_ERASURE_REQUESTED",
          createdAt: REQUESTED_AT,
          userId: "user-req",
        },
        {
          action: "DPDP_ERASURE_EXECUTED",
          createdAt: EXECUTED_AT,
          userId: "user-exec",
        },
      ],
    });
    const receipt = await generateErasureReceipt("req-1", prisma);
    const pdf = await renderErasureReceiptPdf(receipt);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(1024);
    expect(pdf.slice(0, 5).toString("utf8")).toBe("%PDF-");
  });

  it("renders even when many tables + many audit rows are present", async () => {
    const prisma = makePrismaMock({
      row: baseRow({
        executionReceipt: {
          purgedTables: Array.from({ length: 8 }, (_, i) => `Tbl${i}`),
          purgedRows: Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [`Tbl${i}`, i + 1]),
          ),
          anonymizedTables: ["Patient", "User"],
        },
      }),
      auditRows: Array.from({ length: 6 }, (_, i) => ({
        action: i === 0 ? "DPDP_ERASURE_REQUESTED" : "DPDP_ERASURE_EXECUTED",
        createdAt: new Date(REQUESTED_AT.getTime() + i * 1000),
        userId: `u${i}`,
      })),
    });
    const receipt = await generateErasureReceipt("req-1", prisma);
    const pdf = await renderErasureReceiptPdf(receipt);
    expect(pdf.slice(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1024);
  });

  it("renders without crashing when audit-trail is empty", async () => {
    const prisma = makePrismaMock({ row: baseRow(), auditRows: [] });
    const receipt = await generateErasureReceipt("req-1", prisma);
    const pdf = await renderErasureReceiptPdf(receipt);
    expect(pdf.slice(0, 5).toString("utf8")).toBe("%PDF-");
  });
});

describe("ErasureReceiptNotFoundError", () => {
  it("carries the requestId on the error instance + name", () => {
    const e = new ErasureReceiptNotFoundError("xyz");
    expect(e.requestId).toBe("xyz");
    expect(e.name).toBe("ErasureReceiptNotFoundError");
    expect(e.message).toMatch(/xyz/);
  });
});

// Inline canonicalizer mirroring the one in the service — used in the
// verifiable-hash test above.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}
