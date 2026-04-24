import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@medcore/db";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  generateSecret,
  verifyTOTP,
  buildOtpAuthUri,
  generateBackupCodes,
} from "../services/totp";

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
  email: string,
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
  // review did not flag this TTL as a finding (see docs/SECURITY_AUDIT_2026-04-23.md
  // §"Non-findings" → JWT verification). The 24h access / 7d refresh window is
  // intentional for clinical-shift usage (typical shift 8–12h, weekly rotation)
  // and matches MedCore's audit-log retention. Shorter access windows were
  // considered but add friction in ward-side tablets where re-auth during a
  // resuscitation is unsafe; tokens are also invalidated server-side via the
  // `jti` blocklist on password reset / 2FA changes. Leaving unchanged.
  //
  // Issue #1: access-token TTL intentionally NOT extended by rememberMe — a
  // compromised access token should still expire within 24h regardless of
  // the user's session-persistence preference.
  const accessToken = jwt.sign(
    { userId, email, role, tenantId: tid, jti },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "24h" }
  );
  const refreshTtlSeconds = rememberMe
    ? REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS
    : REFRESH_TOKEN_TTL_SECONDS;
  const refreshToken = jwt.sign(
    { userId, email, role, tenantId: tid, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
    { expiresIn: refreshTtlSeconds }
  );
  return { accessToken, refreshToken, refreshTtlSeconds };
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
async function resolveRegistrationTenant(req: Request): Promise<string | null> {
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

// POST /api/v1/auth/register
router.post(
  "/register",
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, phone, password, role } = req.body;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Email already registered",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Resolve the tenant the new user belongs to (header → subdomain → default).
      // Written onto the User row AT CREATE time so subsequent token mints
      // pick it up automatically via `user.tenantId`.
      const tenantId = await resolveRegistrationTenant(req);

      const user = await prisma.user.create({
        data: { name, email, phone, passwordHash, role, tenantId },
      });

      // If patient, create patient record with auto MR number
      if (role === "PATIENT") {
        const config = await prisma.systemConfig.findUnique({
          where: { key: "next_mr_number" },
        });
        const mrSeq = config ? parseInt(config.value) : 1;
        const mrNumber = `MR${String(mrSeq).padStart(6, "0")}`;

        await prisma.patient.create({
          data: {
            userId: user.id,
            mrNumber,
            gender: "OTHER",
          },
        });

        await prisma.systemConfig.upsert({
          where: { key: "next_mr_number" },
          update: { value: String(mrSeq + 1) },
          create: { key: "next_mr_number", value: String(mrSeq + 1) },
        });
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

      auditLog(req, "USER_REGISTER", "user", user.id, { email: user.email, role: user.role }).catch(console.error);

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
router.post(
  "/login",
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, rememberMe } = req.body as {
        email: string;
        password: string;
        rememberMe?: boolean;
      };

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive) {
        auditLog(req, "LOGIN_FAILED", "user", undefined, {
          email,
          reason: "user_not_found_or_inactive",
        }).catch(console.error);
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid email or password",
        });
        return;
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        auditLog(req, "LOGIN_FAILED", "user", user.id, {
          email,
          reason: "bad_password",
        }).catch(console.error);
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid email or password",
        });
        return;
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
          doctor: true,
          patient: true,
        },
      });

      res.json({ success: true, data: user, error: null });
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

      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Password Reset (DB-backed code store) ────────────────────────

// POST /api/v1/auth/forgot-password
router.post(
  "/forgot-password",
  validate(forgotPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Return success even if user not found to avoid email enumeration
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
router.post(
  "/reset-password",
  validate(resetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, code, newPassword } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
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
router.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema),
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
router.patch(
  "/me",
  authenticate,
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
      if (typeof name === "string" && name.trim().length > 0) data.name = name.trim();
      if (typeof phone === "string" && phone.trim().length > 0) data.phone = phone.trim();
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
      const entries = await prisma.auditLog.findMany({
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
      const entries = await prisma.auditLog.findMany({
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

      const otpauthUri = buildOtpAuthUri(user.email, secret, "MedCore");

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
