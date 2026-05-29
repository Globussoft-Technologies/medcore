/**
 * Role-permission catalog API — Pearl §8.1 wizard step 3.
 *
 * Global (NOT tenant-scoped) — `role_catalog_entries` + `role_permission_items`
 * are platform-wide tables, so the endpoints live under
 * `/api/v1/role-permissions/*` rather than under `/tenants/:id/...`.
 *
 * READ is open to ADMIN and SUPER_ADMIN (every tenant admin can review
 * what the role bands grant). MUTATIONS are restricted to SUPER_ADMIN,
 * verified against the live `users.role` column on every request — the
 * JWT claim is informational only, see `requireSuperAdminForEdit` below.
 *
 * Endpoints:
 *   GET    /role-permissions                            list catalog
 *   POST   /role-permissions/entries                    create a new role
 *   DELETE /role-permissions/entries/:role              delete a role (cascades)
 *   POST   /role-permissions/:role/permissions          append a permission
 *   DELETE /role-permissions/:role/permissions/:index   remove a permission
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";

const router = Router();

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));

// ─── Validation constants ────────────────────────────────────────────

const ROLE_REGEX = /^[A-Z][A-Z0-9_]{1,39}$/;
const LABEL_MIN_LEN = 2;
const LABEL_MAX_LEN = 100;
const SUMMARY_MAX_LEN = 300;
const PERMISSION_MAX_LEN = 200;

// ─── Wire shape (matches what the frontend page expects) ─────────────

interface RolePermissionWire {
  role: string;
  label: string;
  summary: string;
  permissions: string[];
}

async function loadCatalog(): Promise<RolePermissionWire[]> {
  const entries = await prisma.roleCatalogEntry.findMany({
    orderBy: { displayOrder: "asc" },
    include: { permissions: { orderBy: { displayOrder: "asc" } } },
  });
  return entries.map((e) => ({
    role: e.role,
    label: e.label,
    summary: e.summary,
    permissions: e.permissions.map((p) => p.permission),
  }));
}

// ─── DB-authoritative super-admin gate ───────────────────────────────

async function requireSuperAdminForEdit(
  req: Request,
  res: Response,
): Promise<boolean> {
  const userId = req.user?.userId;
  if (!userId) {
    res
      .status(401)
      .json({ success: false, data: null, error: "Unauthorised" });
    return false;
  }
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true },
  });
  if (!dbUser || dbUser.isActive === false) {
    res.status(401).json({
      success: false,
      data: null,
      error: "User account is no longer active",
    });
    return false;
  }
  if (dbUser.role !== Role.SUPER_ADMIN) {
    res.status(403).json({
      success: false,
      data: null,
      error: "Only a super admin can edit the role-permission catalog",
    });
    return false;
  }
  return true;
}

// ─── GET / — list the catalog ────────────────────────────────────────

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await loadCatalog();
    res.json({ success: true, data: { roles }, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── POST /entries — create a new role ───────────────────────────────
// Body: { role: string, label: string, summary: string, permissions?: string[] }
// Optionally seeds the new role with starter permissions in the same
// transaction so the modal can create role + initial permissions in one
// round-trip. Returns the full updated catalog so the frontend re-renders.
router.post(
  "/entries",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await requireSuperAdminForEdit(req, res))) return;
      const role =
        typeof req.body?.role === "string"
          ? req.body.role.trim().toUpperCase()
          : "";
      const label =
        typeof req.body?.label === "string" ? req.body.label.trim() : "";
      const summary =
        typeof req.body?.summary === "string"
          ? req.body.summary.trim()
          : "";
      // Normalise the optional permissions array — trim + dedupe + drop
      // empties + enforce per-string length cap. Any non-array body
      // (e.g. a single string posted by a typoed client) is treated as
      // zero permissions rather than a 400 so the modal stays resilient.
      const rawPerms: unknown = req.body?.permissions;
      const permissions: string[] = Array.isArray(rawPerms)
        ? Array.from(
            new Set(
              rawPerms
                .filter((p): p is string => typeof p === "string")
                .map((p) => p.trim())
                .filter((p) => p.length > 0 && p.length <= PERMISSION_MAX_LEN),
            ),
          )
        : [];

      if (!ROLE_REGEX.test(role)) {
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Role must be UPPER_SNAKE format (A-Z, 0-9, _), 2 to 40 chars",
        });
        return;
      }
      if (label.length < LABEL_MIN_LEN || label.length > LABEL_MAX_LEN) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Label must be ${LABEL_MIN_LEN}–${LABEL_MAX_LEN} chars`,
        });
        return;
      }
      if (summary.length === 0 || summary.length > SUMMARY_MAX_LEN) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Summary is required and must be ≤ ${SUMMARY_MAX_LEN} chars`,
        });
        return;
      }

      const existing = await prisma.roleCatalogEntry.findUnique({
        where: { role },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Role ${role} is already in the catalog`,
        });
        return;
      }

      const lastOrder = await prisma.roleCatalogEntry.aggregate({
        _max: { displayOrder: true },
      });
      const nextOrder = (lastOrder._max.displayOrder ?? 0) + 1;
      const created = await prisma.roleCatalogEntry.create({
        data: {
          role,
          label,
          summary,
          displayOrder: nextOrder,
        },
        select: { id: true },
      });
      if (permissions.length > 0) {
        await prisma.rolePermissionItem.createMany({
          data: permissions.map((permission, idx) => ({
            entryId: created.id,
            permission,
            displayOrder: idx + 1,
          })),
        });
      }

      auditLog(req, "ROLE_CATALOG_ENTRY_ADD", "role_catalog_entry", role, {
        role,
        label,
        seededPermissions: permissions.length,
      }).catch(console.error);

      const roles = await loadCatalog();
      res.status(201).json({ success: true, data: { roles }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /entries/:role — drop a role + cascade its permissions ───

router.delete(
  "/entries/:role",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await requireSuperAdminForEdit(req, res))) return;
      const role = req.params.role;
      if (!ROLE_REGEX.test(role)) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Invalid role name" });
        return;
      }
      const entry = await prisma.roleCatalogEntry.findUnique({
        where: { role },
        select: { id: true },
      });
      if (!entry) {
        res.status(404).json({
          success: false,
          data: null,
          error: `Role ${role} is not in the catalog`,
        });
        return;
      }
      // `RolePermissionItem.entry` is declared with onDelete: Cascade,
      // so dropping the entry takes its permission rows with it.
      await prisma.roleCatalogEntry.delete({ where: { id: entry.id } });

      auditLog(
        req,
        "ROLE_CATALOG_ENTRY_REMOVE",
        "role_catalog_entry",
        role,
        { role },
      ).catch(console.error);

      const roles = await loadCatalog();
      res.json({ success: true, data: { roles }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:role/permissions — append one permission row ─────────────

router.post(
  "/:role/permissions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await requireSuperAdminForEdit(req, res))) return;
      const role = req.params.role;
      if (!ROLE_REGEX.test(role)) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Invalid role name" });
        return;
      }
      const permission =
        typeof req.body?.permission === "string"
          ? req.body.permission.trim()
          : "";
      if (!permission) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Permission text is required",
        });
        return;
      }
      if (permission.length > PERMISSION_MAX_LEN) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Permission must be ${PERMISSION_MAX_LEN} characters or fewer`,
        });
        return;
      }

      const entry = await prisma.roleCatalogEntry.findUnique({
        where: { role },
        include: {
          permissions: { orderBy: { displayOrder: "desc" }, take: 1 },
        },
      });
      if (!entry) {
        res.status(404).json({
          success: false,
          data: null,
          error: `Role ${role} is not in the catalog`,
        });
        return;
      }

      const exists = await prisma.rolePermissionItem.findFirst({
        where: { entryId: entry.id, permission },
        select: { id: true },
      });
      if (!exists) {
        const nextOrder = (entry.permissions[0]?.displayOrder ?? 0) + 1;
        await prisma.rolePermissionItem.create({
          data: { entryId: entry.id, permission, displayOrder: nextOrder },
        });
      }

      auditLog(
        req,
        "ROLE_CATALOG_PERMISSION_ADD",
        "role_catalog_entry",
        role,
        { role, permission },
      ).catch(console.error);

      const roles = await loadCatalog();
      res.json({ success: true, data: { roles }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /:role/permissions/:index — remove Nth permission ────────

router.delete(
  "/:role/permissions/:index",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await requireSuperAdminForEdit(req, res))) return;
      const role = req.params.role;
      if (!ROLE_REGEX.test(role)) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Invalid role name" });
        return;
      }
      const idx = Number(req.params.index);
      if (!Number.isInteger(idx) || idx < 0) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Invalid index" });
        return;
      }

      const entry = await prisma.roleCatalogEntry.findUnique({
        where: { role },
        include: { permissions: { orderBy: { displayOrder: "asc" } } },
      });
      if (!entry) {
        res.status(404).json({
          success: false,
          data: null,
          error: `Role ${role} is not in the catalog`,
        });
        return;
      }
      const target = entry.permissions[idx];
      if (!target) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Index out of range" });
        return;
      }
      await prisma.rolePermissionItem.delete({ where: { id: target.id } });

      auditLog(
        req,
        "ROLE_CATALOG_PERMISSION_REMOVE",
        "role_catalog_entry",
        role,
        { role, permission: target.permission, index: idx },
      ).catch(console.error);

      const roles = await loadCatalog();
      res.json({ success: true, data: { roles }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as rolePermissionsRouter };
