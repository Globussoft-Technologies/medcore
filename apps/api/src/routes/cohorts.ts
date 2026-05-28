// SOW row M4 closure — care cohorts (named patient groups).
//
// Endpoints:
//   GET    /api/v1/cohorts                       — list (filters: search, includeArchived)
//   POST   /api/v1/cohorts                       — create
//   GET    /api/v1/cohorts/:id                   — detail (+ members)
//   PATCH  /api/v1/cohorts/:id                   — rename / re-describe
//   POST   /api/v1/cohorts/:id/archive           — soft-delete
//   POST   /api/v1/cohorts/:id/restore           — un-archive
//   DELETE /api/v1/cohorts/:id                   — hard-delete (cascade members)
//   POST   /api/v1/cohorts/:id/members           — add member (single or bulk)
//   DELETE /api/v1/cohorts/:id/members/:patientId — remove member
//
// Every mutation writes an AuditLog row keyed entity="cohort" so the
// activity trail is greppable. Tenant scoping is enforced by
// tenantScopedPrisma (same pattern as leads.ts, holidays.ts).

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createCohortSchema,
  updateCohortSchema,
  addCohortMemberSchema,
  addCohortMembersSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// All cohort surfaces are staff-only. ADMIN + DOCTOR + NURSE manage the
// list; RECEPTION can read but not mutate (matches the "outbound ops
// uses cohorts, front-desk references them" expected workflow). If a
// future hospital asks RECEPTION to be able to add members too, add
// Role.RECEPTION to COHORT_WRITE_ROLES — the read role is already
// wide enough.
const COHORT_READ_ROLES = [
  Role.ADMIN,
  Role.DOCTOR,
  Role.NURSE,
  Role.RECEPTION,
] as const;
const COHORT_WRITE_ROLES = [Role.ADMIN, Role.DOCTOR, Role.NURSE] as const;

