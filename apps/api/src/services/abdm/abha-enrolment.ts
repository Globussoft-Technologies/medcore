/**
 * ABDM ABHA Milestone-1 (V3) enrolment + login service.
 *
 * ── What this module does ─────────────────────────────────────────────────
 * Implements the official ABDM ABHA M1 (V3) Aadhaar-OTP flow:
 *   1. generateAccessToken()      — gateway session token (reused from client.ts)
 *   2. getPublicCertificate()     — RSA public key (fetched + cached)
 *   3. encryptAadhaar()/encryptOtp() — RSA-OAEP / SHA-1, Base64
 *   4. requestAadhaarOtp()        — enrollment/request/otp
 *   5. verifyAadhaarOtp()         — enrollment/enrol/byAadhaar (create ABHA)
 *   6. loginWithAadhaar()         — profile/login/request/otp
 *   7. verifyLoginOtp()           — profile/login/verify (returns X-Token)
 *   8. getPatientProfile()        — profile/account (needs X-Token)
 *   9. downloadAbhaCard()         — profile/account/abha-card (needs X-Token)
 *
 * ── Reuse (do NOT duplicate) ──────────────────────────────────────────────
 * Every outbound call goes through `abdmRequest` (services/abdm/client.ts),
 * which supplies the cached gateway Bearer token, REQUEST-ID, TIMESTAMP and
 * X-CM-ID headers, retries 5xx, and throws `ABDMError` (translated to HTTP by
 * the router-scoped error handler). The M1 endpoints live on a DIFFERENT host
 * than the gateway, so we pass `absoluteUrl: true` with the full ABHA URL.
 *
 * ── Security ──────────────────────────────────────────────────────────────
 * Aadhaar numbers, OTPs and X-Tokens are NEVER logged or persisted. Aadhaar
 * and OTP are RSA-encrypted with the ABDM public certificate before leaving
 * this process. The ABDM X-Token issued on login is held ONLY server-side,
 * keyed by an opaque short-lived `sessionId` (see the session store below);
 * the raw token is never returned to the browser.
 */

import {
  createPublicKey,
  publicEncrypt,
  constants as cryptoConstants,
  randomUUID,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import type { AbhaProfileDto } from "@medcore/shared";
import { abdmRequest, ABDMError, getAccessToken } from "./client";

// ── Config ────────────────────────────────────────────────────────────────

/** ABHA service host (distinct from the gateway host in client.ts). */
function abhaBaseUrl(): string {
  return (
    process.env.ABDM_ABHA_BASE_URL?.replace(/\/+$/, "") ??
    "https://abhasbx.abdm.gov.in"
  );
}

const V3 = "/abha/api/v3";
const paths = {
  certificate: () => `${abhaBaseUrl()}${V3}/profile/public/certificate`,
  enrolRequestOtp: () => `${abhaBaseUrl()}${V3}/enrollment/request/otp`,
  enrolByAadhaar: () => `${abhaBaseUrl()}${V3}/enrollment/enrol/byAadhaar`,
  loginRequestOtp: () => `${abhaBaseUrl()}${V3}/profile/login/request/otp`,
  loginVerify: () => `${abhaBaseUrl()}${V3}/profile/login/verify`,
  profile: () => `${abhaBaseUrl()}${V3}/profile/account`,
  abhaCard: () => `${abhaBaseUrl()}${V3}/profile/account/abha-card`,
};

// ── 1. Gateway session token ────────────────────────────────────────────────
/** Alias to the shared, cached gateway session token acquisition. */
export const generateAccessToken = getAccessToken;

// ── 2. Public certificate (fetched + cached) ────────────────────────────────

interface CachedCert {
  key: KeyObject;
  pem: string;
  expiresAt: number;
}
let cachedCert: CachedCert | null = null;
const CERT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — the cert rotates rarely.

/** Test-only reset of the certificate cache. */
export function __resetAbhaCertCacheForTests(): void {
  cachedCert = null;
}

/** Wrap a bare base64 DER (SPKI) string in PEM public-key armor. */
function base64DerToPem(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  const lines = clean.match(/.{1,64}/g)?.join("\n") ?? clean;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Turn whatever the certificate endpoint returns into a usable public
 * KeyObject + a canonical PEM. Handles the shapes ABDM actually returns
 * across environments:
 *   • JSON `{ publicKey | certificate | publicCertificate | key: "..." }`
 *     (the ABHA sandbox returns `{"publicKey":"<base64 DER>"}`),
 *   • a raw RSA public-key PEM ("BEGIN PUBLIC KEY"),
 *   • an X.509 certificate PEM ("BEGIN CERTIFICATE"),
 *   • a bare base64 DER (SPKI) public key with no PEM armor.
 */
function toPublicKey(raw: string): { key: KeyObject; pem: string } {
  const trimmed = raw.trim();

  // JSON-wrapped → unwrap the key/cert string and recurse.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const val = [obj.publicKey, obj.certificate, obj.publicCertificate, obj.key].find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (val) return toPublicKey(val);
    } catch {
      /* not JSON — fall through */
    }
  }

  // X.509 certificate PEM.
  if (trimmed.includes("BEGIN CERTIFICATE")) {
    const key = new X509Certificate(trimmed).publicKey;
    return { key, pem: key.export({ type: "spki", format: "pem" }).toString() };
  }

  // Public-key PEM.
  if (trimmed.includes("BEGIN")) {
    const key = createPublicKey({ key: trimmed, format: "pem" });
    return { key, pem: trimmed };
  }

  // Bare base64 DER (SPKI) — wrap in PEM armor and import.
  const key = createPublicKey({ key: base64DerToPem(trimmed), format: "pem" });
  return { key, pem: key.export({ type: "spki", format: "pem" }).toString() };
}

