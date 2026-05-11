// Unit tests for the claims reconciliation worker.
//
// Pure unit tests — we mock both `@medcore/db` and the adapter registry so the
// suite runs in milliseconds on any developer laptop (no Postgres required).
// Integration coverage against a real DB lives in
// `src/test/integration/insurance-claims.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AdapterResult,
  ClaimStatusOk,
  ClaimsAdapter,
} from "./adapter";

// ── Prisma mock ──────────────────────────────────────────────────────────
//
// Hoisted so the `vi.mock` factory below can reach the same object the test
// body uses.
const { prismaMock } = vi.hoisted(() => {
  const insuranceClaim2 = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const claimStatusEvent = {
    create: vi.fn(),
  };
  return {
    prismaMock: {
      insuranceClaim2,
      claimStatusEvent,
      $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
        fn({ insuranceClaim2, claimStatusEvent })
      ),
    } as any,
  };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));

// ── Adapter registry mock ────────────────────────────────────────────────

const { getAdapterMock } = vi.hoisted(() => ({
  getAdapterMock: vi.fn(),
}));

vi.mock("./registry", () => ({
  getAdapter: getAdapterMock,
}));

// Now that all module mocks are registered we can import the SUT.
import {
  reconcilePendingClaims,
  reconcileTerminalClaims,
  PENDING_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_TERMINAL_STALENESS_MS,
} from "./reconciliation";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a fake Prisma claim row with sensible defaults. */
function fakeClaim(overrides: Partial<any> = {}): any {
  return {
    id: overrides.id ?? "claim-1",
    billId: "bill-1",
    patientId: "pat-1",
    tpaProvider: "MOCK",
    providerClaimRef: "MOCK-REF-1",
    insurerName: "Star Health",
    policyNumber: "POL-1",
    memberId: null,
    preAuthRequestId: null,
    diagnosis: "Fever",
    icd10Codes: [],
    procedureName: null,
    admissionDate: null,
    dischargeDate: null,
    amountClaimed: 1000,
    amountApproved: null,
    status: "SUBMITTED",
    deniedReason: null,
    notes: null,
    submittedAt: new Date("2026-04-22T00:00:00Z"),
    approvedAt: null,
    settledAt: null,
    cancelledAt: null,
    lastSyncedAt: null,
    createdBy: "u1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function adapterReturning(
  res: AdapterResult<ClaimStatusOk>
): ClaimsAdapter {
  return {
    provider: "MOCK",
    submitClaim: vi.fn(),
    uploadDocument: vi.fn(),
    cancelClaim: vi.fn(),
    getClaimStatus: vi.fn(async () => res),
  } as unknown as ClaimsAdapter;
}

function statusOk(
  status: ClaimStatusOk["status"],
  extras: Partial<ClaimStatusOk> = {}
): AdapterResult<ClaimStatusOk> {
  return {
    ok: true,
    data: {
      providerRef: "MOCK-REF-1",
      status,
      lastUpdated: new Date().toISOString(),
      timeline: [],
      ...extras,
    },
  };
}

beforeEach(() => {
  prismaMock.insuranceClaim2.findMany.mockReset();
  prismaMock.insuranceClaim2.update.mockReset();
  prismaMock.claimStatusEvent.create.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn: any) =>
    fn({
      insuranceClaim2: prismaMock.insuranceClaim2,
      claimStatusEvent: prismaMock.claimStatusEvent,
    })
  );
  getAdapterMock.mockReset();
});

