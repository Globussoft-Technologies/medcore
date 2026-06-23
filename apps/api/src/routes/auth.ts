import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@medcore/db";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  sanitizeUserInput,
  isCommonPassword,
  containsHtmlOrScript,
  canonicalisePhone,
  canonicaliseName,
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  resolveMrPrefix,
  nextMrSeq,
  mrCounterKey,
  formatMrNumber,
} from "../services/mr-number";
// Issue #477 (May 2026): JWTs are set as httpOnly cookies + a non-httpOnly
// CSRF cookie on login/register/refresh/2fa-verify. See
// middleware/auth-cookies.ts for the locked attribute matrix.
import { setAuthCookies, clearAuthCookies } from "../middleware/auth-cookies";
// Issue #456: scope per-user audit reads (/failed-logins, /my-activity)
// through the tenant wrapper so a user never sees rows that originated in
// another tenant — even if their userId somehow collided historically.
import { tenantScopedPrisma } from "../services/tenant-prisma";
// Issue #482: algorithm-agnostic JWT helpers. signAccessToken/signRefreshToken
// route through services/jwt.ts so the algorithm + key are env-driven and
// the rotation cutover (RS256 with HS256 fallback) is centrally controlled.
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
} from "../services/jwt";
import { rateLimit } from "../middleware/rate-limit";
import {
  checkLockout,
  recordFailedLogin,
  clearFailedLogins,
} from "../services/auth-lockout";
import {
  generateSecret,
  verifyTOTP,
  buildOtpAuthUri,
  generateBackupCodes,
} from "../services/totp";
// Resolve a stored photo key/data-URL into a displayable URL. /auth/me
// stores the BARE key on User.photoUrl; the profile pages render it in an
// <img>, so it must be resolved (signed) on read — same as the patient
// endpoints do for Patient.photoUrl.
import { resolvePatientPhotoUrl } from "../lib/patient-photo";

/**
 * Resolve the caller's IP for lockout / audit purposes. Mirrors the same
 * x-forwarded-for handling the rate limiter and audit logger use so the
 * three layers always agree on which IP they're talking about.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  return (
    (typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.ip) ?? "unknown"
  );
}

/**
 * Per-route limiters. Issues #124, #125, #128, #478:
 *   • /login — 5/min/IP (issue #478, May 2026, tightened from 20/min).
 *     The 20/min bucket allowed ~100 attempts in a few seconds via burst
 *     traffic, since the bucket is per-minute and an attacker can wait
 *     out the window. 5/min is the OWASP-recommended floor for password
 *     login on consumer apps, complemented by the IP-failed-login lockout
 *     in services/auth-lockout.ts (which fires on REPEATED FAILURES, not
 *     total volume — the two work together).
 *   • /forgot-password — 5/min/IP (separate from login so a stuck reset flow
 *     doesn't lock a user out of logging in).
 * Both no-op in NODE_ENV=test to keep the integration suite deterministic,
 * unless ENABLE_LOGIN_RATELIMIT_IN_TESTS=true is set — used by the
 * #478 regression test to prove the limiter actually fires.
 *
 * The login limiter is wrapped in a lazy delegate so the env-var check
 * happens at first request time, not at module-import time. The #478
 * regression test sets ENABLE_LOGIN_RATELIMIT_IN_TESTS=true after the
 * test file's first import of `app.ts`, so an eagerly-constructed limiter
 * would already be locked in as a no-op.
 */
let _loginLimiterImpl: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
const loginLimiter = (req: Request, res: Response, next: NextFunction): void => {
  if (!_loginLimiterImpl) {
    _loginLimiterImpl = rateLimit(5, 60_000, {
      enableInTests: process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS === "true",
    });
  }
  _loginLimiterImpl(req, res, next);
};

/**
 * Test-only escape hatch: reset the cached login limiter so the next
 * request reconstructs it with the current env. Used by the `#478`
 * regression test in `auth.test.ts` so its `afterAll` can drop the real
 * limiter (and its accumulated 127.0.0.1 quota) before subsequent
 * integration tests in the same vitest worker call `/auth/login`.
 *
 * `singleFork: true` in `vitest.config.ts` shares this module across
 * every integration test file — without this hook, the rate-limit test's
 * env-flag-flipped real limiter persisted as a 5/min IP gate that
 * cascaded 429s into auth-edges / auth-session-bleed / users tests.
 */
export function __resetLoginLimiterForTests(): void {
  _loginLimiterImpl = null;
}
const forgotPasswordLimiter =
  process.env.NODE_ENV === "test"
    ? (_: Request, __: Response, n: NextFunction) => n()
    : rateLimit(5, 60_000);

// security(2026-04-23-low): CSRF considerations.
// MedCore currently authenticates via `Authorization: Bearer <JWT>` headers
// only — there is no session cookie issued by the API. Because browsers do
// not auto-attach bearer headers on cross-origin requests, all state-changing
// endpoints are safe from classic CSRF without a token. IF a future rollout
// moves to cookie-based auth (e.g. HTTP-only refresh cookie), CSRF protection
// MUST be added here before enabling it: either SameSite=Strict cookies plus
// a double-submit token, or a CSRF middleware (e.g. csurf) gating every
// mutating route. Until then, CSRF is N/A by design.
const router = Router();

// 2FA temp tokens are persisted to Postgres so they survive process restarts
// and behave correctly when the API runs across multiple instances.
async function issueTempToken(userId: string): Promise<string> {
  const token =
    crypto.randomBytes(24).toString("hex") + Date.now().toString(36);
  await prisma.twoFactorTempToken.create({
    data: {
      token,
      userId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min
    },
  });
  return token;
}
async function consumeTempToken(token: string): Promise<string | null> {
  const entry = await prisma.twoFactorTempToken.findUnique({ where: { token } });
  if (!entry || entry.usedAt || entry.expiresAt < new Date()) {
    if (entry) {
      // Best-effort cleanup of expired/used row.
      await prisma.twoFactorTempToken
        .delete({ where: { id: entry.id } })
        .catch(() => undefined);
    }
    return null;
  }
  // Single-use: delete on consume so a replay cannot succeed.
  await prisma.twoFactorTempToken
    .delete({ where: { id: entry.id } })
    .catch(() => undefined);
  return entry.userId;
}

// Same shape as consumeTempToken but DOES NOT delete the row. Used by
// the enrol-setup endpoint so an operator can refresh the page (or
// hit Back) and re-fetch the QR code without burning the token —
// only enrol-verify consumes the token (single-shot on success).
async function peekTempToken(token: string): Promise<string | null> {
  const entry = await prisma.twoFactorTempToken.findUnique({ where: { token } });
  if (!entry || entry.usedAt || entry.expiresAt < new Date()) return null;
  return entry.userId;
}

/**
 * Sign an access + refresh JWT pair. The `tenantId` claim is written into
 * both tokens so the refresh-token exchange can repopulate it without needing
 * another DB round-trip, and the tenant middleware can resolve the caller's
 * tenant on every authenticated request.
 *
 * Pass `null` to represent a global/admin user that does not belong to any
 * tenant. Pass `undefined` only when the call site has not yet loaded the
 * user record (this is an internal fallback — all public auth flows must
 * fetch the user and pass the real value).
 */
/**
 * Issue #1 — "Remember me" refresh-token TTL.
 *
 * When the login request passes `rememberMe: true` we mint a refresh token
 * valid for 30 days instead of the 7-day default. The access-token TTL
 * stays at 24h in both cases (any change there would widen the blast radius
 * of a stolen bearer token, which the 2026-04-23 audit explicitly kept at
 * 24h — see note below).
 *
 * Returning the expiry in seconds lets the caller persist the matching DB
 * row with the same lifetime — keeping `RefreshToken.expiresAt` and the
 * JWT `exp` claim in lockstep so the DB lookup and JWT verification don't
 * disagree about when a token is dead.
 */
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (default)
const REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function generateTokens(
  userId: string,
  // #891 (May 2026): nullable. A walk-in patient registered without an
  // email is still a valid identity that can be authenticated through
  // non-email flows (admin-set password, OTP-by-phone — future); the
  // JWT just carries `null` in the email claim and email-keyed surfaces
  // (forgot-password lookup) naturally don't find a row to match.
  email: string | null,
  role: string,
  tenantId: string | null | undefined,
  rememberMe: boolean = false
) {
  const jti = crypto.randomUUID();
  // Normalise undefined → null so downstream consumers see an explicit signal.
  // `jwt.sign` drops undefined keys silently which would make this ambiguous
  // with legacy-token detection in middleware/auth.ts.
  const tid: string | null = tenantId ?? null;
  // security(2026-04-23-med): session-TTL audit — the 2026-04-23 security
  // review did not flag this TTL as a finding (JWT verification was a
  // documented non-finding in that audit). The 24h access / 7d refresh window is
  // intentional for clinical-shift usage (typical shift 8–12h, weekly rotation)
  // and matches MedCore's audit-log retention. Shorter access windows were
  // considered but add friction in ward-side tablets where re-auth during a
  // resuscitation is unsafe; tokens are also invalidated server-side via the
  // `jti` blocklist on password reset / 2FA changes. Leaving unchanged.
  //
  // Issue #1: access-token TTL intentionally NOT extended by rememberMe — a
  // compromised access token should still expire within 24h regardless of
  // the user's session-persistence preference.
  const accessToken = signAccessToken(
    { userId, email, role, tenantId: tid, jti },
    { expiresIn: "24h" }
  );
  const refreshTtlSeconds = rememberMe
    ? REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS
    : REFRESH_TOKEN_TTL_SECONDS;
  const refreshToken = signRefreshToken(
    { userId, email, role, tenantId: tid, jti: crypto.randomUUID() },
    { expiresIn: refreshTtlSeconds }
  );
  return { accessToken, refreshToken, refreshTtlSeconds };
}

