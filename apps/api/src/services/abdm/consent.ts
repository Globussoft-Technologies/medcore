/**
 * ABDM Consent Manager integration.
 *
 * In ABDM, every health-record access is mediated by a signed consent
 * artefact issued by the Consent Manager (CM). The flow is:
 *
 *   1. HIU (us, as the requesting hospital) → Gateway: `consent/init`
 *      — includes purpose, HI-types, date range, requester info
 *   2. Gateway → CM → patient (via ABHA app): grants / denies the consent
 *   3. CM → Gateway → HIU callback: `consent/notify` with signed artefact
 *   4. Later: HIU uses the artefact to fetch data via the HIP's
 *      `health-information/request`
 *
 * We persist a `ConsentArtefact` row at step 1 (status REQUESTED) and flip
 * it to GRANTED / DENIED / REVOKED from the callback handler.
 *
 * Reference: ABDM HIE-CM v3 Consent APIs (Milestone 3) —
 *   POST /api/hiecm/consent/v3/request/init    (this file, requestConsent)
 *   POST /api/hiecm/consent/v3/request/status  (consentRequestStatus)
 *   POST /api/hiecm/consent/v3/fetch           (fetchConsentArtefact)
 * Async results arrive on our bridge callback URL at
 *   /consent/request/hiu/on-init | /on-status | /on-fetch.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@medcore/db";
import { abdmRequest, ABDMError } from "./client";

// ── Types ─────────────────────────────────────────────────────────────────

export type ConsentStatus = "REQUESTED" | "GRANTED" | "DENIED" | "REVOKED" | "EXPIRED";

export type ConsentHiType =
  | "OPConsultation"
  | "Prescription"
  | "DischargeSummary"
  | "DiagnosticReport"
  | "ImmunizationRecord"
  | "HealthDocumentRecord"
  | "WellnessRecord";

export const CONSENT_PURPOSES = [
  "CAREMGT", // Care Management
  "BTG",     // Break the Glass (emergency)
  "PUBHLTH", // Public Health
  "HPAYMT",  // Healthcare Payment
  "DSRCH",   // Disease Research
  "PATRQT",  // Patient (Self) Requested
] as const;
export type ConsentPurposeCode = (typeof CONSENT_PURPOSES)[number];

// v3 requires the exact human-readable `purpose.text` (ABDM rejects the code
// as text — see ABDM-9999 "Invalid purpose text"). These are the only accepted
// strings, keyed by our code.
const PURPOSE_TEXT: Record<ConsentPurposeCode, string> = {
  CAREMGT: "Care Management",
  BTG: "Break the Glass",
  PUBHLTH: "Public Health",
  HPAYMT: "Healthcare Payment",
  DSRCH: "Disease Specific Healthcare Research",
  PATRQT: "Self Requested",
};

export interface RequestConsentInput {
  patientId: string;
  hiuId: string;               // our HIU identifier, issued by ABDM
  purpose: ConsentPurposeCode;
  hiTypes: ConsentHiType[];
  abhaAddress: string;
  dateFrom: Date;              // HI data window start
  dateTo: Date;                // HI data window end
  expiresAt: Date;             // artefact expiry (dataEraseAt) — must be future
  requesterId: string;         // doctor/user registration id
  requesterName: string;
  /** Optional council-registry system URI for the requester identifier. */
  requesterSystem?: string;
}

export interface ConsentArtefactRecord {
  id: string;
  patientId: string;
  hiuId: string;
  purpose: string;
  status: ConsentStatus;
  artefact: unknown;
  expiresAt: Date;
  createdAt: Date;
}

// ── requestConsent ────────────────────────────────────────────────────────

/**
 * Step 1: create a consent request with the CM (v3). Persists a REQUESTED row
 * and fires `POST /api/hiecm/consent/v3/request/init`. The CM replies 202; the
 * granted artefact arrives asynchronously on our bridge callback
 * (`/consent/request/hiu/on-init` then `/on-notify`).
 */
