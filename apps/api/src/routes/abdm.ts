/**
 * ABDM / ABHA Gateway routes — mounted at `/api/v1/abdm` in apps/api/src/app.ts.
 *
 * All endpoints (except the callback webhook) require authenticate + authorize.
 * Every successful action is recorded in audit_logs via `auditLog()`.
 *
 * The webhook `POST /gateway/callback` is intentionally unauthenticated —
 * ABDM signs the request with an RSA signature in `x-hip-id` / `x-cm-id`
 * headers. A real deployment must verify the signature against the ABDM
 * public JWKS (`${ABDM_BASE_URL}/gateway/v0.5/certs`) before accepting the
 * payload. Signature verification is left as a TODO comment below — without
 * sandbox credentials we cannot integration-test it.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
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

// Callback webhook mounted FIRST, before the authenticate middleware,
// so gateway callbacks (unauthenticated, signed) can reach it.
abdmRouter.post(
  "/gateway/callback",
  validate(callbackSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    // TODO: verify ABDM signature against JWKS at
    //   `${process.env.ABDM_BASE_URL}/gateway/v0.5/certs`
    //   using the `x-hip-id` / `x-cm-id` request headers.
    // Without sandbox credentials this is not integration-testable, so it
    // is intentionally left as a stub. Do NOT ship to production without it.

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

// ── POST /abha/verify ─────────────────────────────────────────────────────

abdmRouter.post(
  "/abha/verify",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  validate(verifyAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyAbha(req.body);
      await auditLog(req, "ABDM_ABHA_VERIFIED", "AbhaLink", undefined, {
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
  validate(linkAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await linkAbha(req.body);
      await auditLog(req, "ABDM_ABHA_LINK_INITIATED", "AbhaLink", result.linkId, {
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
  validate(delinkAbhaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await delinkAbha(req.body.patientId, req.body.abhaAddress);
      await auditLog(req, "ABDM_ABHA_DELINKED", "AbhaLink", undefined, req.body);
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
      await auditLog(req, "ABDM_CONSENT_REQUESTED", "ConsentArtefact", result.consentRequestId, {
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await getConsent(req.params.id);
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Consent not found" });
        return;
      }
      await auditLog(req, "ABDM_CONSENT_VIEWED", "ConsentArtefact", req.params.id);
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeConsent(req.params.id);
      await auditLog(req, "ABDM_CONSENT_REVOKED", "ConsentArtefact", req.params.id);
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
      await auditLog(req, "ABDM_CARE_CONTEXT_LINKED", "CareContext", req.body.careContextRef, {
        abhaAddress: req.body.abhaAddress,
        type: req.body.type,
      });
      res.status(202).json({ success: true, data: result, error: null });
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
