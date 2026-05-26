// Unit tests for the IPD running-bill sync service.
//
// What / which modules / why:
//   - Validates `syncIpdInvoiceTotals` — the helper that walks every PENDING
//     IPD invoice tied to an ADMITTED admission and persists bed + pharmacy
//     + lab totals so every downstream caller (billing list, KPI cards,
//     outstanding report, discharge-readiness guard) reads the same fresh
//     number without overlay logic.
//   - Step 1 of the sync: lazy-create invoices for ADMITTED admissions
//     missing an `invoice` row (backfill); idempotency-safe under
//     concurrent P2002 races; uses systemConfig `next_invoice_number`
//     sequence (and creates the cfg row when missing).
//   - Step 2 of the sync: re-totals each active invoice via
//       bed_charges  = max(1, ceil((endMs - startMs) / DAY_MS)) × bed.dailyRate
//       pharmacy    = Σ over each ADMINISTERED dose × medicine.mrp
//       lab         = Σ over each COMPLETED lab-order item × test.price
//     and re-derives paymentStatus from netPaid (refunds = negative
//     payments cancel out).
//   - Idempotency: when totalAmount + paymentStatus already match, the
//     invoice.update is skipped (no DB churn). The function returns the
//     count of rows actually updated.
//   - Prisma is mocked end-to-end at the `@medcore/db` import boundary —
//     no DB hit.
//
// Pattern reference: `patient-data-export.test.ts` (hoisted prismaMock +
// `vi.mock("@medcore/db", ...)`).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted Prisma mock ───────────────────────────────────────────────────

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    admission: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    invoice: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  return { prismaMock };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

// Import under test (after mocks).
import { syncIpdInvoiceTotals } from "./ipd-billing-sync";

// ─── Test helpers ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Build an active-admission invoice row matching the projection in the
// service's `invoice.findMany` select clause.
function makeInvoice(opts: {
  id?: string;
  totalAmount?: number;
  paymentStatus?: "PENDING" | "PARTIAL" | "PAID" | "REFUNDED";
  payments?: Array<{ amount: number }>;
  admittedAt?: Date | string;
  dischargedAt?: Date | string | null;
  dailyRate?: number;
  medicationOrders?: Array<{
    medicine: { mrp: number } | null;
    administrations: Array<{ id: string }>;
  }>;
  labOrders?: Array<{
    items: Array<{ test: { price: number } | null }>;
  }>;
  admission?: object | null;
}) {
  if (opts.admission === null) {
    return {
      id: opts.id ?? "inv-x",
      totalAmount: opts.totalAmount ?? 0,
      paymentStatus: opts.paymentStatus ?? "PENDING",
      payments: opts.payments ?? [],
      admission: null,
    };
  }
  return {
    id: opts.id ?? "inv-1",
    totalAmount: opts.totalAmount ?? 0,
    paymentStatus: opts.paymentStatus ?? "PENDING",
    payments: opts.payments ?? [],
    admission: {
      admittedAt: opts.admittedAt ?? new Date(Date.now() - DAY_MS),
      dischargedAt: opts.dischargedAt ?? null,
      bed: { dailyRate: opts.dailyRate ?? 1000 },
      medicationOrders: opts.medicationOrders ?? [],
      labOrders: opts.labOrders ?? [],
    },
  };
}

// Default $transaction implementation: synthesise a `tx` proxy that
// delegates each model call to the same prismaMock methods. Tests that
// need to assert tx-internal behaviour override per-call.
function defaultTxImpl() {
  return async (fn: (tx: typeof prismaMock) => Promise<unknown>) => {
    return fn(prismaMock);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Restore defaults after clearAllMocks wipes them.
  prismaMock.admission.findMany.mockResolvedValue([]);
  prismaMock.invoice.findMany.mockResolvedValue([]);
  prismaMock.invoice.create.mockResolvedValue({});
  prismaMock.invoice.update.mockResolvedValue({});
  prismaMock.systemConfig.findUnique.mockResolvedValue(null);
  prismaMock.systemConfig.create.mockResolvedValue({});
  prismaMock.systemConfig.update.mockResolvedValue({});
  prismaMock.$transaction.mockImplementation(defaultTxImpl());
});