describe("reconcilePendingClaims", () => {
  it("skips claims whose lastSyncedAt is within the staleness window", async () => {
    // No candidates come back from findMany because the where-clause filters
    // out anything recently synced. We assert on the filter itself.
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    const now = new Date("2026-04-23T12:00:00Z");
    const result = await reconcilePendingClaims({ now });

    expect(result).toEqual({ checked: 0, updated: 0, errors: [] });

    const call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: [...PENDING_STATUSES] });
    expect(call.where.providerClaimRef).toEqual({ not: null });
    // Cutoff = now - 1h = 2026-04-23T11:00:00Z
    const expectedCutoff = new Date(now.getTime() - 60 * 60 * 1000);
    expect(call.where.OR).toEqual([
      { lastSyncedAt: null },
      { lastSyncedAt: { lt: expectedCutoff } },
    ]);
    // Adapter should never have been consulted.
    expect(getAdapterMock).not.toHaveBeenCalled();
  });

  it("writes a ClaimStatusEvent and patches the row when status changes", async () => {
    const claim = fakeClaim({ id: "claim-A", status: "SUBMITTED" });
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([claim]);
    prismaMock.insuranceClaim2.update.mockResolvedValue(claim);
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    getAdapterMock.mockReturnValue(
      adapterReturning(
        statusOk("APPROVED", { amountApproved: 900 })
      )
    );

    const now = new Date("2026-04-23T12:00:00Z");
    const result = await reconcilePendingClaims({ now });

    expect(result.checked).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.errors).toEqual([]);

    // Event was written with the new status.
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.claimId).toBe("claim-A");
    expect(evArgs.data.status).toBe("APPROVED");
    expect(evArgs.data.source).toBe("API");

    // Claim row patched with new status, amount, approvedAt, lastSyncedAt.
    const upArgs = prismaMock.insuranceClaim2.update.mock.calls[0][0];
    expect(upArgs.where).toEqual({ id: "claim-A" });
    expect(upArgs.data.status).toBe("APPROVED");
    expect(upArgs.data.amountApproved).toBe(900);
    expect(upArgs.data.approvedAt).toEqual(now);
    expect(upArgs.data.lastSyncedAt).toEqual(now);
  });

  it("collects adapter errors rather than letting them bubble", async () => {
    const claim = fakeClaim({ id: "claim-err" });
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([claim]);

    getAdapterMock.mockReturnValue({
      provider: "MOCK",
      submitClaim: vi.fn(),
      uploadDocument: vi.fn(),
      cancelClaim: vi.fn(),
      getClaimStatus: vi.fn(async () => ({
        ok: false,
        error: { code: "TPA_UNAVAILABLE", message: "upstream 503" },
      })),
    } as unknown as ClaimsAdapter);

    const result = await reconcilePendingClaims();

    expect(result.checked).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].claimId).toBe("claim-err");
    expect(result.errors[0].error).toMatch(/TPA_UNAVAILABLE/);
    // No event, no patch.
    expect(prismaMock.claimStatusEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.insuranceClaim2.update).not.toHaveBeenCalled();
  });

  it("handles a mixed batch: one updates, one stays, one fails", async () => {
    const a = fakeClaim({
      id: "a",
      providerClaimRef: "REF-A",
      status: "SUBMITTED",
    });
    const b = fakeClaim({
      id: "b",
      providerClaimRef: "REF-B",
      status: "IN_REVIEW",
    });
    const c = fakeClaim({
      id: "c",
      providerClaimRef: "REF-C",
      status: "SUBMITTED",
    });
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([a, b, c]);
    prismaMock.insuranceClaim2.update.mockResolvedValue({});
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    getAdapterMock.mockImplementation(() => ({
      provider: "MOCK",
      submitClaim: vi.fn(),
      uploadDocument: vi.fn(),
      cancelClaim: vi.fn(),
      // Dispatch off the providerRef we asked about.
      getClaimStatus: vi.fn(async (ref: string) => {
        if (ref === "REF-A") return statusOk("APPROVED"); // update
        if (ref === "REF-B") return statusOk("IN_REVIEW"); // no change
        return {
          ok: false as const,
          error: { code: "RATE_LIMITED" as const, message: "slow down" },
        };
      }),
    } as unknown as ClaimsAdapter));

    const result = await reconcilePendingClaims();

    expect(result.checked).toBe(3);
    expect(result.updated).toBe(1); // only A
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].claimId).toBe("c");

    // Exactly one status event — for A.
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
    expect(
      prismaMock.claimStatusEvent.create.mock.calls[0][0].data.claimId
    ).toBe("a");

    // Two update calls: A's transactional patch + B's lastSyncedAt-only bump.
    // C never reaches the update branch because the adapter errored.
    expect(prismaMock.insuranceClaim2.update).toHaveBeenCalledTimes(2);
    const updatedIds = prismaMock.insuranceClaim2.update.mock.calls
      .map((c: any) => c[0].where.id)
      .sort();
    expect(updatedIds).toEqual(["a", "b"]);
  });

  it("does not include claims in terminal statuses in the candidate set", async () => {
    // The worker itself just trusts the `where` filter — we assert it asks
    // for exactly the PENDING_STATUSES set so terminal statuses (APPROVED,
    // DENIED, SETTLED, CANCELLED, PARTIALLY_APPROVED) never reach the adapter.
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    await reconcilePendingClaims();

    const call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    const requestedStatuses = call.where.status.in as string[];
    expect(requestedStatuses).toContain("SUBMITTED");
    expect(requestedStatuses).toContain("IN_REVIEW");
    expect(requestedStatuses).toContain("QUERY_RAISED");
    expect(requestedStatuses).not.toContain("APPROVED");
    expect(requestedStatuses).not.toContain("DENIED");
    expect(requestedStatuses).not.toContain("SETTLED");
    expect(requestedStatuses).not.toContain("CANCELLED");
    expect(requestedStatuses).not.toContain("PARTIALLY_APPROVED");
  });

  it("bumps lastSyncedAt without writing an event when the status is unchanged", async () => {
    const claim = fakeClaim({ id: "same", status: "IN_REVIEW" });
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([claim]);
    prismaMock.insuranceClaim2.update.mockResolvedValue(claim);

    getAdapterMock.mockReturnValue(adapterReturning(statusOk("IN_REVIEW")));

    const now = new Date("2026-04-23T13:00:00Z");
    const result = await reconcilePendingClaims({ now });

    expect(result.updated).toBe(0);
    expect(prismaMock.claimStatusEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.insuranceClaim2.update).toHaveBeenCalledTimes(1);
    const args = prismaMock.insuranceClaim2.update.mock.calls[0][0];
    expect(args.data).toEqual({ lastSyncedAt: now });
  });
});

