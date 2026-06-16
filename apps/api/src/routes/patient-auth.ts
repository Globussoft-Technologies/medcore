// Patient phone-OTP login (Pearl §5.3 / §6.1 — gap #5 piece 2 of 4).
//
// This is the auth surface for the patient PWA shipped in piece 1
// (apps/web/src/app/patient/**). It is a deliberately separate router
// from the staff /api/v1/auth router because:
//   - Patients identify by phone, not email.
//   - The credential is a short-lived 6-digit OTP delivered over SMS,
//     not a long-lived password. There is no "forgot password" flow.
//   - Patients never see TOTP / 2FA, the deactivated-tenant gate
//     applies, but the failed-login IP lockout used for staff would be
//     hostile on a shared mobile-network NAT — we rate-limit per phone
//     instead.
//
// Endpoints (both NO auth required — they ARE the auth):
//   POST /api/v1/patient-auth/otp-request
//     Validate body, look up User by canonicalised phone, mint+SMS a
//     6-digit code, persist a `PatientOtpChallenge` row (bcrypt-hashed,
//     5-min TTL). Always returns 200 — does NOT leak whether the phone
//     is registered (defence against enumeration). Rate-limited at
//     10/phone/10min via the inline `__resetPatientOtpLimiterForTests`-
//     resettable Map below. The codebase's central `rateLimit` middleware
//     is IP-keyed only, which would mis-fire for shared-NAT mobile
//     networks; per-phone bucketing is the right shape for OTP.
//
//   POST /api/v1/patient-auth/otp-verify
//     Validate body, look up the latest non-consumed non-expired challenge
//     for the phone. bcrypt-compare the code. On match: consume the
//     challenge, mint access + refresh JWTs (via the existing
//     services/jwt helpers — same algorithm + key rotation as staff),
//     set the httpOnly cookies (issue #477 contract), audit, and return.
//     5 failed verify attempts on a single challenge → 429 — the caller
//     must request a fresh code.
//
// Cleanup contract per CLAUDE.md gotcha #2: the per-phone limiter is a
// module-scope Map. `__resetPatientOtpLimiterForTests()` clears it so
// integration tests under singleFork: true don't leak buckets between
// files.

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "@medcore/db";
import {
  requestPatientOtpSchema,
  verifyPatientOtpSchema,
  firebaseVerifyPatientSchema,
  canonicalisePhone,
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { setAuthCookies } from "../middleware/auth-cookies";
import { rateLimit } from "../middleware/rate-limit";
import { signAccessToken, signRefreshToken } from "../services/jwt";
import { sendSMS } from "../services/channels/sms";
import { verifyPhoneIdToken } from "../services/firebase-admin";

const router = Router();

// ─── Per-phone rate limiter ──────────────────────────────────────────
// Pearl §5.3 specifies "OTP" without prescribing a throttle. We allow
// 10 requests / 10 min / phone (above the 3/10min industry floor, to be
// lenient on resends while still blocking SMS-bombing / runaway cost).
// We implement it inline here because the codebase's central
// `rateLimit` middleware is IP-keyed only; per-phone bucketing prevents
// a single user's misbehaviour from punishing every other patient
// behind the same NAT.
//
// TODO(future): consolidate into a per-key extension of
// middleware/rate-limit.ts once a second per-key bucket is needed.

const OTP_REQUESTS_PER_WINDOW = 10;
const OTP_WINDOW_MS = 10 * 60 * 1000;

interface PhoneBucket {
  count: number;
  resetAt: number;
}
const phoneBuckets = new Map<string, PhoneBucket>();

/**
 * Test-only escape hatch matching the auth.ts `__resetLoginLimiterForTests`
 * contract. Vitest's `singleFork: true` shares one worker across the whole
 * integration suite — without this hook, the per-phone bucket from one
 * test file leaks into the next, causing 429 cascades that look like flakes.
 */
export function __resetPatientOtpLimiterForTests(): void {
  phoneBuckets.clear();
}

/**
 * Returns `{ allowed: true }` (and increments) when the phone has not yet
 * exhausted its window, otherwise `{ allowed: false, retryAfterSeconds }`.
 * NODE_ENV=test bypass mirrors the central rateLimit middleware so the
 * integration suite is deterministic unless a test specifically opts in
 * via `ENABLE_PATIENT_OTP_RATELIMIT_IN_TESTS=true`.
 */
function checkPhoneBucket(phone: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const bypass =
    process.env.NODE_ENV === "test" &&
    process.env.ENABLE_PATIENT_OTP_RATELIMIT_IN_TESTS !== "true";
  if (bypass) return { allowed: true, retryAfterSeconds: 0 };

  const now = Date.now();
  const bucket = phoneBuckets.get(phone);
  if (!bucket || bucket.resetAt <= now) {
    phoneBuckets.set(phone, { count: 1, resetAt: now + OTP_WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count++;
  if (bucket.count > OTP_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Resolve the caller IP for audit + abuse tracking. Mirrors the same
 * x-forwarded-for handling as auth.ts so the IP recorded on
 * PatientOtpChallenge.ipAddress matches the audit log entry.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  return (
    (typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.ip) ?? "unknown"
  );
}

// ─── POST /api/v1/patient-auth/otp-request ───────────────────────────
router.post(
  "/otp-request",
  validate(requestPatientOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { phone: rawPhone } = req.body as { phone: string };
      const phone = canonicalisePhone(rawPhone);

      // Per-phone rate limit BEFORE any DB write. Returns the same
      // 200 shape on bypass so the client UI never sees the gate
      // unless it really fires.
      const gate = checkPhoneBucket(phone);
      if (!gate.allowed) {
        res.status(429).json({
          success: false,
          data: null,
          error:
            `Too many code requests for this number. Try again in ` +
            `${gate.retryAfterSeconds} seconds.`,
          retryAfterSeconds: gate.retryAfterSeconds,
        });
        return;
      }

      // Look up the User. We do NOT scope by tenant here — the caller
      // is unauthenticated, no tenant ALS is open. The User row carries
      // its own tenantId which we'll pin onto the JWT on verify.
      const user = await prisma.user.findFirst({
        where: { phone, role: Role.PATIENT, isActive: true },
        select: { id: true, tenantId: true, patient: { select: { id: true } } },
      });

      // Anti-enumeration: ALWAYS return 200 success regardless of
      // whether the phone is registered. If we don't find a User OR
      // the User has no Patient row, we skip the SMS + DB write
      // silently. The audit log still records the attempt so an
      // abuse pattern (1000 requests for non-existent phones) is
      // visible in incident analysis.
      if (!user || !user.patient) {
        await auditLog(
          req,
          "PATIENT_OTP_REQUEST_UNKNOWN_PHONE",
          "patient-auth",
          undefined,
          { phoneSuffix: phone.slice(-4) },
        );
        res.json({ success: true, data: { sent: true }, error: null });
        return;
      }

      // Generate the 6-digit code. `crypto.randomInt` is cryptographically
      // secure — Math.random() would be a real finding.
      const code = String(crypto.randomInt(100_000, 1_000_000));
      const otpHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

      await prisma.patientOtpChallenge.create({
        data: {
          phone,
          otpHash,
          expiresAt,
          tenantId: user.tenantId ?? null,
          ipAddress: clientIp(req),
        },
      });

      // Fire SMS via the existing adapter. In stub-mode (no SMS_API_KEY)
      // the adapter logs to stdout and returns ok:true — that's the
      // test mode the integration tests exercise. We don't bail on
      // SMS failure; the user can request a fresh code if SMS providers
      // are intermittently degraded.
      const smsText = `Your MedCore patient portal code: ${code} — valid 5 min. Do not share.`;
      await sendSMS(phone, smsText).catch((err) => {
        console.error("[patient-auth] SMS send failed", err);
      });

      // Audit. Phone suffix only — the full phone + the OTP itself are
      // NEVER persisted to the audit log (HIPAA / DPDP minimum-data
      // principle).
      await auditLog(
        req,
        "PATIENT_OTP_REQUEST",
        "patient-auth",
        user.id,
        { phoneSuffix: phone.slice(-4) },
      );

      res.json({ success: true, data: { sent: true }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/patient-auth/otp-verify ────────────────────────────
const MAX_VERIFY_ATTEMPTS = 5;

router.post(
  "/otp-verify",
  validate(verifyPatientOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { phone: rawPhone, otp } = req.body as {
        phone: string;
        otp: string;
      };
      const phone = canonicalisePhone(rawPhone);

      const challenge = await prisma.patientOtpChallenge.findFirst({
        where: { phone, consumed: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      });
      if (!challenge) {
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid or expired code",
        });
        return;
      }

      if (challenge.attempts >= MAX_VERIFY_ATTEMPTS) {
        res.status(429).json({
          success: false,
          data: null,
          error: "Too many attempts — request a new code",
        });
        return;
      }

      const valid = await bcrypt.compare(otp, challenge.otpHash);
      if (!valid) {
        await prisma.patientOtpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        await auditLog(
          req,
          "PATIENT_OTP_VERIFY_FAIL",
          "patient-auth",
          undefined,
          { phoneSuffix: phone.slice(-4), attempts: challenge.attempts + 1 },
        );
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid or expired code",
        });
        return;
      }

      // Mark consumed so a replay of the same code fails immediately.
      await prisma.patientOtpChallenge.update({
        where: { id: challenge.id },
        data: { consumed: true },
      });

      // Look up the User now that we've consumed. We re-query
      // (instead of trusting the request-time lookup) so a User
      // de-activated mid-flow can't sneak through.
      const user = await prisma.user.findFirst({
        where: { phone, role: Role.PATIENT, isActive: true },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          tenantId: true,
        },
      });
      if (!user) {
        // Defence-in-depth: should be unreachable because /otp-request
        // wouldn't have minted a challenge for a missing user. If it
        // does happen (race with /users PATCH /deactivate), fail the
        // verify rather than 500.
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid or expired code",
        });
        return;
      }

      // Tenant-deactivation gate, same posture as staff /auth/login.
      if (user.tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { active: true },
        });
        if (tenant && !tenant.active) {
          res.status(401).json({
            success: false,
            data: null,
            error: "Invalid or expired code",
          });
          return;
        }
      }

      // Mint the JWT pair. We mirror auth.ts's generateTokens shape
      // without `rememberMe` (patient PWA defaults to the 7-day
      // refresh window). The jti is per-token so each is independently
      // revocable via the existing blocklist.
      const jti = crypto.randomUUID();
      const accessToken = signAccessToken(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId ?? null,
          jti,
        },
        { expiresIn: "24h" },
      );
      const refreshTtlSeconds = 7 * 24 * 60 * 60;
      const refreshToken = signRefreshToken(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId ?? null,
          jti: crypto.randomUUID(),
        },
        { expiresIn: refreshTtlSeconds },
      );

      await prisma.refreshToken.create({
        data: {
          token: refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
        },
      });

      // Issue #477: cookies. The patient PWA is the canonical
      // first-party consumer — no third-party redirect flows — so the
      // same httpOnly/CSRF cookie posture used for staff applies.
      setAuthCookies(
        res,
        { accessToken, refreshToken },
        refreshTtlSeconds,
      );

      await auditLog(
        req,
        "PATIENT_OTP_VERIFY_SUCCESS",
        "patient-auth",
        user.id,
        { phoneSuffix: phone.slice(-4) },
      );

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
          accessToken,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/patient-auth/firebase-verify ───────────────────────
//
// Firebase Phone Auth exchange endpoint. The patient PWA runs Firebase
// Phone Auth in the browser (signInWithPhoneNumber → ConfirmationResult
// .confirm), receives a Firebase ID token, and POSTs it here. We verify
// the token with the firebase-admin SDK (signature, audience, issuer,
// expiry, revocation), pull the verified `phone_number` out, and use it
// — never the body — to look up the Patient User. If they exist + their
// tenant is active, mint the existing medcore_at / medcore_rt cookies
// and we're done; otherwise return a generic "Couldn't sign you in" so
// we don't leak whether a phone is registered.
//
// Security notes:
//   - Phone comes from the verified token claim, NOT from the body. A
//     malicious client cannot say "I verified phone X but log me in as
//     phone Y" — the body has only the token.
//   - Audit logs the canonical phone suffix (last 4) same as the old
//     otp-verify path so investigation tooling stays uniform.
//   - The endpoint does NOT auto-create patient User rows. If the phone
//     is not registered, the response is the same as for an invalid
//     token — defence against enumeration. Onboarding goes through the
//     existing /patient/register flow.
// Per-IP rate limiter for /firebase-verify.
//
// Why IP-keyed (not per-phone like /otp-request): we can only learn the
// phone number AFTER Firebase verifies the token, which is the expensive
// work we're trying to guard against. An attacker can't fabricate a valid
// token, but they CAN spam the endpoint with junk tokens and force us to
// burn Firebase Admin SDK quota / latency on each rejection.
//
// 20/min/IP — generous enough for a legitimate patient who fat-fingers
// the OTP a few times and re-mints, hostile enough to make brute-forcing
// pointless. Mirrors the central authLimiter's NODE_ENV=test bypass
// pattern (apps/api/src/app.ts:349) so integration tests stay
// deterministic.
//
// CodeQL js/missing-rate-limiting auto-finding from PR #1019 closure.
const firebaseVerifyLimiter =
  process.env.NODE_ENV === "test"
    ? (_: Request, __: Response, n: NextFunction) => n()
    : rateLimit(20, 60_000);

router.post(
  "/firebase-verify",
  firebaseVerifyLimiter,
  validate(firebaseVerifyPatientSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { idToken, name: bodyName, tenantId: bodyTenantId } = req.body as {
      idToken: string;
      name?: string;
      // Selected hospital — login identity is keyed on (phone + name + tenant).
      tenantId?: string;
    };
    try {
      // 1. Verify the token with Firebase Admin. Throws on any failure.
      let verified;
      try {
        verified = await verifyPhoneIdToken(idToken);
      } catch (err) {
        // Don't leak Firebase's verbose error messages — keep parity with
        // the otp-verify endpoint's generic copy so callers can't tell
        // expired-from-tampered.
        console.warn(
          `[patient-auth] firebase-verify rejected token: ${(err as Error).message}`,
        );
        res.status(401).json({
          success: false,
          data: null,
          error: "Couldn't sign you in. Please try again.",
        });
        return;
      }

      // 2. Look up the patient by canonical phone. Firebase returns E.164
      // (+919876543210); our User.phone column stores the bare 10-digit
      // canonical form for accounts created after the register-side
      // canonicalisation fix landed. Legacy rows (pre-fix) still hold the
      // as-typed E.164 / spaced / +91-prefixed string the patient entered
      // at signup. We try both shapes so those accounts can still sign in
      // — Firebase has already authoritatively proven possession of the
      // phone, so widening the WHERE adds no enumeration risk: the only
      // info we leak is whether SOME row matches, which is the same signal
      // a successful sign-in would carry.
      const canonical = canonicalisePhone(verified.phoneNumber);
      const rawE164 = verified.phoneNumber; // e.g. "+919876543210"
      const phoneCandidates = Array.from(
        new Set([canonical, rawE164, rawE164.replace(/^\+/, "")]),
      );
      // Identity is keyed on (phone + name) — duplicate phones are allowed,
      // so a single phone may map to several patient accounts (a family
      // sharing one number). Firebase proved possession of the PHONE, but
      // not WHICH account, so we use the name the login form supplied to
      // pick the right chart. Name match is case-insensitive.
      //   - name provided  → match (phone IN candidates) AND name = bodyName
      //   - name omitted   → match phone only (back-compat / single-account)
      // If the phone has multiple accounts and the name doesn't single one
      // out, the lookup returns null and we respond with the same generic
      // "couldn't sign you in" (no enumeration leak, and no silently logging
      // the user into the wrong chart).
      const trimmedName = (bodyName ?? "").trim();
      // Validate the selected hospital (must be a real, active tenant) so a
      // forged/stale id can't scope the lookup to a suspended org. When the
      // form sends no hospital we fall back to phone+name only (back-compat).
      let scopedTenantId: string | null = null;
      if (bodyTenantId && bodyTenantId.trim()) {
        const t = await prisma.tenant.findUnique({
          where: { id: bodyTenantId.trim() },
          select: { id: true, active: true },
        });
        if (t?.active) scopedTenantId = t.id;
      }
      // Login identity is keyed on (phone + name + tenant). The patient must
      // already exist IN THE SELECTED hospital — no auto-create on login.
      const baseWhere = {
        phone: { in: phoneCandidates },
        role: Role.PATIENT,
        ...(trimmedName
          ? { name: { equals: trimmedName, mode: "insensitive" as const } }
          : {}),
        ...(scopedTenantId ? { tenantId: scopedTenantId } : {}),
      };
      const matches = await prisma.user.findMany({
        where: baseWhere,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          tenantId: true,
        },
        take: 2, // we only need to know "exactly one" vs "ambiguous".
      });
      // Exactly one match → that account. Zero or >1 (ambiguous, e.g. a phone
      // with multiple accounts and no name supplied) → treat as no-match.
      let user = matches.length === 1 ? matches[0] : null;
      // Keep `phone` defined for the downstream audit-log payload (suffix
      // is what gets logged, so canonical vs. raw doesn't matter beyond
      // pinning to a single value).
      const phone = canonical;

      // Identity rule (2026-06): (phone + name + selected hospital) must
      // already match an EXISTING patient — login no longer auto-creates an
      // account. When nothing matches we tell the user explicitly to
      // register. NOTE: this is a deliberate trade-off — the message reveals
      // whether a (phone+name) is registered at the chosen hospital, chosen
      // over the prior generic anti-enumeration response for clearer UX.
      if (!user) {
        await auditLog(
          req,
          "PATIENT_LOGIN_NO_ACCOUNT",
          "patient-auth",
          undefined,
          {
            phoneSuffix: phone.slice(-4),
            tenantId: scopedTenantId,
            ambiguous: matches.length > 1,
          },
        );
        // 404 = "no such account here". The web form surfaces this message
        // inline with a link to /patient/register.
        res.status(404).json({
          success: false,
          data: null,
          error:
            "You don't have an account at the selected hospital. Please register first.",
          code: "NO_ACCOUNT",
        });
        return;
      }

      // 3. Honour the deactivated-tenant gate the otp-verify route uses.
      if (user.tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { active: true },
        });
        if (tenant && !tenant.active) {
          res.status(401).json({
            success: false,
            data: null,
            error: "Couldn't sign you in. Please try again.",
          });
          return;
        }
      }

      // 4. Mint the JWT pair + cookie set — identical to otp-verify's
      // happy path so the rest of the patient surface (audit, refresh
      // rotation, cookie posture) keeps behaving exactly the same.
      const jti = crypto.randomUUID();
      const accessToken = signAccessToken(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId ?? null,
          jti,
        },
        { expiresIn: "24h" },
      );
      const refreshTtlSeconds = 7 * 24 * 60 * 60;
      const refreshToken = signRefreshToken(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId ?? null,
          jti: crypto.randomUUID(),
        },
        { expiresIn: refreshTtlSeconds },
      );

      await prisma.refreshToken.create({
        data: {
          token: refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
        },
      });

      setAuthCookies(res, { accessToken, refreshToken }, refreshTtlSeconds);

      await auditLog(
        req,
        "PATIENT_FIREBASE_VERIFY_SUCCESS",
        "patient-auth",
        user.id,
        {
          phoneSuffix: phone.slice(-4),
          firebaseUid: verified.uid,
        },
      );

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            phone,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as patientAuthRouter };