// ─── No-op shape ───────────────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — no work to do", () => {
  it("returns 0 and writes nothing when there are no admitted admissions and no invoices", async () => {
    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(0);
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.create).not.toHaveBeenCalled();
  });

  it("queries only ADMITTED admissions missing an invoice (orphan backfill scope)", async () => {
    await syncIpdInvoiceTotals();
    expect(prismaMock.admission.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.admission.findMany.mock.calls[0][0];
    expect(args.where.status).toBe("ADMITTED");
    expect(args.where.invoice).toBeNull();
  });

  it("queries only ADMITTED-admission invoices for the resync step", async () => {
    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.findMany.mock.calls[0][0];
    expect(args.where.admissionId).toEqual({ not: null });
    expect(args.where.admission).toEqual({ status: "ADMITTED" });
  });
});

// ─── Step 1: orphan-invoice backfill ───────────────────────────────────────

describe("syncIpdInvoiceTotals — Step 1: orphan-invoice backfill", () => {
  it("creates an invoice using next_invoice_number when the cfg row exists, padded to 6 digits with INV prefix", async () => {
    prismaMock.admission.findMany.mockResolvedValueOnce([
      { id: "adm-1", patientId: "pat-1", admissionNumber: "ADM-001" },
    ]);
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({
      key: "next_invoice_number",
      value: "42",
    });

    await syncIpdInvoiceTotals();

    expect(prismaMock.invoice.create).toHaveBeenCalledTimes(1);
    const createArgs = prismaMock.invoice.create.mock.calls[0][0];
    expect(createArgs.data.invoiceNumber).toBe("INV000042");
    expect(createArgs.data.admissionId).toBe("adm-1");
    expect(createArgs.data.patientId).toBe("pat-1");
    expect(createArgs.data.subtotal).toBe(0);
    expect(createArgs.data.totalAmount).toBe(0);
    expect(createArgs.data.paymentStatus).toBe("PENDING");
    expect(createArgs.data.notes).toContain("ADM-001");
    expect(createArgs.data.notes).toMatch(/backfilled/i);

    // Sequence incremented.
    expect(prismaMock.systemConfig.update).toHaveBeenCalledWith({
      where: { key: "next_invoice_number" },
      data: { value: "43" },
    });
    expect(prismaMock.systemConfig.create).not.toHaveBeenCalled();
  });

  it("creates the next_invoice_number cfg row on first-ever run (defaults seq=1)", async () => {
    prismaMock.admission.findMany.mockResolvedValueOnce([
      { id: "adm-X", patientId: "pat-X", admissionNumber: "ADM-X" },
    ]);
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce(null);

    await syncIpdInvoiceTotals();

    expect(prismaMock.invoice.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoice.create.mock.calls[0][0].data.invoiceNumber).toBe(
      "INV000001",
    );
    expect(prismaMock.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "next_invoice_number", value: "2" },
    });
    expect(prismaMock.systemConfig.update).not.toHaveBeenCalled();
  });

  it("swallows P2002 unique-constraint conflicts silently (concurrent sync raced us)", async () => {
    prismaMock.admission.findMany.mockResolvedValueOnce([
      { id: "adm-race", patientId: "pat-race", admissionNumber: "ADM-RACE" },
    ]);
    prismaMock.$transaction.mockImplementationOnce(async () => {
      const err = new Error("Unique constraint failed");
      (err as Error & { code: string }).code = "P2002";
      throw err;
    });

    await expect(syncIpdInvoiceTotals()).resolves.toBe(0);
    // No warning should be logged for P2002.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs but does not throw on non-P2002 errors and continues the sweep", async () => {
    prismaMock.admission.findMany.mockResolvedValueOnce([
      { id: "adm-a", patientId: "pat-a", admissionNumber: "ADM-A" },
      { id: "adm-b", patientId: "pat-b", admissionNumber: "ADM-B" },
    ]);
    // First admission's tx throws a non-P2002 error.
    prismaMock.$transaction
      .mockImplementationOnce(async () => {
        const err = new Error("connection lost");
        (err as Error & { code: string }).code = "P1001";
        throw err;
      })
      .mockImplementationOnce(defaultTxImpl());

    await expect(syncIpdInvoiceTotals()).resolves.toBe(0);
    // Second admission still got attempted.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    // Warning logged for the failing one.
    expect(console.warn).toHaveBeenCalledTimes(1);
    const msg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg).toContain("ADM-A");
  });
});