describe("reconcileTerminalClaims", () => {
  it("queries APPROVED/SETTLED/DENIED claims whose lastSyncedAt is older than 7 days", async () => {
    // A claim last synced 8 days ago — should qualify for the terminal sweep.
    const staleSyncedAt = new Date("2026-04-15T00:00:00Z");
    const staleClaim = fakeClaim({
      id: "stale-approved",
      status: "APPROVED",
      providerClaimRef: "REF-STALE",
      lastSyncedAt: staleSyncedAt,
    });
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([staleClaim]);
    prismaMock.insuranceClaim2.update.mockResolvedValue(staleClaim);
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    // TPA reports the claim was DENIED on audit — a late revision we'd miss
    // without the terminal sweep.
    getAdapterMock.mockReturnValue(adapterReturning(statusOk("DENIED")));

    const now = new Date("2026-04-23T12:00:00Z");
    const result = await reconcileTerminalClaims({ now });

    expect(result.checked).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.errors).toEqual([]);

    // where-clause asserts: only terminal statuses, providerRef not null,
    // lastSyncedAt-cutoff = now - 7 days.
    const call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    const requestedStatuses = call.where.status.in as string[];
    expect(requestedStatuses).toEqual(expect.arrayContaining([...TERMINAL_STATUSES]));
    expect(requestedStatuses).not.toContain("CANCELLED");
    expect(call.where.providerClaimRef).toEqual({ not: null });
    const expectedCutoff = new Date(now.getTime() - DEFAULT_TERMINAL_STALENESS_MS);
    expect(call.where.OR).toEqual([
      { lastSyncedAt: null },
      { lastSyncedAt: { lt: expectedCutoff } },
    ]);

    // Event + patch both written for the status change.
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.status).toBe("DENIED");
    expect(evArgs.data.claimId).toBe("stale-approved");
    expect(evArgs.data.note).toMatch(/Terminal sweep/);
  });

  it("skips terminal claims whose lastSyncedAt is within the 7-day window", async () => {
    // findMany returns empty because the where-clause filters them out —
    // we still inspect the filter to prove fresh claims aren't queried.
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    const now = new Date("2026-04-23T12:00:00Z");
    const result = await reconcileTerminalClaims({ now });

    expect(result).toEqual({ checked: 0, updated: 0, errors: [] });

    const call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    const expectedCutoff = new Date(now.getTime() - DEFAULT_TERMINAL_STALENESS_MS);
    expect(call.where.OR).toEqual([
      { lastSyncedAt: null },
      { lastSyncedAt: { lt: expectedCutoff } },
    ]);
    // Adapter should not be consulted when there are no stale candidates.
    expect(getAdapterMock).not.toHaveBeenCalled();
    expect(prismaMock.insuranceClaim2.update).not.toHaveBeenCalled();
  });

  it("respects the batch size cap via limitPerRun", async () => {
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    // Custom cap.
    await reconcileTerminalClaims({ limitPerRun: 25 });
    let call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    expect(call.take).toBe(25);

    prismaMock.insuranceClaim2.findMany.mockClear();
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    // Default cap: 100.
    await reconcileTerminalClaims();
    call = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });
});
