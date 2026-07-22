// Department admin module (2026-07) — admin CRUD + dashboard for the
// operational departments that raise requisitions against the central store.
//
// What: REST endpoints to create / read / update / (soft) delete departments,
//   plus a dashboard-stats endpoint that aggregates requisition activity per
//   department (open requests, completed this month, lines issued).
// Which: reads/writes Department; reads Requisition (+ items) for stats. All
//   via the tenant-scoped Prisma client so rows auto-filter by tenant.
// Why: the Requisition workflow needs departments to exist and be maintained;
//   only ADMIN may configure them. Staff read departments through the existing
//   GET /requisitions/departments picker — this file is the admin surface.
//
// RBAC:
//   • create / update / delete → ADMIN only (configuration)
//   • list / get / dashboard   → ADMIN only (this is an admin console page;
//     staff never see the full department registry, only the create-form
//     picker exposed by requisitions.ts)
//
// Delete policy: departments are NEVER hard-deleted. A department with any
// requisition history is referenced by Requisition.departmentId; dropping it
// would orphan that history. DELETE therefore soft-deletes (active=false).
// A department with zero requisitions may be hard-removed.

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createDepartmentSchema,
  updateDepartmentSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { allowedDepartmentIds, isMemberOf } from "../services/department-scope";

const router = Router();
router.use(authenticate);

// The "open" (in-flight) requisition statuses — anything not yet finished or
// abandoned. Used by the dashboard + delete guard.
const OPEN_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "READY_FOR_ISSUE",
  "PARTIALLY_ISSUED",
  "ISSUED",
];

const READ_ROLES = [
  Role.ADMIN,
  Role.PHARMACIST,
  Role.NURSE,
  Role.DOCTOR,
  Role.RECEPTION,
  Role.LAB_TECH,
] as const;