// ─── Step 2: bed charges ───────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — bed-charge math", () => {
  it("uses ceil((endMs-startMs)/DAY_MS) with min 1 day, and dailyRate=0 when bed is missing", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      // Just-admitted (< 1 day) → floor up to 1 day. dailyRate=0 → bed=0.
      {
        id: "inv-bare",
        totalAmount: 0,
        paymentStatus: "PENDING",
        payments: [],
        admission: {
          admittedAt: new Date(now - 60 * 1000),
          dischargedAt: null,
          bed: null,
          medicationOrders: [],
          labOrders: [],
        },
      },
    ]);

    const updated = await syncIpdInvoiceTotals();
    // Target = 0 (no bed × 1 day) and totalAmount=0, status=PENDING — match,
    // no update should fire.
    expect(updated).toBe(0);
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("computes bed charges as ceil(days) × dailyRate and updates the invoice", async () => {
    const now = Date.now();
    // 2.5 days ago → ceil(2.5)=3 days × 1000 = 3000.
    const admittedAt = new Date(now - 2.5 * DAY_MS);
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-bed",
        admittedAt,
        dailyRate: 1000,
        totalAmount: 0, // forces drift → triggers update
        paymentStatus: "PENDING",
      }),
    ]);

    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(1);
    expect(prismaMock.invoice.update).toHaveBeenCalledTimes(1);
    const args = prismaMock.invoice.update.mock.calls[0][0];
    expect(args.where.id).toBe("inv-bed");
    expect(args.data.totalAmount).toBe(3000);
    expect(args.data.subtotal).toBe(3000);
    expect(args.data.paymentStatus).toBe("PENDING");
  });

  it("uses dischargedAt over now when present (frozen-end stop)", async () => {
    const admittedAt = new Date("2026-01-01T00:00:00Z");
    const dischargedAt = new Date("2026-01-05T00:00:00Z"); // exactly 4 days
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-disch",
        admittedAt,
        dischargedAt,
        dailyRate: 500,
        totalAmount: 0,
      }),
    ]);
    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.update.mock.calls[0][0];
    expect(args.data.totalAmount).toBe(4 * 500);
  });
});

// ─── Step 2: pharmacy total ────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — pharmacy total", () => {
  it("sums administered doses × medicine.mrp across all medication orders", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-pharm",
        // Half-day → ceil=1 day. Using exact DAY_MS risks ceil flicker
        // between 1 and 2 when sub-ms wall-clock drift occurs during a
        // slow (--coverage) test run.
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 100,
        medicationOrders: [
          {
            medicine: { mrp: 50 },
            administrations: [{ id: "a1" }, { id: "a2" }], // 2 × 50 = 100
          },
          {
            medicine: { mrp: 200 },
            administrations: [{ id: "a3" }], // 1 × 200 = 200
          },
        ],
        totalAmount: 0,
      }),
    ]);

    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.update.mock.calls[0][0];
    // 100 (bed) + 100 + 200 = 400
    expect(args.data.totalAmount).toBe(400);
  });

  it("skips orders with zero administered doses (no contribution)", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-zero-doses",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 0,
        medicationOrders: [
          { medicine: { mrp: 999 }, administrations: [] }, // 0 contribution
        ],
        totalAmount: 0,
      }),
    ]);
    const updated = await syncIpdInvoiceTotals();
    // Target = 0 + 0 + 0 = 0, totalAmount=0, status=PENDING → no update.
    expect(updated).toBe(0);
  });

  it("treats null medicine / null mrp as 0 (catalog gap)", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-null-med",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 100,
        medicationOrders: [
          { medicine: null, administrations: [{ id: "a1" }] },
          {
            medicine: { mrp: 0 } as unknown as { mrp: number },
            administrations: [{ id: "a2" }],
          },
        ],
        totalAmount: 0,
      }),
    ]);
    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.update.mock.calls[0][0];
    expect(args.data.totalAmount).toBe(100); // bed only
  });
});

// ─── Step 2: lab total ─────────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — lab total", () => {
  it("sums LabOrderItem.test.price across every COMPLETED item", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-lab",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 100,
        labOrders: [
          {
            items: [
              { test: { price: 250 } },
              { test: { price: 400 } },
            ],
          },
          {
            items: [{ test: { price: 50 } }],
          },
        ],
        totalAmount: 0,
      }),
    ]);
    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.update.mock.calls[0][0];
    // 100 bed + 700 lab = 800
    expect(args.data.totalAmount).toBe(800);
  });

  it("treats missing test rows as 0 contribution", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-no-test",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 100,
        labOrders: [{ items: [{ test: null }] }],
        totalAmount: 0,
      }),
    ]);
    await syncIpdInvoiceTotals();
    const args = prismaMock.invoice.update.mock.calls[0][0];
    expect(args.data.totalAmount).toBe(100); // bed only
  });
});

