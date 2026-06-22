import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createWardSchema,
  updateBedStatusSchema,
  updateBedSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

// Issue #36 — the shared `createBedSchema` requires `wardId` in the body,
// but the nested route `POST /wards/:wardId/beds` sources `wardId` from the
// URL. Validating that schema against a body that only carries `bedNumber`
// (what the UI sends) produces a 400 Zod error and the bed is never created.
// We validate against this body-only variant here; the route handler plucks
// `wardId` from `req.params`. Keep the original shared schema untouched so
// any direct callers (tests, Postman scripts) keep working.
const createBedBodySchema = z.object({
  bedNumber: z.string().min(1),
  dailyRate: z.number().min(0).default(0),
});

const router = Router();
router.use(authenticate);

// #511 audit (file-level, 2026-05-09): every handler in this file applies
// `authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION)` (or a
// stricter ADMIN-only subset) — PATIENT is excluded everywhere. Ward
// layout + bed occupancy is operational data. Verified-safe.

// GET /api/v1/wards — list all wards with bed counts
//
// Issue #36 — the web Wards page reads `ward.beds`, `ward.totalBeds`,
// `ward.availableBeds`, `ward.occupiedBeds`, `ward.cleaningBeds`, and
// `ward.maintenanceBeds` directly off each ward. The old response only
// emitted `bedStats: { total, available, occupied }`, so the UI fell back
// to `beds?.length` which was also missing — every ward rendered as 0/0.
// Return both the flat count fields the UI expects AND the nested `beds`
// array so BedCell has something to render. Keep `bedStats` for backward
// compatibility with any internal/CLI callers.
//
// Issue #474 (CWE-285 / OWASP API1:2023 BOLA): ward layout + bed
// occupancy is operational/clinical data — PATIENT role MUST be denied.
router.get("/", authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const wards = await prisma.ward.findMany({
      include: {
        beds: {
          select: {
            id: true,
            bedNumber: true,
            status: true,
            wardId: true,
            dailyRate: true,
          },
          orderBy: { bedNumber: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    const data = wards.map((w) => {
      const total = w.beds.length;
      const available = w.beds.filter((b) => b.status === "AVAILABLE").length;
      const occupied = w.beds.filter((b) => b.status === "OCCUPIED").length;
      const cleaning = w.beds.filter((b) => b.status === "CLEANING").length;
      const maintenance = w.beds.filter(
        (b) => b.status === "MAINTENANCE"
      ).length;
      return {
        id: w.id,
        name: w.name,
        type: w.type,
        floor: w.floor,
        description: w.description,
        createdAt: w.createdAt,
        beds: w.beds,
        totalBeds: total,
        availableBeds: available,
        occupiedBeds: occupied,
        cleaningBeds: cleaning,
        maintenanceBeds: maintenance,
        bedStats: { total, available, occupied, cleaning, maintenance },
      };
    });

    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/wards/:id — ward detail with all beds
// Issue #474: same operational-data argument as the list route — PATIENT denied.
router.get(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ward = await prisma.ward.findUnique({
        where: { id: req.params.id },
        include: {
          beds: {
            orderBy: { bedNumber: "asc" },
            include: {
              admissions: {
                where: { status: "ADMITTED" },
                include: {
                  patient: {
                    include: { user: { select: { name: true, phone: true } } },
                  },
                },
              },
            },
          },
        },
      });

      if (!ward) {
        res.status(404).json({ success: false, data: null, error: "Ward not found" });
        return;
      }

      res.json({ success: true, data: ward, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/wards — create ward (ADMIN only)
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createWardSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ward = await prisma.ward.create({ data: req.body });
      auditLog(req, "WARD_CREATE", "ward", ward.id, { name: ward.name }).catch(console.error);
      res.status(201).json({ success: true, data: ward, error: null });
    } catch (err) {
      // Ward name is unique per tenant (@@unique([tenantId, name])). Translate
      // the P2002 collision into a friendly 409 instead of leaking the raw
      // `prisma.ward.create()` invocation string to the UI as a 500.
      if ((err as { code?: string })?.code === "P2002") {
        res.status(409).json({
          success: false,
          data: null,
          error: `A ward named "${req.body.name}" already exists. Pick a different name.`,
        });
        return;
      }
      next(err);
    }
  }
);

// POST /api/v1/wards/:wardId/beds — create bed (ADMIN only)
router.post(
  "/:wardId/beds",
  authorize(Role.ADMIN),
  validate(createBedBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { wardId } = req.params;
      const ward = await prisma.ward.findUnique({ where: { id: wardId } });
      if (!ward) {
        res.status(404).json({ success: false, data: null, error: "Ward not found" });
        return;
      }

      // A (wardId, bedNumber) unique constraint guards against duplicate
      // bed numbers within a ward. Pre-check so we can return a friendly
      // 409 instead of letting the raw Prisma P2002 surface as a 500 (which
      // leaked the full `prisma.bed.create()` invocation string to the UI).
      const existing = await prisma.bed.findFirst({
        where: { wardId, bedNumber: req.body.bedNumber },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Bed "${req.body.bedNumber}" already exists in this ward. Pick a different bed number.`,
        });
        return;
      }

      const bed = await prisma.bed.create({
        data: {
          wardId,
          bedNumber: req.body.bedNumber,
          dailyRate: req.body.dailyRate ?? 0,
        },
      });

      auditLog(req, "BED_CREATE", "bed", bed.id, { wardId, bedNumber: bed.bedNumber }).catch(console.error);
      res.status(201).json({ success: true, data: bed, error: null });
    } catch (err) {
      // Belt-and-suspenders: if two requests race past the pre-check, the DB
      // unique constraint still fires — translate that P2002 to the same 409.
      if ((err as { code?: string })?.code === "P2002") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Bed "${req.body.bedNumber}" already exists in this ward. Pick a different bed number.`,
        });
        return;
      }
      next(err);
    }
  }
);

export { router as wardRouter };

// Separate router for /beds endpoints
const bedsRouter = Router();
bedsRouter.use(authenticate);

// PATCH /api/v1/beds/:id/status — update bed status
bedsRouter.patch(
  "/:id/status",
  authorize(Role.ADMIN, Role.NURSE, Role.RECEPTION),
  validate(updateBedStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bed = await prisma.bed.update({
        where: { id: req.params.id },
        data: { status: req.body.status, notes: req.body.notes },
      });
      auditLog(req, "BED_STATUS_UPDATE", "bed", bed.id, { status: req.body.status }).catch(console.error);
      res.json({ success: true, data: bed, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/beds/:id — edit a bed's number and/or daily rate (ADMIN only).
// Distinct from /:id/status (which staff use for the occupancy lifecycle).
// Re-checks the (wardId, bedNumber) uniqueness when the number changes so a
// rename collision returns a clean 409 instead of a raw Prisma P2002.
bedsRouter.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateBedSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const current = await prisma.bed.findUnique({
        where: { id: req.params.id },
        select: { id: true, wardId: true, bedNumber: true },
      });
      if (!current) {
        res.status(404).json({ success: false, data: null, error: "Bed not found" });
        return;
      }

      // Only collision-check when the number is actually changing.
      if (
        req.body.bedNumber !== undefined &&
        req.body.bedNumber !== current.bedNumber
      ) {
        const clash = await prisma.bed.findFirst({
          where: {
            wardId: current.wardId,
            bedNumber: req.body.bedNumber,
            id: { not: current.id },
          },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Bed "${req.body.bedNumber}" already exists in this ward. Pick a different bed number.`,
          });
          return;
        }
      }

      const bed = await prisma.bed.update({
        where: { id: req.params.id },
        data: {
          ...(req.body.bedNumber !== undefined && { bedNumber: req.body.bedNumber }),
          ...(req.body.dailyRate !== undefined && { dailyRate: req.body.dailyRate }),
        },
      });
      auditLog(req, "BED_UPDATE", "bed", bed.id, {
        bedNumber: bed.bedNumber,
        dailyRate: bed.dailyRate,
      }).catch(console.error);
      res.json({ success: true, data: bed, error: null });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Bed "${req.body.bedNumber}" already exists in this ward. Pick a different bed number.`,
        });
        return;
      }
      next(err);
    }
  }
);

// DELETE /api/v1/beds/:id — remove a bed (ADMIN only). Refuses to delete a
// bed that is occupied or has an active (ADMITTED) admission — deleting it
// would orphan an in-house patient's location. The operator must discharge
// or transfer first. Returns 409 with an actionable message in that case.
bedsRouter.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bed = await prisma.bed.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          bedNumber: true,
          status: true,
          _count: { select: { admissions: { where: { status: "ADMITTED" } } } },
        },
      });
      if (!bed) {
        res.status(404).json({ success: false, data: null, error: "Bed not found" });
        return;
      }

      if (bed.status === "OCCUPIED" || bed._count.admissions > 0) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Bed "${bed.bedNumber}" is occupied. Discharge or transfer the patient before deleting it.`,
        });
        return;
      }

      await prisma.bed.delete({ where: { id: req.params.id } });
      auditLog(req, "BED_DELETE", "bed", bed.id, { bedNumber: bed.bedNumber }).catch(console.error);
      res.json({ success: true, data: { id: bed.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { bedsRouter };
