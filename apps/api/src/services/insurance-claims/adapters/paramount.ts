// Paramount Health Services (Paramount TPA) adapter.
//
// STATUS: stubbed. Paramount exposes a legacy SOAP+XML service at
// https://www.paramounttpa.com/ and a newer REST gateway that requires
// partner on-boarding. Env vars:
//   - `TPA_PARAMOUNT_API_KEY`       — HMAC signing key (not a bearer token)
//   - `TPA_PARAMOUNT_CLIENT_CODE`   — hospital client code on the Paramount network
//   - `TPA_PARAMOUNT_API_URL`       — defaults to production REST base
//
// TODO(integration): Paramount signs requests with HMAC-SHA256 over
//   `${method}\n${path}\n${timestamp}\n${body}` using `TPA_PARAMOUNT_API_KEY`.
//   Docs: https://paramounttpa.com/api-docs (request access via
//   provider-support@paramounttpa.com).

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

interface ParamountConfig {
  apiKey: string;
  clientCode: string;
  baseUrl: string;
}

function readConfig(): AdapterResult<ParamountConfig> {
  const apiKey = process.env.TPA_PARAMOUNT_API_KEY;
  const clientCode = process.env.TPA_PARAMOUNT_CLIENT_CODE;
  const baseUrl =
    process.env.TPA_PARAMOUNT_API_URL || "https://api.paramounttpa.com";
  if (!apiKey || !clientCode) {
    return {
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message:
          "Paramount credentials missing: set TPA_PARAMOUNT_API_KEY and TPA_PARAMOUNT_CLIENT_CODE",
      },
    };
  }
  return { ok: true, data: { apiKey, clientCode, baseUrl } };
}

/**
 * Paramount uses numeric status codes internally. Keep the mapper in one place
 * so the wire changes don't ripple through the routes.
 */
function mapParamountStatus(raw: string | number): NormalisedClaimStatus {
  const s = String(raw).toUpperCase();
  switch (s) {
    case "1":
    case "SUBMITTED":
      return "SUBMITTED";
    case "2":
    case "IN_PROCESS":
      return "IN_REVIEW";
    case "3":
    case "QUERY":
      return "QUERY_RAISED";
    case "4":
    case "APPROVED":
      return "APPROVED";
    case "5":
    case "PART_APPROVED":
      return "PARTIALLY_APPROVED";
    case "6":
    case "REJECTED":
      return "DENIED";
    case "7":
    case "SETTLED":
      return "SETTLED";
    case "8":
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "IN_REVIEW";
  }
}

export const paramountAdapter: ClaimsAdapter = {
  provider: "PARAMOUNT",

  async submitClaim(
    _input: ClaimSubmissionInput
  ): Promise<AdapterResult<SubmitClaimOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): POST `${cfg.data.baseUrl}/rest/v1/claims/submit`
    // Body is Paramount-shaped: { clientCode, claimRef, member: {...}, amt, diag }.
    // Headers:  X-Client-Code, X-Timestamp, X-Signature (HMAC-SHA256 of canonical string).
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message:
          "Paramount live adapter is not wired yet — use the MOCK adapter for local dev",
      },
    };
  },

  async getClaimStatus(
    _providerRef: string
  ): Promise<AdapterResult<ClaimStatusOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): GET `${cfg.data.baseUrl}/rest/v1/claims/${providerRef}/status`
    // Feed `status` field through mapParamountStatus().
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Paramount live adapter stub — status polling not implemented",
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
    // TODO(integration): multipart POST `/rest/v1/claims/${providerRef}/documents`
    // Paramount expects their own docType code — build a map once we have docs.
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Paramount live adapter stub — document upload not implemented",
      },
    };
  },

  async cancelClaim(
    _providerRef: string,
    _reason: string
  ): Promise<AdapterResult<CancelOk>> {
    const cfg = readConfig();
    if (!cfg.ok) return cfg;
    // TODO(integration): POST `/rest/v1/claims/${providerRef}/withdraw` { reason }
    return {
      ok: false,
      error: {
        code: "TPA_UNAVAILABLE",
        message: "Paramount live adapter stub — cancel not implemented",
      },
    };
  },
};

export const __internal = { mapParamountStatus };
