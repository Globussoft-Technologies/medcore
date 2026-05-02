// Unit tests for the Prisma-backed insurance-claims store.
//
// We mock @medcore/db using the same vi.hoisted pattern as
// reconciliation.test.ts so the suite runs with no database. The store has
// no state machine — `updateStatus` accepts any transition — but it MUST
// always write a `ClaimStatusEvent` audit row for the new status, which is
// the load-bearing invariant for compliance.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const insuranceClaim2 = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  };
  const claimStatusEvent = {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const claimDocument = {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    prismaMock: {
      insuranceClaim2,
      claimStatusEvent,
      claimDocument,
      $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
        fn({ insuranceClaim2, claimStatusEvent, claimDocument })
      ),
    } as any,
  };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  createClaim,
  getClaim,
  updateClaim,
  updateStatus,
  cancelClaim,
  syncFromProvider,
  addEvent,
  addDocument,
} from "./store";

function fakePrismaClaimRow(overrides: Partial<any> = {}): any {
  return {
    id: "c1",
    billId: "inv-1",
    patientId: "p1",
    tpaProvider: "MOCK",
    providerClaimRef: null,
    insurerName: "Star Health",
    policyNumber: "POL-1",
    memberId: "M-1",
    preAuthRequestId: null,
    diagnosis: "Pneumonia",
    icd10Codes: ["J18.9"],
    procedureName: null,
    admissionDate: null,
    dischargeDate: null,
    amountClaimed: 10000,
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

beforeEach(() => {
  prismaMock.insuranceClaim2.create.mockReset();
  prismaMock.insuranceClaim2.findUnique.mockReset();
  prismaMock.insuranceClaim2.findMany.mockReset();
  prismaMock.insuranceClaim2.update.mockReset();
  prismaMock.claimStatusEvent.create.mockReset();
  prismaMock.claimStatusEvent.findMany.mockReset();
  prismaMock.claimDocument.create.mockReset();
  prismaMock.claimDocument.findMany.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn: any) =>
    fn({
      insuranceClaim2: prismaMock.insuranceClaim2,
      claimStatusEvent: prismaMock.claimStatusEvent,
      claimDocument: prismaMock.claimDocument,
    })
  );
});

describe("createClaim", () => {
  it("persists a new claim with normalised ISO dates and array icd10Codes", async () => {
    prismaMock.insuranceClaim2.create.mockResolvedValue(
      fakePrismaClaimRow({ id: "new-1" })
    );

    const row = await createClaim({
      billId: "inv-1",
      patientId: "p1",
      tpaProvider: "MOCK",
      providerClaimRef: null,
      insurerName: "Star Health",
      policyNumber: "POL-1",
      memberId: null,
      preAuthRequestId: null,
      diagnosis: "Fever",
      icd10Codes: ["A01"],
      procedureName: null,
      admissionDate: null,
      dischargeDate: null,
      amountClaimed: 1000,
      amountApproved: null,
      status: "SUBMITTED",
      deniedReason: null,
      notes: null,
      submittedAt: new Date().toISOString(),
      approvedAt: null,
      settledAt: null,
      cancelledAt: null,
      lastSyncedAt: null,
      createdBy: "u1",
    });

    expect(row.id).toBe("new-1");
    expect(row.icd10Codes).toEqual(["J18.9"]); // returned from fakePrismaClaimRow default
    expect(prismaMock.insuranceClaim2.create).toHaveBeenCalledTimes(1);
    const args = prismaMock.insuranceClaim2.create.mock.calls[0][0];
    expect(args.data.icd10Codes).toEqual(["A01"]);
    expect(args.data.submittedAt).toBeInstanceOf(Date);
  });
});

describe("getClaim", () => {
  it("returns undefined when no row exists", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(null);
    const row = await getClaim("missing");
    expect(row).toBeUndefined();
  });

  it("normalises Date columns to ISO strings", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(
      fakePrismaClaimRow({ submittedAt: new Date("2026-04-22T00:00:00Z") })
    );
    const row = await getClaim("c1");
    expect(row?.submittedAt).toBe("2026-04-22T00:00:00.000Z");
  });

  it("normalises null icd10Codes to an empty array", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(
      fakePrismaClaimRow({ icd10Codes: null })
    );
    const row = await getClaim("c1");
    expect(row?.icd10Codes).toEqual([]);
  });
});

describe("updateClaim", () => {
  it("returns undefined when the row doesn't exist", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(null);
    const row = await updateClaim("missing", { amountClaimed: 5000 });
    expect(row).toBeUndefined();
    expect(prismaMock.insuranceClaim2.update).not.toHaveBeenCalled();
  });

  it("only sends defined patch fields to Prisma", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(fakePrismaClaimRow());
    prismaMock.insuranceClaim2.update.mockResolvedValue(
      fakePrismaClaimRow({ amountClaimed: 5000 })
    );

    await updateClaim("c1", { amountClaimed: 5000 });

    const args = prismaMock.insuranceClaim2.update.mock.calls[0][0];
    expect(Object.keys(args.data)).toEqual(["amountClaimed"]);
    expect(args.data.amountClaimed).toBe(5000);
  });
});

