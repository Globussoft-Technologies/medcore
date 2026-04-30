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
} from "../services/abdm/health-records";
import { ABDMError } from "../services/abdm/client";
import { verifyGatewaySignature } from "../services/abdm/jwks";

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

// Callback webhook mounted FIRST, before the authenticate middleware,
// so gateway callbacks (unauthenticated, signed) can reach it.
abdmRouter.post(
  "/gateway/callback",
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

// ── POST /abha/link ───────────────────────────────────────────────────────

abdmRouter.post(
  "/abha/link",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  abhaVerifyLinkLimit,
  validate(linkAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await linkAbha(req.body);
      await auditLog(req, "ABDM_ABHA_LINK_CREATE", "AbhaLink", result.linkId, {
        patientId: req.body.patientId,
        abhaAddress: req.body.abhaAddress,
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
