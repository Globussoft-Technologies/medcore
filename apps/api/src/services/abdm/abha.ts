/**
 * ABHA (Ayushman Bharat Health Account) operations.
 *
 * An ABHA identity has two forms:
 *   • ABHA number — 14-digit numeric ID (e.g. "12-3456-7890-1234")
 *   • ABHA address — human-readable handle (e.g. "sumit@abdm" / "sumit@sbx")
 *
 * This module covers the "HIP" (Health Information Provider) side of the
 * ABDM spec: verifying that an address/number exists, linking it to a local
 * MedCore patient record, and de-linking on patient request.
 *
 * The actual gateway exchanges are asynchronous — ABDM replies 202 and
 * pushes the result to our `POST /abdm/gateway/callback` webhook.
 * We therefore persist an `AbhaLink` row in state PENDING up front and move
 * it to VERIFIED / LINKED / FAILED from the webhook handler.
 *
 * Stubs clearly marked below need the real ABDM response payload shapes,
 * which are fully documented in the ABDM HIP Facility API Spec (v2.5).
 */

import { prisma } from "@medcore/db";
import { abdmRequest, ABDMError } from "./client";

// ── Validators ────────────────────────────────────────────────────────────

const ABHA_NUMBER_RE = /^\d{2}-\d{4}-\d{4}-\d{4}$/;
const ABHA_ADDRESS_RE = /^[a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9]+$/;

export function isValidAbhaNumber(n: string): boolean {
  return ABHA_NUMBER_RE.test(n);
}

export function isValidAbhaAddress(a: string): boolean {
  return ABHA_ADDRESS_RE.test(a);
}

/**
 * Validate the 14-digit ABHA number using the Verhoeff checksum algorithm.
 * ABDM uses Verhoeff for ABHA numbers, identical to Aadhaar.
 */
export function isAbhaChecksumValid(n: string): boolean {
  if (!ABHA_NUMBER_RE.test(n)) return false;
  const digits = n.replace(/-/g, "").split("").map(Number);
  // Verhoeff tables
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];
  let c = 0;
  const reversed = digits.reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = d[c][p[i % 8][reversed[i]]];
  }
  return c === 0;
}

// ── Types ─────────────────────────────────────────────────────────────────

export type AbhaLinkStatus = "PENDING" | "VERIFIED" | "LINKED" | "REVOKED" | "FAILED";

export interface VerifyAbhaInput {
  abhaAddress?: string;
  abhaNumber?: string;
}

export interface VerifyAbhaResult {
  ok: boolean;
  abhaAddress?: string;
  abhaNumber?: string;
  name?: string;
  gender?: string;
  yearOfBirth?: number;
  /** Correlation id to match against the async webhook response. */
  requestId: string;
  /** True when the sandbox couldn't confirm the ABHA (404/unavailable) but we
   *  allow the link to proceed for local testing. */
  unverified?: boolean;
  /** Human-readable note shown to the operator when unverified. */
  note?: string;
}

// ── ABHA mobile-OTP verify (real 2-step flow) ─────────────────────────────
//
// The correct ABDM ABHA identity check is a 2-step OTP handshake (NOT the
// version-shifted `existsByHealthId` endpoint, which the gateway/mock returns
// 404 for):
//   1. POST /v0.5/users/auth/init { healthid }       → { transactionId }
//      (gateway sends an OTP to the ABHA holder's registered mobile)
//   2. POST /v0.5/users/auth/confirmWithMobileOtp { transactionId, otp }
//      → the verified ABHA profile.
// Against the bundled mock server (scripts/abdm-mock-server.ts): any
// `<x>@abdm` address is accepted at init, and OTP `123456` confirms.

export interface SendAbhaOtpResult {
  transactionId: string;
  requestId: string;
}

/** Step 1 — request an OTP for an ABHA address. */
export async function sendAbhaAuthOtp(abhaAddress: string): Promise<SendAbhaOtpResult> {
  if (!isValidAbhaAddress(abhaAddress)) {
    throw new ABDMError("ABHA address must be handle@domain", 400);
  }
  const requestId = crypto.randomUUID();
  const resp = await abdmRequest<{
    authInitResponse?: { transactionId?: string };
    transactionId?: string;
  }>({
    method: "POST",
    path: "/v0.5/users/auth/init",
    requestId,
    body: { healthid: abhaAddress, authMode: "MOBILE_OTP", purpose: "KYC_AND_LINK" },
  });
  const transactionId =
    resp?.authInitResponse?.transactionId ?? resp?.transactionId ?? "";
  if (!transactionId) {
    throw new ABDMError("ABDM did not return a transactionId for the OTP", 502);
  }
  return { transactionId, requestId };
}

