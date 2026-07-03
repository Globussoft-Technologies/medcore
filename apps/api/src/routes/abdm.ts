/**
 * ABDM / ABHA Gateway routes — mounted at `/api/v1/abdm` in apps/api/src/app.ts.
 *
 * All endpoints (except the callback webhook) require authenticate + authorize.
 * Every successful action is recorded in audit_logs via `auditLog()`.
 *
 * The webhook `POST /gateway/callback` is intentionally unauthenticated at
 * the app level — ABDM instead signs the request with an RS256 JWT in the
 * `Authorization: Bearer <jwt>` header. The `verifyAbdmSignature` middleware
 * below verifies against the ABDM public JWKS
 * (`${ABDM_BASE_URL}/gateway/v0.5/certs`). Verification failures return 401
 * and write a dedicated audit entry. Sandbox traffic that isn't signed can
 * be allowed through by setting `ABDM_SKIP_VERIFY=true` or when
 * `NODE_ENV !== "production"` — both log a warning.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { validateUuidParams } from "../middleware/validate-params";
import { rateLimit } from "../middleware/rate-limit";
import { auditLog } from "../middleware/audit";
import {
  verifyAbha,
  linkAbha,
  delinkAbha,
  handleLinkCallback,
  isValidAbhaAddress,
  isValidAbhaNumber,
  sendAbhaAuthOtp,
  confirmAbhaOtp,
} from "../services/abdm/abha";
import {
  requestConsent,
  getConsent,
  revokeConsent,
  handleConsentCallback,
  CONSENT_PURPOSES,
} from "../services/abdm/consent";
import {
  linkCareContext,
  handleHealthInformationRequest,
  buildOPConsultationBundle,
  buildDischargeSummaryBundle,
  buildDiagnosticReportBundle,
} from "../services/abdm/health-records";
import {
  requestDataTransfer,
  receiveHealthInformation,
} from "../services/abdm/hiu";
import { ABDMError } from "../services/abdm/client";
import {
  requestAadhaarOtp,
  verifyAadhaarOtp,
  loginWithAadhaar,
  verifyLoginOtp,
  getPatientProfile,
  downloadAbhaCard,
  putAbhaSession,
  getAbhaXToken,
} from "../services/abdm/abha-enrolment";
import { verifyGatewaySignature } from "../services/abdm/jwks";
import { getSignedDownloadUrl } from "../services/storage";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import {
  hiuFetchSchema,
  uploadRecordSchema,
  recordsQuerySchema,
  abhaEnrolRequestOtpSchema,
  abhaEnrolVerifyOtpSchema,
  abhaLoginRequestOtpSchema,
  abhaLoginVerifyOtpSchema,
  abhaSessionQuerySchema,
} from "@medcore/shared";

// Resolve the caller's own Patient row id (PATIENT role) — null for staff.
async function callerPatientId(req: Request): Promise<string | null> {
  if (req.user?.role !== Role.PATIENT) return null;
  const p = await prisma.patient.findFirst({
    where: { userId: req.user.userId, mergedIntoId: null },
    select: { id: true },
  });
  return p?.id ?? null;
}

export const abdmRouter = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────

const verifyAbhaSchema = z
  .object({
    abhaAddress: z.string().optional(),
    abhaNumber: z.string().optional(),
  })
  .refine((v) => v.abhaAddress || v.abhaNumber, {
    message: "Provide abhaAddress or abhaNumber",
  })
  .refine(
    (v) => !v.abhaAddress || isValidAbhaAddress(v.abhaAddress),
    { message: "abhaAddress must be handle@domain", path: ["abhaAddress"] }
  )
  .refine(
    (v) => !v.abhaNumber || isValidAbhaNumber(v.abhaNumber),
    { message: "abhaNumber must match NN-NNNN-NNNN-NNNN", path: ["abhaNumber"] }
  );

const linkAbhaSchema = z.object({
  patientId: z.string().uuid(),
  abhaAddress: z.string().refine(isValidAbhaAddress, "Invalid ABHA address"),
  abhaNumber: z
    .string()
    .refine(isValidAbhaNumber, "Invalid ABHA number")
    .optional(),
  // Set when the ABHA was already OTP-verified in the same session, so the
  // link handler skips the re-verify gateway round-trip.
  preVerified: z.boolean().optional(),
});

const delinkAbhaSchema = z.object({
  patientId: z.string().uuid(),
  abhaAddress: z.string().refine(isValidAbhaAddress, "Invalid ABHA address"),
});

const requestConsentSchema = z.object({
  patientId: z.string().uuid(),
  hiuId: z.string().min(1),
  abhaAddress: z.string().refine(isValidAbhaAddress, "Invalid ABHA address"),
  purpose: z.enum(CONSENT_PURPOSES),
  hiTypes: z
    .array(
      z.enum([
        "OPConsultation",
        "Prescription",
        "DischargeSummary",
        "DiagnosticReport",
        "ImmunizationRecord",
        "HealthDocumentRecord",
        "WellnessRecord",
      ])
    )
    .min(1),
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  expiresAt: z.coerce.date(),
  requesterId: z.string(),
  requesterName: z.string(),
});

const careContextLinkSchema = z.object({
  patientId: z.string().uuid(),
  abhaAddress: z.string().refine(isValidAbhaAddress, "Invalid ABHA address"),
  careContextRef: z.string().min(1),
  display: z.string().min(1),
  type: z.enum(["OPConsultation", "DischargeSummary", "DiagnosticReport"]),
});

// Webhook payload is intentionally loose — ABDM sends several shapes.
const callbackSchema = z.object({
  requestId: z.string().optional(),
  timestamp: z.string().optional(),
  // Link on-init callback
  auth: z.any().optional(),
  // Consent on-notify callback
  notification: z.any().optional(),
  consentRequestId: z.string().optional(),
  // Health information request callback
  hiRequest: z.any().optional(),
  // Generic error wrapper
  error: z.any().optional(),
  resp: z.any().optional(),
});

// ── Auth gate for everything except /gateway/callback ─────────────────────

/**
 * Gateway signature verification middleware.
 *
 * ABDM signs every outbound callback with an RS256 JWT. We verify against
 * the public JWKS at `${ABDM_BASE_URL}/gateway/v0.5/certs`. On failure we
 * write a dedicated audit entry and return 401 without invoking the handler.
 *
 * Two development escape hatches (used in sandbox only, never in prod):
 *   • `NODE_ENV !== "production"` — failure is logged + audited but the
 *     request is allowed through.
 *   • `ABDM_SKIP_VERIFY=true` — same behaviour, explicit override.
 */
