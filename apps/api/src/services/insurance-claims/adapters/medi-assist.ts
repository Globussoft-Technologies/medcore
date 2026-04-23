// Medi Assist adapter.
//
// STATUS: stubbed. Medi Assist's TPA portal publishes its API under NDA and
// currently only exposes a partner-sandbox at https://api.mediassist.in/ —
// real wiring needs:
//   - `TPA_MEDIASSIST_API_KEY`      — issued by Medi Assist partner on-boarding
//   - `TPA_MEDIASSIST_API_URL`      — defaults to their production base URL
//   - `TPA_MEDIASSIST_HOSPITAL_ID`  — the hospital's provider id on their network
//
// TODO(integration): flesh out HTTP calls once we receive the partner SDK.
//   Docs: https://api.mediassist.in/docs (partner portal, login required)
//   Endpoints we need to call:
//     POST /v2/claims                  → submit
//     GET  /v2/claims/{providerRef}    → status
//     POST /v2/claims/{providerRef}/docs  → multipart upload
//     POST /v2/claims/{providerRef}/cancel

import {
  ClaimsAdapter,
  ClaimSubmissionInput,
  AdapterResult,
  SubmitClaimOk,
  ClaimStatusOk,
  DocumentUploadOk,
  CancelOk,
  ClaimDocumentType,
  NormalisedClaimStatus,
} from "../adapter";

interface MediAssistConfig {
  apiKey: string;
  baseUrl: string;
  hospitalId: string;
}

function readConfig(): AdapterResult<MediAssistConfig> {
  const apiKey = process.env.TPA_MEDIASSIST_API_KEY;
  const hospitalId = process.env.TPA_MEDIASSIST_HOSPITAL_ID;
  const baseUrl =
    process.env.TPA_MEDIASSIST_API_URL || "https://api.mediassist.in";
  if (!apiKey || !hospitalId) {
    return {
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message:
          "Medi Assist credentials missing: set TPA_MEDIASSIST_API_KEY and TPA_MEDIASSIST_HOSPITAL_ID",
      },
    };
  }
  return { ok: true, data: { apiKey, baseUrl, hospitalId } };
}

/** Medi Assist uses non-standard status strings — map them to our canonical set. */
function mapMediAssistStatus(raw: string): NormalisedClaimStatus {
  const s = raw.toUpperCase();
  if (s === "RECEIVED" || s === "NEW") return "SUBMITTED";
  if (s === "UNDER_REVIEW" || s === "PROCESSING") return "IN_REVIEW";
  if (s === "QUERY" || s === "ADDITIONAL_DOCS_REQUIRED") return "QUERY_RAISED";
  if (s === "APPROVED") return "APPROVED";
  if (s === "PART_APPROVED") return "PARTIALLY_APPROVED";
  if (s === "REJECTED" || s === "DENIED") return "DENIED";
  if (s === "SETTLED" || s === "PAID") return "SETTLED";
  if (s === "CANCELLED" || s === "WITHDRAWN") return "CANCELLED";
  return "IN_REVIEW";
}

export const mediAssistAdapter: ClaimsAdapter = {
  provider: "MEDI_ASSIST",

  async submitClaim(
    _input: ClaimSubmissionInput
  ): Promise<AdapterResult<SubmitClaimOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): POST `${cfg.data.baseUrl}/v2/claims` with body
    //   {
    //     hospitalId, internalRef: input.internalClaimId,
    //     patient: { name, dob, gender }, policy: { number, memberId },
    //     diagnosis, icd10: input.icd10Codes, amount: input.amountClaimed,
    //     preAuthRef: input.preAuthorization?.claimReferenceNumber
    //   }
    // and `Authorization: Bearer ${cfg.data.apiKey}`.
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message:
          "Medi Assist live adapter is not wired yet — use the MOCK adapter for local dev",
      },
    };
  },

  async getClaimStatus(
    _providerRef: string
  ): Promise<AdapterResult<ClaimStatusOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): GET `${cfg.data.baseUrl}/v2/claims/${providerRef}`
    // Expected response: { status, approvedAmount?, deniedReason?, events: [{status, timestamp, note}] }
    // Call mapMediAssistStatus() on each `status` field.
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Medi Assist live adapter stub — status polling not implemented",
      },
    };
  },

  async uploadDocument(
    _providerRef: string,
    _docType: ClaimDocumentType,
    _buffer: Buffer,
    _filename: string,
    _contentType: string
  ): Promise<AdapterResult<DocumentUploadOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): multipart POST to `/v2/claims/${providerRef}/docs`
    // form fields: type=docType, file=<binary>
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Medi Assist live adapter stub — document upload not implemented",
      },
    };
  },

  async cancelClaim(
    _providerRef: string,
    _reason: string
  ): Promise<AdapterResult<CancelOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): POST `/v2/claims/${providerRef}/cancel` { reason }
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Medi Assist live adapter stub — cancel not implemented",
      },
    };
  },
};

// Exported for unit tests of the mapper.
export const __internal = { mapMediAssistStatus };