/** Fetch (and cache) the ABDM public certificate → canonical PEM. */
export async function getPublicCertificate(): Promise<string> {
  const now = Date.now();
  if (cachedCert && cachedCert.expiresAt > now) return cachedCert.pem;

  // The cert endpoint returns either JSON ({publicKey}) or a PEM → read raw.
  const res = await abdmRequest<Response>({
    method: "GET",
    path: paths.certificate(),
    absoluteUrl: true,
    parseJson: false,
  });
  const body = (await res.text()).trim();
  if (!body) {
    throw new ABDMError("ABDM public certificate response was empty", 502);
  }
  let parsed: { key: KeyObject; pem: string };
  try {
    parsed = toPublicKey(body);
  } catch {
    throw new ABDMError("ABDM public certificate response was invalid", 502);
  }
  cachedCert = { key: parsed.key, pem: parsed.pem, expiresAt: now + CERT_TTL_MS };
  return parsed.pem;
}

// ── 3. RSA-OAEP / SHA-1 encryption (Aadhaar + OTP) ──────────────────────────

/** RSA-OAEP (SHA-1) encrypt `value` with the ABDM public cert → Base64. */
async function rsaEncrypt(value: string): Promise<string> {
  await getPublicCertificate(); // ensures cachedCert.key is populated
  const key = cachedCert!.key;
  const encrypted = publicEncrypt(
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(value, "utf8"),
  );
  return encrypted.toString("base64");
}

/** Encrypt an Aadhaar number for transport to ABDM. */
export function encryptAadhaar(aadhaar: string): Promise<string> {
  return rsaEncrypt(aadhaar);
}

/** Encrypt an OTP for transport to ABDM. */
export function encryptOtp(otp: string): Promise<string> {
  return rsaEncrypt(otp);
}

// ── Server-side X-Token session store ───────────────────────────────────────
// The ABDM X-Token must never reach the browser. On login we stash it here
// under a random opaque `sessionId` (short TTL); the profile/card endpoints
// swap the sessionId back for the real token server-side.

interface AbhaSession {
  xToken: string;
  expiresAt: number;
}
let sessionStore: Map<string, AbhaSession> | null = null;
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min

