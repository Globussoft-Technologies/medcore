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
const router = Router();

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
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid email or password",
        });
        return;
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        res.status(401).json({
          success: false,
          data: null,
          error: "Invalid email or password",
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

export { router as authRouter };