export async function requestConsent(
  input: RequestConsentInput
): Promise<{ consentRequestId: string; localId: string }> {
  if (input.dateTo <= input.dateFrom) {
    throw new ABDMError("dateTo must be after dateFrom", 400);
  }
  if (input.expiresAt <= new Date()) {
    throw new ABDMError("expiresAt (dataEraseAt) must be a future date", 400);
  }
  if (input.hiTypes.length === 0) {
    throw new ABDMError("At least one hiType is required", 400);
  }

  const consentRequestId = crypto.randomUUID();

  // Store locally first so a subsequent webhook can always find us.
  const local = await prisma.consentArtefact.create({
    data: {
      id: consentRequestId,
      patientId: input.patientId,
      hiuId: input.hiuId,
      purpose: input.purpose,
      status: "REQUESTED",
      artefact: {
        hiTypes: input.hiTypes,
        abhaAddress: input.abhaAddress,
        dateFrom: input.dateFrom.toISOString(),
        dateTo: input.dateTo.toISOString(),
        requester: { id: input.requesterId, name: input.requesterName },
      },
      expiresAt: input.expiresAt,
    },
  });

  // v3 consent init — body is just the `consent` object. REQUEST-ID/TIMESTAMP
  // are sent as headers by the client, not in the body.
  await abdmRequest<void>({
    method: "POST",
    path: "/consent/v3/request/init",
    requestId: consentRequestId,
    body: {
      consent: {
        purpose: {
          text: PURPOSE_TEXT[input.purpose],
          code: input.purpose,
          refUri: "www.abdm.gov.in",
        },
        patient: { id: input.abhaAddress },
        hiu: { id: input.hiuId },
        hip: null,
        careContexts: null,
        requester: {
          name: input.requesterName,
          identifier: {
            type: "REGNO",
            value: input.requesterId,
            system: input.requesterSystem ?? "https://www.nmc.org.in",
          },
        },
        hiTypes: input.hiTypes,
        permission: {
          accessMode: "VIEW",
          dateRange: {
            from: input.dateFrom.toISOString(),
            to: input.dateTo.toISOString(),
          },
          dataEraseAt: input.expiresAt.toISOString(),
          frequency: { unit: "HOUR", value: 0, repeats: 0 },
        },
      },
    },
  });

  return { consentRequestId, localId: local.id };
}

// ── consentRequestStatus (v3) ───────────────────────────────────────────────

/**
 * Poll the CM for a consent request's status (v3). The synchronous reply is
 * 202; the actual status lands on the `/consent/request/hiu/on-status`
 * callback. Requires the X-HIU-ID header.
 */
export async function consentRequestStatus(
  consentRequestId: string,
  hiuId: string,
): Promise<void> {
  await abdmRequest<void>({
    method: "POST",
    path: "/consent/v3/request/status",
    requestId: crypto.randomUUID(),
    headers: { "X-HIU-ID": hiuId },
    body: { consentRequestId },
  });
}

// ── fetchConsentArtefact (v3) ───────────────────────────────────────────────

/**
 * Fetch the signed consent artefact by consentId (v3), once the patient has
 * GRANTED. 202 sync; the artefact arrives on `/consent/on-fetch`. Requires the
 * X-HIU-ID header.
 */
export async function fetchConsentArtefact(
  consentId: string,
  hiuId: string,
): Promise<void> {
  await abdmRequest<void>({
    method: "POST",
    path: "/consent/v3/fetch",
    requestId: crypto.randomUUID(),
    headers: { "X-HIU-ID": hiuId },
    body: { consentId },
  });
}

// ── getConsent ────────────────────────────────────────────────────────────

export async function getConsent(consentRequestId: string): Promise<ConsentArtefactRecord | null> {
  const row = await prisma.consentArtefact.findUnique({
    where: { id: consentRequestId },
  });
  if (!row) return null;
  return row as ConsentArtefactRecord;
}

// ── revokeConsent ─────────────────────────────────────────────────────────

/**
 * Revoke a previously-granted consent. Only works if the artefact is in
 * GRANTED state.
 *
 * NOTE (v3 migration): revoke is not part of the Milestone-3 Postman
 * collection, so the exact v3 path is unverified. Using the documented v3
 * consent revoke path; confirm against the CM spec before relying on it in
 * production. The local status flip still happens regardless.
 */
export async function revokeConsent(consentRequestId: string): Promise<void> {
  const row = await prisma.consentArtefact.findUnique({
    where: { id: consentRequestId },
  });
  if (!row) throw new ABDMError("Consent not found", 404);
  if (row.status !== "GRANTED") {
    throw new ABDMError(`Cannot revoke consent in state ${row.status}`, 409);
  }

  await abdmRequest<void>({
    method: "POST",
    path: "/consent/v3/revoke",
    requestId: crypto.randomUUID(),
    headers: { "X-HIU-ID": row.hiuId },
    body: {
      consents: [{ id: consentRequestId }],
    },
  });

  await prisma.consentArtefact.update({
    where: { id: consentRequestId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}

// ── Webhook handlers ──────────────────────────────────────────────────────

/**
 * Handle `consent/on-notify` / `hiu/consent-on-notify` callback.
 * `artefact` is the full signed consent artefact JSON returned by the CM.
 */
export async function handleConsentCallback(payload: {
  consentRequestId: string;
  status: "GRANTED" | "DENIED" | "EXPIRED" | "REVOKED";
  artefact?: unknown;
}): Promise<void> {
  const row = await prisma.consentArtefact.findUnique({
    where: { id: payload.consentRequestId },
  });
  if (!row) return; // unknown id — idempotent
  await prisma.consentArtefact.update({
    where: { id: payload.consentRequestId },
    data: {
      status: payload.status,
      artefact: (payload.artefact ?? row.artefact ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      grantedAt: payload.status === "GRANTED" ? new Date() : row.grantedAt,
    },
  });
}