describe("updateStatus — audit-row contract", () => {
  it("writes a ClaimStatusEvent row alongside the status update", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(fakePrismaClaimRow());
    prismaMock.insuranceClaim2.update.mockResolvedValue(
      fakePrismaClaimRow({ status: "APPROVED" })
    );
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    const r = await updateStatus("c1", {
      status: "APPROVED",
      amountApproved: 9000,
      approvedAt: "2026-04-30T12:00:00.000Z",
      note: "TPA approved",
      source: "WEBHOOK",
      createdBy: "system",
    });

    expect(r?.status).toBe("APPROVED");
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.claimId).toBe("c1");
    expect(evArgs.data.status).toBe("APPROVED");
    expect(evArgs.data.note).toBe("TPA approved");
    expect(evArgs.data.source).toBe("WEBHOOK");
    expect(evArgs.data.createdBy).toBe("system");

    const upArgs = prismaMock.insuranceClaim2.update.mock.calls[0][0];
    expect(upArgs.data.status).toBe("APPROVED");
    expect(upArgs.data.amountApproved).toBe(9000);
  });

  it("returns undefined and writes nothing when the claim doesn't exist", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(null);
    const r = await updateStatus("missing", { status: "APPROVED" });
    expect(r).toBeUndefined();
    expect(prismaMock.insuranceClaim2.update).not.toHaveBeenCalled();
    expect(prismaMock.claimStatusEvent.create).not.toHaveBeenCalled();
  });

  it("defaults source to API when not specified", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(fakePrismaClaimRow());
    prismaMock.insuranceClaim2.update.mockResolvedValue(
      fakePrismaClaimRow({ status: "IN_REVIEW" })
    );
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    await updateStatus("c1", { status: "IN_REVIEW" });

    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.source).toBe("API");
  });
});

describe("cancelClaim", () => {
  it("transitions to CANCELLED with reason captured in the audit event", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(fakePrismaClaimRow());
    prismaMock.insuranceClaim2.update.mockResolvedValue(
      fakePrismaClaimRow({ status: "CANCELLED" })
    );
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    const r = await cancelClaim("c1", "duplicate submission", { createdBy: "u1" });

    expect(r?.status).toBe("CANCELLED");
    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.status).toBe("CANCELLED");
    expect(evArgs.data.note).toBe("duplicate submission");
    expect(evArgs.data.source).toBe("MANUAL");
    expect(evArgs.data.createdBy).toBe("u1");

    const upArgs = prismaMock.insuranceClaim2.update.mock.calls[0][0];
    expect(upArgs.data.status).toBe("CANCELLED");
    expect(upArgs.data.cancelledAt).toBeInstanceOf(Date);
  });
});

describe("syncFromProvider — timeline dedup", () => {
  it("only inserts events not already present (status+timestamp key)", async () => {
    prismaMock.insuranceClaim2.findUnique.mockResolvedValue(fakePrismaClaimRow());
    prismaMock.insuranceClaim2.update.mockResolvedValue(
      fakePrismaClaimRow({ status: "APPROVED" })
    );
    prismaMock.claimStatusEvent.findMany.mockResolvedValue([
      { status: "SUBMITTED", timestamp: new Date("2026-04-22T00:00:00Z") },
    ]);
    prismaMock.claimStatusEvent.create.mockResolvedValue({});

    await syncFromProvider("c1", {
      patch: { status: "APPROVED" },
      timeline: [
        { status: "SUBMITTED", timestamp: "2026-04-22T00:00:00.000Z" }, // dup
        { status: "APPROVED", timestamp: "2026-04-25T00:00:00.000Z" }, // new
      ],
    });

    // Only the APPROVED event should have been inserted.
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
    const evArgs = prismaMock.claimStatusEvent.create.mock.calls[0][0];
    expect(evArgs.data.status).toBe("APPROVED");
  });
});

describe("addEvent / addDocument", () => {
  it("addEvent forwards the row to prisma.claimStatusEvent.create", async () => {
    prismaMock.claimStatusEvent.create.mockResolvedValue({
      id: "ev-1",
      claimId: "c1",
      status: "IN_REVIEW",
      note: null,
      source: "API",
      createdBy: null,
      timestamp: new Date(),
    });

    const ev = await addEvent({
      claimId: "c1",
      status: "IN_REVIEW",
      note: null,
      source: "API",
      createdBy: null,
    });
    expect(ev.claimId).toBe("c1");
    expect(prismaMock.claimStatusEvent.create).toHaveBeenCalledTimes(1);
  });

  it("addDocument forwards the row to prisma.claimDocument.create", async () => {
    prismaMock.claimDocument.create.mockResolvedValue({
      id: "doc-1",
      claimId: "c1",
      type: "BILL",
      fileKey: "k",
      filename: "bill.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      providerDocId: null,
      uploadedBy: "u1",
      uploadedAt: new Date(),
    });

    const doc = await addDocument({
      claimId: "c1",
      type: "BILL",
      fileKey: "k",
      filename: "bill.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      providerDocId: null,
      uploadedBy: "u1",
    });
    expect(doc.claimId).toBe("c1");
    expect(doc.type).toBe("BILL");
  });
});