/**
 * The tenant id of an authenticated, tenant-bound ADMIN making the request,
 * or null. Used by resolveRegistrationTenant so a tenant-scoped admin's new
 * staff land in the admin's OWN tenant (not the `default` tenant) even on a
 * bare host with no subdomain. SUPER_ADMIN (tenantId=null) returns null and
 * falls through to the explicit body/header tenant choice.
 */
function authenticatedStaffTenantId(req: Request): string | null {
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.medcore_at;
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ")
    ? header.split(" ")[1]
    : undefined;
  const token = cookieToken || headerToken;
  if (!token) return null;
  try {
    const decoded = verifyAccessToken<{ role?: string; tenantId?: string | null }>(
      token,
    );
    if (decoded.role === "ADMIN" && decoded.tenantId) {
      return decoded.tenantId;
    }
  } catch {
    // Invalid/expired token → treat as no staff context.
  }
  return null;
}

/**
 * Resolve the tenant a new registration should be scoped to.
 *
 * Priority:
 *   1. `X-Tenant-Id` header — direct override for admin tooling / API
 *      clients that know the tenant id already.
 *   2. Subdomain resolution — `<subdomain>.medcore.globusdemos.com` maps to
 *      `Tenant.subdomain`.
 *   3. The seeded `default` tenant — for direct IP access, localhost dev,
 *      or hosts that do not match our subdomain scheme.
 *
 * Returns `null` when no tenant is found (e.g. the `default` tenant has not
 * been seeded yet). Callers should tolerate `null` since `User.tenantId` is
 * optional and the tenant middleware handles absent tenant as pass-through.
 */
async function resolveRegistrationTenant(
  req: Request,
  bodyTenantId?: string,
): Promise<string | null> {
  // 0a. Authenticated ADMIN staff-creation: the new user belongs to the
  //     CREATING admin's own tenant — authoritative, above everything else.
  //     Only returns non-null for a logged-in ADMIN, so the public patient
  //     self-registration flow (no admin token) falls straight through to the
  //     body-choice logic below. Fixes doctors/staff silently landing in the
  //     `default` tenant when an admin on a bare host (localhost, no subdomain)
  //     creates them (June 2026).
  const staffTenantId = authenticatedStaffTenantId(req);
  if (staffTenantId) {
    const t = await prisma.tenant.findUnique({
      where: { id: staffTenantId },
      select: { id: true, active: true },
    });
    if (t?.active) return t.id;
  }

  // 0b. Explicit patient choice from the registration form ("Select
  //    Hospital / Clinic"). Highest priority for SELF-registration — when a
  //    patient self-registers they pick the tenant their account belongs to.
  //    Validated active so a stale/forged id can't pin the account to a
  //    suspended hospital.
  if (bodyTenantId && bodyTenantId.trim().length > 0) {
    const t = await prisma.tenant.findUnique({
      where: { id: bodyTenantId.trim() },
      select: { id: true, active: true },
    });
    if (t?.active) return t.id;
  }

  // 1. Explicit header override.
  const headerTenant = req.header("X-Tenant-Id");
  if (headerTenant && headerTenant.trim().length > 0) {
    const t = await prisma.tenant.findUnique({
      where: { id: headerTenant.trim() },
      select: { id: true, active: true },
    });
    if (t?.active) return t.id;
  }

  // 2. Subdomain resolution off the Host header.
  //    `patient-portal.medcore.globusdemos.com` → subdomain = "patient-portal".
  //    We only treat the leading label as a subdomain when it is NOT the
  //    apex ("medcore"), to avoid accidentally pinning the apex to a tenant
  //    of the same name.
  const host = (req.headers.host || "").toLowerCase().split(":")[0];
  if (host.endsWith(".medcore.globusdemos.com")) {
    const subdomain = host.slice(0, host.length - ".medcore.globusdemos.com".length);
    if (subdomain && subdomain !== "www") {
      const t = await prisma.tenant.findUnique({
        where: { subdomain },
        select: { id: true, active: true },
      });
      if (t?.active) return t.id;
    }
  }

  // 3. Fall back to the seeded `default` tenant.
  const fallback = await prisma.tenant.findUnique({
    where: { subdomain: "default" },
    select: { id: true, active: true },
  });
  return fallback?.active ? fallback.id : null;
}

/**
 * Issue #473 (CRITICAL, May 2026): mass-assignment role check.
 *
 * `/auth/register` serves two distinct callers:
 *   1. Unauthenticated patient self-registration (the public flow).
 *   2. Authenticated admin staff creation (the dashboard /users page).
 *
 * Before this fix the handler trusted `req.body.role` blindly, so the public
 * flow could POST `{ ..., role: "ADMIN" }` and silently get an admin account.
 * Fixed by inspecting the (optional) Bearer token here: only an authenticated
 * ADMIN may set a non-PATIENT role. Anyone else — including unauthenticated
 * callers, expired/invalid tokens, and any non-ADMIN role — is coerced to
 * PATIENT regardless of what was submitted.
 *
 * Returns the role the new user should be created with. NEVER returns the
 * raw `req.body.role` to the caller.
 */
function resolveRegistrationRole(req: Request, requestedRole: unknown): Role {
  const PUBLIC_DEFAULT: Role = Role.PATIENT;
  const allowedRoles: Record<string, Role> = {
    ADMIN: Role.ADMIN,
    DOCTOR: Role.DOCTOR,
    RECEPTION: Role.RECEPTION,
    NURSE: Role.NURSE,
    PATIENT: Role.PATIENT,
    PHARMACIST: Role.PHARMACIST,
    LAB_TECH: Role.LAB_TECH,
  };

  // No role requested (or unknown role string) → public default.
  if (typeof requestedRole !== "string" || !(requestedRole in allowedRoles)) {
    return PUBLIC_DEFAULT;
  }
  const resolved = allowedRoles[requestedRole];
  // Patients are always allowed to self-register as PATIENT — no auth needed.
  if (resolved === Role.PATIENT) return Role.PATIENT;

  // Anything else requires the caller to be an authenticated ADMIN.
  // We do an in-line, best-effort token decode here (the route is otherwise
  // unauthenticated, so we can't bolt on `authenticate` middleware without
  // breaking the public flow). Any decode/role failure → coerce to PATIENT.
  //
  // Issue #991: read BOTH the httpOnly `medcore_at` cookie (the post-#477
  // primary storage for the access token) AND the legacy `Authorization:
  // Bearer ...` header. Previously this only looked at the header; the
  // web Create-Staff form lets the browser send the cookie automatically
  // (api.ts uses credentials:"include") and never adds the header — so
  // every staff-creation POST got demoted to PATIENT, which then tripped
  // the PATIENT-only address + emergencyContact gate below and returned
  // 400 with messages for fields the staff form deliberately doesn't
  // collect.
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.medcore_at;
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ")
    ? header.split(" ")[1]
    : undefined;
  const token = cookieToken || headerToken;
  if (!token) return PUBLIC_DEFAULT;
  try {
    // Issue #482: algorithm-agnostic — services/jwt.ts.
    const decoded = verifyAccessToken<{ role?: string }>(token);
    if (decoded.role === "ADMIN" || decoded.role === "SUPER_ADMIN") {
      return resolved;
    }
  } catch {
    // Fall through.
  }
  return PUBLIC_DEFAULT;
}

/**
 * True when the request carries a valid access token for an ADMIN or
 * SUPER_ADMIN. Used by /register to tell an admin CREATING an account on
 * someone else's behalf (must keep the admin's OWN session) apart from
 * public self-registration (where the brand-new user should be logged in).
 *
 * Without this gate, /register set the new user's session cookies on the
 * response — so a super-admin who created a doctor was silently "logged in"
 * as that doctor on the next refresh, and the staff list then rendered as
 * the doctor (blank rows / wrong account).
 */
function callerIsAuthenticatedAdmin(req: Request): boolean {
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.medcore_at;
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ")
    ? header.split(" ")[1]
    : undefined;
  const token = cookieToken || headerToken;
  if (!token) return false;
  try {
    const decoded = verifyAccessToken<{ role?: string }>(token);
    return decoded.role === "ADMIN" || decoded.role === "SUPER_ADMIN";
  } catch {
    return false;
  }
}

// ─── Hardening schemas (Issues #706, #707, #708, #712, #713) ──────────────
//
// These schemas extend the ones imported from `@medcore/shared` with the
// stricter rules surfaced in the May 2026 production-bug sweep. We compose
// at the route layer (rather than mutating the shared schemas) so the
// existing schema unit tests in packages/shared don't have to be re-baselined
// in lockstep, and so the rules read top-to-bottom alongside the route
// handler that enforces them.
//
//   • #706 — register password floor lifts from 8 → 12 characters and the
//     denylist (already in `validatePasswordStrength`) keeps blocking
//     "password", "12345678", etc.
//   • #707 — register age range tightens from [1, 150] → [0, 130].
//   • #708 — register email uses a regex that rejects "abc", "a@", "a@b",
//     "@b.com", "a b@c.com" — the bare zod `.email()` was lax on some of
//     those edges (notably "a@b" and trailing whitespace).
//   • #712 — same strict-email rule on /forgot-password.
//   • #713 — phone, address, and emergencyContact required for PATIENT
//     self-registration (still optional for staff-creation flows where an
//     authenticated ADMIN is filling the form on behalf of someone else).

// Issues #708 + #712: explicit format regex. zod 3.24's `.email()` is
// reasonably strict but accepts a couple of edge cases ("a@b" and addresses
// with embedded whitespace once the global strip middleware touches them).
// This regex is the one the registration form's client-side validator already
// uses, so we keep server-side and client-side in lockstep.
const STRICT_EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const strictEmail = z
  .string()
  .trim()
  .refine((v) => STRICT_EMAIL_REGEX.test(v), {
    message: "Invalid email address",
  });

// Issue #713: phone in E.164-ish form — 10–15 digits with an optional leading
// "+" and tolerant of spaces/dashes that humans type. Mirrors the same regex
// already used by `updateProfileSchema` for /auth/me phone updates.
const PHONE_REGEX = /^[+]?[\d\s-]{10,15}$/;

