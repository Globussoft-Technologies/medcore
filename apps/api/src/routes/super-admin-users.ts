/**
 * Cross-tenant super-admin user roster — Pearl ERP Stage 1 §8.2
 * (gap row 208 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Operator-facing list of users in the "super-admin" set: rows where
 *     `tenantId == null AND role == ADMIN`. This is the load-bearing
 *     pattern enforced by `routes/tenants.ts:requireSuperAdmin`, NOT a
 *     new permission model — no `SuperAdmin` Prisma table is introduced.
 *   - Mounts at /api/v1/super-admin/users. Endpoints:
 *       GET   /                  — list with `active` + `q` (name/email
 *                                 free-text) filters.
 *       PATCH /:id               — toggle `isActive` on a super-admin
 *                                 user. Refuses to deactivate the LAST
 *                                 ACTIVE super-admin (count guard) so an
 *                                 operator can't lock the org out of the
 *                                 Pearl console.
 *   - RBAC: router-level `authenticate` + `authorize(Role.ADMIN)` +
 *     `requireSuperAdmin` (mirrors `tenants.ts` exactly: tenant-less
 *     ADMIN OR ADMIN on the seeded "default" tenant). PATIENT/DOCTOR/etc
 *     bounce at `authorize`; tenant-bound ADMINs bounce at
 *     `requireSuperAdmin` with 403.
 *   - Audit: awaited `auditLog()` (NOT `safeAudit`) so integration tests
 *     can read AuditLog immediately. Action SUPER_ADMIN_USER_UPDATED on
 *     PATCH success.
 *   - Scope-cut from prompt: `lastSignInAt` is NOT exposed because the
 *     User model does not currently track it. Adding the column was
 *     forbidden by the prompt's "no schema files" allowlist; the page
 *     just omits the column. `createdAt` is shown as the closest proxy.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { sendEmail } from "../services/messaging/email";
import { renderSuperAdminInviteEmail } from "../templates/super-admin-invite.html";
import {
  enforceSuperAdminIdleTimeout,
  getSuperAdminIdleMinutes,
  setSuperAdminIdleMinutes,
  SUPER_ADMIN_IDLE_LIMITS,
} from "../middleware/session-idle";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Mirrors `routes/tenants.ts:requireSuperAdmin`. We re-declare it locally
 * rather than importing because that helper is module-private and the
 * intent is to keep these endpoints independently movable (Pearl wants
 * /super-admin/ on its own host eventually — CLAUDE.md §5.5).
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
    if (req.user?.role === Role.SUPER_ADMIN) {
      return next();
    }
    const callerTenantId = req.user?.tenantId ?? null;
    if (callerTenantId == null) {
      return next();
    }
    const callerTenant = await prisma.tenant.findUnique({
      where: { id: callerTenantId },
      select: { subdomain: true },
    });
    if (callerTenant?.subdomain === "default") {
      return next();
    }
    res.status(403).json({
      success: false,
      data: null,
      error: "Only super-admins can manage the super-admin roster",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  // Default to ALL so the operator sees deactivated rows too (otherwise
  // the "last-active" guard error is mysterious — "but I see one active
  // super-admin in the list" is what the operator needs to verify).
  active: z
    .enum(["true", "false", "all"])
    .optional()
    .transform((v) => (v == null ? "all" : v)),
  q: z.string().trim().max(200).optional(),
});

const patchUserSchema = z.object({
  active: z.boolean(),
});

// Pearl §8.2 — invite a new super-admin. Pearl-style "Onviqa operator"
// (tenantId = null + role = ADMIN). The temporary password is set
// inline; TOTP enrolment is enforced on first login when
// `requireTwoFactor=true` (default true).
const createSuperAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{7,15}$/, "Invalid phone (7-15 digits, optional leading +)"),
  password: z.string().min(8).max(128),
  requireTwoFactor: z.boolean().optional().default(true),
  permissions: z
    .object({
      canManageTenants: z.boolean().optional(),
      canOnboardTenant: z.boolean().optional(),
      canViewBilling: z.boolean().optional(),
      canTriggerJobs: z.boolean().optional(),
      canDpdpWorkbench: z.boolean().optional(),
      canViewAudit: z.boolean().optional(),
      tenantScope: z.array(z.string()).optional(),
      moduleScope: z.array(z.string()).optional(),
    })
    .optional(),
});

// Pearl §8.2 — granular permission grants. Stored as JSON in
// SystemConfig under `superadmin:<userId>:permissions` (no schema change).
// `tenantScope` empty/missing == all-tenants; same for `moduleScope`.
const permissionsSchema = z.object({
  canManageTenants: z.boolean().optional(),
  canOnboardTenant: z.boolean().optional(),
  canViewBilling: z.boolean().optional(),
  canTriggerJobs: z.boolean().optional(),
  canDpdpWorkbench: z.boolean().optional(),
  canViewAudit: z.boolean().optional(),
  tenantScope: z.array(z.string()).optional(),
  moduleScope: z.array(z.string()).optional(),
});

const PERMISSIONS_KEY = (userId: string) =>
  `superadmin:${userId}:permissions`;

async function readPermissions(
  userId: string,
): Promise<Record<string, unknown>> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: PERMISSIONS_KEY(userId) },
  });
  if (!row) return {};
  try {
    return JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
// Pearl §8.2 — accept both the legacy super-admin shape (Role.ADMIN +
// tenantId=null) and the new dedicated SUPER_ADMIN role. The narrower
// `requireSuperAdmin` guard below disambiguates per request.
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
// Pearl §8.2 — enforce the sliding idle-timeout on all super-admin
// surfaces. Returns 401 with code "session_idle" when the cross-tenant
// operator has been idle longer than the configured window.
router.use(enforceSuperAdminIdleTimeout);

// GET /api/v1/super-admin/users — list the super-admin set.
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { active, q } = parsed.data;
      // Pearl §8.2 — "List of super-admins across all tenants" includes:
      //   - New super-admin invites  (Role.SUPER_ADMIN, tenantId IS NULL)
      //   - Legacy Onviqa operators  (Role.ADMIN, tenantId IS NULL)
      //   - Tenant super-admins      (Role.ADMIN, tenantId IS SET)
      // Both ADMIN and SUPER_ADMIN are recognised so the UI shows
      // newly-invited operators alongside the legacy population during
      // the migration window. The response carries `tenant` (null for
      // cross-tenant) and `kind` ("onviqa" | "tenant") discriminators.
      const where: Record<string, unknown> = {
        role: { in: [Role.ADMIN, Role.SUPER_ADMIN] },
      };
      if (active === "true") where.isActive = true;
      else if (active === "false") where.isActive = false;
      if (q && q.length > 0) {
        where.OR = [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ];
      }
      const rowsRaw = await prisma.user.findMany({
        where,
        orderBy: [{ tenantId: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          twoFactorEnabled: true,
          createdAt: true,
          tenantId: true,
          tenant: {
            select: { id: true, name: true, subdomain: true },
          },
        },
        take: 500,
      });

      // Pearl §8.2 — fetch `isMainSuperAdmin` via raw SQL because the
      // on-disk Prisma client hasn't been regenerated yet on this dev
      // box (DLL lock by the running dev server). Once `prisma generate`
      // runs cleanly the column can move back into the typed `select`
      // above and this block collapses. We fetch every admin-like row
      // (the set is bounded by the number of platform operators, which
      // is small) and join in memory.
      const mainFlagRows = await prisma.$queryRaw<
        Array<{ id: string; isMainSuperAdmin: boolean }>
      >`SELECT id, "isMainSuperAdmin" FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN')`;
      const mainFlagById = new Map<string, boolean>();
      for (const r of mainFlagRows) {
        mainFlagById.set(r.id, r.isMainSuperAdmin);
      }
      const rows = rowsRaw.map((r) => ({
        ...r,
        isMainSuperAdmin: mainFlagById.get(r.id) ?? false,
      }));

      // Pearl §8.2 — fan-out the permission grants and the
      // last-login timestamp (from AuditLog action='AUTH_LOGIN') in
      // single batched queries so the list is O(1) round-trips, not
      // O(N).
      const userIds = rows.map((u) => u.id);
      const [permRows, lastLoginRows] = await Promise.all([
        userIds.length === 0
          ? []
          : prisma.systemConfig.findMany({
              where: {
                OR: userIds.map((id) => ({ key: PERMISSIONS_KEY(id) })),
              },
            }),
        userIds.length === 0
          ? []
          : prisma.auditLog.groupBy({
              by: ["userId"],
              where: {
                userId: { in: userIds },
                action: "AUTH_LOGIN",
              },
              _max: { createdAt: true },
            }),
      ]);
      const permByUser = new Map<string, Record<string, unknown>>();
      for (const r of permRows) {
        const m = r.key.match(/^superadmin:([^:]+):permissions$/);
        if (!m) continue;
        try {
          permByUser.set(m[1], JSON.parse(r.value));
        } catch {
          permByUser.set(m[1], {});
        }
      }
      const lastLoginByUser = new Map<string, string | null>();
      for (const r of lastLoginRows) {
        if (!r.userId) continue;
        lastLoginByUser.set(
          r.userId,
          r._max.createdAt ? r._max.createdAt.toISOString() : null,
        );
      }

      const enriched = rows.map((u) => ({
        ...u,
        // Pearl §8.2 — discriminator the UI uses to decide whether the
        // row is an Onviqa operator (cross-tenant) or a tenant
        // super-admin. Onviqa rows allow Deactivate / permission edit;
        // tenant rows are read-only (managed via that tenant's own
        // user admin).
        kind: u.tenantId == null ? "onviqa" : "tenant",
        // Permission grants only exist for Onviqa operators; tenant
        // ADMINs don't go through the super-admin invite flow.
        permissions: permByUser.get(u.id) ?? {},
        lastLoginAt: lastLoginByUser.get(u.id) ?? null,
      }));

      res.status(200).json({
        success: true,
        data: { users: enriched },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Super-admin session idle-timeout settings ───────────────────────
// Pearl §8.2 — operator-facing knob for the global super-admin idle
// window. Returns the current value + the allowed range so the UI
// can render a slider/input with proper bounds.
//
// IMPORTANT: declared BEFORE the `/:id`-shaped routes below. Express
// matches in registration order, so a literal `/session-idle` must
// beat the dynamic `/:id` or the `GET /:id` handler swallows the
// request and returns "Super-admin user not found".

router.get(
  "/session-idle",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const minutes = await getSuperAdminIdleMinutes();
      res.status(200).json({
        success: true,
        data: {
          minutes,
          min: SUPER_ADMIN_IDLE_LIMITS.min,
          max: SUPER_ADMIN_IDLE_LIMITS.max,
          default: SUPER_ADMIN_IDLE_LIMITS.default,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

const sessionIdleBodySchema = z.object({
  minutes: z
    .number()
    .int()
    .min(SUPER_ADMIN_IDLE_LIMITS.min)
    .max(SUPER_ADMIN_IDLE_LIMITS.max),
});

router.put(
  "/session-idle",
  validate(sessionIdleBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Main-only gate: the idle-timeout is a platform-wide policy
      // knob — only the root super-admin may change it. Peers can
      // still GET the current value (read-only), but mutating it is
      // restricted. UI hides the card; this matches it server-side.
      const callerRows = await prisma.$queryRaw<
        Array<{ isMainSuperAdmin: boolean }>
      >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
      const callerIsMain = callerRows[0]?.isMainSuperAdmin === true;
      if (!callerIsMain) {
        res.status(403).json({
          success: false,
          data: null,
          error:
            "Only the main super-admin can change the auto-sign-out policy.",
        });
        return;
      }

      const body = req.body as z.infer<typeof sessionIdleBodySchema>;
      const persisted = await setSuperAdminIdleMinutes(body.minutes);
      await auditLog(
        req,
        "SUPER_ADMIN_SESSION_IDLE_UPDATED",
        "system",
        undefined,
        { minutes: persisted },
      );
      res.status(200).json({
        success: true,
        data: { minutes: persisted },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/super-admin/users/:id — toggle isActive on a super-admin.
// Refuses to deactivate the last active super-admin (count guard) so the
// operator population cannot drop to zero.
router.patch(
  "/:id",
  validate(patchUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          tenantId: true,
        },
      });
      if (!target) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }
      // Defence-in-depth: the route guard already enforces super-admin
      // caller shape, but PATCH /:id MUST refuse to mutate anything that
      // isn't either (a) a cross-tenant super-admin or (b) a tenant
      // ADMIN. Otherwise the endpoint becomes a tenant-user mass-mutation
      // surface masquerading as a super-admin tool.
      const targetIsCrossTenantSuperAdmin =
        target.tenantId === null &&
        (target.role === Role.ADMIN || target.role === Role.SUPER_ADMIN);
      const targetIsTenantAdmin =
        target.tenantId !== null && target.role === Role.ADMIN;
      if (!targetIsCrossTenantSuperAdmin && !targetIsTenantAdmin) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }

      const body = req.body as z.infer<typeof patchUserSchema>;
      const nextActive = body.active;

      const targetingSelf = req.user?.userId === target.id;
      if (targetingSelf) {
        res.status(400).json({
          success: false,
          data: null,
          error: "You cannot change your own active state.",
        });
        return;
      }

      // Resolve the caller's main flag once — we use it for the
      // cross-tenant super-admin gate below, and tenant-admin mutations
      // are still allowed without it.
      // Use raw SQL for the same DLL-lock reason as the list endpoint.
      const callerRows = await prisma.$queryRaw<
        Array<{ isMainSuperAdmin: boolean }>
      >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
      const callerIsMain = callerRows[0]?.isMainSuperAdmin === true;

      if (targetIsCrossTenantSuperAdmin) {
        // Only the main super-admin may deactivate / reactivate ANOTHER
        // cross-tenant super-admin. Peers keep every other power; this
        // gate exists so a compromised or rogue peer can't lock the
        // root operator out of the platform.
        if (!callerIsMain) {
          res.status(403).json({
            success: false,
            data: null,
            error:
              "Only the main super-admin can deactivate or reactivate another super-admin.",
          });
          return;
        }
        // Refuse to deactivate the main super-admin itself. The
        // count-guard below would catch the "last active" case but the
        // root row should be untouchable regardless.
        const targetMainRows = await prisma.$queryRaw<
          Array<{ isMainSuperAdmin: boolean }>
        >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${target.id}`;
        const targetIsMain = targetMainRows[0]?.isMainSuperAdmin === true;
        if (targetIsMain && nextActive === false) {
          res.status(403).json({
            success: false,
            data: null,
            error: "The main super-admin cannot be deactivated.",
          });
          return;
        }
      }
      // Tenant-admin mutations: any cross-tenant super-admin (main or
      // peer) may toggle a hospital tenant's local admin from this page.
      // The route guard already proved the caller is cross-tenant.

      // No-op short-circuit — return current state without audit churn.
      if (nextActive === target.isActive) {
        res.status(200).json({
          success: true,
          data: {
            id: target.id,
            name: target.name,
            email: target.email,
            role: target.role,
            isActive: target.isActive,
          },
          error: null,
        });
        return;
      }

      // Count-guard: deactivating must leave at least one active
      // cross-tenant super-admin. Tenant ADMINs don't count — they only
      // manage their own hospital, so deactivating one never locks the
      // platform out. Counts BOTH Role.SUPER_ADMIN (new invites) and the
      // legacy Role.ADMIN + tenantId=null shape so the migration window
      // can't accidentally bottom out at zero operators.
      if (nextActive === false && targetIsCrossTenantSuperAdmin) {
        const otherActive = await prisma.user.count({
          where: {
            tenantId: null,
            role: { in: [Role.ADMIN, Role.SUPER_ADMIN] },
            isActive: true,
            id: { not: target.id },
          },
        });
        if (otherActive === 0) {
          res.status(409).json({
            success: false,
            data: null,
            error:
              "Cannot deactivate the last active super-admin — promote another user first",
          });
          return;
        }
      }

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { isActive: nextActive },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      await auditLog(
        req,
        "SUPER_ADMIN_USER_UPDATED",
        "user",
        updated.id,
        {
          previousIsActive: target.isActive,
          newIsActive: updated.isActive,
        },
      );

      res.status(200).json({
        success: true,
        data: updated,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST / — invite a new super-admin ──────────────────────────────
// Creates a `Role.ADMIN` user with `tenantId = null`. Email must be
// unique. The temporary password is hashed via bcrypt before insert.
// TOTP enrolment is encouraged via `requireTwoFactor` flag — stored in
// SystemConfig (`superadmin:<userId>:require_two_factor`) so the login
// flow can refuse to admit the user until they've enrolled.
router.post(
  "/",
  validate(createSuperAdminSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Main-only gate: peer super-admins can browse the roster but
      // cannot mint new platform operators. The /dashboard UI hides
      // the "Add Super-Admin" button for non-main viewers; this is
      // the matching server-side guard so a direct API hit can't
      // bypass it. Raw SQL because the on-disk Prisma client may not
      // yet know the column on this dev box (DLL lock during dev).
      const callerRows = await prisma.$queryRaw<
        Array<{ isMainSuperAdmin: boolean }>
      >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
      const callerIsMain = callerRows[0]?.isMainSuperAdmin === true;
      if (!callerIsMain) {
        res.status(403).json({
          success: false,
          data: null,
          error:
            "Only the main super-admin can invite new platform operators.",
        });
        return;
      }

      const body = req.body as z.infer<typeof createSuperAdminSchema>;

      const existing = await prisma.user.findUnique({
        where: { email: body.email.trim().toLowerCase() },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: "A user with this email already exists",
        });
        return;
      }

      // bcryptjs is the same library auth.ts uses — same cost factor.
      const bcrypt = await import("bcryptjs");
      const passwordHash = await bcrypt.hash(body.password, 10);

      const created = await prisma.user.create({
        data: {
          email: body.email.trim().toLowerCase(),
          name: body.name.trim(),
          phone: body.phone.trim(),
          passwordHash,
          // Pearl §8.2 — new super-admin invites get the dedicated
          // SUPER_ADMIN role. Legacy super-admins still exist as
          // ADMIN + tenantId=null; both shapes are recognised below
          // by the count-guard, requireSuperAdmin, and list filters.
          role: Role.SUPER_ADMIN,
          tenantId: null,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          twoFactorEnabled: true,
          createdAt: true,
        },
      });

      // Stash the TOTP-required flag + initial permissions in
      // SystemConfig (keyed by the new user's id).
      const writes: Array<Promise<unknown>> = [];
      writes.push(
        prisma.systemConfig.upsert({
          where: { key: `superadmin:${created.id}:require_two_factor` },
          create: {
            key: `superadmin:${created.id}:require_two_factor`,
            value: body.requireTwoFactor === false ? "false" : "true",
          },
          update: {
            value: body.requireTwoFactor === false ? "false" : "true",
          },
        }),
      );
      if (body.permissions) {
        writes.push(
          prisma.systemConfig.upsert({
            where: { key: PERMISSIONS_KEY(created.id) },
            create: {
              key: PERMISSIONS_KEY(created.id),
              value: JSON.stringify(body.permissions),
            },
            update: { value: JSON.stringify(body.permissions) },
          }),
        );
      }
      await Promise.all(writes);

      await auditLog(req, "SUPER_ADMIN_USER_CREATED", "user", created.id, {
        email: created.email,
        requireTwoFactor: body.requireTwoFactor !== false,
      });

      // Pearl §8.2 — send the SendGrid invite email so the new
      // super-admin gets their temp password + sign-in link in their
      // inbox. The operator no longer has to share credentials out of
      // band on Slack / voice. Fire-and-forget: a SendGrid failure
      // does NOT roll back the user creation (that would leave the
      // operator with a 5xx and a half-created row). We surface a
      // `mailSent: boolean` on the response and write a second audit
      // row so the trail captures the delivery outcome.
      const appUrl =
        process.env.APP_URL ||
        process.env.WEB_APP_URL ||
        process.env.CORS_ORIGIN ||
        "http://localhost:3000";
      const signInUrl = `${appUrl.replace(/\/$/, "")}/login`;
      // Coerce nullable Prisma columns to strings the template helper
      // expects — `name` defaults to the email local-part if missing,
      // `email` is mandatory in the create flow so the fallback is
      // purely defensive.
      const inviteeName = created.name ?? created.email?.split("@")[0] ?? "";
      const inviteeEmail = created.email ?? body.email;
      const { subject, html, text } = renderSuperAdminInviteEmail({
        inviteeName,
        inviteeEmail,
        temporaryPassword: body.password,
        signInUrl,
        requireTwoFactor: body.requireTwoFactor !== false,
        invitedByName: req.user?.email ?? null,
      });
      let mailSent = false;
      let mailError: string | undefined;
      try {
        const mailResult = await sendEmail({
          to: inviteeEmail,
          subject,
          html,
          text,
        });
        mailSent = mailResult.ok;
        if (!mailResult.ok) mailError = mailResult.error;
      } catch (err) {
        mailError = err instanceof Error ? err.message : String(err);
      }
      auditLog(
        req,
        mailSent
          ? "SUPER_ADMIN_INVITE_EMAILED"
          : "SUPER_ADMIN_INVITE_EMAIL_FAILED",
        "user",
        created.id,
        {
          to: created.email,
          ...(mailError ? { error: mailError } : {}),
        },
      ).catch(console.error);

      res.status(201).json({
        success: true,
        data: {
          ...created,
          permissions: body.permissions ?? {},
          requireTwoFactor: body.requireTwoFactor !== false,
          mailSent,
          ...(mailError ? { mailError } : {}),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id — single super-admin detail ────────────────────────────
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          twoFactorEnabled: true,
          tenantId: true,
          createdAt: true,
        },
      });
      if (
        !user ||
        user.tenantId !== null ||
        (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN)
      ) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }
      const [permissions, lastLogin] = await Promise.all([
        readPermissions(user.id),
        prisma.auditLog.findFirst({
          where: { userId: user.id, action: "AUTH_LOGIN" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);
      res.status(200).json({
        success: true,
        data: {
          ...user,
          permissions,
          lastLoginAt: lastLogin?.createdAt
            ? lastLogin.createdAt.toISOString()
            : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id/permissions — fetch granular grants ────────────────────
router.get(
  "/:id/permissions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, role: true, tenantId: true },
      });
      if (
        !user ||
        user.tenantId !== null ||
        (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN)
      ) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }
      const permissions = await readPermissions(user.id);
      res.status(200).json({
        success: true,
        data: { userId: user.id, permissions },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PUT /:id/permissions — replace the grant set ────────────────────
router.put(
  "/:id/permissions",
  validate(permissionsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, role: true, tenantId: true },
      });
      if (
        !user ||
        user.tenantId !== null ||
        (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN)
      ) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }
      const body = req.body as z.infer<typeof permissionsSchema>;
      await prisma.systemConfig.upsert({
        where: { key: PERMISSIONS_KEY(user.id) },
        create: {
          key: PERMISSIONS_KEY(user.id),
          value: JSON.stringify(body),
        },
        update: { value: JSON.stringify(body) },
      });

      await auditLog(
        req,
        "SUPER_ADMIN_PERMISSIONS_UPDATED",
        "user",
        user.id,
        {
          permissionKeys: Object.keys(body),
        },
      );

      res.status(200).json({
        success: true,
        data: { userId: user.id, permissions: body },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// (Session-idle routes moved above `/:id` — see comment near the top
// of the route table for why. Express matches in registration order
// and a literal `/session-idle` GET / PUT must beat the dynamic
// `/:id` declarations or the dynamic handler swallows the request
// with a "Super-admin user not found" 404.)

export const superAdminUsersRouter = router;
