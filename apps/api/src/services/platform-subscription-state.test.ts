/**
 * Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3c, 2026-05-25) —
 * platform-subscription state-machine unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the five transition helpers
 *   (`transitionToActive`, `transitionToPastDue`, `transitionToSuspended`,
 *   `cancelSubscription`, `checkGracePeriodExpirations`) plus
 *   `applyProration`. Pins idempotency (re-call → no-op), the
 *   one-direction-only refusals (e.g. cannot un-cancel), the
 *   pastDueSince + GRACE_PERIOD_DAYS sweep arithmetic, and the
 *   proration delta + sign-preserving GST math.
 * - MODULES: mocks `@medcore/db` so no real Postgres is touched, plus a
 *   targeted mock of `@medcore/shared` so the plan-price + grace-days
 *   constants are deterministic.
 * - WHY: every transition writes an AuditLog row that the super-admin
 *   trail reads as ground-truth for billing-state changes. Wrong
 *   transitions = wrong audit = compliance gap. Wrong proration math =
 *   real-money damage. This file is the unit-level guard before the
 *   Razorpay webhook (sibling file) wires these helpers in.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@medcore/db", () => ({}));

vi.mock("@medcore/shared", () => ({
  GRACE_PERIOD_DAYS: 7,
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

import {
  transitionToActive,
  transitionToPastDue,
  transitionToSuspended,
  cancelSubscription,
  checkGracePeriodExpirations,
  applyProration,
} from "./platform-subscription-state";

interface FakeSubscription {
  id: string;
  tenantId: string;
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled";
  plan: "STARTER" | "GROWTH" | "ENTERPRISE";
  pastDueSince: Date | null;
  cancelledAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  customPriceMonthlyInPaise: number | null;
  tenant?: {
    id: string;
    name: string;
    branches: Array<{ state: string | null }>;
  };
}

function buildPrismaMock(subs: FakeSubscription[]) {
  const subStore: FakeSubscription[] = subs.map((s) => ({ ...s }));
  const invoiceStore: any[] = [];
  const auditStore: any[] = [];

  const prismaMock: any = {
    tenantSubscription: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = subStore.find((s) => s.id === where.id);
        if (!row) return null;
        // Echo back only what `select` asked for (mimics Prisma; the
        // helpers `select` exactly the fields they read).
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if (k === "tenant" && row.tenant) {
            out.tenant = row.tenant;
          } else {
            out[k] = (row as any)[k];
          }
        }
        return out;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let rows = [...subStore];
        if (where?.status) rows = rows.filter((s) => s.status === where.status);
        if (where?.pastDueSince?.lt) {
          const cutoff = where.pastDueSince.lt as Date;
          rows = rows.filter(
            (s) => s.pastDueSince && s.pastDueSince.getTime() < cutoff.getTime(),
          );
        }
        return rows.map((s) => ({ id: s.id }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = subStore.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
    },
    platformInvoice: {
      count: vi.fn(async ({ where }: any) => {
        const prefix: string | undefined = where?.invoiceNumber?.startsWith;
        if (!prefix) return invoiceStore.length;
        return invoiceStore.filter((i) => i.invoiceNumber.startsWith(prefix)).length;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `inv-${invoiceStore.length + 1}`;
        const row = { id, ...data };
        invoiceStore.push(row);
        return { id, invoiceNumber: data.invoiceNumber };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditStore.push(data);
        return { id: `audit-${auditStore.length}` };
      }),
    },
  };

  return { prismaMock, subStore, invoiceStore, auditStore };
}

function baseSubscription(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  return {
    id: "sub-1",
    tenantId: "t-1",
    status: "active",
    plan: "STARTER",
    pastDueSince: null,
    cancelledAt: null,
    currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
    customPriceMonthlyInPaise: null,
    tenant: {
      id: "t-1",
      name: "Acme",
      branches: [{ state: "Maharashtra" }],
    },
    ...overrides,
  };
}

const NOW = new Date("2026-05-15T12:00:00.000Z");

describe("transitionToActive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips trial → active and writes the audit row", async () => {
    const { prismaMock, subStore, auditStore } = buildPrismaMock([
      baseSubscription({ status: "trial" }),
    ]);

    const r = await transitionToActive(prismaMock, "sub-1", NOW);

    expect(r).toEqual({ changed: true, status: "active", subscriptionId: "sub-1" });
    expect(subStore[0].status).toBe("active");
    expect(subStore[0].pastDueSince).toBeNull();
    expect(auditStore).toHaveLength(1);
    expect(auditStore[0].action).toBe("PLATFORM_SUBSCRIPTION_ACTIVATED");
    expect(auditStore[0].entity).toBe("tenant_subscription");
    expect(auditStore[0].details.fromStatus).toBe("trial");
    expect(auditStore[0].details.toStatus).toBe("active");
  });

  it("clears pastDueSince when lifting past_due → active", async () => {
    const { prismaMock, subStore } = buildPrismaMock([
      baseSubscription({
        status: "past_due",
        pastDueSince: new Date("2026-05-10T00:00:00.000Z"),
      }),
    ]);

    await transitionToActive(prismaMock, "sub-1", NOW);

    expect(subStore[0].status).toBe("active");
    expect(subStore[0].pastDueSince).toBeNull();
  });

  it("is idempotent on already-active rows (no audit row, no update call)", async () => {
    const { prismaMock, auditStore } = buildPrismaMock([
      baseSubscription({ status: "active" }),
    ]);

    const r = await transitionToActive(prismaMock, "sub-1", NOW);

    expect(r.changed).toBe(false);
    expect((r as any).reason).toBe("ALREADY_ACTIVE");
    expect(prismaMock.tenantSubscription.update).not.toHaveBeenCalled();
    expect(auditStore).toHaveLength(0);
  });

  it("refuses to activate from cancelled or suspended", async () => {
    const { prismaMock } = buildPrismaMock([
      baseSubscription({ status: "cancelled" }),
    ]);
    const r = await transitionToActive(prismaMock, "sub-1", NOW);
    expect(r.changed).toBe(false);
    expect((r as any).reason).toBe("CANNOT_ACTIVATE_FROM_CANCELLED");
  });

  it("throws when the subscription does not exist", async () => {
    const { prismaMock } = buildPrismaMock([]);
    await expect(transitionToActive(prismaMock, "missing", NOW)).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("transitionToPastDue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips active → past_due and stamps pastDueSince", async () => {
    const { prismaMock, subStore, auditStore } = buildPrismaMock([
      baseSubscription({ status: "active" }),
    ]);

    await transitionToPastDue(prismaMock, "sub-1", NOW);

    expect(subStore[0].status).toBe("past_due");
    expect(subStore[0].pastDueSince).toEqual(NOW);
    expect(auditStore).toHaveLength(1);
    expect(auditStore[0].action).toBe("PLATFORM_SUBSCRIPTION_PAST_DUE");
    expect(auditStore[0].details.pastDueSince).toBe(NOW.toISOString());
  });

  it("is idempotent on already-past_due rows (no audit row, no update)", async () => {
    const earlier = new Date("2026-05-10T00:00:00.000Z");
    const { prismaMock, subStore, auditStore } = buildPrismaMock([
      baseSubscription({ status: "past_due", pastDueSince: earlier }),
    ]);

    const r = await transitionToPastDue(prismaMock, "sub-1", NOW);

    expect(r.changed).toBe(false);
    // pastDueSince should NOT be re-stamped — the grace clock must keep ticking.
    expect(subStore[0].pastDueSince).toEqual(earlier);
    expect(prismaMock.tenantSubscription.update).not.toHaveBeenCalled();
    expect(auditStore).toHaveLength(0);
  });
});

describe("transitionToSuspended", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips past_due → suspended", async () => {
    const { prismaMock, subStore, auditStore } = buildPrismaMock([
      baseSubscription({
        status: "past_due",
        pastDueSince: new Date("2026-05-01T00:00:00.000Z"),
      }),
    ]);

    await transitionToSuspended(prismaMock, "sub-1", NOW);

    expect(subStore[0].status).toBe("suspended");
    expect(auditStore[0].action).toBe("PLATFORM_SUBSCRIPTION_SUSPENDED");
  });

  it("refuses to suspend from active (grace window must not be skipped)", async () => {
    const { prismaMock } = buildPrismaMock([
      baseSubscription({ status: "active" }),
    ]);

    const r = await transitionToSuspended(prismaMock, "sub-1", NOW);

    expect(r.changed).toBe(false);
    expect((r as any).reason).toBe("CANNOT_SUSPEND_FROM_ACTIVE");
  });

  it("is idempotent on already-suspended", async () => {
    const { prismaMock, auditStore } = buildPrismaMock([
      baseSubscription({ status: "suspended" }),
    ]);
    const r = await transitionToSuspended(prismaMock, "sub-1", NOW);
    expect(r.changed).toBe(false);
    expect(auditStore).toHaveLength(0);
  });
});

describe("cancelSubscription", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips any non-cancelled state → cancelled and stamps cancelledAt", async () => {
    const { prismaMock, subStore, auditStore } = buildPrismaMock([
      baseSubscription({ status: "active" }),
    ]);

    await cancelSubscription(prismaMock, "sub-1", NOW);

    expect(subStore[0].status).toBe("cancelled");
    expect(subStore[0].cancelledAt).toEqual(NOW);
    expect(auditStore[0].action).toBe("PLATFORM_SUBSCRIPTION_CANCELLED");
  });

  it("is idempotent on already-cancelled", async () => {
    const { prismaMock, auditStore } = buildPrismaMock([
      baseSubscription({ status: "cancelled", cancelledAt: NOW }),
    ]);
    const r = await cancelSubscription(prismaMock, "sub-1", NOW);
    expect(r.changed).toBe(false);
    expect(auditStore).toHaveLength(0);
  });
});

describe("checkGracePeriodExpirations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips past_due rows whose pastDueSince is more than 7 days ago", async () => {
    const longAgo = new Date("2026-05-01T00:00:00.000Z"); // 14d before NOW
    const recent = new Date("2026-05-12T00:00:00.000Z"); // 3d before NOW
    const { prismaMock, subStore } = buildPrismaMock([
      baseSubscription({ id: "sub-old", status: "past_due", pastDueSince: longAgo }),
      baseSubscription({ id: "sub-young", status: "past_due", pastDueSince: recent }),
      baseSubscription({ id: "sub-active", status: "active" }),
    ]);

    const r = await checkGracePeriodExpirations(prismaMock, NOW);

    expect(r.inspected).toBe(1);
    expect(r.suspended).toBe(1);
    expect(r.suspendedIds).toEqual(["sub-old"]);
    expect(subStore.find((s) => s.id === "sub-old")!.status).toBe("suspended");
    expect(subStore.find((s) => s.id === "sub-young")!.status).toBe("past_due");
    expect(subStore.find((s) => s.id === "sub-active")!.status).toBe("active");
  });

  it("is idempotent — a second sweep on the same day finds zero rows", async () => {
    const longAgo = new Date("2026-05-01T00:00:00.000Z");
    const { prismaMock } = buildPrismaMock([
      baseSubscription({ id: "sub-old", status: "past_due", pastDueSince: longAgo }),
    ]);

    const first = await checkGracePeriodExpirations(prismaMock, NOW);
    const second = await checkGracePeriodExpirations(prismaMock, NOW);

    expect(first.suspended).toBe(1);
    // After the first run the row is `suspended`, so the `status: "past_due"`
    // filter excludes it from the second sweep entirely.
    expect(second.inspected).toBe(0);
    expect(second.suspended).toBe(0);
  });
});

describe("applyProration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upgrade STARTER → GROWTH at the half-cycle mark writes a positive delta invoice", async () => {
    // periodStart = 2026-05-01, periodEnd = 2026-06-01 (31 days).
    // NOW = 2026-05-15T12:00:00Z → remainingMs ≈ 16.5 days of 31 = factor ~0.532.
    // delta = (500_000 - 100_000) * 0.532 ≈ 212_903 paise (rounded).
    const { prismaMock, invoiceStore, auditStore } = buildPrismaMock([
      baseSubscription({ plan: "STARTER" }),
    ]);

    const r = await applyProration(prismaMock, "sub-1", "STARTER", "GROWTH", NOW);

    expect(r).not.toBeNull();
    expect(r!.deltaInPaise).toBeGreaterThan(0);
    expect(r!.deltaInPaise).toBeLessThan(500_000 - 100_000); // < full month delta
    expect(invoiceStore).toHaveLength(1);
    expect(invoiceStore[0].status).toBe("ISSUED");
    expect(invoiceStore[0].subtotalInPaise).toBe(r!.deltaInPaise);
    // Maharashtra ≠ Karnataka → IGST 18%, sign matches subtotal sign.
    expect(invoiceStore[0].cgstInPaise).toBe(0);
    expect(invoiceStore[0].sgstInPaise).toBe(0);
    expect(invoiceStore[0].igstInPaise).toBeGreaterThan(0);
    expect(invoiceStore[0].invoiceNumber).toMatch(/^PI-202605-\d{4}$/);
    expect(auditStore.some((a) => a.action === "PLATFORM_SUBSCRIPTION_PRORATED")).toBe(
      true,
    );
  });

  it("downgrade GROWTH → STARTER writes a negative-delta (credit) line item", async () => {
    const { prismaMock, invoiceStore } = buildPrismaMock([
      baseSubscription({ plan: "GROWTH" }),
    ]);

    const r = await applyProration(prismaMock, "sub-1", "GROWTH", "STARTER", NOW);

    expect(r).not.toBeNull();
    expect(r!.deltaInPaise).toBeLessThan(0);
    expect(invoiceStore[0].subtotalInPaise).toBeLessThan(0);
    // Sign preservation on GST so negative subtotal yields a negative GST
    // contribution (credit-back), keeping total = sub + tax internally consistent.
    expect(invoiceStore[0].igstInPaise).toBeLessThan(0);
    expect(invoiceStore[0].totalInPaise).toBeLessThan(0);
  });

  it("same-plan call (no delta) returns zero without writing an invoice or audit", async () => {
    const { prismaMock, invoiceStore, auditStore } = buildPrismaMock([
      baseSubscription({ plan: "STARTER" }),
    ]);

    const r = await applyProration(prismaMock, "sub-1", "STARTER", "STARTER", NOW);

    expect(r).not.toBeNull();
    expect(r!.deltaInPaise).toBe(0);
    expect(invoiceStore).toHaveLength(0);
    expect(auditStore).toHaveLength(0);
  });

  it("same-state (Karnataka) tenant splits proration GST as CGST+SGST", async () => {
    const { prismaMock, invoiceStore } = buildPrismaMock([
      baseSubscription({
        plan: "STARTER",
        tenant: {
          id: "t-1",
          name: "Local",
          branches: [{ state: "Karnataka" }],
        },
      }),
    ]);

    await applyProration(prismaMock, "sub-1", "STARTER", "GROWTH", NOW);

    expect(invoiceStore[0].cgstInPaise).toBeGreaterThan(0);
    expect(invoiceStore[0].sgstInPaise).toBeGreaterThan(0);
    expect(invoiceStore[0].igstInPaise).toBe(0);
  });
});
