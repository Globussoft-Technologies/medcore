/**
 * Public ABHA (ABDM Milestone-1 V3) Aadhaar flow — mounted UNAUTHENTICATED at
 * /api/v1/public/abha in apps/api/src/app.ts.
 *
 * Powers the pre-login "Continue with Aadhaar" step on the public booking page
 * (apps/web/src/app/(marketing)/book). A prospective patient — who does not yet
 * have an account — enters their Aadhaar, receives an OTP, verifies it, and we
 * create/fetch their ABHA and return a NORMALISED PROFILE the booking form
 * auto-populates (name, DOB, gender, mobile, address, ABHA number/address).
 *
 * This mirrors the authenticated routes in routes/abdm.ts (/abha/enrol/* and
 * /abha/login/*) and reuses the SAME service (services/abdm/abha-enrolment.ts).
 * It exists separately only because the booking surface is unauthenticated and
 * uses bare fetch (no auth cookies).
 *
 * Security posture (this surface writes nothing to the DB and issues no
 * session, but it does reach the ABDM gateway with a user's Aadhaar):
 *   • per-IP rate-limited (tight on OTP sends),
 *   • Aadhaar/OTP arrive as plaintext over HTTPS and are RSA-encrypted
 *     server-side before leaving the process — NEVER logged or persisted,
 *   • the ABDM X-Token is held ONLY server-side (putAbhaSession); the browser
 *     only ever sees an opaque short-lived sessionId,
 *   • ABDMError is translated to a clean HTTP response by the scoped handler.
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  abhaEnrolRequestOtpSchema,
  abhaEnrolVerifyOtpSchema,
  abhaLoginRequestOtpSchema,
  abhaLoginVerifyOtpSchema,
  abhaSessionQuerySchema,
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { rateLimit } from "../middleware/rate-limit";
import { auditLog } from "../middleware/audit";
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

export const publicAbhaRouter = Router();

// Tight limits — OTP sends reach the ABDM gateway with a real Aadhaar.
const otpSendLimit = rateLimit(3, 60_000); // 3/min/IP
const otpVerifyLimit = rateLimit(6, 60_000); // 6/min/IP
const readLimit = rateLimit(20, 60_000); // 20/min/IP

// POST /public/abha/request-otp — enrolment OTP for a NEW ABHA.
publicAbhaRouter.post(
  "/request-otp",
  otpSendLimit,
  validate(abhaEnrolRequestOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { txnId } = await requestAadhaarOtp(req.body.aadhaar);
      await auditLog(req, "ABDM_ABHA_ENROL_OTP_REQUEST", "AbhaLink", undefined, {
        source: "public-booking",
        txnIdIssued: true,
      });
      res.json({ success: true, data: { txnId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /public/abha/verify-otp — verify OTP + create ABHA → profile.
publicAbhaRouter.post(
  "/verify-otp",
  otpVerifyLimit,
  validate(abhaEnrolVerifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyAadhaarOtp(req.body);
      const sessionId = result.xToken ? putAbhaSession(result.xToken) : null;
      await auditLog(req, "ABDM_ABHA_ENROL_CREATE", "AbhaLink", undefined, {
        source: "public-booking",
        abhaNumber: result.profile.abhaNumber ?? undefined,
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

// POST /public/abha/login/request-otp — login OTP for an EXISTING ABHA.
publicAbhaRouter.post(
  "/login/request-otp",
  otpSendLimit,
  validate(abhaLoginRequestOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { txnId } = await loginWithAadhaar(req.body.aadhaar);
      await auditLog(req, "ABDM_ABHA_LOGIN_OTP_REQUEST", "AbhaLink", undefined, {
        source: "public-booking",
        txnIdIssued: true,
      });
      res.json({ success: true, data: { txnId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /public/abha/login/verify-otp — verify OTP → profile (+ opaque session).
publicAbhaRouter.post(
  "/login/verify-otp",
  otpVerifyLimit,
  validate(abhaLoginVerifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyLoginOtp(req.body);
      const sessionId = putAbhaSession(result.xToken);
      const profile = result.profile ?? (await getPatientProfile(result.xToken));
      await auditLog(req, "ABDM_ABHA_LOGIN_VERIFY", "AbhaLink", undefined, {
        source: "public-booking",
        abhaNumber: profile.abhaNumber ?? undefined,
      });
      res.json({ success: true, data: { profile, sessionId }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /public/abha/profile?sessionId= — re-fetch the profile.
publicAbhaRouter.get(
  "/profile",
  readLimit,
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

// GET /public/abha/card?sessionId= — download the ABHA card (PDF).
publicAbhaRouter.get(
  "/card",
  readLimit,
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
      await auditLog(req, "ABDM_ABHA_CARD_DOWNLOAD", "AbhaLink", undefined, {
        source: "public-booking",
      });
      res.setHeader("Content-Type", card.contentType);
      res.setHeader("Content-Disposition", 'inline; filename="abha-card.pdf"');
      res.send(card.buffer);
    } catch (err) {
      next(err);
    }
  },
);

// Scope-specific error handler so ABDMError becomes a clean HTTP response
// (mirrors the translator in routes/abdm.ts).
publicAbhaRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
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
  },
);
