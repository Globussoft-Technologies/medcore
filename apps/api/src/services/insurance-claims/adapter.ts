// Insurance TPA Claims — abstract adapter interface.
//
// The Indian insurance TPA market is fragmented: Medi Assist, Paramount, Vidal,
// FHPL, ICICI Lombard, Star Health, etc. each publish different (and often
// undocumented) REST or SOAP APIs. There is no single IRDAI-mandated wire
// standard — so we abstract the submission + status polling behind this
// interface and ship one concrete adapter per TPA.
//
// Each method returns a discriminated union (`{ ok: true, data }` | `{ ok: false, error }`)
// so route handlers can pattern-match on `result.ok` without throwing.

/** Minimum shape a caller must assemble before hitting `submitClaim`. */
export interface ClaimSubmissionInput {
  /** Our internal claim id (UUID) — we pass this as the providerRef on our side. */
  internalClaimId: string;
  /** Associated Invoice (a.k.a. "Bill") id for traceability. */
  invoiceId: string;
  /** Patient demographics required by every TPA. */
  patient: {
    name: string;
    dob?: string; // ISO date
    gender: "MALE" | "FEMALE" | "OTHER";
    phone?: string;
    address?: string;
  };
  /** Insurance policy metadata. */
  policy: {
    policyNumber: string;
    insurerName: string; // e.g. "Star Health & Allied"
    tpaProvider: TpaProvider;
    memberId?: string;
  };
  /** Optional linkage to an approved pre-authorization. */
  preAuthorization?: {
    requestNumber: string;
    claimReferenceNumber?: string;
    approvedAmount?: number;
  };
  /** Clinical details. */
  diagnosis: string;
  icd10Codes?: string[];
  procedureName?: string;
  admissionDate?: string; // ISO date — IPD only
  dischargeDate?: string; // ISO date — IPD only
  /** Amount the hospital is claiming (INR). */
  amountClaimed: number;
  /** Free-text notes for the TPA claims officer. */
  notes?: string;
}

/** All TPAs we currently model. Extendable. */
export type TpaProvider =
  | "MEDI_ASSIST"
  | "PARAMOUNT"
  | "VIDAL"
  | "FHPL"
  | "ICICI_LOMBARD"
  | "STAR_HEALTH"
  | "MOCK";

/** Normalised claim lifecycle status across all TPAs. */
export type NormalisedClaimStatus =
  | "SUBMITTED"
  | "IN_REVIEW"
  | "QUERY_RAISED" // TPA asked for more documents
  | "APPROVED"
  | "PARTIALLY_APPROVED"
  | "DENIED"
  | "SETTLED" // TPA paid the hospital
  | "CANCELLED";

export interface SubmitClaimOk {
  /** Our own claim id — echoed back so callers can correlate. */
  claimId: string;
  /** The TPA's reference number (we store this for all future lookups). */
  providerRef: string;
  status: NormalisedClaimStatus;
  submittedAt: string; // ISO datetime
}

export interface ClaimStatusOk {
  providerRef: string;
  status: NormalisedClaimStatus;
  amountApproved?: number;
  deniedReason?: string;
  lastUpdated: string; // ISO datetime
  /** Events ordered oldest → newest. */
  timeline: Array<{
    status: NormalisedClaimStatus;
    timestamp: string;
    note?: string;
  }>;
}

export interface DocumentUploadOk {
  providerRef: string;
  /** TPA-assigned document identifier (echo into our ClaimDocument table). */
  providerDocId: string;
  docType: ClaimDocumentType;
  uploadedAt: string;
}

export type ClaimDocumentType =
  | "DISCHARGE_SUMMARY"
  | "INVESTIGATION_REPORT"
  | "PRESCRIPTION"
  | "BILL"
  | "ID_PROOF"
  | "CONSENT_FORM"
  | "OTHER";

export interface CancelOk {
  providerRef: string;
  cancelledAt: string;
}

/** Standardised error shape from every adapter. */
export interface AdapterError {
  /** Machine-readable code. */
  code:
    | "AUTH_FAILED"
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "TPA_UNAVAILABLE"
    | "RATE_LIMITED"
    | "BUSINESS_RULE" // TPA rejected for a rules reason we got back
    | "UNKNOWN";
  message: string;
  /** Raw provider payload for debugging. NOT returned to end-users. */
  providerRaw?: unknown;
}

/** Discriminated-union return shape used by every adapter method. */
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AdapterError };

/**
 * Pluggable TPA adapter. Implementers translate MedCore's neutral claim shape
 * to whatever wire format the specific TPA expects, and normalise responses
 * back into {@link NormalisedClaimStatus} / the `*Ok` types above.
 */
export interface ClaimsAdapter {
  /** Human-readable name for logs / audit entries. */
  readonly provider: TpaProvider;

  /**
   * Submit a fresh claim. MUST be idempotent by `input.internalClaimId` — if
   * the caller retries after a network blip, implementers should return the
   * same `providerRef` rather than creating a duplicate on the TPA side.
   */
  submitClaim(input: ClaimSubmissionInput): Promise<AdapterResult<SubmitClaimOk>>;

  /** Fetch latest status + event timeline by our provider reference. */
  getClaimStatus(providerRef: string): Promise<AdapterResult<ClaimStatusOk>>;

  /** Upload a supporting document (we already stored the bytes in our own storage). */
  uploadDocument(
    providerRef: string,
    docType: ClaimDocumentType,
    buffer: Buffer,
    filename: string,
    contentType: string
  ): Promise<AdapterResult<DocumentUploadOk>>;

  /** Cancel / withdraw a claim. Not every TPA allows this — they will return BUSINESS_RULE. */
  cancelClaim(
    providerRef: string,
    reason: string
  ): Promise<AdapterResult<CancelOk>>;
}