/** Test-only reset of the X-Token session store. */
export function __resetAbhaSessionStoreForTests(): void {
  sessionStore = null;
}

function pruneSessions(now: number): void {
  if (!sessionStore) return;
  for (const [id, s] of sessionStore) if (s.expiresAt <= now) sessionStore.delete(id);
}

/** Stash an X-Token, returning an opaque sessionId to hand to the client. */
export function putAbhaSession(xToken: string): string {
  if (!sessionStore) sessionStore = new Map();
  const now = Date.now();
  pruneSessions(now);
  const sessionId = randomUUID();
  sessionStore.set(sessionId, { xToken, expiresAt: now + SESSION_TTL_MS });
  return sessionId;
}

/** Resolve a sessionId back to its X-Token, or null if missing/expired. */
export function getAbhaXToken(sessionId: string): string | null {
  if (!sessionStore) return null;
  const now = Date.now();
  const s = sessionStore.get(sessionId);
  if (!s || s.expiresAt <= now) {
    if (s) sessionStore.delete(sessionId);
    return null;
  }
  return s.xToken;
}

// ── Response normalisation ──────────────────────────────────────────────────

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Extract the ABDM X-Token from the various shapes M1 responses use. */
function extractToken(raw: Record<string, unknown>): string | null {
  const tokens = (raw.tokens ?? {}) as Record<string, unknown>;
  const jwt = (raw.jwtResponse ?? {}) as Record<string, unknown>;
  return firstString(raw.token, tokens.token, jwt.token, raw.accessToken);
}

/** Map an ABDM ABHAProfile (enrol / login / account) to our DTO. */
export function normaliseAbhaProfile(raw: Record<string, unknown>): AbhaProfileDto {
  const p = ((raw.ABHAProfile ?? raw.abhaProfile ?? raw.accounts ?? raw) ??
    {}) as Record<string, unknown>;
  // `accounts` is an array on some login responses → take the first.
  const acct = (Array.isArray(p) ? p[0] : p) as Record<string, unknown>;
  const name = firstString(
    acct.name,
    acct.fullName,
    [acct.firstName, acct.middleName, acct.lastName]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ") || undefined,
  );
  return {
    abhaNumber: firstString(acct.ABHANumber, acct.abhaNumber, acct.healthIdNumber),
    abhaAddress: firstString(
      acct.preferredAbhaAddress,
      acct.abhaAddress,
      acct.phrAddress,
      acct.healthId,
    ),
    name,
    gender: firstString(acct.gender),
    dateOfBirth: firstString(
      acct.dob,
      acct.dateOfBirth,
      [acct.yearOfBirth, acct.monthOfBirth, acct.dayOfBirth]
        .filter((x) => x)
        .join("-") || undefined,
    ),
    mobile: firstString(acct.mobile, acct.phoneNumber),
    email: firstString(acct.email),
    address: firstString(acct.address),
    pincode: firstString(acct.pinCode, acct.pincode),
    stateName: firstString(acct.stateName, acct.state),
    districtName: firstString(acct.districtName, acct.district),
    photoBase64: firstString(acct.profilePhoto, acct.photo),
  };
}

// ── 4. Request Aadhaar OTP (enrolment) ──────────────────────────────────────

export interface RequestOtpResult {
  txnId: string;
  raw: Record<string, unknown>;
}

export async function requestAadhaarOtp(
  aadhaar: string,
): Promise<RequestOtpResult> {
  const loginId = await encryptAadhaar(aadhaar);
  const raw = await abdmRequest<Record<string, unknown>>({
    method: "POST",
    path: paths.enrolRequestOtp(),
    absoluteUrl: true,
    body: {
      txnId: "",
      scope: ["abha-enrol"],
      loginHint: "aadhaar",
      loginId,
      otpSystem: "aadhaar",
    },
  });
  const txnId = firstString(raw.txnId, raw.txnID);
  if (!txnId) throw new ABDMError("ABDM enrolment OTP response missing txnId", 502, raw);
  return { txnId, raw };
}