/** Step 2 — confirm the OTP and resolve the verified ABHA profile. */
export async function confirmAbhaOtp(input: {
  transactionId: string;
  otp: string;
  abhaAddress?: string;
}): Promise<VerifyAbhaResult> {
  if (!input.transactionId) throw new ABDMError("transactionId is required", 400);
  if (!/^\d{4,8}$/.test(input.otp)) throw new ABDMError("OTP must be 4–8 digits", 400);
  const requestId = crypto.randomUUID();
  const resp = await abdmRequest<{
    id?: string;
    fullName?: string;
    name?: string;
    gender?: string;
    yearOfBirth?: number;
    abhaAddress?: string;
    healthIdNumber?: string;
  }>({
    method: "POST",
    path: "/v0.5/users/auth/confirmWithMobileOtp",
    requestId,
    body: {
      transactionId: input.transactionId,
      otp: input.otp,
      healthid: input.abhaAddress,
    },
  });
  return {
    ok: true,
    abhaAddress: resp?.abhaAddress ?? input.abhaAddress,
    abhaNumber: resp?.healthIdNumber,
    name: resp?.fullName ?? resp?.name,
    gender: resp?.gender,
    yearOfBirth: resp?.yearOfBirth,
    requestId,
  };
}

// ── verifyAbha ────────────────────────────────────────────────────────────

/**
 * Ask the ABDM Gateway to confirm an ABHA identifier exists.
 *
 * Implementation note: the gateway's "exists" check is
 * `POST /v0.5/users/auth/init` with `authMode=DEMOGRAPHICS|MOBILE_OTP`.
 * For a simple existence check the sandbox also accepts a short-circuit
 * `POST /v1/search/existsByHealthId`. Both are wired below; we prefer the
 * existsByHealthId endpoint when an ABHA number is provided because it
 * does not trigger an OTP.
 */
export async function verifyAbha(input: VerifyAbhaInput): Promise<VerifyAbhaResult> {
  if (!input.abhaAddress && !input.abhaNumber) {
    throw new ABDMError("Provide either abhaAddress or abhaNumber", 400);
  }
  if (input.abhaNumber && !isValidAbhaNumber(input.abhaNumber)) {
    throw new ABDMError("ABHA number must match 99-9999-9999-9999 format", 400);
  }
  if (input.abhaNumber && !isAbhaChecksumValid(input.abhaNumber)) {
    throw new ABDMError("ABHA number failed Verhoeff checksum", 400);
  }
  if (input.abhaAddress && !isValidAbhaAddress(input.abhaAddress)) {
    throw new ABDMError("ABHA address must be handle@domain", 400);
  }

  const requestId = crypto.randomUUID();

  // The ABHA existence-check API lives on the ABDM HEALTHID service at the
  // BASE url (e.g. https://dev.abdm.gov.in/api/v1/search/existsByHealthId) —
  // NOT under the /gateway prefix that abdmRequest prepends by default. Build
  // the absolute URL off ABDM_BASE_URL so the call reaches the right service.
  // (Hitting /gateway/v1/search/existsByHealthId returns a 404 "no matching
  // resource", which is the symptom this fixes.)
  const base = (process.env.ABDM_BASE_URL ?? "https://dev.abdm.gov.in").replace(
    /\/$/,
    "",
  );
  const searchUrl = `${base}/api/v1/search/existsByHealthId`;

  try {
    const resp = await abdmRequest<{
      status?: "ACTIVE" | "INACTIVE" | string;
      name?: string;
      gender?: string;
      yearOfBirth?: number;
      healthIdNumber?: string;
      healthId?: string;
    }>({
      method: "POST",
      path: searchUrl,
      absoluteUrl: true,
      requestId,
      body: input.abhaNumber
        ? { healthIdNumber: input.abhaNumber }
        : { healthId: input.abhaAddress },
    });

    return {
      ok: (resp?.status ?? "ACTIVE") === "ACTIVE",
      abhaAddress: resp?.healthId ?? input.abhaAddress,
      abhaNumber: resp?.healthIdNumber ?? input.abhaNumber,
      name: resp?.name,
      gender: resp?.gender,
      yearOfBirth: resp?.yearOfBirth,
      requestId,
    };
  } catch (err) {
    // Graceful sandbox degradation. The ABDM sandbox frequently returns 404
    // for ABHA addresses that don't exist in the staging directory (and the
    // search endpoint itself is version-sensitive). In a NON-production env we
    // don't want a 404 to block local testing of the link flow — we surface an
    // `ok:false, unverified:true` result the route maps to a clear message and
    // still allows "Link to patient". In production we re-throw so a real
    // verification failure is honest.
    const status = err instanceof ABDMError ? err.statusCode : 0;
    const isSandbox = process.env.ABDM_CM_ID !== "ndhm" && process.env.NODE_ENV !== "production";
    if (isSandbox && (status === 404 || status === 503)) {
      return {
        ok: false,
        unverified: true,
        abhaAddress: input.abhaAddress,
        abhaNumber: input.abhaNumber,
        requestId,
        note: "ABHA could not be verified against the ABDM sandbox (not found / endpoint unavailable). You can still link it for local testing.",
      } as VerifyAbhaResult;
    }
    throw err;
  }
}