// ─── Step 2: paymentStatus derivation ──────────────────────────────────────

describe("syncIpdInvoiceTotals — derived paymentStatus", () => {
  it("derives PENDING when netPaid <= 0", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-pend",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        payments: [],
        totalAmount: 0,
        paymentStatus: "PENDING",
      }),
    ]);
    await syncIpdInvoiceTotals();
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PENDING",
    );
  });

  it("derives PARTIAL when 0 < netPaid < total", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-part",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        payments: [{ amount: 400 }],
        totalAmount: 0,
        paymentStatus: "PENDING",
      }),
    ]);
    await syncIpdInvoiceTotals();
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PARTIAL",
    );
  });

  it("derives PAID when netPaid >= total", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-paid",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        payments: [{ amount: 500 }, { amount: 500 }],
        totalAmount: 0,
        paymentStatus: "PENDING",
      }),
    ]);
    await syncIpdInvoiceTotals();
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PAID",
    );
  });

  it("clamps netPaid at 0 when refunds exceed payments (no PAID by accident)", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-refund-overflow",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        // Refunds stored as negative — sum is -200 → clamped to 0 → PENDING.
        payments: [{ amount: 300 }, { amount: -500 }],
        totalAmount: 0,
        paymentStatus: "PENDING",
      }),
    ]);
    await syncIpdInvoiceTotals();
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PENDING",
    );
  });

  it("handles null payment.amount as 0 in the sum", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-null-pay",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        payments: [
          { amount: 600 },
          // @ts-expect-error null amount tolerated via `?? 0`
          { amount: null },
        ],
        totalAmount: 0,
        paymentStatus: "PENDING",
      }),
    ]);
    await syncIpdInvoiceTotals();
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PARTIAL",
    );
  });
});

// ─── Idempotency ───────────────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — idempotency", () => {
  it("skips invoice.update when both totalAmount and paymentStatus already match", async () => {
    const now = Date.now();
    // Bed-only target = 1 day × 1000 = 1000, paid 1000 → PAID, already set.
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-stable",
        admittedAt: new Date(now - DAY_MS / 2), // ceil → 1 day
        dailyRate: 1000,
        payments: [{ amount: 1000 }],
        totalAmount: 1000,
        paymentStatus: "PAID",
      }),
    ]);

    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(0);
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("updates when totalAmount is right but paymentStatus drifted", async () => {
    const now = Date.now();
    // Bed = 1000, paid 1000 → derived PAID, but row says PARTIAL.
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({
        id: "inv-status-drift",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        payments: [{ amount: 1000 }],
        totalAmount: 1000,
        paymentStatus: "PARTIAL", // stale
      }),
    ]);
    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(1);
    expect(prismaMock.invoice.update.mock.calls[0][0].data.paymentStatus).toBe(
      "PAID",
    );
  });

  it("ignores invoices with admission=null (defensive null-guard)", async () => {
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      makeInvoice({ id: "inv-orphan-null", admission: null }),
    ]);
    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(0);
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });
});

// ─── Aggregate returns ─────────────────────────────────────────────────────

describe("syncIpdInvoiceTotals — return count", () => {
  it("returns the number of rows actually updated (mixed stable + drifted)", async () => {
    const now = Date.now();
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      // Stable — no update.
      makeInvoice({
        id: "inv-stable",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 1000,
        totalAmount: 1000,
        paymentStatus: "PENDING",
      }),
      // Drifted total.
      makeInvoice({
        id: "inv-drift-a",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 500,
        totalAmount: 0,
      }),
      // Drifted status.
      makeInvoice({
        id: "inv-drift-b",
        admittedAt: new Date(now - DAY_MS / 2),
        dailyRate: 200,
        payments: [{ amount: 200 }],
        totalAmount: 200,
        paymentStatus: "PARTIAL", // should be PAID
      }),
    ]);

    const updated = await syncIpdInvoiceTotals();
    expect(updated).toBe(2);
    expect(prismaMock.invoice.update).toHaveBeenCalledTimes(2);
    const ids = prismaMock.invoice.update.mock.calls.map((c) => c[0].where.id);
    expect(ids).toEqual(expect.arrayContaining(["inv-drift-a", "inv-drift-b"]));
  });
});
