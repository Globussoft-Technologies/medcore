// PM-JAY (Ayushman Bharat) claims adapter.
//
// Implements the neutral `ClaimsAdapter` contract so PM-JAY behaves like any
// other TPA to the rest of the engine (registry, reconciliation poller, store).
// Two modes, chosen by the current tenant's `loadPmjayConfig().simulation`:
//   - SIMULATION (default when live creds are absent): a deterministic in-memory
//     TPA, mirroring `mock.ts`, so the full workflow is demoable/testable.
//   - LIVE: real HTTP to the SHA/TMS gateway, with the OAuth token supplied by
//     `../../pmjay/token-manager`. URLs are 100% env-driven (states differ), so
//     nothing is hardcoded here.
// Authentication lives entirely in the token manager — this file never touches
// client credentials.

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
import { loadPmjayConfig, PmjayConfig } from "../../pmjay/config";
import { getAccessToken, invalidateToken } from "../../pmjay/token-manager";

// ─── Simulated TPA-side state (mirror of mock.ts) ──────────────────────
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
    "PMJAY-" +
    crypto.createHash("sha256").update(internalId).digest("hex").slice(0, 12).toUpperCase()
  );
}

/**
 * PM-JAY TMS publishes its own status vocabulary; normalise to our canonical
 * set. Anything unrecognised defaults to IN_REVIEW (safe: keeps it in the
 * pending-poll set rather than prematurely marking it terminal).
 */
function mapPmjayStatus(raw: string): NormalisedClaimStatus {
  const s = String(raw || "").toUpperCase();
  if (s === "SUBMITTED" || s === "INITIATED" || s === "RECEIVED") return "SUBMITTED";
  if (s === "UNDER_PROCESS" || s === "PROCESSING" || s === "UNDER_REVIEW") return "IN_REVIEW";
  if (s === "QUERY" || s === "QUERY_RAISED" || s === "ENQUIRY") return "QUERY_RAISED";
  if (s === "APPROVED" || s === "PREAUTH_APPROVED") return "APPROVED";
  if (s === "PART_APPROVED" || s === "PARTIALLY_APPROVED") return "PARTIALLY_APPROVED";
  if (s === "REJECTED" || s === "DENIED" || s === "REPUDIATED") return "DENIED";
  if (s === "SETTLED" || s === "PAID" || s === "CLAIM_PAID") return "SETTLED";
  if (s === "CANCELLED" || s === "WITHDRAWN") return "CANCELLED";
  return "IN_REVIEW";
}

// ─── Live HTTP helper ──────────────────────────────────────────────────
/**
 * Authenticated fetch against the TMS gateway with one automatic
 * re-authentication on 401 and a small retry budget on transient failures.
 * Returns the parsed JSON body or an AdapterResult error.
 */