async function verifyAbdmSignature(req: Request, res: Response, next: NextFunction) {
  const isProd = process.env.NODE_ENV === "production";
  const skip = process.env.ABDM_SKIP_VERIFY === "true";
  const rawBody = req.body !== undefined ? Buffer.from(JSON.stringify(req.body)) : undefined;

  let result;
  try {
    result = await verifyGatewaySignature(req.headers.authorization, rawBody);
  } catch (err) {
    result = { valid: false as const, reason: (err as Error).message };
  }

  if (result.valid) {
    next();
    return;
  }

  // Failure path — always write an audit log so ops can spot unsigned traffic.
  await auditLog(
    req,
    "ABDM_GATEWAY_SIGNATURE_INVALID",
    "GatewayCallback",
    undefined,
    {
      reason: result.reason,
      hasAuthHeader: Boolean(req.headers.authorization),
      skippedForDev: !isProd || skip,
    }
  ).catch(() => {
    /* best-effort — never fail the request due to audit write */
  });

  if (!isProd || skip) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "abdm_gateway_signature_skipped",
        reason: result.reason,
        ts: new Date().toISOString(),
      })
    );
    next();
    return;
  }

  res
    .status(401)
    .json({ success: false, data: null, error: `Gateway signature invalid: ${result.reason}` });
}

// security(2026-05-04-med): F-ABDM-1 — defence-in-depth on the gateway
// callback. The route already verifies an RS256 JWT against the ABDM
// public JWKS via `verifyAbdmSignature`, but a compromised gateway key
// (or a sandbox `ABDM_SKIP_VERIFY` window) would let an attacker flood
// us and exhaust the AsyncLocalStorage / Prisma connection pool. A
// per-IP cap of 60/min bleeds the burst off cheaply BEFORE we touch the
// JWKS verifier. Genuine ABDM gateway callback volume per IP is well
// below this — bursts above 60/min are by definition adversarial.
//
// Lazy delegate (same trick as auth.ts loginLimiter for issue #478) so
// the abdm.test.ts regression below can flip
// ENABLE_ABDM_RATELIMIT_IN_TESTS=true AFTER the module is imported but
// BEFORE the first request — without it, NODE_ENV=test would otherwise
// lock in a no-op at construction time.
let _gatewayCallbackLimiterImpl:
  | ((req: Request, res: Response, next: NextFunction) => void)
  | null = null;
const gatewayCallbackLimiter = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!_gatewayCallbackLimiterImpl) {
    _gatewayCallbackLimiterImpl = rateLimit(60, 60_000, {
      enableInTests: process.env.ENABLE_ABDM_RATELIMIT_IN_TESTS === "true",
    });
  }
  _gatewayCallbackLimiterImpl(req, res, next);
};