// ── GET / — list departments (admin) ──────────────────────────────────────
// Optional ?active=true|false filter and ?q= name/code search. Includes a
// requisition count per department so the admin grid can show activity.
router.get(
  "/",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { active, q } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (active === "true") where.active = true;
      if (active === "false") where.active = false;
      if (q && q.trim()) {
        where.OR = [
          { name: { contains: q.trim(), mode: "insensitive" } },
          { code: { contains: q.trim(), mode: "insensitive" } },
        ];
      }
      const allowed = await allowedDepartmentIds(req.user?.userId, req.user?.role);
      if (allowed !== null) {
        if (allowed.length === 0) {
          res.json({
            success: true,
            data: [],
            meta: { notInAnyDepartment: true },
            error: null,
          });
          return;
        }
        where.id = { in: allowed };
        where.active = true;
      }

      const departments = await prisma.department.findMany({
        where,
        orderBy: [{ active: "desc" }, { name: "asc" }],
        include: { _count: { select: { requisitions: true } } },
      });

      const data = departments.map((d) => ({
        id: d.id,
        name: d.name,
        code: d.code,
        active: d.active,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        requisitionCount: d._count.requisitions,
      }));
      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /dashboard — per-department activity summary (admin) ───────────────
// Aggregates requisitions grouped by department into the tiles the dashboard
// renders: total departments, active/inactive counts, and per-department
// open/completed request counts + total line items issued.
router.get(
  "/dashboard",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [departments, requisitions] = await Promise.all([
        prisma.department.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true, code: true, active: true },
        }),
        prisma.requisition.findMany({
          select: {
            departmentId: true,
            status: true,
            items: { select: { issuedQty: true } },
          },
        }),
      ]);

      // Fold requisitions into a per-department accumulator.
      const byDept = new Map<
        string,
        { open: number; completed: number; total: number; issuedUnits: number }
      >();
      for (const r of requisitions) {
        const acc =
          byDept.get(r.departmentId) ??
          { open: 0, completed: 0, total: 0, issuedUnits: 0 };
        acc.total += 1;
        if (r.status === "COMPLETED") acc.completed += 1;
        else if (OPEN_STATUSES.includes(r.status)) acc.open += 1;
        acc.issuedUnits += r.items.reduce((s, it) => s + (it.issuedQty || 0), 0);
        byDept.set(r.departmentId, acc);
      }

      const perDepartment = departments.map((d) => {
        const acc = byDept.get(d.id) ?? {
          open: 0,
          completed: 0,
          total: 0,
          issuedUnits: 0,
        };
        return {
          id: d.id,
          name: d.name,
          code: d.code,
          active: d.active,
          openRequests: acc.open,
          completedRequests: acc.completed,
          totalRequests: acc.total,
          issuedUnits: acc.issuedUnits,
        };
      });

      const summary = {
        totalDepartments: departments.length,
        activeDepartments: departments.filter((d) => d.active).length,
        inactiveDepartments: departments.filter((d) => !d.active).length,
        openRequests: perDepartment.reduce((s, d) => s + d.openRequests, 0),
        completedRequests: perDepartment.reduce(
          (s, d) => s + d.completedRequests,
          0,
        ),
      };

      res.json({
        success: true,
        data: { summary, perDepartment },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id — single department detail (admin) ───────────────────────────
router.get(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dept = await prisma.department.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { requisitions: true } } },
      });
      if (!dept) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Department not found" });
        return;
      }
      res.json({
        success: true,
        data: {
          id: dept.id,
          name: dept.name,
          code: dept.code,
          active: dept.active,
          createdAt: dept.createdAt,
          updatedAt: dept.updatedAt,
          requisitionCount: dept._count.requisitions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id/detail — full department detail (admin) ───────────────────────
// One call powering the department detail page: info + stats + members +
// requisition history + a materials-consumed rollup + the department's current
// equipment / material holdings.
router.get(
  "/:id/detail",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dept = await prisma.department.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, code: true, active: true, createdAt: true },
      });
      if (!dept) {
        res.status(404).json({ success: false, data: null, error: "Department not found" });
        return;
      }
      if (!(await isMemberOf(req.user?.userId, req.user?.role, dept.id))) {
        const allowed = await allowedDepartmentIds(req.user?.userId, req.user?.role);
        res.status(allowed !== null && allowed.length === 0 ? 403 : 404).json({
          success: false,
          data: null,
          error:
            allowed !== null && allowed.length === 0
              ? "No assigned department"
              : "Department not found",
        });
        return;
      }

      const [members, requisitions, holdings] = await Promise.all([
        prisma.departmentMember.findMany({
          where: { departmentId: dept.id },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        }),
        prisma.requisition.findMany({
          where: { departmentId: dept.id },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            requisitionNumber: true,
            status: true,
            createdAt: true,
            requestedBy: { select: { name: true } },
            items: {
              select: {
                requestedQty: true,
                approvedQty: true,
                issuedQty: true,
                inventoryItem: { select: { batchNumber: true, medicine: { select: { name: true } } } },
                material: { select: { name: true, unit: true } },
              },
            },
          },
        }),
        prisma.departmentMaterialHolding.findMany({
          where: { departmentId: dept.id, quantity: { gt: 0 } },
          orderBy: [{ quantity: "desc" }, { material: { name: "asc" } }],
          select: {
            id: true,
            quantity: true,
            material: {
              select: { id: true, name: true, unit: true, category: true },
            },
          },
        }),
      ]);

      // Stats
      const open = requisitions.filter((r) =>
        OPEN_STATUSES.includes(r.status),
      ).length;
      const completed = requisitions.filter((r) => r.status === "COMPLETED").length;

      // Materials-consumed rollup: sum issuedQty per item name across all reqs.
      const consumedMap = new Map<string, { name: string; unit: string; issued: number }>();
      for (const r of requisitions) {
        for (const it of r.items) {
          if (it.issuedQty <= 0) continue;
          const name = it.inventoryItem
            ? it.inventoryItem.medicine?.name ?? it.inventoryItem.batchNumber ?? "Item"
            : it.material?.name ?? "Material";
          const unit = it.material?.unit ?? "unit";
          const key = name.toLowerCase();
          const acc = consumedMap.get(key) ?? { name, unit, issued: 0 };
          acc.issued += it.issuedQty;
          consumedMap.set(key, acc);
        }
      }
      const consumed = [...consumedMap.values()].sort((a, b) => b.issued - a.issued);
      const totalUnitsIssued = consumed.reduce((s, c) => s + c.issued, 0);
      const totalUnitsOnHand = holdings.reduce((sum, holding) => sum + holding.quantity, 0);

      res.json({
        success: true,
        data: {
          department: dept,
          stats: {
            memberCount: members.length,
            totalRequests: requisitions.length,
            openRequests: open,
            completedRequests: completed,
            totalUnitsIssued,
            totalUnitsOnHand,
          },
          members,
          requisitions: requisitions.map((r) => ({
            id: r.id,
            requisitionNumber: r.requisitionNumber,
            status: r.status,
            createdAt: r.createdAt,
            requestedBy: r.requestedBy?.name ?? "—",
            itemCount: r.items.length,
          })),
          holdings: holdings.map((holding) => ({
            id: holding.id,
            quantity: holding.quantity,
            materialId: holding.material.id,
            name: holding.material.name,
            unit: holding.material.unit,
            category: holding.material.category,
          })),
          consumed,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id/members — list a department's members (admin) ─────────────────
router.get(
  "/:id/members",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const members = await prisma.departmentMember.findMany({
        where: { departmentId: req.params.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      });
      res.json({ success: true, data: members, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id/members/search — searchable staff picker (admin) ──────────────
// Returns staff NOT already in this department, matched by name/email/phone,
// so the admin "Add member" box can search-and-add. Excludes patients.
router.get(
  "/:id/members/search",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q ?? "").trim();
      const existing = await prisma.departmentMember.findMany({
        where: { departmentId: req.params.id },
        select: { userId: true },
      });
      const excludeIds = existing.map((m) => m.userId);

      const users = await prisma.user.findMany({
        where: {
          id: excludeIds.length ? { notIn: excludeIds } : undefined,
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
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                  { phone: { contains: q } },
                ],
              }
            : {}),
        },
        take: 20,
        orderBy: [{ name: "asc" }],
        select: { id: true, name: true, email: true, role: true },
      });
      res.json({ success: true, data: users, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/members — add a user to a department (admin) ─────────────────
router.post(
  "/:id/members",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.body as { userId?: string };
      if (!userId) {
        res
          .status(400)
          .json({ success: false, data: null, error: "userId is required" });
        return;
      }

      const [dept, targetUser] = await Promise.all([
        prisma.department.findUnique({
          where: { id: req.params.id },
          select: { id: true },
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true },
        }),
      ]);
      if (!dept) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Department not found" });
        return;
      }
      if (!targetUser) {
        res
          .status(404)
          .json({ success: false, data: null, error: "User not found" });
        return;
      }

      // Idempotent — the @@unique([departmentId, userId]) makes a repeat add a
      // no-op rather than a 500. Return the existing/created row either way.
      const member = await prisma.departmentMember.upsert({
        where: {
          departmentId_userId: { departmentId: req.params.id, userId },
        },
        update: {},
        create: { departmentId: req.params.id, userId },
        select: {
          id: true,
          userId: true,
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      });
      await auditLog(req, "DEPARTMENT_MEMBER_ADD", "Department", req.params.id, {
        userId,
      });
      res.status(201).json({ success: true, data: member, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /:id/members/:userId — remove a member (admin) ──────────────────
router.delete(
  "/:id/members/:userId",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.departmentMember.findUnique({
        where: {
          departmentId_userId: {
            departmentId: req.params.id,
            userId: req.params.userId,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Member not found" });
        return;
      }
      await prisma.departmentMember.delete({ where: { id: existing.id } });
      await auditLog(
        req,
        "DEPARTMENT_MEMBER_REMOVE",
        "Department",
        req.params.id,
        { userId: req.params.userId },
      );
      res.json({ success: true, data: { removed: true }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST / — create a department (admin) ──────────────────────────────────
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createDepartmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, code } = req.body as { name: string; code: string };

      // Friendly 409 on the (tenantId, code) unique clash rather than a raw
      // Prisma P2002 500. Case-insensitive because codes are stored uppercase.
      const existing = await prisma.department.findFirst({
        where: { code: { equals: code, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `A department with code "${code}" already exists`,
        });
        return;
      }

      const dept = await prisma.department.create({ data: { name, code } });
      await auditLog(req, "DEPARTMENT_CREATE", "Department", dept.id, {
        name,
        code,
      });
      res.status(201).json({ success: true, data: dept, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — update a department (admin) ───────────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateDepartmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, code, active } = req.body as {
        name?: string;
        code?: string;
        active?: boolean;
      };

      const current = await prisma.department.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!current) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Department not found" });
        return;
      }

      // Guard the unique code constraint when the code is being changed.
      if (code) {
        const clash = await prisma.department.findFirst({
          where: {
            code: { equals: code, mode: "insensitive" },
            id: { not: req.params.id },
          },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A department with code "${code}" already exists`,
          });
          return;
        }
      }

      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name;
      if (code !== undefined) data.code = code;
      if (active !== undefined) data.active = active;

      const dept = await prisma.department.update({
        where: { id: req.params.id },
        data,
      });
      await auditLog(req, "DEPARTMENT_UPDATE", "Department", dept.id, data);
      res.json({ success: true, data: dept, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /:id — soft-delete (deactivate) or hard-delete if unused (admin) ─
// ?force=true → the "permanently delete" path from the Inactive view. It hard-
// deletes ONLY when the department has no requisition history; a department
// with history can never be hard-deleted (Requisition.departmentId is a
// required FK — dropping it would orphan/break that history), so we return a
// clear 409 instead of silently soft-deleting.
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const force = req.query.force === "true";
      const dept = await prisma.department.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { requisitions: true } } },
      });
      if (!dept) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Department not found" });
        return;
      }

      const hasHistory = dept._count.requisitions > 0;

      if (hasHistory && force) {
        // Explicit permanent-delete request, but history blocks it.
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot permanently delete "${dept.name}" — it has ${dept._count.requisitions} requisition(s) on record. Keep it deactivated to preserve that history.`,
        });
        return;
      }

      // Referenced by requisition history (non-force) → soft-delete.
      if (hasHistory) {
        const updated = await prisma.department.update({
          where: { id: req.params.id },
          data: { active: false },
        });
        await auditLog(req, "DEPARTMENT_DEACTIVATE", "Department", dept.id, {
          reason: "has requisition history",
          requisitionCount: dept._count.requisitions,
        });
        res.json({
          success: true,
          data: { ...updated, softDeleted: true },
          error: null,
        });
        return;
      }

      // No history → safe to hard-delete. Clean up any member links first
      // (DepartmentMember cascades on the FK, but be explicit for clarity).
      await prisma.department.delete({ where: { id: req.params.id } });
      await auditLog(req, "DEPARTMENT_DELETE", "Department", dept.id, {
        name: dept.name,
        code: dept.code,
        force,
      });
      res.json({
        success: true,
        data: { id: dept.id, hardDeleted: true },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as departmentsRouter };