// Issues #284, #666, #686, #667, #687 (May 2026): Add Staff User name field
// accepted SQL-injection-style (`Robert'); DROP TABLE--`, `1' OR '1'='1`) and
// raw `<script>` payloads. The shared `registerSchema` already refines against
// `containsHtmlOrScript`, which catches HTML/script vectors but PASSES strings
// like `Robert'); DROP TABLE--` because none of the XSS patterns match. We
// layer a strict character-class regex on top so only letters (Latin +
// Devanagari per CLAUDE.md gotcha #8), whitespace, and the three punctuation
// marks legitimate names actually use (".", "-", "'") are accepted. This
// rejects digits, parentheses, semicolons, equals signs, asterisks, and every
// other character common in injection payloads. The `containsHtmlOrScript`
// refine stays in force as defence in depth (it would catch `&lt;script&gt;`
// HTML-entity smuggling, which the regex would also reject — belt + braces).
const PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/;
const strictStaffName = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name must be at most 100 characters")
  .regex(
    PATIENT_NAME_REGEX,
    "Name contains invalid characters — letters, spaces, '.', '-' and \"'\" only"
  )
  .refine((v) => !containsHtmlOrScript(v), {
    message:
      "Name contains characters that aren't allowed (e.g. < > or HTML tags)",
  });

// Issue #706: bump the floor from 8 to 12 characters at the registration
// surface specifically. Login still accepts the legacy 6-char rule (so
// pre-#266 accounts can sign in to change their password); /change-password
// + /reset-password keep the shared `strongPassword` (>=8) — only public
// /register tightens to 12. The denylist check is the same `isCommonPassword`
// already used by the shared rule.
const strictRegisterPassword = z
  .string()
  // Floor relaxed 12 → 6 (2026-06): patient self-registration password
  // minimum lowered per product. Letter+digit + common-password denylist
  // are kept so it's not trivially weak.
  .min(6, "Password must be at least 6 characters")
  .refine((pw) => /[A-Za-z]/.test(pw), {
    message: "Password must contain at least one letter",
  })
  .refine((pw) => /\d/.test(pw), {
    message: "Password must contain at least one digit",
  })
  .refine((pw) => !isCommonPassword(pw), {
    message:
      "This password is too common — please choose a less predictable password",
  });

// Issue #713: emergency-contact block. Required for PATIENT registration; the
// route handler enforces presence post-parse (see register handler). We keep
// the field-level shape here so a malformed sub-object (e.g. empty name,
// short phone) is rejected with a proper field-shaped error.
const emergencyContactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Emergency contact name is required")
    .max(100, "Emergency contact name must be at most 100 characters"),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Emergency contact phone must be 10–15 digits"),
  relationship: z
    .string()
    .trim()
    .min(1, "Emergency contact relationship is required")
    .max(50, "Emergency contact relationship must be at most 50 characters"),
});

// Issues #706, #707, #708, #713 composed: the strict register schema. We
// `extend()` the shared `registerSchema` so existing rules (XSS-in-name,
// role enum, etc.) stay in force, and overlay the tightened fields.
//
// Issues #284, #666, #686, #667, #687 (May 2026): the staff-creation form
// (Add Staff User on /dashboard/users) POSTs to this same /auth/register
// endpoint with a Bearer admin token. We replace the `name` field with the
// strict regex-based `strictStaffName` so SQL-injection-style payloads
// (`Robert'); DROP TABLE--`, `1' OR '1'='1`) and `<script>...</script>` XSS
// vectors are rejected with a 400 BEFORE they ever touch prisma.user.create.
const strictRegisterSchema = registerSchema
  .extend({
    name: strictStaffName,
    email: strictEmail,
    phone: z
      .string()
      .trim()
      .regex(PHONE_REGEX, "Phone must be 10–15 digits, optional leading +"),
    password: strictRegisterPassword,
    // Issue #707: tightened to [0, 130] — newborn (age=0) is now valid via
    // the public registration body for the rare case a parent self-registers
    // a same-day birth. 200 / negatives stay rejected.
    age: z
      .number()
      .int("Age must be a whole number")
      .min(0, "Age must be at least 0")
      .max(130, "Age must be at most 130")
      .optional(),
    // Issue #713: address required for PATIENT (verified post-parse since the
    // schema can't see the resolved role yet — the role is set by
    // `resolveRegistrationRole` after auth-token decode).
    address: z
      .string()
      .trim()
      .min(5, "Address must be at least 5 characters")
      .max(500, "Address must be at most 500 characters")
      .optional(),
    // SOW §2.1.1 address triplet — city/state captured at registration.
    // Optional; legacy clients that don't send them stay valid.
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    pincode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "PIN code must be 6 digits")
      .optional()
      .or(z.literal("")),
    // SOW §2.1.1 — optional ABHA address capture at registration. Stored as a
    // placeholder on Patient.abhaId; the full OTP-verified link flow lives on
    // the ABHA page (services/abdm). Optional by design.
    abhaId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9]+$/, "ABHA address must look like handle@domain")
      .optional()
      .or(z.literal("")),
    emergencyContact: emergencyContactSchema.optional(),
    // Issue #617: optional DOB + T&C consent on the public /register surface.
    // Both are sent by the web register form but kept optional so older clients
    // (mobile app, dashboard staff-creation) keep working unchanged. The web
    // form's client-side validator gates submit on both being present so the
    // required-on-the-wire contract is enforced upstream of the API.
    //   - dateOfBirth: ISO calendar date (YYYY-MM-DD). Persisted onto Patient.dateOfBirth.
    //   - acceptedTerms: literal `true` — submitting the body without ticking
    //     the checkbox sends `false` which the literal rejects with a 400.
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD")
      .optional(),
    acceptedTerms: z.literal(true).optional(),
    // Optional profile photo for self-registration. The registrant is
    // logged OUT, so they can't use the authed POST /uploads pipeline —
    // instead the photo arrives as an inline base64 image data URL and is
    // stored directly on Patient.photoUrl (data URLs never expire and need
    // no signing). Constrained to JPEG/PNG/WEBP and ~1.4MB encoded
    // (≈1MB raw — plenty for an avatar) so an anonymous caller can't dump
    // arbitrary blobs into the row. The web form downscales before sending.
    photoUrl: z
      .string()
      .regex(
        /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/,
        "Photo must be a JPEG, PNG, or WEBP image",
      )
      .max(1_400_000, "Photo is too large (max ~1MB)")
      .optional()
      .or(z.literal("")),
  });

// Issue #712: forgot-password schema with the strict email refine on top of
// the existing `forgotPasswordSchema` shape (which only carries `email`).
const strictForgotPasswordSchema = forgotPasswordSchema.extend({
  email: strictEmail,
});

// Issue #623 (May 2026): Pharmacist (and every other authed role)'s
// /auth/change-password used `strongPassword` (>=8 chars + letter/digit +
// denylist) for the new password. This was only marginally stronger than the
// 6-char floor a few users reported being able to set, and well below the
// 12-char floor /register now requires for new accounts. The bug report
// surfaced two related concerns:
//
//   1. The new-password rule was too loose for clinical roles with PHI access.
//      Trivially weak passphrases (`abcdef`, `password1`, `qwerty12`) could be
//      set on the change-password surface even after the 12-char floor lifted
//      on /register.
//   2. The handler ran the bcrypt check on `currentPassword` BEFORE the new
//      password was validated, so a user submitting (wrong-current, weak-new)
//      saw "Current password is incorrect" — masking the more actionable
//      "New password is too weak" message.
//
// Fix: extend the shared `changePasswordSchema` with the same
// `strictRegisterPassword` rule the /register surface uses. Zod's `validate(…)`
// middleware runs BEFORE the route handler, so a weak new password is now
// rejected with the field-shaped 400 first — before any bcrypt comparison —
// regardless of whether the current password is right or wrong. (The handler
// itself does not need re-ordering because Zod already runs first; we keep
// the bcrypt-then-update flow downstream of the schema gate.)
const strictChangePasswordSchema = changePasswordSchema.extend({
  newPassword: strictRegisterPassword,
});

// Issue #714: zod 3.x strips unknown keys by default. Extend the imported
// `loginSchema` so `next` is recognised in the body and survives validation
// (otherwise the open-redirect sanitizer below would always see undefined
// for body-supplied `next`). Optional + string-only — anything else is
// dropped, then `sanitizeNextPath` returns the safe default.
const strictLoginSchema = loginSchema.extend({
  next: z.string().optional(),
});

/**
 * Issue #714 (May 2026): open-redirect sanitizer for the login `?next=` flow.
 *
 * The web client redirects unauthenticated users to `/login?next=<orig>` and
 * uses the `next` value to bounce them back after login. If the client (or a
 * future server-side login endpoint) treats `next` as a destination URL
 * without sanitizing, an attacker's phishing page can be reached via:
 *
 *   /login?next=https://evil.example.com/harvest
 *   /login?next=//evil.example.com/harvest        (protocol-relative)
 *   /login?next=\\\\evil.example.com\\harvest     (Windows UNC variant)
 *
 * `sanitizeNextPath` returns "/dashboard" for any of those vectors and
 * passes through legitimate same-origin paths ("/dashboard/patients",
 * "/billing") unchanged. The server uses this helper anywhere it accepts a
 * `next`-style parameter; the web client should call the same helper on the
 * client side before navigating (see Lane B note below).
 *
 * NOTE FOR LANE B / web team: the actual `next=` consumption today lives in
 * apps/web/src/app/login/page.tsx (and apps/web/src/lib/api.ts which sets
 * the cookie's stash on 401). Mirror this exact rule there before passing
 * `next` to `router.push()` / `window.location.replace()`. The server-side
 * helper here is exported so the web bundle can import it directly via
 * `@medcore/api-helpers` once that re-export is wired up.
 */
