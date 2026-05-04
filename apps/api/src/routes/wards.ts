import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import {
  Role,
  createWardSchema,
  updateBedStatusSchema,
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
          select: { id: true, bedNumber: true, status: true, wardId: true },
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

export { bedsRouter };
