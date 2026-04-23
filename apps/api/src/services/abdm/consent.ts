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
 * Reference: ABDM Consent Manager APIs v0.5 — `/v0.5/consent-requests/*`.
 */

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
  "PATRQT",  // Patient Request
] as const;
export type ConsentPurposeCode = (typeof CONSENT_PURPOSES)[number];

export interface RequestConsentInput {
  patientId: string;
  hiuId: string;               // our HIU identifier, issued by ABDM
  purpose: ConsentPurposeCode;
  hiTypes: ConsentHiType[];
  abhaAddress: string;
  dateFrom: Date;              // HI data window start
  dateTo: Date;                // HI data window end
  expiresAt: Date;             // artefact expiry
  requesterId: string;         // doctor/user id requesting
  requesterName: string;
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
 * Step 1: create a consent request with the CM. Persists a REQUESTED row
 * and fires `POST /v0.5/consent-requests/init`. The CM replies 202; the
 * final artefact arrives asynchronously on `/gateway/callback`.
 */
export async function requestConsent(
  input: RequestConsentInput
): Promise<{ consentRequestId: string; localId: string }> {
  if (input.dateTo <= input.dateFrom) {
    throw new ABDMError("dateTo must be after dateFrom", 400);
  }
  if (input.expiresAt <= new Date()) {
    throw new ABDMError("expiresAt must be in the future", 400);
  }
  if (input.hiTypes.length === 0) {
    throw new ABDMError("At least one hiType is required", 400);
  }

  const consentRequestId = crypto.randomUUID();

  // Store locally first so a subsequent webhook can always find us.
  const local = await (prisma as any).consentArtefact.create({
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

  // Kick off the CM init.
  await abdmRequest<void>({
    method: "POST",
    path: "/v0.5/consent-requests/init",
    requestId: consentRequestId,
    body: {
      requestId: consentRequestId,
      timestamp: new Date().toISOString(),
      consent: {
        purpose: { text: input.purpose, code: input.purpose },
        patient: { id: input.abhaAddress },
        hiu: { id: input.hiuId },
        requester: { name: input.requesterName, identifier: { type: "REGNO", value: input.requesterId } },
        hiTypes: input.hiTypes,
        permission: {
          accessMode: "VIEW",
          dateRange: {
            from: input.dateFrom.toISOString(),
            to: input.dateTo.toISOString(),
          },
          dataEraseAt: input.expiresAt.toISOString(),
          frequency: { unit: "HOUR", value: 1, repeats: 0 },
        },
      },
    },
  });

  return { consentRequestId, localId: local.id };
}

// ── getConsent ────────────────────────────────────────────────────────────

export async function getConsent(consentRequestId: string): Promise<ConsentArtefactRecord | null> {
  const row = await (prisma as any).consentArtefact.findUnique({
    where: { id: consentRequestId },
  });
  if (!row) return null;
  return row as ConsentArtefactRecord;
}

// ── revokeConsent ─────────────────────────────────────────────────────────

/**
 * Revoke a previously-granted consent. Only works if the artefact is in
 * GRANTED state. Fires `POST /v0.5/consents/revoke` at the CM.
 */
export async function revokeConsent(consentRequestId: string): Promise<void> {
  const row = await (prisma as any).consentArtefact.findUnique({
    where: { id: consentRequestId },
  });
  if (!row) throw new ABDMError("Consent not found", 404);
  if (row.status !== "GRANTED") {
    throw new ABDMError(`Cannot revoke consent in state ${row.status}`, 409);
  }

  await abdmRequest<void>({
    method: "POST",
    path: "/v0.5/consents/revoke",
    requestId: crypto.randomUUID(),
    body: {
      consents: [{ id: consentRequestId }],
    },
  });

  await (prisma as any).consentArtefact.update({
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
  const row = await (prisma as any).consentArtefact.findUnique({
    where: { id: payload.consentRequestId },
  });
  if (!row) return; // unknown id — idempotent
  await (prisma as any).consentArtefact.update({
    where: { id: payload.consentRequestId },
    data: {
      status: payload.status,
      artefact: payload.artefact ?? row.artefact,
      grantedAt: payload.status === "GRANTED" ? new Date() : row.grantedAt,
    },
  });
}