export function sanitizeNextPath(next: unknown): string {
  const SAFE_DEFAULT = "/dashboard";
  if (typeof next !== "string") return SAFE_DEFAULT;
  const trimmed = next.trim();
  if (trimmed.length === 0) return SAFE_DEFAULT;
  // Reject Windows UNC / backslash variants outright — these can be coerced
  // by some browsers into protocol-relative navigations.
  if (trimmed.includes("\\")) return SAFE_DEFAULT;
  // Must be a relative path anchored at the site root.
  if (!trimmed.startsWith("/")) return SAFE_DEFAULT;
  // Reject protocol-relative URLs ("//evil.example.com/harvest").
  if (trimmed.startsWith("//")) return SAFE_DEFAULT;
  // Reject absolute http(s) URLs even if they somehow start with "/" after
  // a malformed prefix — belt-and-braces.
  if (/^https?:/i.test(trimmed)) return SAFE_DEFAULT;
  return trimmed;
}

// POST /api/v1/auth/register
//
// Issues #480 (anti-enumeration) + #489 (XSS in name) + #473 (mass-assignment),
// rolled together May 2026:
//
//   • #480: pre-fix the duplicate-email path returned `409 { error: "Email
//     already registered" }` while the new-email path returned `201` with a
//     token pair. An attacker could iterate a list of emails and learn which
//     were registered. Post-fix, both paths return the SAME shape — a generic
//     202 envelope with `{ success: true, data: { message: "..." }, error: null }`
//     — mirroring the /forgot-password anti-enumeration pattern. New users
//     still complete signup via /auth/login on the very next request (the
//     password they just set is valid). Existing accounts are silently NOT
//     created on the duplicate path, but the response is indistinguishable.
//   • #489: `name` is sanitized via the canonical `sanitizeUserInput()`
//     helper as a second pass — the schema already rejects HTML/script via
//     `containsHtmlOrScript`, but the sanitizer normalizes whitespace and
//     enforces the same maxLength so what lands in the DB is exactly what
//     downstream renderers expect.
// POST /api/v1/auth/check-availability — does this email / phone already
// exist? Used by the patient register form on the "Continue" step so the
// user is told up-front instead of failing at submit. Rate-limited
// (10/min/IP) to soften the account-enumeration surface this exposes.
router.post(
  "/check-availability",
  rateLimit(10, 60_000),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const emailRaw =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const phoneRaw =
        typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
      const nameRaw =
        typeof req.body?.name === "string" ? canonicaliseName(req.body.name) : "";
      const bodyTenantId =
        typeof req.body?.tenantId === "string" ? req.body.tenantId.trim() : "";

      // Mirror the register handler's PER-TENANT patient uniqueness rules so
      // the inline pre-check matches what submit actually enforces:
      //   • email      → unique within the chosen tenant (Patient.contactEmail)
      //   • phone      → NOT unique on its own (no phone-alone flag)
      //   • name+phone → unique together within the chosen tenant
      const tenantId = await resolveRegistrationTenant(req, bodyTenantId);

      let emailTaken = false;
      let namePhoneTaken = false;

      if (emailRaw) {
        const trimmed = emailRaw.toLowerCase();
        const dup = await prisma.patient.findFirst({
          where: {
            tenantId,
            mergedIntoId: null,
            contactEmail: { equals: trimmed, mode: "insensitive" },
          },
          select: { id: true },
        });
        emailTaken = !!dup;
      }
      if (phoneRaw && nameRaw) {
        const phone = canonicalisePhone(phoneRaw);
        const dup = await prisma.patient.findFirst({
          where: {
            tenantId,
            mergedIntoId: null,
            user: {
              phone,
              name: { equals: nameRaw, mode: "insensitive" },
            },
          },
          select: { id: true },
        });
        namePhoneTaken = !!dup;
      }

      res.json({
        success: true,
        // `phoneTaken` is kept in the response for back-compat but is ALWAYS
        // false now — phone alone is not a duplicate. `namePhoneTaken` is the
        // real (name + phone + tenant) collision the form should surface.
        data: { emailTaken, phoneTaken: false, namePhoneTaken },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/register",
  validate(strictRegisterSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, phone: rawPhone, password, address, city, state, pincode, abhaId, emergencyContact, dateOfBirth, gender, age, photoUrl, tenantId: bodyTenantId } = req.body as {
        email: string;
        phone: string;
        password: string;
        // Public registration "Select Hospital / Clinic" choice.
        tenantId?: string;
        address?: string;
        // SOW §2.1.1 registration address triplet + optional ABHA capture.
        city?: string;
        state?: string;
        pincode?: string;
        abhaId?: string;
        emergencyContact?: {
          name: string;
          phone: string;
          relationship: string;
        };
        // Inline base64 image data URL (self-registration photo), stored
        // directly on Patient.photoUrl. Validated by strictRegisterSchema.
        photoUrl?: string;
        // Issue #617: ISO calendar string YYYY-MM-DD when sent by the web form.
        dateOfBirth?: string;
        // Gender on PATIENT self-registration. Required by the public web
        // /register form (Issue #684 — no silent MALE default) and the
        // patient PWA register page. Persisted onto the Patient row below.
        gender?: "MALE" | "FEMALE" | "OTHER";
        // Age on PATIENT self-registration. The public /register form sends
        // an explicit integer; the PWA register uses DOB instead. Persisted
        // onto the Patient row below so the Rx PDF's "Age / Gender" line
        // shows the value the user actually entered.
        age?: number;
      };
      // Issue #489: sanitize the display name as a defence-in-depth pass on
      // top of the schema-level XSS rejection. Strips tags, normalises whitespace,
      // enforces a 100-char ceiling. Returns 400 with a field-level error if
      // the string is unsalvageable.
      const nameResult = sanitizeUserInput(req.body.name, {
        field: "Name",
        maxLength: 100,
      });
      if (!nameResult.ok) {
        res.status(400).json({
          success: false,
          data: null,
          error: nameResult.error || "Invalid name",
          details: [{ field: "name", message: nameResult.error }],
        });
        return;
      }
      const name = nameResult.value!;
      // Issue #473: NEVER trust `req.body.role` directly. The resolver
      // verifies the caller is an authenticated ADMIN before honouring a
      // non-PATIENT role; everyone else gets PATIENT.
      const role = resolveRegistrationRole(req, req.body.role);

      // Canonicalise phone for PATIENT self-registration so the value stored
      // in User.phone matches what /patient-auth/firebase-verify (and the
      // legacy /otp-verify) look up after Firebase Phone Auth returns the
      // E.164 number. Without this, a patient who registers with
      // "+91 9876543210" gets that exact string stored on User.phone, then
      // the OTP-verify lookup canonicalises Firebase's "+919876543210" to
      // "9876543210" and finds no row → 401. Staff roles (DOCTOR, NURSE,
      // ADMIN, …) keep the raw value to avoid touching admin staff-creation
      // flows that may rely on the as-typed form.
      const phone =
        role === Role.PATIENT ? canonicalisePhone(rawPhone) : rawPhone.trim();

      // Issue #713: PATIENT self-registration must include address and
      // emergencyContact (phone is required for ALL roles by the schema).
      // For non-PATIENT roles these stay optional — admin staff-creation
      // forms don't need to gate on a casualty contact.
      if (role === Role.PATIENT) {
        const missing: { field: string; message: string }[] = [];
        if (!address || address.trim().length < 5) {
          missing.push({
            field: "address",
            message: "Address is required (min 5 characters)",
          });
        }
        if (!emergencyContact) {
          missing.push({
            field: "emergencyContact",
            message: "Emergency contact is required",
          });
        }
        if (missing.length > 0) {
          res.status(400).json({
            success: false,
            data: null,
            error: missing[0].message,
            details: missing,
          });
          return;
        }
      }

      // Guard: when the caller EXPLICITLY chose a tenant — either the
      // registration form's "Select Hospital" pick (body tenantId) or an
      // admin's X-Tenant-Id header — and that tenant exists but is
      // SUSPENDED, fail loudly. Previously resolveRegistrationTenant just
      // skipped an inactive tenant (`if (t?.active)`) and silently fell
      // through to the default tenant, so an admin adding staff to a
      // suspended hospital got a "success" toast while the user was
      // misfiled into the default tenant — invisible until someone noticed
      // the row was missing. A clear 400 here is the correct behaviour.
      const explicitTenantId =
        (bodyTenantId && bodyTenantId.trim()) ||
        (req.header("X-Tenant-Id") || "").trim();
      if (explicitTenantId) {
        const chosen = await prisma.tenant.findUnique({
          where: { id: explicitTenantId },
          select: { active: true, name: true },
        });
        if (chosen && !chosen.active) {
          res.status(400).json({
            success: false,
            data: null,
            error: `"${chosen.name}" is suspended — reactivate the tenant before adding users, or choose an active tenant.`,
            details: [{ field: "tenantId", message: "Tenant is suspended" }],
          });
          return;
        }
      }

      // Resolve the tenant the new user belongs to FIRST — the patient
      // uniqueness rules below are scoped to the chosen hospital. Priority:
      //   body tenantId (patient's "Select Hospital" choice)
      //     → X-Tenant-Id header → subdomain → default.
      const tenantId = await resolveRegistrationTenant(req, bodyTenantId);

      // ── Per-tenant uniqueness for PATIENT self-registration ─────────────
      // Rules (scoped to the SELECTED hospital/tenant):
      //   • email  → unique within the tenant (same email may exist in
      //              another hospital). Checked against Patient.contactEmail.
      //   • phone  → NOT unique on its own (families share a number).
      //   • name+phone → unique together within the tenant (a real
      //              duplicate person at that hospital).
      // Staff/non-PATIENT registrations keep the global User.email identity
      // semantics (handled by the create + global mirror below).
      if (role === "PATIENT") {
        const trimmedEmail = email.trim().toLowerCase();
        // Email already used by a patient in THIS tenant?
        const emailDup = await prisma.patient.findFirst({
          where: {
            tenantId,
            mergedIntoId: null,
            contactEmail: { equals: trimmedEmail, mode: "insensitive" },
          },
          select: { id: true },
        });
        // Name + phone already paired on a patient in THIS tenant?
        const namePhoneDup = await prisma.patient.findFirst({
          where: {
            tenantId,
            mergedIntoId: null,
            user: {
              name: { equals: name.trim(), mode: "insensitive" },
              phone: phone.trim(),
            },
          },
          select: { id: true },
        });
        if (emailDup || namePhoneDup) {
          // Anti-enumeration (Issue #480): respond with the SAME 201 +
          // success envelope as a brand-new signup so an attacker can't probe
          // which (email) or (name+phone) pairs exist in a tenant. We audit
          // the duplicate server-side for the SOC trail; no account is made.
          auditLog(req, "USER_REGISTER_DUPLICATE", "patient", emailDup?.id ?? namePhoneDup?.id, {
            tenantId,
            reason: emailDup ? "email_in_tenant" : "name_phone_in_tenant",
          }).catch(console.error);
          res.status(201).json({
            success: true,
            data: {
              message:
                "Registration received. If the credentials are new please log in.",
            },
            error: null,
          });
          return;
        }
      } else {
        // Non-patient (staff) registration keeps the GLOBAL email identity
        // check — staff log in by a globally-unique email.
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
          auditLog(req, "USER_REGISTER_DUPLICATE", "user", existing.id, {
            email,
          }).catch(console.error);
          res.status(201).json({
            success: true,
            data: {
              message:
                "Registration received. If the credentials are new please log in.",
            },
            error: null,
          });
          return;
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Mirror the patient email onto the login User.email only when it is
      // still globally free (User.email is globally unique — the sign-in
      // identity). When it's taken, the login email is left null and the
      // email is captured on Patient.contactEmail below. NOTE: until the
      // login flow is made tenant-aware, a per-tenant-duplicate email that
      // collides globally means that patient can't sign in by email yet —
      // a known, accepted follow-up.
      let loginEmail: string | null = email;
      if (role === "PATIENT") {
        const emailOwner = await prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (emailOwner) loginEmail = null;
      }

      const user = await prisma.user.create({
        data: { name, email: loginEmail, phone, passwordHash, role, tenantId },
      });

      // If patient, create patient record with auto MR number.
      // Uses the shared per-tenant MR scheme (<tenant code><sequence>, e.g.
      // PG01000001) so self-registration matches staff-registration. Retries
      // on an mrNumber unique-constraint clash (stale counter / concurrent
      // signup) by recomputing the next sequence.
      if (role === "PATIENT") {
        const mrPrefix = await resolveMrPrefix(prisma, tenantId);
        const counterKey = mrCounterKey(tenantId);
        let mrSeq = await nextMrSeq(prisma, counterKey, mrPrefix);

        const MAX_MR_ATTEMPTS = 5;
        for (let attempt = 0; attempt < MAX_MR_ATTEMPTS; attempt++) {
          try {
            await prisma.patient.create({
          data: {
            userId: user.id,
            mrNumber: formatMrNumber(mrPrefix, mrSeq),
            // Patient email lives here (per-tenant), decoupled from the
            // globally-unique login User.email. Lowercased to match the
            // case-insensitive per-tenant duplicate pre-check above.
            contactEmail: email.trim() ? email.trim().toLowerCase() : null,
            // Use the submitted gender when the form provided one; fall
            // back to "OTHER" only for legacy callers that don't send it.
            // Before this fix the field was hard-coded to "OTHER", so every
            // self-registered patient landed as OTHER regardless of form
            // selection — visible on the Rx PDF's "Age / Gender" line.
            gender: gender ?? "OTHER",
            // Persist the registration-time age. The public /register form
            // sends an explicit integer; the PWA path sends DOB instead and
            // age stays undefined here (Prisma writes null, downstream
            // helpers derive age from dateOfBirth when needed).
            age: age ?? null,
            // The Doctor.create branch below already pins tenantId; the
            // Patient.create did not. Without it the row is created with
            // tenantId: null and tenantScopedPrisma filters it out for
            // every other (tenant-scoped) caller — admins can't see new
            // self-registered patients, telemedicine schedules 404 on
            // them, etc.
            tenantId,
            // Issue #713: persist the registration-time demographics so
            // casualty / triage have the contact info on file from the
            // moment the patient first signs up. Phone lives on User
            // (already written above); address + emergency contact live
            // on Patient.
            address: address?.trim() || null,
            // SOW §2.1.1 — registration address triplet + optional ABHA.
            city: city?.trim() || null,
            state: state?.trim() || null,
            pincode: pincode?.trim() || null,
            abhaId: abhaId?.trim() || null,
            emergencyContactName: emergencyContact?.name?.trim() || null,
            emergencyContactPhone: emergencyContact?.phone?.trim() || null,
            emergencyContactRelationship:
              emergencyContact?.relationship?.trim() || null,
            // Issue #617: persist the registration-time DOB onto the new
            // Patient row so downstream workflows (appointments, prescriptions,
            // billing) have it from the first signup. Kept optional — older
            // clients that don't send it land null and can fill in via the
            // patient-edit modal later.
            dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
            // Self-registration photo: stored as the inline base64 data URL
            // (renders directly via <img src>, never expires). Empty/absent
            // → null and the avatar falls back to initials.
            photoUrl: photoUrl ? photoUrl : null,
          },
        });

            await prisma.systemConfig.upsert({
              where: { key: counterKey },
              update: { value: String(mrSeq + 1) },
              create: { key: counterKey, value: String(mrSeq + 1) },
            });
            break; // created successfully
          } catch (err) {
            // Retry only on an mrNumber clash; re-throw anything else
            // (e.g. a User-side issue) so it surfaces normally.
            const code = (err as { code?: string })?.code;
            const target = (err as { meta?: { target?: string[] | string } })
              ?.meta?.target;
            const fields = Array.isArray(target)
              ? target
              : target
                ? [String(target)]
                : [];
            const isMrClash = code === "P2002" && fields.includes("mrNumber");
            if (!isMrClash || attempt === MAX_MR_ATTEMPTS - 1) throw err;
            mrSeq = Math.max(
              await nextMrSeq(prisma, counterKey, mrPrefix),
              mrSeq + 1,
            );
          }
        }
      }

      // Issue #205: when an admin creates a DOCTOR via the staff form,
      // a corresponding Doctor row was never created — which meant the
      // new user was missing from every doctor picker (Walk-in,
      // Appointment, AI Booking). We create one with sensible defaults
      // that the admin can edit later from the doctor profile page.
      if (role === "DOCTOR") {
        // Idempotent: guard against re-runs / partial migrations.
        const existing = await prisma.doctor.findUnique({
          where: { userId: user.id },
        });
        if (!existing) {
          // June 2026: honour the specialization / qualification / registration
          // number the admin chose on the Add-Doctor form. These arrive on the
          // validated register body (registerSchema, all optional). When absent
          // (legacy callers, patient self-register) we keep the historical
          // defaults so the row is always bookable.
          const docSpecialization =
            typeof req.body.specialization === "string" &&
            req.body.specialization.trim()
              ? req.body.specialization.trim()
              : "General Medicine";
          const docQualification =
            typeof req.body.qualification === "string" &&
            req.body.qualification.trim()
              ? req.body.qualification.trim()
              : "MBBS";
          // The Doctor model stores the registration number as `nmcRegNumber`
          // (National Medical Commission). The form labels it "Registration
          // Number" and posts it as `registrationNumber`, so map it here.
          const docRegNumber =
            typeof req.body.registrationNumber === "string" &&
            req.body.registrationNumber.trim()
              ? req.body.registrationNumber.trim()
              : undefined;
          const newDoctor = await prisma.doctor.create({
            data: {
              userId: user.id,
              specialization: docSpecialization,
              qualification: docQualification,
              ...(docRegNumber ? { nmcRegNumber: docRegNumber } : {}),
              tenantId,
            },
            select: { id: true },
          });
          // Seed a default weekly availability (Mon–Sat 09:00–17:00, 15-min
          // slots) so the doctor is BOOKABLE the moment they're created. A
          // doctor with no DoctorSchedule rows has no working hours, so
          // computeOpenSlots() returns [] and they never appear in the
          // public-booking / walk-in / appointment pickers — the exact
          // "I added a doctor but No doctors available" symptom (June 2026).
          // The admin can refine these hours later from the doctor profile.
          await prisma.doctorSchedule.createMany({
            data: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
              doctorId: newDoctor.id,
              dayOfWeek,
              startTime: "09:00",
              endTime: "17:00",
              slotDurationMinutes: 15,
              tenantId,
            })),
            skipDuplicates: true,
          });
        }
      }

      auditLog(req, "USER_REGISTER", "user", user.id, { email: user.email, role: user.role }).catch(console.error);

      // When an authenticated admin/super-admin created this account on
      // someone else's behalf, DO NOT issue a session. Setting the new
      // user's cookies here would overwrite the admin's own session in the
      // browser — the admin would be silently logged in as the freshly
      // created staff member on the next refresh. Return just the created
      // user; the admin's existing cookies stay untouched.
      if (callerIsAuthenticatedAdmin(req)) {
        res.status(201).json({
          success: true,
          data: {
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
            },
          },
          error: null,
        });
        return;
      }

      const tokens = generateTokens(user.id, user.email, user.role, user.tenantId);

      // Store refresh token
      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Issue #477: set the access + refresh + csrf cookies. Tokens stay in
      // the response body for the brief migration window — the e2e
      // suite's `apiLogin` helper still reads `data.tokens.accessToken`
      // for its `Authorization: Bearer` fallback path. The cookie is
      // what browser clients consume.
      setAuthCookies(res, tokens, tokens.refreshTtlSeconds);

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
          tokens,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/login