// ─── GET /cohorts — list ──────────────────────────────────────────
router.get(
  "/",
  authorize(...COHORT_READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      const includeArchived = req.query.includeArchived === "true";

      const where: Record<string, unknown> = {};
      if (!includeArchived) where.archivedAt = null;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }

      const cohorts = await prisma.cohort.findMany({
        where,
        include: {
          _count: { select: { members: true } },
          createdByUser: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: cohorts, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /cohorts — create ───────────────────────────────────────
router.post(
  "/",
  authorize(...COHORT_WRITE_ROLES),
  validate(createCohortSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, description } = req.body as {
        name: string;
        description?: string | null;
      };

      const cohort = await prisma.cohort.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          createdByUserId: req.user?.userId ?? null,
          tenantId: req.tenantId,
        },
        include: {
          _count: { select: { members: true } },
          createdByUser: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "COHORT_CREATE", "cohort", cohort.id, {
        name: cohort.name,
      }).catch(console.error);

      res.status(201).json({ success: true, data: cohort, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /cohorts/:id — detail + members ──────────────────────────
router.get(
  "/:id",
  authorize(...COHORT_READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cohort = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        include: {
          createdByUser: { select: { id: true, name: true } },
          members: {
            orderBy: { addedAt: "desc" },
            include: {
              patient: {
                select: {
                  id: true,
                  mrNumber: true,
                  gender: true,
                  age: true,
                  dateOfBirth: true,
                  user: { select: { id: true, name: true, phone: true } },
                },
              },
              addedByUser: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (!cohort) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }

      res.json({ success: true, data: cohort, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /cohorts/:id — rename / re-describe ────────────────────
router.patch(
  "/:id",
  authorize(...COHORT_WRITE_ROLES),
  validate(updateCohortSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }

      const data: Record<string, unknown> = {};
      if (typeof req.body.name === "string") data.name = req.body.name.trim();
      if (req.body.description === null) data.description = null;
      else if (typeof req.body.description === "string")
        data.description = req.body.description.trim();

      const updated = await prisma.cohort.update({
        where: { id: existing.id },
        data,
        include: {
          _count: { select: { members: true } },
          createdByUser: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "COHORT_UPDATE", "cohort", updated.id, req.body).catch(
        console.error,
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /cohorts/:id/archive — soft delete ──────────────────────
router.post(
  "/:id/archive",
  authorize(...COHORT_WRITE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        select: { id: true, archivedAt: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }
      if (existing.archivedAt) {
        res.json({ success: true, data: { id: existing.id }, error: null });
        return;
      }
      await prisma.cohort.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      });
      auditLog(req, "COHORT_ARCHIVE", "cohort", existing.id).catch(
        console.error,
      );
      res.json({ success: true, data: { id: existing.id }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /cohorts/:id/restore — un-archive ───────────────────────
router.post(
  "/:id/restore",
  authorize(...COHORT_WRITE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        select: { id: true, archivedAt: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }
      if (!existing.archivedAt) {
        res.json({ success: true, data: { id: existing.id }, error: null });
        return;
      }
      await prisma.cohort.update({
        where: { id: existing.id },
        data: { archivedAt: null },
      });
      auditLog(req, "COHORT_RESTORE", "cohort", existing.id).catch(
        console.error,
      );
      res.json({ success: true, data: { id: existing.id }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /cohorts/:id — hard delete (cascade members) ──────────
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }
      await prisma.cohort.delete({ where: { id: existing.id } });
      auditLog(req, "COHORT_DELETE", "cohort", existing.id, {
        name: existing.name,
      }).catch(console.error);
      res.json({ success: true, data: { id: existing.id }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /cohorts/:id/members — add member(s) ────────────────────
//
// Two body shapes are accepted on this one URL — single via
// `{ patientId, note? }` (matches the EntityPicker UX) and bulk via
// `{ patientIds: [...] }` (matches a filter-then-select UX). We
// discriminate by which key is present so the frontend doesn't need
// to know which endpoint to hit.
router.post(
  "/:id/members",
  authorize(...COHORT_WRITE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cohort = await prisma.cohort.findUnique({
        where: { id: req.params.id },
        select: { id: true, archivedAt: true },
      });
      if (!cohort) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Cohort not found" });
        return;
      }
      if (cohort.archivedAt) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cohort is archived. Restore it before adding members.",
        });
        return;
      }

      // Bulk shape takes precedence — a payload with both keys is
      // treated as bulk (`patientIds` is the more specific intent).
      if (Array.isArray((req.body as Record<string, unknown>).patientIds)) {
        const parsed = addCohortMembersSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            success: false,
            data: null,
            error: parsed.error.issues[0]?.message ?? "Invalid bulk payload",
          });
          return;
        }
        const { patientIds } = parsed.data;

        // Defence-in-depth: scope the existence check to the tenant so
        // a malicious operator can't add a cross-tenant patient even
        // if their token somehow had a stale tenantId. tenantScopedPrisma
        // already injects the filter, but we do an explicit findMany +
        // diff so the response is honest about which ids were skipped.
        const existingPatients = await prisma.patient.findMany({
          where: { id: { in: patientIds } },
          select: { id: true },
        });
        const validIds = new Set(existingPatients.map((p) => p.id));

        // skipDuplicates is the cleanest way to honour the unique
        // constraint without a per-row try/catch.
        const result = await prisma.cohortMember.createMany({
          data: patientIds
            .filter((pid) => validIds.has(pid))
            .map((pid) => ({
              cohortId: cohort.id,
              patientId: pid,
              addedByUserId: req.user?.userId ?? null,
              tenantId: req.tenantId ?? null,
            })),
          skipDuplicates: true,
        });

        auditLog(req, "COHORT_ADD_MEMBERS", "cohort", cohort.id, {
          requested: patientIds.length,
          inserted: result.count,
          skipped: patientIds.length - result.count,
        }).catch(console.error);

        res.status(201).json({
          success: true,
          data: {
            cohortId: cohort.id,
            inserted: result.count,
            requested: patientIds.length,
            skipped: patientIds.length - result.count,
          },
          error: null,
        });
        return;
      }

      // Single-add shape.
      const parsed = addCohortMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid payload",
        });
        return;
      }
      const { patientId, note } = parsed.data;

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Idempotency — if the row already exists, return it rather than
      // throwing on the unique constraint. Matches the "add a member"
      // intent: a double-click shouldn't 409.
      const existingMember = await prisma.cohortMember.findUnique({
        where: {
          cohortId_patientId: { cohortId: cohort.id, patientId },
        },
      });
      if (existingMember) {
        res.status(200).json({
          success: true,
          data: existingMember,
          error: null,
        });
        return;
      }

      const member = await prisma.cohortMember.create({
        data: {
          cohortId: cohort.id,
          patientId,
          note: note?.trim() || null,
          addedByUserId: req.user?.userId ?? null,
          tenantId: req.tenantId ?? null,
        },
        include: {
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { id: true, name: true, phone: true } },
            },
          },
          addedByUser: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "COHORT_ADD_MEMBER", "cohort", cohort.id, {
        patientId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: member, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /cohorts/:id/members/:patientId — remove a member ─────
router.delete(
  "/:id/members/:patientId",
  authorize(...COHORT_WRITE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, patientId } = req.params;
      const member = await prisma.cohortMember.findUnique({
        where: { cohortId_patientId: { cohortId: id, patientId } },
        select: { id: true },
      });
      if (!member) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Cohort member not found",
        });
        return;
      }
      await prisma.cohortMember.delete({ where: { id: member.id } });
      auditLog(req, "COHORT_REMOVE_MEMBER", "cohort", id, {
        patientId,
      }).catch(console.error);
      res.json({ success: true, data: { id: member.id }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export const cohortsRouter = router;