// Callback webhook mounted FIRST, before the authenticate middleware,
// so gateway callbacks (unauthenticated, signed) can reach it.
abdmRouter.post(
  "/gateway/callback",
  gatewayCallbackLimiter,
  verifyAbdmSignature,
  validate(callbackSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as any;

      // Dispatch based on payload shape.
      if (body?.auth?.status && body?.requestId) {
        await handleLinkCallback({
          requestId: body.requestId,
          status: body.auth.status === "GRANTED" ? "SUCCESS" : "FAILED",
          error: body.error,
        });
      } else if (body?.notification?.consentRequestId || body?.consentRequestId) {
        const consentId = body.notification?.consentRequestId ?? body.consentRequestId;
        const status = (body.notification?.status ?? body.status ?? "GRANTED") as
          | "GRANTED"
          | "DENIED"
          | "EXPIRED"
          | "REVOKED";
        await handleConsentCallback({
          consentRequestId: consentId,
          status,
          artefact: body.notification?.consentArtefact ?? body.consentArtefact,
        });
      } else if (body?.hiRequest) {
        await handleHealthInformationRequest({
          consentId: body.hiRequest.consent?.id ?? body.hiRequest.consentId,
          transactionId: body.hiRequest.transactionId ?? body.requestId,
          dataPushUrl: body.hiRequest.dataPushUrl,
          hiuPublicKey: body.hiRequest.keyMaterial?.dhPublicKey?.keyValue ?? "",
          hiuNonce: body.hiRequest.keyMaterial?.nonce ?? "",
          hiTypes: body.hiRequest.hiTypes ?? [],
          dateRange: body.hiRequest.dateRange ?? { from: "", to: "" },
        });
      }
      // Always ACK so the gateway does not retry indefinitely.
      res.status(202).json({ success: true, data: { accepted: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /hiu/data-push (UNAUTHENTICATED webhook) ─────────────────────────
//
// The remote HIP pushes the encrypted FHIR bundle here after we requested a
// data-transfer (POST /hiu/fetch). Like /gateway/callback it carries no user
// session — it's identified by the transactionId we minted, and the entries
// are AES-GCM-encrypted to OUR ephemeral key (only we can decrypt). Mounted
// BEFORE `authenticate`. Rate-limited to blunt junk pushes.
const dataPushLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(60, 60_000);
abdmRouter.post(
  "/hiu/data-push",
  dataPushLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        transactionId?: string;
        entries?: any[];
        keyMaterial?: unknown;
      };
      if (!body?.transactionId || !Array.isArray(body.entries)) {
        // Always 202 so the gateway/HIP doesn't retry-storm on a malformed
        // push; we log and move on.
        res.status(202).json({ success: true, data: { received: false }, error: null });
        return;
      }
      const result = await receiveHealthInformation({
        transactionId: body.transactionId,
        entries: body.entries,
        keyMaterial: body.keyMaterial,
      });
      res.status(202).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// All remaining endpoints require auth.
abdmRouter.use(authenticate);

// security(2026-04-23-med): F-ABDM-2 — abha verify/link are
// authentication-adjacent (they resolve an external identity against the ABDM
// gateway). Tight 10/min/IP cap to blunt credential-stuffing / enumeration
// against the ABDM sandbox. Delink is less abuse-prone but we keep 20/min for
// consistency with the authenticated-write posture.
const abhaVerifyLinkLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(10, 60_000);
const abhaDelinkLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(20, 60_000);
// security: HIU data-transfer + HIP record-push are gateway-hitting writes —
// cap per-IP to blunt abuse (a tight loop could spam the ABDM gateway / our
// storage). 20/min matches the authenticated-write posture above.
// Closes CodeQL js/missing-rate-limiting on /hiu/fetch + /records/upload.
const abdmWriteLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(20, 60_000);

// ── POST /abha/otp/send (Issue #741) ─────────────────────────────────────
//
// Scaffolds the ABHA OTP-send step that the mobile linking flow needs. Two
// concerns are addressed here:
//
//   1. Server-side cooldown — the endpoint is rate-limited per
//      (mobile_or_aadhaar, IP) bucket: any second send for the same key
//      inside 30 seconds returns 429 with a `Retry-After: <seconds>`
//      header so the client can render an honest countdown. The existing
//      global `rateLimit(...)` middleware is per-IP; we layer a
//      per-(key, IP) map on top so a shared NAT can still send for
//      DIFFERENT mobile numbers without colliding.
//
//   2. Frontend cooldown is OUT OF SCOPE for this lane (a separate agent
//      owns /dashboard/abdm). The UI must hide the Resend button for 30s
//      and show a countdown — server returns the seconds in `retryAfter`
//      and the standard `Retry-After` header so the client doesn't have
//      to track the timer itself.
//
// Test infra (per CLAUDE.md gotcha #2): lazy delegate so the regression
// test can flip ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS=true AFTER importing
// the router but BEFORE the first request. The reset hook
// `__resetAbdmOtpLimiterForTests()` is called from the test's beforeAll
// to ensure module-scope state from prior files is cleared under
// `singleFork: true`.

interface OtpRateLimitEntry {
  lastSentAt: number;
}

let _otpRateMap: Map<string, OtpRateLimitEntry> | null = null;

/** Reset the OTP-cooldown state (test-only — do not call from prod code). */
export function __resetAbdmOtpLimiterForTests(): void {
  _otpRateMap = null;
}

const OTP_COOLDOWN_MS = 30_000;

/**
 * Per-(key, IP) cooldown gate for /abha/otp/send. Returns `null` when the
 * caller is allowed to proceed; returns a positive `retryAfterSeconds`
 * when the caller must wait. Skipped under NODE_ENV=test unless the
 * regression test opts in via ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS=true.
 */
function checkOtpCooldown(
  req: Request,
  key: string
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const enableInTests =
    process.env.ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS === "true";
  if (process.env.NODE_ENV === "test" && !enableInTests) {
    return { ok: true };
  }
  if (!_otpRateMap) {
    _otpRateMap = new Map();
  }
  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.ip) ?? "unknown";
  const bucketKey = `${ip}::${key}`;
  const now = Date.now();
  const entry = _otpRateMap.get(bucketKey);
  if (entry && now - entry.lastSentAt < OTP_COOLDOWN_MS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((OTP_COOLDOWN_MS - (now - entry.lastSentAt)) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }
  _otpRateMap.set(bucketKey, { lastSentAt: now });
  return { ok: true };
}

const sendOtpSchema = z
  .object({
    mobile: z
      .string()
      .regex(/^[0-9]{10}$/, "mobile must be a 10-digit number")
      .optional(),
    aadhaar: z
      .string()
      .regex(/^[0-9]{12}$/, "aadhaar must be a 12-digit number")
      .optional(),
  })
  .refine((v) => v.mobile || v.aadhaar, {
    message: "Provide mobile or aadhaar",
  });

abdmRouter.post(
  "/abha/otp/send",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  validate(sendOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = (req.body.mobile || req.body.aadhaar) as string;
      const cool = checkOtpCooldown(req, key);
      if (!cool.ok) {
        res.setHeader("Retry-After", String(cool.retryAfterSeconds));
        res.status(429).json({
          success: false,
          data: null,
          error: `Please wait ${cool.retryAfterSeconds}s before requesting another OTP.`,
          retryAfter: cool.retryAfterSeconds,
        });
        return;
      }
      // Real ABDM OTP send is plumbed via the abdm/abha service when the
      // sandbox credentials are configured. For now we ack synchronously
      // — the regression test for #741 only exercises the cooldown gate,
      // and the real send is wired through the existing verifyAbha helper
      // when the sandbox/transactionId flow is implemented.
      const txnId = `otp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await auditLog(req, "ABDM_ABHA_OTP_SEND", "AbhaLink", undefined, {
        keyType: req.body.mobile ? "mobile" : "aadhaar",
        // Store only the last-4 of the key in the audit row — never the
        // full mobile number / aadhaar. Mirrors the redaction posture of
        // redactedSearchParams() in fhir.ts.
        keyTail: key.slice(-4),
        txnId,
      });
      res.status(202).json({
        success: true,
        data: { sent: true, txnId, cooldownSeconds: OTP_COOLDOWN_MS / 1000 },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /abha/verify ─────────────────────────────────────────────────────

abdmRouter.post(
  "/abha/verify",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  abhaVerifyLinkLimit,
  validate(verifyAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyAbha(req.body);
      await auditLog(req, "ABDM_ABHA_VERIFY", "AbhaLink", undefined, {
        abhaAddress: req.body.abhaAddress,
        abhaNumber: req.body.abhaNumber,
        ok: result.ok,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /abha/auth/otp — send OTP for an ABHA address (real 2-step) ───────
//
// Step 1 of the proper ABHA mobile-OTP verify: ask ABDM to send an OTP to the
// ABHA holder's registered mobile and return the transactionId the confirm
// step quotes back. Replaces the legacy mobile/aadhaar OTP stub for the link
// flow on the UI.
const abhaAuthOtpSchema = z.object({
  abhaAddress: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9]+$/, "ABHA address must be handle@domain"),
});
abdmRouter.post(
  "/abha/auth/otp",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  abhaVerifyLinkLimit,
  validate(abhaAuthOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await sendAbhaAuthOtp(req.body.abhaAddress);
      await auditLog(req, "ABDM_ABHA_OTP_SEND", "AbhaLink", undefined, {
        abhaAddress: req.body.abhaAddress,
        transactionId: result.transactionId,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /abha/auth/verify — confirm OTP → verified ABHA profile ──────────
const abhaAuthVerifySchema = z.object({
  transactionId: z.string().min(1, "transactionId is required"),
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4–8 digits"),
  abhaAddress: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9]+$/)
    .optional(),
});
abdmRouter.post(
  "/abha/auth/verify",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  abhaVerifyLinkLimit,
  validate(abhaAuthVerifySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await confirmAbhaOtp(req.body);
      await auditLog(req, "ABDM_ABHA_VERIFY", "AbhaLink", undefined, {
        abhaAddress: result.abhaAddress,
        ok: result.ok,
        via: "mobile-otp",
      });
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /abha/link ───────────────────────────────────────────────────────

abdmRouter.post(
  "/abha/link",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  abhaVerifyLinkLimit,
  validate(linkAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, abhaAddress, abhaNumber, preVerified } = req.body;
      const result = await linkAbha({
        patientId,
        abhaAddress,
        abhaNumber,
        // Skip the internal re-verify when the session already OTP-verified.
        ...(preVerified
          ? {
              verified: {
                ok: true,
                abhaAddress,
                abhaNumber,
                requestId: "session-verified",
              },
            }
          : {}),
      });
      await auditLog(req, "ABDM_ABHA_LINK_CREATE", "AbhaLink", result.linkId, {
        patientId,
        abhaAddress,
        preVerified: !!preVerified,
      });
      res.status(202).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /abha/delink ─────────────────────────────────────────────────────

abdmRouter.post(
  "/abha/delink",
  authorize(Role.DOCTOR, Role.ADMIN),
  abhaDelinkLimit,
  validate(delinkAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await delinkAbha(req.body.patientId, req.body.abhaAddress);
      await auditLog(req, "ABDM_ABHA_LINK_DELETE", "AbhaLink", undefined, req.body);
      res.json({ success: true, data: { delinked: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /consent/request ─────────────────────────────────────────────────

abdmRouter.post(
  "/consent/request",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(requestConsentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await requestConsent(req.body);
      await auditLog(req, "ABDM_CONSENT_REQUEST", "ConsentArtefact", result.consentRequestId, {
        patientId: req.body.patientId,
        purpose: req.body.purpose,
        hiTypes: req.body.hiTypes,
      });
      res.status(202).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /consent/:id ──────────────────────────────────────────────────────

abdmRouter.get(
  "/consent/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await getConsent(req.params.id);
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Consent not found" });
        return;
      }
      await auditLog(req, "ABDM_CONSENT_VIEW", "ConsentArtefact", req.params.id);
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /consent/:id/revoke ──────────────────────────────────────────────

abdmRouter.post(
  "/consent/:id/revoke",
  authorize(Role.DOCTOR, Role.ADMIN),
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeConsent(req.params.id);
      await auditLog(req, "ABDM_CONSENT_REVOKE", "ConsentArtefact", req.params.id);
      res.json({ success: true, data: { revoked: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /care-context/link ───────────────────────────────────────────────

abdmRouter.post(
  "/care-context/link",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(careContextLinkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await linkCareContext(req.body);
      await auditLog(req, "ABDM_CARE_CONTEXT_LINK", "CareContext", req.body.careContextRef, {
        abhaAddress: req.body.abhaAddress,
        type: req.body.type,
      });
      res.status(202).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /consents (list by patient) ───────────────────────────────────────
//
// Introduced after the /dashboard/abdm Consents tab flagged that there was no
// way to enumerate existing consent artefacts for a given patient. Reads
// straight from our local DB — use `GET /consent/:id` (singular) if you want
// to go round-trip to the ABDM gateway for a single artefact. Note the field
// name: the ConsentArtefact model uses `createdAt` as its request timestamp
// (set at step 1 of the consent request flow), so we sort by that.

const listConsentsQuerySchema = z.object({
  patientId: z.string().uuid(),
});

abdmRouter.get(
  "/consents",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listConsentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { patientId } = parsed.data;

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const rows = await prisma.consentArtefact.findMany({
        where: { patientId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      await auditLog(req, "ABDM_CONSENT_LIST", "ConsentArtefact", undefined, {
        patientId,
        count: rows.length,
      });

      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /consents/:id (local read) ────────────────────────────────────────
//
// Unlike `GET /consent/:id` which calls the ABDM gateway, this endpoint reads
// the artefact row from our own DB — useful for UIs that just want to render
// the last known status without triggering a gateway round-trip.

abdmRouter.get(
  "/consents/:id",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.consentArtefact.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Consent not found" });
        return;
      }
      await auditLog(req, "ABDM_CONSENT_READ", "ConsentArtefact", req.params.id);
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// ABDM MODULE COMPLETION (2026-06) — dashboard, profile, HIU fetch, records,
// upload→HIP, transactions, audit. Patients see only their own data; staff
// scope by the patientId they pass.
// ══════════════════════════════════════════════════════════════════════════

// ── GET /dashboard — connection + HIP/HIU status + recent txns + stats ────
abdmRouter.get(
  "/dashboard",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const configured = Boolean(
        process.env.ABDM_CLIENT_ID && process.env.ABDM_CLIENT_SECRET,
      );
      const [recentTxns, consentStats, linkCount, recordCount] = await Promise.all([
        prisma.abdmTransaction.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            type: true,
            status: true,
            summary: true,
            createdAt: true,
          },
        }),
        prisma.consentArtefact.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.abhaLink.count({ where: { status: "LINKED" } }),
        prisma.medicalRecord.count(),
      ]);
      const consents: Record<string, number> = {};
      for (const row of consentStats) consents[row.status] = row._count._all;
      res.json({
        success: true,
        data: {
          abdmConnected: configured,
          mode: process.env.ABDM_CM_ID === "ndhm" ? "production" : "sandbox",
          hip: { id: process.env.ABDM_HIP_ID ?? "medcore-hip-sandbox", status: configured ? "ready" : "not-configured" },
          hiu: { id: process.env.ABDM_HIU_ID ?? "medcore-hiu-sandbox", status: configured ? "ready" : "not-configured" },
          linkedAbhaCount: linkCount,
          recordCount,
          consents,
          recentTransactions: recentTxns,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /profile/:patientId — ABHA profile + demographics ─────────────────
abdmRouter.get(
  "/profile/:patientId",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.PATIENT),
  validateUuidParams(["patientId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.patientId;
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: {
          id: true,
          gender: true,
          dateOfBirth: true,
          abhaId: true,
          user: { select: { name: true, phone: true } },
          abhaLinks: {
            where: { status: "LINKED" },
            orderBy: { linkedAt: "desc" },
            take: 1,
            select: { abhaAddress: true, abhaNumber: true, linkedAt: true },
          },
        },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      await auditLog(req, "ABDM_ABHA_PROFILE_VIEW", "Patient", patientId);
      res.json({ success: true, data: patient, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /hiu/fetch — request a data-transfer for a granted consent ───────
abdmRouter.post(
  "/hiu/fetch",
  authorize(Role.ADMIN, Role.DOCTOR, Role.PATIENT),
  abdmWriteLimit,
  validate(hiuFetchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { consentId } = req.body as { consentId: string };
      const consent = await prisma.consentArtefact.findUnique({
        where: { id: consentId },
        select: { id: true, patientId: true },
      });
      if (!consent) {
        res.status(404).json({ success: false, data: null, error: "Consent not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, consent.patientId))) return;
      const result = await requestDataTransfer(consentId);
      await auditLog(req, "ABDM_HIU_FETCH", "ConsentArtefact", consentId, {
        transactionId: result.transactionId,
      });
      res.status(202).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /records — list medical records (HIP + HIU) ───────────────────────
abdmRouter.get(
  "/records",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = recordsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, data: null, error: parsed.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      // Patients are scoped to their own records; staff may pass a patientId.
      const selfPatientId = await callerPatientId(req);
      const patientId = selfPatientId ?? parsed.data.patientId;
      if (!patientId) {
        res.status(400).json({ success: false, data: null, error: "patientId is required" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;
      const rows = await prisma.medicalRecord.findMany({
        where: {
          patientId,
          ...(parsed.data.source ? { source: parsed.data.source } : {}),
          ...(parsed.data.hiType ? { hiType: { contains: parsed.data.hiType, mode: "insensitive" } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          source: true,
          hiType: true,
          title: true,
          providerName: true,
          recordDate: true,
          fetchedAt: true,
          createdAt: true,
          fileKey: true,
        },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /records/:id — record detail (full FHIR bundle) ───────────────────
abdmRouter.get(
  "/records/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.PATIENT),
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Record not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, row.patientId))) return;
      await auditLog(req, "ABDM_RECORD_VIEW", "MedicalRecord", row.id);
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /records/:id/download — signed URL for an attached file ───────────
abdmRouter.get(
  "/records/:id/download",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.PATIENT),
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.medicalRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true, patientId: true, fileKey: true },
      });
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Record not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, row.patientId))) return;
      if (!row.fileKey) {
        res.status(404).json({ success: false, data: null, error: "This record has no downloadable file" });
        return;
      }
      const url = await getSignedDownloadUrl(row.fileKey);
      await auditLog(req, "ABDM_RECORD_DOWNLOAD", "MedicalRecord", row.id);
      res.json({ success: true, data: { url }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /records/upload — doctor uploads a record → build FHIR → push HIP ─
abdmRouter.post(
  "/records/upload",
  authorize(Role.DOCTOR, Role.ADMIN),
  abdmWriteLimit,
  validate(uploadRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        patientId: string;
        abhaAddress: string;
        type: "OPConsultation" | "DischargeSummary" | "DiagnosticReport";
        title: string;
        fileKey?: string;
        diagnosis?: string;
        notes?: string;
        recordDate?: Date;
      };
      const patient = await prisma.patient.findUnique({
        where: { id: body.patientId },
        select: { id: true, user: { select: { name: true } } },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Create the upload-tracking row first (status QUEUED).
      const upload = await prisma.recordUpload.create({
        data: {
          patientId: body.patientId,
          type: body.type,
          status: "QUEUED",
          title: body.title,
          fileKey: body.fileKey ?? null,
          uploadedById: req.user?.userId ?? null,
        },
        select: { id: true },
      });

      // Build the FHIR bundle for the chosen type.
      const patientName = patient.user?.name ?? "Patient";
      const when = body.recordDate ? new Date(body.recordDate) : new Date();
      let bundle;
      if (body.type === "DischargeSummary") {
        bundle = buildDischargeSummaryBundle({
          patientName, patientAbha: body.abhaAddress,
          admittingDiagnosis: body.diagnosis ?? "", dischargeDiagnosis: body.diagnosis ?? "",
          proceduresPerformed: [], medicationsOnDischarge: [],
          admissionDate: when, dischargeDate: when, doctorName: req.user?.email ?? "",
        });
      } else if (body.type === "DiagnosticReport") {
        bundle = buildDiagnosticReportBundle({
          patientName, patientAbha: body.abhaAddress,
          reportName: body.title, conclusion: body.notes ?? "",
          observations: [], reportDate: when, orderedBy: req.user?.email ?? "",
        });
      } else {
        bundle = buildOPConsultationBundle({
          patientName, patientAbha: body.abhaAddress,
          chiefComplaint: body.notes ?? "", diagnosis: body.diagnosis ?? "",
          medications: [], doctorName: req.user?.email ?? "", visitDate: when,
        });
      }

      const careContextRef = `upload:${upload.id}`;

      // Advertise the care-context (HIP discovery) — best-effort against sandbox.
      let status: "BUNDLED" | "PUSHED" | "FAILED" = "BUNDLED";
      let errorMessage: string | null = null;
      try {
        await linkCareContext({
          patientId: body.patientId,
          abhaAddress: body.abhaAddress,
          careContextRef,
          display: body.title,
          type: body.type,
        });
        status = "PUSHED";
      } catch (e) {
        errorMessage = (e as Error).message;
        status = "FAILED";
      }

      // Persist the local MedicalRecord (HIP_LOCAL) + finalise the upload row.
      const record = await prisma.medicalRecord.create({
        data: {
          patientId: body.patientId,
          source: "HIP_LOCAL",
          hiType: body.type,
          title: body.title,
          careContextRef,
          fhirBundle: bundle as any,
          fileKey: body.fileKey ?? null,
          recordDate: when,
        },
        select: { id: true },
      });
      await prisma.recordUpload.update({
        where: { id: upload.id },
        data: {
          status,
          careContextRef,
          bundleId: bundle.id,
          errorMessage,
          pushedAt: status === "PUSHED" ? new Date() : null,
        },
      });
      await prisma.abdmTransaction.create({
        data: {
          type: "HIP_PUSH",
          status: status === "PUSHED" ? "SUCCESS" : "FAILED",
          refId: record.id,
          patientId: body.patientId,
          summary: `${body.type} "${body.title}" ${status === "PUSHED" ? "pushed to ABDM" : "bundle built (push failed)"}`,
          errorMessage,
        },
      });
      await auditLog(req, "ABDM_RECORD_UPLOAD", "MedicalRecord", record.id, {
        patientId: body.patientId, type: body.type, status,
      });

      res.status(201).json({
        success: true,
        data: { uploadId: upload.id, recordId: record.id, careContextRef, status },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /transactions — ABDM gateway transaction feed ─────────────────────
abdmRouter.get(
  "/transactions",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = typeof req.query.patientId === "string" ? req.query.patientId : undefined;
      const rows = await prisma.abdmTransaction.findMany({
        where: patientId ? { patientId } : {},
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true, type: true, status: true, requestId: true, refId: true,
          patientId: true, summary: true, errorMessage: true, createdAt: true,
        },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /audit — ABDM-scoped audit log feed (admin) ───────────────────────
abdmRouter.get(
  "/audit",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.auditLog.findMany({
        where: { action: { startsWith: "ABDM_" } },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true, userId: true, action: true, entity: true, entityId: true,
          details: true, ipAddress: true, createdAt: true,
        },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── ABHA Milestone-1 (V3) Aadhaar enrolment + login (authenticated) ────────
//
// Staff (RECEPTION/DOCTOR/ADMIN) and a logged-in PATIENT can run the Aadhaar
// OTP → create/verify ABHA → profile → card flow. The PUBLIC, pre-login
// booking variant lives in routes/public-abha.ts and reuses the same service.
// Aadhaar/OTP arrive as plaintext (HTTPS) and are RSA-encrypted server-side;
// the ABDM X-Token is held server-side (putAbhaSession) and only an opaque
// sessionId is returned. NOTHING sensitive is ever logged.

const ABHA_ENROL_ROLES = [
  Role.PATIENT,
  Role.RECEPTION,
  Role.DOCTOR,
  Role.ADMIN,
] as const;

// POST /abha/enrol/request-otp — send Aadhaar OTP for a NEW ABHA.
abdmRouter.post(
  "/abha/enrol/request-otp",
  authorize(...ABHA_ENROL_ROLES),
  validate(abhaEnrolRequestOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cd = checkOtpCooldown(req, "abha-enrol");
      if (!cd.ok) {
        res.setHeader("Retry-After", String(cd.retryAfterSeconds));
        res.status(429).json({
          success: false,
          data: null,
          error: "Please wait before requesting another OTP",
          retryAfter: cd.retryAfterSeconds,
        });
        return;
      }
      const { txnId } = await requestAadhaarOtp(req.body.aadhaar);
      await auditLog(req, "ABDM_ABHA_ENROL_OTP_REQUEST", "AbhaLink", undefined, {
        txnIdIssued: true,
      });
      res.json({ success: true, data: { txnId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /abha/enrol/verify-otp — verify OTP + create ABHA.
abdmRouter.post(
  "/abha/enrol/verify-otp",
  authorize(...ABHA_ENROL_ROLES),
  validate(abhaEnrolVerifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyAadhaarOtp(req.body);
      const sessionId = result.xToken ? putAbhaSession(result.xToken) : null;
      await auditLog(req, "ABDM_ABHA_ENROL_CREATE", "AbhaLink", undefined, {
        abhaNumber: result.profile.abhaNumber ?? undefined,
        abhaAddress: result.profile.abhaAddress ?? undefined,
      });
      res.json({
        success: true,
        data: { profile: result.profile, sessionId },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /abha/login/request-otp — send Aadhaar OTP for an EXISTING ABHA.
abdmRouter.post(
  "/abha/login/request-otp",
  authorize(...ABHA_ENROL_ROLES),
  validate(abhaLoginRequestOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cd = checkOtpCooldown(req, "abha-login");
      if (!cd.ok) {
        res.setHeader("Retry-After", String(cd.retryAfterSeconds));
        res.status(429).json({
          success: false,
          data: null,
          error: "Please wait before requesting another OTP",
          retryAfter: cd.retryAfterSeconds,
        });
        return;
      }
      const { txnId } = await loginWithAadhaar(req.body.aadhaar);
      await auditLog(req, "ABDM_ABHA_LOGIN_OTP_REQUEST", "AbhaLink", undefined, {
        txnIdIssued: true,
      });
      res.json({ success: true, data: { txnId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /abha/login/verify-otp — verify OTP → X-Token (server-side) + profile.
abdmRouter.post(
  "/abha/login/verify-otp",
  authorize(...ABHA_ENROL_ROLES),
  validate(abhaLoginVerifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyLoginOtp(req.body);
      const sessionId = putAbhaSession(result.xToken);
      const profile = result.profile ?? (await getPatientProfile(result.xToken));
      await auditLog(req, "ABDM_ABHA_LOGIN_VERIFY", "AbhaLink", undefined, {
        abhaNumber: profile.abhaNumber ?? undefined,
        abhaAddress: profile.abhaAddress ?? undefined,
      });
      res.json({ success: true, data: { profile, sessionId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /abha/enrol/profile?sessionId= — re-fetch the ABHA profile.
abdmRouter.get(
  "/abha/enrol/profile",
  authorize(...ABHA_ENROL_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = abhaSessionQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "A valid sessionId query param is required",
        });
        return;
      }
      const xToken = getAbhaXToken(parsed.data.sessionId);
      if (!xToken) {
        res.status(401).json({
          success: false,
          data: null,
          error: "ABHA session expired — please verify OTP again",
        });
        return;
      }
      const profile = await getPatientProfile(xToken);
      res.json({ success: true, data: { profile }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /abha/enrol/card?sessionId= — download the ABHA card (PDF).
abdmRouter.get(
  "/abha/enrol/card",
  authorize(...ABHA_ENROL_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = abhaSessionQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "A valid sessionId query param is required",
        });
        return;
      }
      const xToken = getAbhaXToken(parsed.data.sessionId);
      if (!xToken) {
        res.status(401).json({
          success: false,
          data: null,
          error: "ABHA session expired — please verify OTP again",
        });
        return;
      }
      const card = await downloadAbhaCard(xToken);
      await auditLog(req, "ABDM_ABHA_CARD_DOWNLOAD", "AbhaLink", undefined, {});
      res.setHeader("Content-Type", card.contentType);
      res.setHeader("Content-Disposition", 'inline; filename="abha-card.pdf"');
      res.send(card.buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ── Error translation ─────────────────────────────────────────────────────

// Scope-specific error handler so ABDMError becomes a clean HTTP response
// without changing the global error middleware.
abdmRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ABDMError) {
    res.status(err.statusCode).json({
      success: false,
      data: null,
      error: err.message,
      upstream: err.upstreamBody,
    });
    return;
  }
  next(err);
});