//
// Rate limiting IS applied here via two layers that CodeQL's dataflow can't
// trace through the lazy `loginLimiter` middleware factory + the in-handler
// `checkLockout(ip)` IP lockout:
//   1. `loginLimiter` — 5 requests / 60s per IP (route middleware below).
//   2. `checkLockout` / `recordFailedLogin` — IP failed-login lockout inside
//      the handler (see `checkLockout(ip)` near the top of the body).
// The `js/missing-rate-limiting` alert on this authorization handler is a
// false positive; suppress it the same way the repo already does elsewhere.
// lgtm[js/missing-rate-limiting]
router.post(
  "/login",
  loginLimiter,
  validate(strictLoginSchema),
  // lgtm[js/missing-rate-limiting]
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, rememberMe, tenantId: bodyTenantId } = req.body as {
        email: string;
        password: string;
        rememberMe?: boolean;
        // Patient multi-hospital disambiguation: when the same email+password
        // matches PATIENT accounts in several tenants, the first /login call
        // returns the hospital list; the web form then re-calls /login with
        // the chosen tenantId to complete sign-in.
        tenantId?: string;
      };

      // Issue #164: IP-based failed-login lockout. Distinct from the
      // rate limiter — fires only on REPEATED FAILURES, not total volume.
      const ip = clientIp(req);
      const lockout = checkLockout(ip);
      if (lockout.locked) {
        res.status(429).json({
          success: false,
          data: null,
          error: `Too many failed login attempts. Try again in ${lockout.remainingSeconds} seconds.`,
          retryAfterSeconds: lockout.remainingSeconds,
          locked: true,
        });
        return;
      }

      const recordFailure = (
        userId: string | undefined,
        reason: string
      ): void => {
        const result = recordFailedLogin(ip);
        auditLog(req, "LOGIN_FAILED", "user", userId, {
          email,
          reason,
          failureCount: result.failureCount,
          remainingAttempts: result.remainingAttempts,
        }).catch(console.error);
        if (result.justLocked) {
          auditLog(req, "AUTH_LOCKOUT_TRIGGERED", "auth", undefined, {
            ip,
            email,
            failureCount: result.failureCount,
            lockoutSeconds: 15 * 60,
          }).catch(console.error);
        }
      };

      // ── User resolution ────────────────────────────────────────────────
      // Email is the GLOBAL login identity for STAFF/ADMIN (`User.email` is
      // globally unique). PATIENTS, however, can have the SAME email at
      // multiple hospitals — their email lives on `Patient.contactEmail`
      // (per-tenant) and the login `User.email` may be null. So we resolve in
      // two layers:
      //   1. The single global-email account (staff/admin, or the one patient
      //      whose email did land on User.email).
      //   2. ALL patient accounts whose `contactEmail` matches (across
      //      tenants), so a multi-hospital patient can be disambiguated.
      // We then keep only the accounts whose password actually matches, and
      // branch on the count: 0 → fail, 1 → log in, >1 → hospital picker.
      const globalUser = await prisma.user.findUnique({ where: { email } });
      const patientUsers = await prisma.user.findMany({
        where: {
          role: "PATIENT",
          isActive: true,
          patient: {
            is: {
              mergedIntoId: null,
              contactEmail: { equals: email.trim().toLowerCase(), mode: "insensitive" },
            },
          },
        },
      });

      // Build the candidate set (dedup by id), then filter to password matches.
      const candidatesById = new Map<string, (typeof patientUsers)[number]>();
      if (globalUser && globalUser.isActive) {
        candidatesById.set(globalUser.id, globalUser as (typeof patientUsers)[number]);
      }
      for (const pu of patientUsers) candidatesById.set(pu.id, pu);

      const matched: Array<(typeof patientUsers)[number]> = [];
      for (const cand of candidatesById.values()) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(password, cand.passwordHash)) matched.push(cand);
      }

      // If the caller already picked a hospital (2nd /login call), narrow to it.
      const picked = bodyTenantId?.trim()
        ? matched.filter((m) => m.tenantId === bodyTenantId.trim())
        : matched;

      if (picked.length === 0) {
        // No credential match (or the picked tenant didn't match). Generic
        // 401 so we never reveal whether the email/tenant exists.
        recordFailure(globalUser?.id, "user_not_found_or_bad_password");
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid email or password",
        });
        return;
      }

      if (picked.length > 1) {
        // Same email + password at multiple hospitals → ask which one.
        // Return the tenant list; the web form re-submits /login with the
        // chosen `tenantId`. No tokens issued yet.
        const tenantIds = Array.from(
          new Set(picked.map((m) => m.tenantId).filter((t): t is string => !!t)),
        );
        const tenants = await prisma.tenant.findMany({
          where: { id: { in: tenantIds }, active: true },
          select: { id: true, name: true },
        });
        const codeRows = await prisma.systemConfig.findMany({
          where: { key: { in: tenantIds.map((id) => `tenant:${id}:code`) } },
          select: { key: true, value: true },
        });
        const codeById = new Map<string, string>();
        for (const r of codeRows) {
          const m = r.key.match(/^tenant:([^:]+):code$/);
          if (m) codeById.set(m[1], r.value);
        }
        clearFailedLogins(ip);
        res.json({
          success: true,
          data: {
            needsHospitalSelection: true,
            hospitals: tenants.map((t) => ({
              id: t.id,
              name: t.name,
              code: codeById.get(t.id) ?? null,
            })),
          },
          error: null,
        });
        return;
      }

      // Exactly one match → proceed as a normal login with that account.
      const user = picked[0];

      // Tenant-deactivation gate — only AFTER the credentials check passes do
      // we tell a legitimate user that their hospital tenant has been
      // suspended/archived (via `/api/v1/tenants/:id/deactivate`). Valid creds
      // → clear suspended message; wrong creds → generic error above.
      if (user.tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { active: true },
        });
        if (tenant && !tenant.active) {
          recordFailure(user.id, "tenant_deactivated");
          res.status(403).json({
            success: false,
            data: null,
            error:
              "Your hospital account has been suspended. Please contact your administrator or MedCore support to restore access.",
          });
          return;
        }
      }

      // Successful credential check — clear any prior failures so the next
      // operator on this IP isn't locked out by a previous user's typos.
      clearFailedLogins(ip);

      // Pearl gap #10b + §8.2 — mandatory TOTP for ADMIN.
      //
      //   - Tenant-bound ADMIN: enforce when `Tenant.requireAdminTOTP=true`.
      //   - Cross-tenant super-admin (tenantId IS NULL): enforce when
      //     SystemConfig `superadmin:<userId>:require_two_factor` is "true"
      //     (set at invite time via POST /super-admin/users with
      //     `requireTwoFactor: true`, which is the default per §8.2).
      //
      // Either way the login is blocked with 412 + a one-shot enrolToken
      // the client swaps for /auth/2fa/setup to enrol the authenticator.
      // Pearl §8.2 — recognise both the new dedicated SUPER_ADMIN role
      // and the legacy ADMIN+tenantId=null shape as super-admin login
      // candidates that need TOTP enforcement.
      const isAdminLike =
        user.role === "ADMIN" || user.role === "SUPER_ADMIN";
      if (isAdminLike && !user.twoFactorEnabled) {
        let requireTotp = false;
        let reason: "tenant" | "super_admin" | null = null;
        if (user.tenantId) {
          // Tenant-bound ADMIN — read Tenant.requireAdminTOTP.
          const tenant = await prisma.tenant.findUnique({
            where: { id: user.tenantId },
            select: { requireAdminTOTP: true },
          });
          if (tenant?.requireAdminTOTP) {
            requireTotp = true;
            reason = "tenant";
          }
        } else {
          // Pearl §8.2 — cross-tenant super-admin (either SUPER_ADMIN
          // or legacy ADMIN+tenantId=null).
          //
          // Policy (tightened 2026-05): TOTP is mandatory for every
          // peer super-admin. Only the main (root) super-admin row —
          // `User.isMainSuperAdmin = true` — is exempt and signs in
          // without 2FA. There is no per-user opt-out flag check
          // anymore; the flag is ignored. Raw SQL because the on-disk
          // Prisma client may not yet know the column on this dev box
          // (DLL lock during dev).
          const mainFlagRows = await prisma.$queryRaw<
            Array<{ isMainSuperAdmin: boolean }>
          >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${user.id}`;
          const isMain = mainFlagRows[0]?.isMainSuperAdmin === true;
          if (!isMain) {
            requireTotp = true;
            reason = "super_admin";
          }
          // isMain === true → requireTotp stays false; the root account
          // passes straight through to the normal login response.
        }

        if (requireTotp) {
          const enrolToken = await issueTempToken(user.id);
          // Pearl §8.2 row 211 — audit the blocked sign-in so operators
          // can see when mandatory-TOTP is biting unenrolled admins.
          auditLog(req, "LOGIN_BLOCKED_TOTP_REQUIRED", "user", user.id, {
            email: user.email,
            tenantId: user.tenantId,
            reason,
          }).catch(console.error);
          // The frontend reads `data.totpEnrolmentRequired` and redirects
          // to /auth/enrol-totp with the enrolToken so the new operator
          // can scan a QR + enter the first code in a guided flow.
          // `role` lets the enrolment page tailor copy ("super-admin"
          // vs "tenant admin"); `email` is shown back so the operator
          // confirms which account they're enrolling.
          res.status(412).json({
            success: false,
            data: {
              totpEnrolmentRequired: true,
              enrolToken,
              role: user.role,
              email: user.email,
              reason,
            },
            error:
              reason === "super_admin"
                ? "Two-factor authentication is required for super-admin accounts. We'll walk you through setting it up next."
                : "Your hospital requires admins to use two-factor authentication. We'll walk you through setting it up next.",
          });
          return;
        }
      }

      // If 2FA is enabled, do not issue real tokens — return a temp token.
      if (user.twoFactorEnabled && user.twoFactorSecret) {
        const tempToken = await issueTempToken(user.id);
        res.json({
          success: true,
          data: { twoFactorRequired: true, tempToken },
          error: null,
        });
        return;
      }

      // Issue #1: pass `rememberMe` so the refresh token is minted with a
      // 30-day TTL when the user opted in, and the DB row matches.
      const tokens = generateTokens(
        user.id,
        user.email,
        user.role,
        user.tenantId,
        rememberMe === true
      );

      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + tokens.refreshTtlSeconds * 1000),
        },
      });

      auditLog(req, "AUTH_LOGIN", "user", user.id, { email: user.email }).catch(console.error);
      // Stamp last-login for the super-admin Tenants "Last login" column.
      prisma.user
        .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        .catch(console.error);

      // Issue #477: set the access + refresh + csrf cookies. The login
      // honoured the user's `rememberMe` flag for refresh-token TTL — pass
      // the same value through so the cookie's maxAge matches the JWT exp.
      setAuthCookies(res, tokens, tokens.refreshTtlSeconds);

      // Issue #714 (May 2026): if the caller passed a `next` hint via the
      // request body OR `?next=` query string, sanitize it to a safe
      // same-origin path before echoing it back as `redirectUrl`. Off-origin
      // / protocol-relative / backslash variants collapse to "/dashboard".
      // The web bundle today does its own client-side bounce (see comment on
      // sanitizeNextPath above for the Lane B follow-up), but exposing the
      // sanitized value here lets future SSR / API-only clients trust the
      // server's redirect target without re-implementing the rule.
      const nextHint =
        (req.body as { next?: unknown })?.next ??
        (req.query as { next?: unknown })?.next;
      const redirectUrl = sanitizeNextPath(nextHint);

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
          tokens,
          redirectUrl,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/refresh
router.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Refresh token required",
        });
        return;
      }

      const stored = await prisma.refreshToken.findUnique({
        where: { token: refreshToken },
        include: { user: true },
      });

      if (!stored || stored.expiresAt < new Date()) {
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid or expired refresh token",
        });
        return;
      }

      // Tenant-deactivation gate — if the user's tenant has been soft
      // deactivated since this session was issued, refuse to mint a new
      // token pair. The tenants admin UI advertises "users are signed out
      // at their next refresh", and this is where that promise is kept.
      if (stored.user.tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: stored.user.tenantId },
          select: { active: true },
        });
        if (tenant && !tenant.active) {
          await prisma.refreshToken.delete({ where: { id: stored.id } }).catch(() => undefined);
          res.status(401).json({
            success: false,
            data: null,
            error: "Tenant has been deactivated",
          });
          return;
        }
      }

      // Delete old token and create new pair
      await prisma.refreshToken.delete({ where: { id: stored.id } });

      const tokens = generateTokens(
        stored.user.id,
        stored.user.email,
        stored.user.role,
        stored.user.tenantId
      );

      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: stored.user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Issue #477: rotate the cookies so the new access/refresh/csrf
      // tokens replace the prior set. CSRF rotates with refresh — keeps
      // the client's CSRF token in lockstep with the access token.
      setAuthCookies(res, tokens, tokens.refreshTtlSeconds);

      res.json({ success: true, data: { tokens }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/auth/me
router.get(
  "/me",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true,
          photoUrl: true,
          twoFactorEnabled: true,
          preferredLanguage: true,
          defaultLandingPage: true,
          // Surface tenantId on /auth/me so the web client can short-
          // circuit cross-tenant cache misses and any future tenant-
          // aware UX (sub-domain banner, tenant-switch widget) can
          // read the active tenant directly from the auth payload
          // instead of decoding the JWT.
          tenantId: true,
          doctor: true,
          patient: true,
        },
      });

      // Resolve the photo to a displayable URL for the profile pages'
      // <img src>. Prefer the User-level photo (set via PATCH /auth/me on
      // the Settings page); fall back to the patient's photo (set at
      // self-registration / by reception) so it shows on the patient
      // profile too. Bare storage keys → signed URL; data:/http URLs pass
      // through; null when neither is set (avatar falls back to initials).
      const rawPhoto =
        user?.photoUrl ??
        (user?.patient as { photoUrl?: string | null } | null)?.photoUrl ??
        null;
      const resolvedPhoto = await resolvePatientPhotoUrl(rawPhoto);
      // Surface isMainSuperAdmin so the web client can gate main-only UI
      // (Add Tenant / Add Super-Admin / Tenants nav). Raw SQL because the
      // on-disk Prisma client may not yet know the column on a dev box under
      // the `prisma generate` DLL lock — mirrors super-admin-users.ts.
      const meMainRows = await prisma.$queryRaw<
        Array<{ isMainSuperAdmin: boolean }>
      >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
      const isMainSuperAdmin = meMainRows[0]?.isMainSuperAdmin === true;
      const data = user
        ? { ...user, photoUrl: resolvedPhoto, isMainSuperAdmin }
        : user;

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/logout
router.post(
  "/logout",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.refreshToken.deleteMany({
        where: { userId: req.user!.userId },
      });

      auditLog(req, "AUTH_LOGOUT", "user", req.user!.userId).catch(console.error);

      // Issue #477: clear all auth cookies so the next request from this
      // browser is unauthenticated. Server-side refresh tokens are
      // already revoked via deleteMany above.
      clearAuthCookies(res);

      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Password Reset (DB-backed code store) ────────────────────────

// POST /api/v1/auth/forgot-password
// Issue #128: dedicated 5/min/IP limiter so a stuck reset flow doesn't burn
// the shared auth bucket and lock the user out of /login too.
//
// Issue #493 (May 2026): anti-enumeration parity. The known-email and
// unknown-email paths return BYTE-IDENTICAL response envelopes — same status
// (200), same `success: true`, same `error: null`, same `data.message`
// string. The only difference is server-side side effects (a real
// PasswordResetCode row is created on the known-email path), which the
// caller cannot observe. The `expectAntiEnumeration` helper in
// security-assertions.ts pins this contract.
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  validate(strictForgotPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Anti-enumeration (#493): identical envelope to the known-email path
        // below — same status, same success, same error, same message. Do NOT
        // diverge this branch even by a whitespace difference; the test in
        // auth.test.ts compares both bodies via expectAntiEnumeration.
        res.json({
          success: true,
          data: { message: "If that email exists, a reset code has been sent." },
          error: null,
        });
        return;
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));

      // Invalidate any prior unused codes so only the latest is valid.
      await prisma.passwordResetCode.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      await prisma.passwordResetCode.create({
        data: {
          userId: user.id,
          code,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
        },
      });

      // cleanup(2026-04-24): never print reset codes in production — they'd
      // land in log aggregators and are effectively a password. Keep the dev
      // helper so local runs without an email channel still work.
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[Password Reset] Code for ${email}: ${code}`);
      }

      res.json({
        success: true,
        data: { message: "If that email exists, a reset code has been sent." },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/reset-password
//
// Issue #493 (May 2026): anti-enumeration parity + strong-password rules.
//
//   • Anti-enumeration: the schema's `strongPassword` runs FIRST (via the
//     `validate(resetPasswordSchema)` middleware), so a weak `newPassword`
//     still 400's regardless of whether the email is known. Past the schema,
//     the unknown-email path AND the bad-code path return the SAME envelope:
//     `{ status: 400, success: false, error: "Invalid or expired reset code" }`.
//     This means an attacker cannot enumerate registered emails by submitting
//     a junk code — both branches are indistinguishable to the client. The
//     `expectAntiEnumeration` helper in security-assertions.ts pins this.
//   • Strong-password: `resetPasswordSchema.newPassword === strongPassword`
//     (>= 8 chars, letter+digit, not in the top-100 denylist). Mirrors the
//     rule already enforced on /auth/register and /auth/change-password —
//     "password", "123456", and 6-char strings all 400 here.
router.post(
  "/reset-password",
  validate(resetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, code, newPassword } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Anti-enumeration: same envelope as the bad-code branch below so an
        // attacker cannot tell "email exists, code wrong" from "email doesn't
        // exist". See block comment above.
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid or expired reset code",
        });
        return;
      }

      const stored = await prisma.passwordResetCode.findFirst({
        where: {
          userId: user.id,
          code,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!stored) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid or expired reset code",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: { passwordHash },
        }),
        prisma.passwordResetCode.update({
          where: { id: stored.id },
          data: { usedAt: new Date() },
        }),
      ]);

      res.json({
        success: true,
        data: { message: "Password has been reset successfully." },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/change-password (authenticated)
//
// Issue #623 (May 2026): clinical roles (Pharmacist reported, but the rule
// is now tenant-wide) could change to a 6-char or denylisted password
// because the schema only enforced `strongPassword` (>=8). We swap to
// `strictChangePasswordSchema` which uses `strictRegisterPassword` (>=12 +
// letter + digit + denylist). Zod runs as middleware BEFORE this handler,
// so a weak `newPassword` is rejected at the schema layer first — the
// caller never reaches the bcrypt-compare branch and never sees the
// misleading "Current password is incorrect" when their actual error is a
// weak new password.
router.post(
  "/change-password",
  authenticate,
  validate(strictChangePasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { currentPassword, newPassword } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          data: null,
          error: "User not found",
        });
        return;
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Current password is incorrect",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      res.json({
        success: true,
        data: { message: "Password changed successfully." },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/auth/me — update own profile (name/phone/photoUrl/prefs)
// Issue #138 (Apr 2026): use the shared `updateProfileSchema` so empty
// names and bogus phones ("abc") are rejected with field-level errors
// surfaced via extractFieldErrors, matching every other write endpoint.
router.patch(
  "/me",
  authenticate,
  validate(updateProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        name,
        phone,
        photoUrl,
        preferredLanguage,
        defaultLandingPage,
      } = req.body as {
        name?: string;
        phone?: string;
        photoUrl?: string | null;
        preferredLanguage?: string | null;
        defaultLandingPage?: string | null;
      };

      const data: Record<string, unknown> = {};
      // Issues #248, #265 (Apr 2026): sanitize the profile Full Name on the
      // API edge — even if the form is bypassed, no payload with `<script>`
      // reaches the DB and renders into the sidebar.
      if (typeof name === "string") {
        const sanitized = sanitizeUserInput(name, {
          field: "Name",
          maxLength: 100,
        });
        if (!sanitized.ok) {
          res.status(400).json({
            success: false,
            error: sanitized.error || "Invalid name",
            details: [{ field: "name", message: sanitized.error }],
          });
          return;
        }
        data.name = sanitized.value;
      }
      if (typeof phone === "string") data.phone = phone.trim();
      if (photoUrl !== undefined) data.photoUrl = photoUrl;
      if (preferredLanguage !== undefined) data.preferredLanguage = preferredLanguage;
      if (defaultLandingPage !== undefined) data.defaultLandingPage = defaultLandingPage;

      if (Object.keys(data).length === 0) {
        res.status(400).json({ success: false, data: null, error: "Nothing to update" });
        return;
      }

      const updated = await prisma.user.update({
        where: { id: req.user!.userId },
        data,
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          role: true,
          isActive: true,
          photoUrl: true,
          twoFactorEnabled: true,
          preferredLanguage: true,
          defaultLandingPage: true,
        },
      });

      auditLog(req, "USER_PROFILE_UPDATE", "user", req.user!.userId, data).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/auth/sessions — list active sessions (refresh tokens)
router.get(
  "/sessions",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tokens = await prisma.refreshToken.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, expiresAt: true },
      });
      res.json({ success: true, data: tokens, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/sessions/logout-others — clear all refresh tokens
router.post(
  "/sessions/logout-others",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await prisma.refreshToken.deleteMany({
        where: { userId: req.user!.userId },
      });
      auditLog(req, "AUTH_LOGOUT_ALL", "user", req.user!.userId, {
        cleared: result.count,
      }).catch(console.error);
      res.json({ success: true, data: { cleared: result.count }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/auth/failed-logins — last 10 failed login attempts for self
router.get(
  "/failed-logins",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entries = await tenantScopedPrisma.auditLog.findMany({
        where: {
          action: "LOGIN_FAILED",
          OR: [
            { userId: req.user!.userId },
            { entityId: req.user!.userId },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/auth/my-activity — last 100 audit log entries for self
router.get(
  "/my-activity",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entries = await tenantScopedPrisma.auditLog.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 2FA (TOTP) ─────────────────────────────────────────

// POST /api/v1/auth/2fa/setup — generate secret + backup codes (unconfirmed)
router.post(
  "/2fa/setup",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      });
      if (!user) {
        res.status(404).json({ success: false, data: null, error: "User not found" });
        return;
      }

      // #891 (May 2026): User.email is now nullable. The TOTP otpauth URI
      // uses the email as the human-readable label in the authenticator
      // app (the "account name" in Google Authenticator). When the user
      // has no email on file, fall back to a label derived from the user
      // id + role so the row in the authenticator app is still distinguishable.
      // Refuse 2FA setup for emailless users? No — phone-only users
      // still want 2FA. Just label gracefully.
      const otpLabel = user.email || `user-${user.id.slice(0, 8)}@medcore`;

      const secret = generateSecret();
      const backupCodes = generateBackupCodes(10);

      // Store secret + codes but keep twoFactorEnabled=false until verified
      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorSecret: secret,
          twoFactorBackupCodes: backupCodes as any,
          twoFactorEnabled: false,
        },
      });

      const otpauthUri = buildOtpAuthUri(otpLabel, secret, "MedCore");

      auditLog(req, "2FA_SETUP_INIT", "user", user.id).catch(console.error);

      res.json({
        success: true,
        data: { secret, otpauthUri, backupCodes },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Enrolment-at-login (mandatory TOTP for unenrolled admins) ──────
//
// When the login route returns 412 + `enrolToken` because the operator
// has never set up 2FA, the frontend redirects to /auth/enrol-totp.
// That page can't call /auth/2fa/setup (which needs a real session it
// doesn't have) — these two routes accept the enrolToken instead.
//
// Flow:
//   1. enrol-setup: validate enrolToken (peek, not consume), generate
//      secret + backup codes + otpauth URI + QR PNG data URL. Operator
//      can refresh the page and re-fetch the QR until the token expires
//      (5 min).
//   2. enrol-verify: validate enrolToken (consume — single-shot),
//      check the 6-digit code, flip twoFactorEnabled=true. Operator
//      then signs in normally (which will route through verify-login).
//
// POST /api/v1/auth/2fa/enrol-setup — body { enrolToken }
router.post(
  "/2fa/enrol-setup",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { enrolToken } = req.body as { enrolToken?: string };
      if (!enrolToken) {
        res.status(400).json({
          success: false,
          data: null,
          error: "enrolToken is required",
        });
        return;
      }
      const userId = await peekTempToken(enrolToken);
      if (!userId) {
        res.status(401).json({
          success: false,
          data: null,
          error:
            "This enrolment link has expired. Please sign in again to get a fresh one.",
        });
        return;
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Account not found",
        });
        return;
      }

      const otpLabel = user.email || `user-${user.id.slice(0, 8)}@medcore`;
      const secret = generateSecret();
      const backupCodes = generateBackupCodes(10);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorSecret: secret,
          twoFactorBackupCodes: backupCodes as any,
          twoFactorEnabled: false,
        },
      });

      const otpauthUri = buildOtpAuthUri(otpLabel, secret, "MedCore");
      // Render the otpauth URI as a base64 PNG so the frontend can
      // <img src={qrDataUrl}> it directly — no client-side QR lib needed.
      const QRCode = await import("qrcode");
      const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
        width: 220,
        margin: 1,
      });

      auditLog(req, "2FA_ENROL_SETUP", "user", user.id, {
        email: user.email,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          secret,
          otpauthUri,
          qrDataUrl,
          backupCodes,
          email: user.email,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/auth/2fa/enrol-verify — body { enrolToken, code }
router.post(
  "/2fa/enrol-verify",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { enrolToken, code } = req.body as {
        enrolToken?: string;
        code?: string;
      };
      if (!enrolToken || !code) {
        res.status(400).json({
          success: false,
          data: null,
          error: "enrolToken and code are required",
        });
        return;
      }
      // Single-shot: consume the enrol token regardless of verify
      // outcome. A wrong code burns the token so the operator has to
      // sign in again — that's the right safety property (otherwise
      // an attacker who stole the enrol token gets unlimited tries).
      const userId = await consumeTempToken(enrolToken);
      if (!userId) {
        res.status(401).json({
          success: false,
          data: null,
          error:
            "This enrolment link has expired or already been used. Please sign in again.",
        });
        return;
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.twoFactorSecret) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Two-factor setup wasn't started. Please sign in again.",
        });
        return;
      }
      if (!verifyTOTP(user.twoFactorSecret, code)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "That code didn't match. Please sign in again and retry.",
        });
        return;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });
      auditLog(req, "2FA_ENABLED", "user", user.id, {
        via: "enrol-at-login",
      }).catch(console.error);
      res.json({
        success: true,
        data: { enabled: true },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/auth/2fa/verify — confirm secret with first TOTP code
router.post(
  "/2fa/verify",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body as { token?: string };
      if (!token) {
        res.status(400).json({ success: false, data: null, error: "Token required" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      });
      if (!user || !user.twoFactorSecret) {
        res.status(400).json({
          success: false,
          data: null,
          error: "2FA setup not initialized",
        });
        return;
      }

      if (!verifyTOTP(user.twoFactorSecret, token)) {
        res.status(400).json({ success: false, data: null, error: "Invalid code" });
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });

      auditLog(req, "2FA_ENABLED", "user", user.id).catch(console.error);

      res.json({ success: true, data: { enabled: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/2fa/disable — requires current password
router.post(
  "/2fa/disable",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { currentPassword } = req.body as { currentPassword?: string };
      if (!currentPassword) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Current password required",
        });
        return;
      }
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      });
      if (!user) {
        res.status(404).json({ success: false, data: null, error: "User not found" });
        return;
      }
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Current password is incorrect",
        });
        return;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorBackupCodes: undefined,
        },
      });
      auditLog(req, "2FA_DISABLED", "user", user.id).catch(console.error);
      res.json({ success: true, data: { enabled: false }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/auth/2fa/verify-login — second step of login flow
router.post(
  "/2fa/verify-login",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tempToken, code } = req.body as { tempToken?: string; code?: string };
      if (!tempToken || !code) {
        res.status(400).json({
          success: false,
          data: null,
          error: "tempToken and code required",
        });
        return;
      }
      const userId = await consumeTempToken(tempToken);
      if (!userId) {
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid or expired temp token",
        });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.twoFactorSecret) {
        res.status(401).json({
          success: false,
          data: null,
          error: "2FA not configured",
        });
        return;
      }

      // Try TOTP first
      let verified = verifyTOTP(user.twoFactorSecret, code);

      // Fall back to single-use backup code
      if (!verified && Array.isArray(user.twoFactorBackupCodes)) {
        const codes = user.twoFactorBackupCodes as unknown as string[];
        const idx = codes.indexOf(code.toUpperCase());
        if (idx >= 0) {
          verified = true;
          const remaining = codes.slice();
          remaining.splice(idx, 1);
          await prisma.user.update({
            where: { id: user.id },
            data: { twoFactorBackupCodes: remaining as any },
          });
        }
      }

      if (!verified) {
        auditLog(req, "LOGIN_FAILED", "user", user.id, {
          email: user.email,
          reason: "bad_2fa_code",
        }).catch(console.error);
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid 2FA code",
        });
        return;
      }

      const tokens = generateTokens(user.id, user.email, user.role, user.tenantId);
      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      auditLog(req, "AUTH_LOGIN", "user", user.id, { email: user.email, twoFactor: true }).catch(
        console.error
      );
      // Stamp last-login for the super-admin Tenants "Last login" column.
      prisma.user
        .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        .catch(console.error);

      // Issue #477: set cookies after 2FA verify (same as login).
      setAuthCookies(res, tokens, tokens.refreshTtlSeconds);

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
          tokens,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as authRouter };