// ── linkAbha ──────────────────────────────────────────────────────────────

export interface LinkAbhaInput {
  patientId: string;
  abhaAddress: string;
  abhaNumber?: string;
  /** Pre-verified ABHA profile — if not supplied, verifyAbha is called. */
  verified?: VerifyAbhaResult;
}

/**
 * Link an ABHA identity to a MedCore patient. Creates an `AbhaLink` row in
 * state PENDING and fires `POST /v0.5/links/link/init` to the gateway.
 * The gateway answers with 202 and later POSTs the outcome to our webhook
 * (see routes/abdm.ts → /gateway/callback).
 */
export async function linkAbha(input: LinkAbhaInput): Promise<{ linkId: string; requestId: string }> {
  if (!isValidAbhaAddress(input.abhaAddress)) {
    throw new ABDMError("Invalid ABHA address", 400);
  }
  if (input.abhaNumber && !isValidAbhaNumber(input.abhaNumber)) {
    throw new ABDMError("Invalid ABHA number", 400);
  }

  const verified = input.verified ?? (await verifyAbha({
    abhaAddress: input.abhaAddress,
    abhaNumber: input.abhaNumber,
  }));

  // Block linking only on a genuine verification failure. A sandbox-degraded
  // result (`unverified` — the ABDM staging directory couldn't confirm) is
  // allowed through so local testing of the link flow isn't blocked; the
  // AbhaLink row simply starts PENDING as usual.
  if (!verified.ok && !verified.unverified) {
    throw new ABDMError("ABHA identity could not be verified", 404);
  }

  const requestId = crypto.randomUUID();
  // Persist a PENDING link record — the webhook flips it to LINKED.
  const link = await prisma.abhaLink.create({
    data: {
      patientId: input.patientId,
      abhaAddress: verified.abhaAddress ?? input.abhaAddress,
      abhaNumber: verified.abhaNumber ?? input.abhaNumber ?? null,
      status: "PENDING",
      requestId,
    },
  });

  // Kick off the async link flow on the Gateway.
  await abdmRequest<void>({
    method: "POST",
    path: "/v0.5/links/link/init",
    requestId,
    body: {
      requestId,
      timestamp: new Date().toISOString(),
      patient: {
        id: verified.abhaAddress ?? input.abhaAddress,
        referenceNumber: input.patientId,
        careContexts: [],
      },
    },
  });

  return { linkId: link.id, requestId };
}

// ── delinkAbha ────────────────────────────────────────────────────────────

/**
 * De-link (revoke) an ABHA from a patient. We keep the row for audit and
 * set status=REVOKED. ABDM does not require a Gateway call to forget the
 * binding on our side — HIU simply stops advertising care-contexts for that
 * ABHA.
 */
export async function delinkAbha(patientId: string, abhaAddress: string): Promise<void> {
  const existing = await prisma.abhaLink.findFirst({
    where: { patientId, abhaAddress, status: { in: ["LINKED", "VERIFIED", "PENDING"] } },
  });
  if (!existing) {
    throw new ABDMError("No active ABHA link for this patient", 404);
  }
  await prisma.abhaLink.update({
    where: { id: existing.id },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}

// ── Webhook helpers ───────────────────────────────────────────────────────

/**
 * Called by the gateway webhook once an async link request completes.
 * Transitions the PENDING row to LINKED (or FAILED on error).
 */
export async function handleLinkCallback(payload: {
  requestId: string;
  status: "SUCCESS" | "FAILED";
  error?: { code?: string; message?: string };
}): Promise<void> {
  const row = await prisma.abhaLink.findFirst({
    where: { requestId: payload.requestId },
  });
  if (!row) return; // idempotent — unknown request id is ignored
  await prisma.abhaLink.update({
    where: { id: row.id },
    data: {
      status: payload.status === "SUCCESS" ? "LINKED" : "FAILED",
      linkedAt: payload.status === "SUCCESS" ? new Date() : null,
      failureReason: payload.error?.message ?? null,
    },
  });
}
