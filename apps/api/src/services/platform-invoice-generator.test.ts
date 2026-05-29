/**
 * Pearl ERP Stage 1 §8.3 (gap row 215 closure piece 3b, 2026-05-24) —
 * monthly platform-invoice generator tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression suite around `generateMonthlyPlatformInvoices`
 *   + `markInvoicePaid`. Pins per-tenant idempotency, GST split by
 *   state, PI-YYYYMM-NNNN numbering + monotonic counter, and the
 *   PAID-stays-PAID idempotency of the operator-paid helper.
 * - MODULES: mocks `@medcore/db` so no real Postgres is touched —
 *   exercises only the pure billing logic. Mocks
 *   `@medcore/shared` so the Plan label constants stay stable.
 * - WHY: invoices are tax-traceable financial records. Off-by-one
 *   in the counter, wrong GST math, or accidental re-invoicing
 *   creates real-money damage and an audit nightmare. This file
 *   is the unit-level guard before piece 3c wires the Razorpay
 *   webhook in.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @medcore/db at the package boundary so we never load the real
// Prisma client / connect to a DB. We only re-export the Prisma
// namespace type — the runtime is fully mocked via the test prisma
// shape below.
vi.mock("@medcore/db", () => ({}));

// Mirror just the bits of @medcore/shared the service references at
// runtime. The plan prices are intentionally distinct from production
// values so a test failure unambiguously points at the test fixture,
// not at production drift.
vi.mock("@medcore/shared", () => ({
  PLAN_DEFINITIONS: {
    STARTER: { key: "STARTER", monthlyPriceInPaise: 100_000, includedFeatures: [] },
    GROWTH: { key: "GROWTH", monthlyPriceInPaise: 500_000, includedFeatures: [] },
    ENTERPRISE: {
      key: "ENTERPRISE",
      monthlyPriceInPaise: 1_000_000,
      includedFeatures: [],
    },
  },
}));

// Pearl §8.3 piece 3e (2026-05) — the invoice generator now calls
// aggregateUsageForBilling() to add per-tenant WhatsApp / SMS / LLM /
// ABDM line items alongside the plan subscription. Under the hood that
// hits `prisma.usageEvent.groupBy` + reads SystemConfig for unit prices
// — neither of which this file's prisma fake knows about. Stubbing the
// whole module here means the invoice arithmetic tests stay focused on
// plan price + GST split (which is what this file pins) and any usage-
// metering regression surfaces in usage-tracker's own tests.
vi.mock("./usage-tracker", () => ({
  aggregateUsageForBilling: vi.fn(async () => [] as never[]),
  USAGE_KIND_LABEL: {
    WHATSAPP_MESSAGE: "WhatsApp message",
    SMS_MESSAGE: "SMS message",
    LLM_TOKEN: "LLM tokens",
    ABDM_TRANSACTION: "ABDM transaction",
  },
}));

import {
  generateMonthlyPlatformInvoices,
  markInvoicePaid,
  computePreviousMonthUtcWindow,
  PLATFORM_OPERATOR_STATE,
} from "./platform-invoice-generator";

interface FakeInvoiceRow {
  id: string;
  tenantId: string;
  periodStart: Date;
  invoiceNumber: string;
  status: string;
  totalInPaise: number;
  paidAt: Date | null;
  paidByUserId: string | null;
  paymentReference: string | null;
}

function buildPrismaMock(
  subscriptions: any[],
  existingInvoices: FakeInvoiceRow[] = [],
) {
  // Mutable invoice store that updates feed into the same array so
  // the second call to `generateMonthlyPlatformInvoices` sees what
  // the first call wrote (the load-bearing idempotency test).
  const invoiceStore: FakeInvoiceRow[] = [...existingInvoices];
  const lineItemStore: any[] = [];
  const auditStore: any[] = [];

  const prismaMock: any = {
    tenantSubscription: {
      findMany: vi.fn(async () => subscriptions),
    },
    platformInvoice: {
      findFirst: vi.fn(async ({ where }: any) => {
        const ps = where.periodStart;
        return (
          invoiceStore.find(
            (i) => i.tenantId === where.tenantId && i.periodStart.getTime() === ps.getTime(),
          ) ?? null
        );
      }),
      count: vi.fn(async ({ where }: any) => {
        const prefix: string | undefined = where?.invoiceNumber?.startsWith;
        if (!prefix) return invoiceStore.length;
        return invoiceStore.filter((i) => i.invoiceNumber.startsWith(prefix)).length;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `inv-${invoiceStore.length + 1}`;
        const row: FakeInvoiceRow = {
          id,
          tenantId: data.tenantId,
          periodStart: data.periodStart,
          invoiceNumber: data.invoiceNumber,
          status: data.status,
          totalInPaise: data.totalInPaise,
          paidAt: null,
          paidByUserId: null,
          paymentReference: null,
        };
        invoiceStore.push(row);
        // Capture line items separately so we can assert their shape.
        if (data.lineItems?.create) {
          for (const li of data.lineItems.create) {
            lineItemStore.push({ invoiceId: id, ...li });
          }
        }
        // Capture the FULL payload so tests can assert GST splits etc.
        (row as any)._raw = data;
        return { id };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return invoiceStore.find((i) => i.id === where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = invoiceStore.find((i) => i.id === where.id);
        if (!row) throw new Error("invoice not found in fake store");
        Object.assign(row, data);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditStore.push(data);
        return { id: `audit-${auditStore.length}` };
      }),
    },
  };

  return { prismaMock, invoiceStore, lineItemStore, auditStore };
}

const NOW = new Date("2026-05-15T03:00:00.000Z"); // mid-May → expects April invoices
const APRIL_START = new Date(Date.UTC(2026, 3, 1));
const MAY_START = new Date(Date.UTC(2026, 4, 1));

describe("computePreviousMonthUtcWindow", () => {
  it("returns April 1 → May 1 (UTC) for a mid-May now", () => {
    const { periodStart, periodEnd, yyyymm, monthLabel } =
      computePreviousMonthUtcWindow(NOW);
    expect(periodStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(yyyymm).toBe("202604");
    expect(monthLabel).toBe("April 2026");
  });

  it("rolls year backward on a January now", () => {
    const jan = new Date("2026-01-10T00:00:00.000Z");
    const { periodStart, yyyymm } = computePreviousMonthUtcWindow(jan);
    expect(periodStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(yyyymm).toBe("202512");
  });
});

describe("generateMonthlyPlatformInvoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one ISSUED invoice per active subscription for the previous month", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "STARTER",
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Acme Hospital",
          active: true,
          branches: [{ state: "Maharashtra" }], // cross-state → IGST
        },
      },
      {
        id: "sub-2",
        tenantId: "t-2",
        plan: "GROWTH",
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-2",
          name: "Beta Clinic",
          active: true,
          branches: [{ state: PLATFORM_OPERATOR_STATE }], // same-state → CGST+SGST
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    const result = await generateMonthlyPlatformInvoices(prismaMock, NOW);

    expect(result.generated).toBe(2);
    expect(result.skippedAlreadyExists).toBe(0);
    expect(result.errors).toBe(0);
    expect(invoiceStore).toHaveLength(2);
    expect(invoiceStore.every((i) => i.status === "ISSUED")).toBe(true);
    expect(invoiceStore.every((i) => i.periodStart.getTime() === APRIL_START.getTime())).toBe(true);
  });

  it("skips a subscription whose tenant is inactive without creating an invoice", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "STARTER",
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Suspended Hospital",
          active: false,
          branches: [{ state: "Karnataka" }],
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    const result = await generateMonthlyPlatformInvoices(prismaMock, NOW);

    expect(result.skippedInactive).toBe(1);
    expect(result.generated).toBe(0);
    expect(invoiceStore).toHaveLength(0);
    expect(prismaMock.platformInvoice.create).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run does not duplicate invoices for the same tenant+month", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "STARTER",
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Acme",
          active: true,
          branches: [{ state: "Maharashtra" }],
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    const first = await generateMonthlyPlatformInvoices(prismaMock, NOW);
    const second = await generateMonthlyPlatformInvoices(prismaMock, NOW);

    expect(first.generated).toBe(1);
    expect(second.generated).toBe(0);
    expect(second.skippedAlreadyExists).toBe(1);
    expect(invoiceStore).toHaveLength(1);
  });

  it("splits GST as CGST+SGST 9%+9% for same-state tenants", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "STARTER", // 100_000 paise in mock
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Same-state Hospital",
          active: true,
          branches: [{ state: PLATFORM_OPERATOR_STATE }],
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    await generateMonthlyPlatformInvoices(prismaMock, NOW);

    const raw = (invoiceStore[0] as any)._raw;
    expect(raw.subtotalInPaise).toBe(100_000);
    expect(raw.cgstInPaise).toBe(9_000); // 9% of 100_000
    expect(raw.sgstInPaise).toBe(9_000);
    expect(raw.igstInPaise).toBe(0);
    expect(raw.totalInPaise).toBe(118_000);
  });

  it("splits GST as IGST 18% for cross-state tenants and for tenants with no branch state", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "GROWTH", // 500_000 paise
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Cross-state",
          active: true,
          branches: [{ state: "Tamil Nadu" }],
        },
      },
      {
        id: "sub-2",
        tenantId: "t-2",
        plan: "STARTER", // 100_000 paise
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-2",
          name: "No-state",
          active: true,
          branches: [], // no default branch → IGST fallback
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    await generateMonthlyPlatformInvoices(prismaMock, NOW);

    const cross = (invoiceStore.find((i) => i.tenantId === "t-1") as any)._raw;
    expect(cross.cgstInPaise).toBe(0);
    expect(cross.sgstInPaise).toBe(0);
    expect(cross.igstInPaise).toBe(90_000); // 18% of 500_000
    expect(cross.totalInPaise).toBe(590_000);

    const nostate = (invoiceStore.find((i) => i.tenantId === "t-2") as any)._raw;
    expect(nostate.igstInPaise).toBe(18_000);
    expect(nostate.cgstInPaise).toBe(0);
    expect(nostate.totalInPaise).toBe(118_000);
  });

  it("respects customPriceMonthlyInPaise override over the plan default", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "ENTERPRISE",
        customPriceMonthlyInPaise: 250_000_000, // ₹25 lakh bespoke deal
        tenant: {
          id: "t-1",
          name: "Bespoke",
          active: true,
          branches: [{ state: "Maharashtra" }],
        },
      },
    ];
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    await generateMonthlyPlatformInvoices(prismaMock, NOW);

    const raw = (invoiceStore[0] as any)._raw;
    expect(raw.subtotalInPaise).toBe(250_000_000);
    expect(raw.igstInPaise).toBe(45_000_000); // 18% of 250M
  });

  it("emits PI-YYYYMM-NNNN invoice numbers with a monotonic, zero-padded counter", async () => {
    const subs = Array.from({ length: 3 }, (_, n) => ({
      id: `sub-${n + 1}`,
      tenantId: `t-${n + 1}`,
      plan: "STARTER",
      customPriceMonthlyInPaise: null,
      tenant: {
        id: `t-${n + 1}`,
        name: `Tenant ${n + 1}`,
        active: true,
        branches: [{ state: "Maharashtra" }],
      },
    }));
    const { prismaMock, invoiceStore } = buildPrismaMock(subs);

    await generateMonthlyPlatformInvoices(prismaMock, NOW);

    const numbers = invoiceStore.map((i) => i.invoiceNumber).sort();
    expect(numbers).toEqual([
      "PI-202604-0001",
      "PI-202604-0002",
      "PI-202604-0003",
    ]);
  });

  it("writes one PLATFORM_INVOICE_GENERATED audit row per generated invoice", async () => {
    const subs = [
      {
        id: "sub-1",
        tenantId: "t-1",
        plan: "STARTER",
        customPriceMonthlyInPaise: null,
        tenant: {
          id: "t-1",
          name: "Acme",
          active: true,
          branches: [{ state: PLATFORM_OPERATOR_STATE }],
        },
      },
    ];
    const { prismaMock, auditStore } = buildPrismaMock(subs);

    await generateMonthlyPlatformInvoices(prismaMock, NOW);

    expect(auditStore).toHaveLength(1);
    expect(auditStore[0].action).toBe("PLATFORM_INVOICE_GENERATED");
    expect(auditStore[0].entity).toBe("platform_invoice");
    expect(auditStore[0].details.gstSplit).toBe("CGST+SGST");
  });
});

describe("markInvoicePaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks an ISSUED invoice PAID and stamps paidAt + paidByUserId + paymentReference", async () => {
    const seeded: FakeInvoiceRow = {
      id: "inv-1",
      tenantId: "t-1",
      periodStart: APRIL_START,
      invoiceNumber: "PI-202604-0001",
      status: "ISSUED",
      totalInPaise: 118_000,
      paidAt: null,
      paidByUserId: null,
      paymentReference: null,
    };
    const { prismaMock, invoiceStore, auditStore } = buildPrismaMock([], [seeded]);
    const at = new Date("2026-05-20T10:00:00.000Z");

    const result = await markInvoicePaid(
      prismaMock,
      "inv-1",
      "ops-user-9",
      "BANKREF-XYZ",
      at,
    );

    expect(result).toEqual({ status: "PAID", invoiceId: "inv-1" });
    const row = invoiceStore[0];
    expect(row.status).toBe("PAID");
    expect((row as any).paidAt).toBe(at);
    expect((row as any).paidByUserId).toBe("ops-user-9");
    expect((row as any).paymentReference).toBe("BANKREF-XYZ");
    expect(auditStore).toHaveLength(1);
    expect(auditStore[0].action).toBe("PLATFORM_INVOICE_MARKED_PAID");
  });

  it("is a no-op when invoked on an already-PAID invoice", async () => {
    const seeded: FakeInvoiceRow = {
      id: "inv-1",
      tenantId: "t-1",
      periodStart: APRIL_START,
      invoiceNumber: "PI-202604-0001",
      status: "PAID",
      totalInPaise: 118_000,
      paidAt: new Date("2026-05-19T10:00:00.000Z"),
      paidByUserId: "ops-user-9",
      paymentReference: "BANKREF-XYZ",
    };
    const { prismaMock, auditStore } = buildPrismaMock([], [seeded]);

    const result = await markInvoicePaid(
      prismaMock,
      "inv-1",
      "another-user",
      "WEBHOOK-RETRY",
    );

    expect(result).toEqual({ status: "ALREADY_PAID", invoiceId: "inv-1" });
    expect(prismaMock.platformInvoice.update).not.toHaveBeenCalled();
    expect(auditStore).toHaveLength(0);
  });

  it("throws when the invoice does not exist", async () => {
    const { prismaMock } = buildPrismaMock([], []);
    await expect(
      markInvoicePaid(prismaMock, "missing", "u", "REF"),
    ).rejects.toThrow(/not found/i);
  });

  // Sanity-check the silenced-now warning (`MAY_START` is the upper bound the
  // service returns; the test imports it to clarify intent in the previous
  // assertion block and to keep an unused-import lint clean if anything is
  // re-shuffled later).
  it("MAY_START sentinel matches the period-end produced by computePreviousMonthUtcWindow(NOW)", () => {
    const { periodEnd } = computePreviousMonthUtcWindow(NOW);
    expect(periodEnd.getTime()).toBe(MAY_START.getTime());
  });
});
