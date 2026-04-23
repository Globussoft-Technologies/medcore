// Deterministic in-memory TPA adapter used by integration tests and the local
// dev environment. All responses are derived from a stable hash of the input
// so the same submission always yields the same providerRef / timestamps.
//
// The module also exposes `__mockState` helpers that tests use to seed
// specific scenarios (e.g. force a claim into DENIED or QUERY_RAISED).

import crypto from "crypto";
import {
  ClaimsAdapter,
  ClaimSubmissionInput,
  ClaimStatusOk,
  SubmitClaimOk,
  DocumentUploadOk,
  CancelOk,
  AdapterResult,
  NormalisedClaimStatus,
  ClaimDocumentType,
} from "../adapter";

interface StoredClaim {
  providerRef: string;
  internalClaimId: string;
  amountClaimed: number;
  status: NormalisedClaimStatus;
  amountApproved?: number;
  deniedReason?: string;
  submittedAt: string;
  lastUpdated: string;
  timeline: Array<{ status: NormalisedClaimStatus; timestamp: string; note?: string }>;
  documents: Array<{ providerDocId: string; docType: ClaimDocumentType; uploadedAt: string }>;
}

// Exposed for tests. Reset between suites via `resetMockState()`.
const store = new Map<string, StoredClaim>();

function hashRef(internalId: string): string {
  return (
    "MOCK-" +
    crypto
      .createHash("sha256")
      .update(internalId)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase()
  );
}

export function resetMockState(): void {
  store.clear();
}

/** Force a particular claim into a specific status — used to exercise branches in tests. */
export function forceStatus(
  providerRef: string,
  status: NormalisedClaimStatus,
  opts: { amountApproved?: number; deniedReason?: string; note?: string } = {}
): boolean {
  const claim = store.get(providerRef);
  if (!claim) return false;
  const ts = new Date().toISOString();
  claim.status = status;
  if (opts.amountApproved !== undefined) claim.amountApproved = opts.amountApproved;
  if (opts.deniedReason !== undefined) claim.deniedReason = opts.deniedReason;
  claim.lastUpdated = ts;
  claim.timeline.push({ status, timestamp: ts, note: opts.note });
  return true;
}

export const mockAdapter: ClaimsAdapter = {
  provider: "MOCK",

  async submitClaim(
    input: ClaimSubmissionInput
  ): Promise<AdapterResult<SubmitClaimOk>> {
    // Mock business-rule failures so tests can exercise the error path.
    if (input.amountClaimed <= 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "amountClaimed must be > 0",
        },
      };
    }
    if (input.policy.policyNumber === "DENY-ME") {
      return {
        ok: false,
        error: {
          code: "BUSINESS_RULE",
          message: "Policy is lapsed (test fixture)",
        },
      };
    }

    const providerRef = hashRef(input.internalClaimId);
    const now = new Date().toISOString();

    // Idempotency — a second call with the same internalClaimId returns the
    // existing record rather than creating a second one.
    const existing = store.get(providerRef);
    if (existing) {
      return {
        ok: true,
        data: {
          claimId: input.internalClaimId,
          providerRef,
          status: existing.status,
          submittedAt: existing.submittedAt,
        },
      };
    }

    const record: StoredClaim = {
      providerRef,
      internalClaimId: input.internalClaimId,
      amountClaimed: input.amountClaimed,
      status: "SUBMITTED",
      submittedAt: now,
      lastUpdated: now,
      timeline: [{ status: "SUBMITTED", timestamp: now, note: "Claim received" }],
      documents: [],
    };
    store.set(providerRef, record);

    return {
      ok: true,
      data: {
        claimId: input.internalClaimId,
        providerRef,
        status: "SUBMITTED",
        submittedAt: now,
      },
    };
  },

  async getClaimStatus(
    providerRef: string
  ): Promise<AdapterResult<ClaimStatusOk>> {
    const claim = store.get(providerRef);
    if (!claim) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `No claim with ref ${providerRef}` },
      };
    }
    return {
      ok: true,
      data: {
        providerRef: claim.providerRef,
        status: claim.status,
        amountApproved: claim.amountApproved,
        deniedReason: claim.deniedReason,
        lastUpdated: claim.lastUpdated,
        timeline: [...claim.timeline],
      },
    };
  },

  async uploadDocument(
    providerRef: string,
    docType: ClaimDocumentType,
    buffer: Buffer,
    _filename: string,
    _contentType: string
  ): Promise<AdapterResult<DocumentUploadOk>> {
    const claim = store.get(providerRef);
    if (!claim) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `No claim with ref ${providerRef}` },
      };
    }
    if (buffer.length === 0) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Empty document buffer" },
      };
    }
    const providerDocId =
      "DOC-" +
      crypto
        .createHash("sha256")
        .update(providerRef + docType + buffer.length + claim.documents.length)
        .digest("hex")
        .slice(0, 10)
        .toUpperCase();
    const uploadedAt = new Date().toISOString();
    claim.documents.push({ providerDocId, docType, uploadedAt });
    claim.timeline.push({
      status: claim.status,
      timestamp: uploadedAt,
      note: `Document uploaded: ${docType}`,
    });
    claim.lastUpdated = uploadedAt;
    return {
      ok: true,
      data: { providerRef, providerDocId, docType, uploadedAt },
    };
  },

  async cancelClaim(
    providerRef: string,
    reason: string
  ): Promise<AdapterResult<CancelOk>> {
    const claim = store.get(providerRef);
    if (!claim) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `No claim with ref ${providerRef}` },
      };
    }
    if (claim.status === "SETTLED") {
      return {
        ok: false,
        error: {
          code: "BUSINESS_RULE",
          message: "Cannot cancel a settled claim",
        },
      };
    }
    const ts = new Date().toISOString();
    claim.status = "CANCELLED";
    claim.lastUpdated = ts;
    claim.timeline.push({ status: "CANCELLED", timestamp: ts, note: reason });
    return { ok: true, data: { providerRef, cancelledAt: ts } };
  },
};
