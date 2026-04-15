import { Router, Request, Response, NextFunction } from "express";
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
const router = Router();

// In-memory store for short-lived 2FA temp tokens issued during login.
const twoFactorTempTokens = new Map<
  string,
  { userId: string; expiresAt: number }
>();
function issueTempToken(userId: string): string {
  const token =
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36);
  twoFactorTempTokens.set(token, {
    userId,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
  });
  return token;
}
function consumeTempToken(token: string): string | null {
  const entry = twoFactorTempTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    twoFactorTempTokens.delete(token);
    return null;
  }
  twoFactorTempTokens.delete(token);
  return entry.userId;
}

function generateTokens(userId: string, email: string, role: string) {
  const accessToken = jwt.sign(
    { userId, email, role },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "24h" }
  );
  const refreshToken = jwt.sign(
    { userId, email, role },
    process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
    { expiresIn: "7d" }
  );
  return { accessToken, refreshToken };
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
      const user = await prisma.user.create({
        data: { name, email, phone, passwordHash, role },
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

      const tokens = generateTokens(user.id, user.email, user.role);

      // Store refresh token
      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      auditLog(req, "REGISTER", "user", user.id, { email: user.email, role: user.role }).catch(console.error);

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
      const { email, password } = req.body;

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
        const tempToken = issueTempToken(user.id);
        res.json({
          success: true,
          data: { twoFactorRequired: true, tempToken },
          error: null,
        });
        return;
      }

      const tokens = generateTokens(user.id, user.email, user.role);

      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      auditLog(req, "LOGIN", "user", user.id, { email: user.email }).catch(console.error);

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
        stored.user.role
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

      auditLog(req, "LOGOUT", "user", req.user!.userId).catch(console.error);

      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Password Reset (in-memory code store) ────────────────────────

const resetCodes = new Map<string, { code: string; expiresAt: number }>();

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
      resetCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min

      console.log(`[Password Reset] Code for ${email}: ${code}`);

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

      const stored = resetCodes.get(email);
      if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid or expired reset code",
        });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(404).json({
          success: false,
          data: null,
          error: "User not found",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      resetCodes.delete(email);

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
      auditLog(req, "LOGOUT_ALL_SESSIONS", "user", req.user!.userId, {
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
      const userId = consumeTempToken(tempToken);
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

      const tokens = generateTokens(user.id, user.email, user.role);
      await prisma.refreshToken.create({
        data: {
          token: tokens.refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      auditLog(req, "LOGIN", "user", user.id, { email: user.email, twoFactor: true }).catch(
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