async function tmsFetch(
  cfg: PmjayConfig,
  path: string,
  init: { method: string; body?: unknown }
): Promise<AdapterResult<unknown>> {
  if (!cfg.urls.tms) {
    return {
      ok: false,
      error: { code: "AUTH_FAILED", message: "TPA_PMJAY_TMS_URL is not configured" },
    };
  }
  const url = `${cfg.urls.tms.replace(/\/$/, "")}${path}`;

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const tok = await getAccessToken(cfg);
    if (!tok.ok) {
      return { ok: false, error: { code: tok.code, message: tok.message } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${tok.token}`,
          "Content-Type": "application/json",
          ...(cfg.hospitalId ? { "X-Hospital-Id": cfg.hospitalId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        invalidateToken(cfg); // force re-auth on next attempt
        if (attempt < cfg.retries) continue;
        return { ok: false, error: { code: "AUTH_FAILED", message: "PM-JAY TMS rejected token" } };
      }
      if (resp.status === 404) {
        return { ok: false, error: { code: "NOT_FOUND", message: "Claim not found on TMS" } };
      }
      if (resp.status === 429) {
        if (attempt < cfg.retries) continue;
        return { ok: false, error: { code: "RATE_LIMITED", message: "PM-JAY TMS rate-limited" } };
      }
      if (resp.status >= 500) {
        if (attempt < cfg.retries) continue;
        return {
          ok: false,
          error: { code: "TPA_UNAVAILABLE", message: `PM-JAY TMS HTTP ${resp.status}` },
        };
      }
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          ok: false,
          error: {
            code: "BUSINESS_RULE",
            message: (json as { message?: string }).message || `PM-JAY TMS HTTP ${resp.status}`,
            providerRaw: json,
          },
        };
      }
      return { ok: true, data: json };
    } catch (err) {
      if (attempt < cfg.retries) continue;
      return {
        ok: false,
        error: {
          code: "TPA_UNAVAILABLE",
          message: `PM-JAY TMS network error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: { code: "TPA_UNAVAILABLE", message: "PM-JAY TMS unreachable" } };
}

// ─── Adapter ────────────────────────────────────────────────────────────
export const pmjayAdapter: ClaimsAdapter = {
  provider: "PMJAY",

  async submitClaim(input: ClaimSubmissionInput): Promise<AdapterResult<SubmitClaimOk>> {
    const cfg = await loadPmjayConfig();
    if (!cfg.enabled) {
      return { ok: false, error: { code: "TPA_UNAVAILABLE", message: "PM-JAY integration disabled" } };
    }
    if (input.amountClaimed <= 0) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "amountClaimed must be > 0" } };
    }

    if (cfg.simulation) {
      const providerRef = hashRef(input.internalClaimId);
      const now = new Date().toISOString();
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
      store.set(providerRef, {
        providerRef,
        internalClaimId: input.internalClaimId,
        amountClaimed: input.amountClaimed,
        status: "SUBMITTED",
        submittedAt: now,
        lastUpdated: now,
        timeline: [{ status: "SUBMITTED", timestamp: now, note: "PM-JAY claim received (simulated)" }],
        documents: [],
      });
      return {
        ok: true,
        data: { claimId: input.internalClaimId, providerRef, status: "SUBMITTED", submittedAt: now },
      };
    }

    // LIVE: POST the claim to TMS.
    const res = await tmsFetch(cfg, "/v1/claims", {
      method: "POST",
      body: {
        hospitalId: cfg.hospitalId,
        internalRef: input.internalClaimId,
        beneficiary: { name: input.patient.name, memberId: input.policy.memberId },
        cardNumber: input.policy.policyNumber,
        diagnosis: input.diagnosis,
        icd10: input.icd10Codes,
        packageCode: input.procedureName, // PM-JAY claims carry the package code
        preAuthNumber: input.preAuthorization?.claimReferenceNumber,
        admissionDate: input.admissionDate,
        dischargeDate: input.dischargeDate,
        amountClaimed: input.amountClaimed,
      },
    });
    if (!res.ok) return res;
    const body = res.data as { claimRef?: string; status?: string; submittedAt?: string };
    if (!body.claimRef) {
      return { ok: false, error: { code: "UNKNOWN", message: "PM-JAY response missing claimRef", providerRaw: body } };
    }
    return {
      ok: true,
      data: {
        claimId: input.internalClaimId,
        providerRef: body.claimRef,
        status: mapPmjayStatus(body.status ?? "SUBMITTED"),
        submittedAt: body.submittedAt ?? new Date().toISOString(),
      },
    };
  },

  async getClaimStatus(providerRef: string): Promise<AdapterResult<ClaimStatusOk>> {
    const cfg = await loadPmjayConfig();
    if (cfg.simulation) {
      const claim = store.get(providerRef);
      if (!claim) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No PM-JAY claim ${providerRef}` } };
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
    }

    const res = await tmsFetch(cfg, `/v1/claims/${encodeURIComponent(providerRef)}`, { method: "GET" });
    if (!res.ok) return res;
    const body = res.data as {
      status?: string;
      approvedAmount?: number;
      deniedReason?: string;
      lastUpdated?: string;
      events?: Array<{ status?: string; timestamp?: string; note?: string }>;
    };
    return {
      ok: true,
      data: {
        providerRef,
        status: mapPmjayStatus(body.status ?? "IN_REVIEW"),
        amountApproved: body.approvedAmount,
        deniedReason: body.deniedReason,
        lastUpdated: body.lastUpdated ?? new Date().toISOString(),
        timeline: (body.events ?? []).map((ev) => ({
          status: mapPmjayStatus(ev.status ?? "IN_REVIEW"),
          timestamp: ev.timestamp ?? new Date().toISOString(),
          note: ev.note,
        })),
      },
    };
  },

  async uploadDocument(
    providerRef: string,
    docType: ClaimDocumentType,
    buffer: Buffer,
    filename: string,
    _contentType: string
  ): Promise<AdapterResult<DocumentUploadOk>> {
    const cfg = await loadPmjayConfig();
    if (buffer.length === 0) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Empty document buffer" } };
    }

    if (cfg.simulation) {
      const claim = store.get(providerRef);
      if (!claim) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No PM-JAY claim ${providerRef}` } };
      }
      const providerDocId =
        "PMJAY-DOC-" +
        crypto
          .createHash("sha256")
          .update(providerRef + docType + buffer.length + claim.documents.length)
          .digest("hex")
          .slice(0, 10)
          .toUpperCase();
      const uploadedAt = new Date().toISOString();
      claim.documents.push({ providerDocId, docType, uploadedAt });
      claim.timeline.push({ status: claim.status, timestamp: uploadedAt, note: `Document uploaded: ${docType}` });
      claim.lastUpdated = uploadedAt;
      return { ok: true, data: { providerRef, providerDocId, docType, uploadedAt } };
    }

    const res = await tmsFetch(cfg, `/v1/claims/${encodeURIComponent(providerRef)}/documents`, {
      method: "POST",
      body: { type: docType, filename, contentBase64: buffer.toString("base64") },
    });
    if (!res.ok) return res;
    const body = res.data as { docId?: string; uploadedAt?: string };
    return {
      ok: true,
      data: {
        providerRef,
        providerDocId: body.docId ?? "PMJAY-DOC",
        docType,
        uploadedAt: body.uploadedAt ?? new Date().toISOString(),
      },
    };
  },

  async cancelClaim(providerRef: string, reason: string): Promise<AdapterResult<CancelOk>> {
    const cfg = await loadPmjayConfig();
    if (cfg.simulation) {
      const claim = store.get(providerRef);
      if (!claim) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No PM-JAY claim ${providerRef}` } };
      }
      if (claim.status === "SETTLED") {
        return { ok: false, error: { code: "BUSINESS_RULE", message: "Cannot cancel a settled claim" } };
      }
      const ts = new Date().toISOString();
      claim.status = "CANCELLED";
      claim.lastUpdated = ts;
      claim.timeline.push({ status: "CANCELLED", timestamp: ts, note: reason });
      return { ok: true, data: { providerRef, cancelledAt: ts } };
    }

    const res = await tmsFetch(cfg, `/v1/claims/${encodeURIComponent(providerRef)}/cancel`, {
      method: "POST",
      body: { reason },
    });
    if (!res.ok) return res;
    const body = res.data as { cancelledAt?: string };
    return { ok: true, data: { providerRef, cancelledAt: body.cancelledAt ?? new Date().toISOString() } };
  },
};

/**
 * @internal test-only escape hatch. Mirrors mock.ts `__mockInternals`. Guarded
 * by NODE_ENV so production code can't reset/force simulated TPA state.
 */
export const __pmjayInternals = {
  reset(): void {
    if (process.env.NODE_ENV !== "test") return;
    store.clear();
  },
  forceStatus(
    providerRef: string,
    status: NormalisedClaimStatus,
    opts: { amountApproved?: number; deniedReason?: string; note?: string } = {}
  ): boolean {
    if (process.env.NODE_ENV !== "test") return false;
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

// Exported for unit tests of the status mapper.
export const __internal = { mapPmjayStatus };