// ── 5. Verify Aadhaar OTP + create ABHA ─────────────────────────────────────

export interface VerifyEnrolResult {
  profile: AbhaProfileDto;
  /** X-Token (if the enrol response carried one) — held server-side only. */
  xToken: string | null;
  txnId: string | null;
  raw: Record<string, unknown>;
}

export async function verifyAadhaarOtp(input: {
  txnId: string;
  otp: string;
  mobile: string;
}): Promise<VerifyEnrolResult> {
  const otpValue = await encryptOtp(input.otp);
  const raw = await abdmRequest<Record<string, unknown>>({
    method: "POST",
    path: paths.enrolByAadhaar(),
    absoluteUrl: true,
    body: {
      authData: {
        authMethods: ["otp"],
        otp: { txnId: input.txnId, otpValue, mobile: input.mobile },
      },
      consent: { code: "abha-enrollment", version: "1.4" },
    },
  });
  return {
    profile: normaliseAbhaProfile(raw),
    xToken: extractToken(raw),
    txnId: firstString(raw.txnId, raw.txnID),
    raw,
  };
}

// ── 6. Login — request Aadhaar OTP ──────────────────────────────────────────

export async function loginWithAadhaar(
  aadhaar: string,
): Promise<RequestOtpResult> {
  const loginId = await encryptAadhaar(aadhaar);
  const raw = await abdmRequest<Record<string, unknown>>({
    method: "POST",
    path: paths.loginRequestOtp(),
    absoluteUrl: true,
    body: {
      scope: ["abha-login", "aadhaar-verify"],
      loginHint: "aadhaar",
      loginId,
      otpSystem: "aadhaar",
    },
  });
  const txnId = firstString(raw.txnId, raw.txnID);
  if (!txnId) throw new ABDMError("ABDM login OTP response missing txnId", 502, raw);
  return { txnId, raw };
}

// ── 7. Login — verify OTP → X-Token ─────────────────────────────────────────

export interface VerifyLoginResult {
  xToken: string;
  profile: AbhaProfileDto | null;
  raw: Record<string, unknown>;
}

export async function verifyLoginOtp(input: {
  txnId: string;
  otp: string;
}): Promise<VerifyLoginResult> {
  const otpValue = await encryptOtp(input.otp);
  const raw = await abdmRequest<Record<string, unknown>>({
    method: "POST",
    path: paths.loginVerify(),
    absoluteUrl: true,
    body: {
      scope: ["abha-login", "aadhaar-verify"],
      authData: {
        authMethods: ["otp"],
        otp: { txnId: input.txnId, otpValue },
      },
    },
  });
  const xToken = extractToken(raw);
  if (!xToken) throw new ABDMError("ABDM login verify response missing token", 502, raw);
  const hasProfile = raw.ABHAProfile || raw.abhaProfile || raw.accounts;
  return { xToken, profile: hasProfile ? normaliseAbhaProfile(raw) : null, raw };
}

// ── 8. Fetch profile (X-Token) ──────────────────────────────────────────────

export async function getPatientProfile(xToken: string): Promise<AbhaProfileDto> {
  const raw = await abdmRequest<Record<string, unknown>>({
    method: "GET",
    path: paths.profile(),
    absoluteUrl: true,
    headers: { "X-token": `Bearer ${xToken}` },
  });
  return normaliseAbhaProfile(raw);
}

// ── 9. Download ABHA card (X-Token) ─────────────────────────────────────────

export interface AbhaCard {
  buffer: Buffer;
  contentType: string;
}

export async function downloadAbhaCard(xToken: string): Promise<AbhaCard> {
  const res = await abdmRequest<Response>({
    method: "GET",
    path: paths.abhaCard(),
    absoluteUrl: true,
    parseJson: false,
    headers: { "X-token": `Bearer ${xToken}`, Accept: "application/pdf" },
  });
  const contentType = res.headers.get("content-type") ?? "application/pdf";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new ABDMError("ABDM ABHA card response was empty", 502);
  }
  return { buffer, contentType };
}
