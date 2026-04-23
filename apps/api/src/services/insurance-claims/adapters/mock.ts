// Deterministic in-memory TPA adapter used by integration tests and the local
// dev environment. All responses are derived from a stable hash of the input
// so the same submission always yields the same providerRef / timestamps.
//
// IMPORTANT: the `store` Map inside this file models the *TPA side* of the
// world — it is simulated state that lives with the mock adapter, NOT our
// own persistence. Our persistence is Prisma, accessed through
// `../store.ts`. The route handler is what bridges the two (submit → write
// row via store; sync → call adapter.getClaimStatus → write events via store).
//
// `forceStatus` and `resetMockState` used to be exported from here directly.
// They are now exposed only via the `__mockInternals` escape hatch below,
// which `../test-helpers.ts` wraps with a `NODE_ENV==='test'` guard so
// production code cannot accidentally call them.

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

/**
 * Escape hatch for the test-only helpers in `../test-helpers.ts`. Do NOT
 * import this directly from tests or production code — go through
 * `test-helpers.ts` so the `NODE_ENV === "test"` guard is enforced.
 *
 * @internal
 */
export const __mockInternals = {
  reset(): void {
    store.clear();
  },

  forceStatus(
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
  },
};

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
