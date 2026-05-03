// Routes for /api/v1/users — staff user management + per-user preferences.
//
// Why this file exists (TODO.md A6 — discoverability):
// Until this refactor, the user-edit / disable / role-change PATCH and a
// few other user-scoped handlers (`POST /users/:id/reset-password`,
// `GET /users`, `GET /users/:id/service-certificate`,
// `GET|PUT /users/me/dashboard-preferences`) lived inside
// `routes/patient-extras.ts` — a grab-bag router mounted at `/api/v1`.
// New contributors searching `routes/` for "where do users get edited"
// found nothing obvious. Splitting them out here keeps the URL space
// identical (mounted at `/api/v1/users`) but makes the file system
// reflect the API surface.
//
// Modules touched:
//   - apps/api/src/app.ts  — new `app.use("/api/v1/users", usersRouter)`.
//   - apps/api/src/routes/patient-extras.ts — handlers moved out.
//
// Backward compatibility: every URL is preserved 1:1; no client updates
// required.

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant Prisma wrapper (see services/tenant-prisma).
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, dashboardPreferenceSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { generateServiceCertificateHTML } from "../services/pdf";

const router = Router();
router.use(authenticate);

// ─── GET /users — list staff users for /dashboard/users (Issue #4) ────
//
// Returns a flat list of staff users with the fields the User Management
// table reads directly: name, email, phone, role, isActive, createdAt.
//
// The existing `/shifts/staff` endpoint omits `phone` and `createdAt`,
// which is why the UsersPage rendered empty "Joined" / "Phone" cells —
// and the page was falling back to `/doctors`, whose payload is shaped
// as `{ user: { name, email, phone } }` (nested), so `u.name` etc. were
// all undefined. This endpoint returns the exact shape the `StaffUser`
// interface in apps/web/src/app/dashboard/users/page.tsx expects.
router.get(
  "/",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          // Issue #190: include PHARMACIST + LAB_TECH so newly-created
          // staff in those roles show up in the User Management table.
          role: {
            in: [
              Role.ADMIN,
              Role.DOCTOR,
              Role.NURSE,
              Role.RECEPTION,
              Role.PHARMACIST,
              Role.LAB_TECH,
            ],
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });
      res.json({ success: true, data: users, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /users/:id/service-certificate ───────────────
router.get(
  "/:id/service-certificate",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conduct = (req.query.conduct as string) || "satisfactory";
      const html = await generateServiceCertificateHTML(req.params.id, conduct);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "User not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── Issue #286: User Management actions (Edit / Disable / Reset PW) ─
//
// The Users page previously had no row-level actions. ADMINs can now:
//   1. PATCH /users/:id           — edit name/phone/role/isActive
//   2. POST  /users/:id/reset-password — generate a 6-digit reset code
//
// Disabling sets isActive=false (no hard delete — preserves audit trail
// and references on prescriptions/orders).
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { name, phone, role, isActive } = req.body as {
        name?: string;
        phone?: string;
        role?: string;
        isActive?: boolean;
      };

      const data: Record<string, unknown> = {};
      // Issue #284: sanitize the staff name on the API edge — even if
      // the form is patched, no payload with `<script>` reaches the DB.
      if (typeof name === "string") {
        const cleaned = name.replace(/\s+/g, " ").trim();
        if (cleaned.length === 0 || cleaned.length > 100) {
          res.status(400).json({
            success: false,
            error: "Name must be 1–100 characters",
            details: [{ field: "name", message: "Name must be 1–100 characters" }],
          });
          return;
        }
        if (/<[^>]*>|javascript:|vbscript:|\bon\w+\s*=/i.test(cleaned)) {
          res.status(400).json({
            success: false,
            error: "Name contains characters that aren't allowed",
            details: [
              { field: "name", message: "Name cannot contain HTML or scripts" },
            ],
          });
          return;
        }
        data.name = cleaned;
      }
      if (typeof phone === "string") {
        const trimmed = phone.trim();
        if (!/^\+?\d{10,15}$/.test(trimmed)) {
          res.status(400).json({
            success: false,
            error: "Phone must be 10–15 digits, optional leading +",
            details: [{ field: "phone", message: "Phone must be 10–15 digits" }],
          });
          return;
        }
        data.phone = trimmed;
      }
      if (typeof role === "string") {
        const validRoles = [
          "ADMIN",
          "DOCTOR",
          "NURSE",
          "RECEPTION",
          "PHARMACIST",
          "LAB_TECH",
        ];
        if (!validRoles.includes(role)) {
          res.status(400).json({
            success: false,
            error: "Invalid role",
            details: [{ field: "role", message: "Invalid role" }],
          });
          return;
        }
        // Self-demotion guard.
        if (req.user!.userId === id && role !== "ADMIN") {
          res.status(400).json({
            success: false,
            error: "You cannot change your own role",
          });
          return;
        }
        data.role = role;
      }
      if (typeof isActive === "boolean") {
        // Self-disable guard.
        if (req.user!.userId === id && isActive === false) {
          res.status(400).json({
            success: false,
            error: "You cannot disable your own account",
          });
          return;
        }
        data.isActive = isActive;
      }

      if (Object.keys(data).length === 0) {
        res.status(400).json({ success: false, error: "Nothing to update" });
        return;
      }

      const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });
      auditLog(req, "USER_UPDATED", "user", id, data).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/reset-password",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true },
      });
      if (!target) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      // Mirror the /auth/forgot-password flow: invalidate prior unused
      // codes and persist a fresh one.
      await (prisma as any).passwordResetCode.deleteMany({
        where: { userId: target.id, usedAt: null },
      });
      await (prisma as any).passwordResetCode.create({
        data: {
          userId: target.id,
          code,
          expiresAt,
        },
      });
      auditLog(req, "USER_PASSWORD_RESET_INITIATED", "user", target.id).catch(
        console.error
      );
      res.json({
        success: true,
        data: {
          message: `Password reset code generated. Expires in 30 min.`,
          code,
          email: target.email,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── User dashboard preferences ───────────────────────

router.get(
  "/me/dashboard-preferences",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const pref = await prisma.userDashboardPreference.findUnique({
        where: { userId },
      });
      res.json({
        success: true,
        data: pref ?? { userId, layout: { widgets: [] } },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/me/dashboard-preferences",
  validate(dashboardPreferenceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const layout = req.body.layout;
      const saved = await prisma.userDashboardPreference.upsert({
        where: { userId },
        update: { layout: layout as any },
        create: { userId, layout: layout as any },
      });
      res.json({ success: true, data: saved, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as usersRouter };
