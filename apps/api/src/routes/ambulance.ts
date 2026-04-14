import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createAmbulanceSchema,
  updateAmbulanceSchema,
  tripRequestSchema,
  completeTripSchema,
  fuelLogSchema,
  equipmentCheckSchema,
  tripBillSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

async function generateTripNumber(): Promise<string> {
  const last = await prisma.ambulanceTrip.findFirst({
    orderBy: { createdAt: "desc" },
    select: { tripNumber: true },
  });
  let next = 1;
  if (last?.tripNumber) {
    const m = last.tripNumber.match(/TRP(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "TRP" + String(next).padStart(6, "0");
}

// ───────────────────────────────────────────────────────
// TRIPS (defined first to avoid /:id catching "trips")
// ───────────────────────────────────────────────────────

router.get(
  "/trips",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        status,
        ambulanceId,
        from,
        to,
        page = "1",
        limit = "20",
      } = req.query as Record<string, string | undefined>;
      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
      const take = Math.min(parseInt(limit || "20"), 100);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (ambulanceId) where.ambulanceId = ambulanceId;
      if (from || to) {
        const dateFilter: Record<string, Date> = {};
        if (from) dateFilter.gte = new Date(from);
        if (to) dateFilter.lte = new Date(to);
        where.requestedAt = dateFilter;
      }

      const [trips, total] = await Promise.all([
        prisma.ambulanceTrip.findMany({
          where,
          skip,
          take,
          orderBy: { requestedAt: "desc" },
          include: {
            ambulance: true,
            patient: { include: { user: { select: { name: true } } } },
          },
        }),
        prisma.ambulanceTrip.count({ where }),
      ]);

      res.json({
        success: true,
        data: trips,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/trips",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  validate(tripRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ambulance = await prisma.ambulance.findUnique({
        where: { id: req.body.ambulanceId },
      });
      if (!ambulance) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Ambulance not found",
        });
        return;
      }
      if (ambulance.status !== "AVAILABLE") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Ambulance is ${ambulance.status}`,
        });
        return;
      }

      const tripNumber = await generateTripNumber();

      const trip = await prisma.$transaction(async (tx) => {
        const t = await tx.ambulanceTrip.create({
          data: {
            tripNumber,
            ambulanceId: req.body.ambulanceId,
            patientId: req.body.patientId,
            callerName: req.body.callerName,
            callerPhone: req.body.callerPhone,
            pickupAddress: req.body.pickupAddress,
            pickupLat: req.body.pickupLat,
            pickupLng: req.body.pickupLng,
            dropAddress: req.body.dropAddress,
            dropLat: req.body.dropLat,
            dropLng: req.body.dropLng,
            chiefComplaint: req.body.chiefComplaint,
            priority: req.body.priority,
          },
          include: {
            ambulance: true,
            patient: { include: { user: { select: { name: true } } } },
          },
        });

        await tx.ambulance.update({
          where: { id: req.body.ambulanceId },
          data: { status: "ON_TRIP" },
        });

        return t;
      });

      auditLog(req, "CREATE_AMBULANCE_TRIP", "ambulance_trip", trip.id, {
        tripNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/trips/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
        include: {
          ambulance: true,
          patient: { include: { user: { select: { name: true } } } },
        },
      });
      if (!trip) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/dispatch",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { dispatchedAt: new Date(), status: "DISPATCHED" },
      });
      auditLog(req, "DISPATCH_TRIP", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/arrived",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { arrivedAt: new Date(), status: "ARRIVED_SCENE" },
      });
      auditLog(req, "TRIP_ARRIVED_SCENE", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/enroute",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { status: "EN_ROUTE_HOSPITAL" },
      });
      auditLog(req, "TRIP_EN_ROUTE", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/complete",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  validate(completeTripSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }

      const trip = await prisma.$transaction(async (tx) => {
        const t = await tx.ambulanceTrip.update({
          where: { id: req.params.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            distanceKm: req.body.distanceKm,
            cost: req.body.cost,
            notes: req.body.notes,
          },
        });

        await tx.ambulance.update({
          where: { id: existing.ambulanceId },
          data: { status: "AVAILABLE" },
        });

        return t;
      });

      auditLog(req, "COMPLETE_TRIP", "ambulance_trip", trip.id, {
        distanceKm: req.body.distanceKm,
        cost: req.body.cost,
      }).catch(console.error);

      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/cancel",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }

      const trip = await prisma.$transaction(async (tx) => {
        const t = await tx.ambulanceTrip.update({
          where: { id: req.params.id },
          data: { status: "CANCELLED" },
        });
        await tx.ambulance.update({
          where: { id: existing.ambulanceId },
          data: { status: "AVAILABLE" },
        });
        return t;
      });

      auditLog(req, "CANCEL_TRIP", "ambulance_trip", trip.id).catch(
        console.error
      );

      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// AMBULANCES
// ───────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const ambulances = await prisma.ambulance.findMany({
      where,
      orderBy: { vehicleNumber: "asc" },
      include: {
        trips: {
          where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
          take: 1,
          orderBy: { requestedAt: "desc" },
        },
      },
    });

    res.json({ success: true, data: ambulances, error: null });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createAmbulanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { lastServiceDate, nextServiceDate, ...rest } = req.body;
      const ambulance = await prisma.ambulance.create({
        data: {
          ...rest,
          lastServiceDate: lastServiceDate ? new Date(lastServiceDate) : null,
          nextServiceDate: nextServiceDate ? new Date(nextServiceDate) : null,
        },
      });

      auditLog(req, "CREATE_AMBULANCE", "ambulance", ambulance.id, {
        vehicleNumber: ambulance.vehicleNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: ambulance, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateAmbulanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { lastServiceDate, nextServiceDate, ...rest } = req.body;
      const ambulance = await prisma.ambulance.update({
        where: { id: req.params.id },
        data: {
          ...rest,
          ...(lastServiceDate !== undefined
            ? { lastServiceDate: lastServiceDate ? new Date(lastServiceDate) : null }
            : {}),
          ...(nextServiceDate !== undefined
            ? { nextServiceDate: nextServiceDate ? new Date(nextServiceDate) : null }
            : {}),
        },
      });

      auditLog(req, "UPDATE_AMBULANCE", "ambulance", ambulance.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: ambulance, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ambulance = await prisma.ambulance.findUnique({
      where: { id: req.params.id },
      include: {
        trips: {
          orderBy: { requestedAt: "desc" },
          take: 20,
          include: {
            patient: { include: { user: { select: { name: true } } } },
          },
        },
      },
    });
    if (!ambulance) {
      res
        .status(404)
        .json({ success: false, data: null, error: "Ambulance not found" });
      return;
    }
    res.json({ success: true, data: ambulance, error: null });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────
// GPS / TRIP LOCATION UPDATE
// ───────────────────────────────────────────────────────

router.patch(
  "/trips/:id/location",
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pickupLat, pickupLng, dropLat, dropLng } = req.body as {
        pickupLat?: number;
        pickupLng?: number;
        dropLat?: number;
        dropLng?: number;
      };
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: {
          ...(pickupLat !== undefined ? { pickupLat } : {}),
          ...(pickupLng !== undefined ? { pickupLng } : {}),
          ...(dropLat !== undefined ? { dropLat } : {}),
          ...(dropLng !== undefined ? { dropLng } : {}),
        },
      });
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// EQUIPMENT CHECK
// ───────────────────────────────────────────────────────

router.patch(
  "/trips/:id/equipment-check",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(equipmentCheckSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: {
          equipmentChecked: req.body.equipmentChecked,
          equipmentNotes: req.body.equipmentNotes,
        },
      });
      auditLog(req, "AMBULANCE_EQUIPMENT_CHECK", "ambulance_trip", trip.id, {
        checked: req.body.equipmentChecked,
      }).catch(console.error);
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// TRIP BILLING (compute and link invoice)
// ───────────────────────────────────────────────────────

router.post(
  "/trips/:id/bill",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(tripBillSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!trip) {
        res.status(404).json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      if (!trip.patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Trip has no linked patient",
        });
        return;
      }

      const { baseFare, perKmRate } = req.body as { baseFare: number; perKmRate: number };
      const km = trip.distanceKm || 0;
      const total = baseFare + perKmRate * km;

      const updated = await prisma.ambulanceTrip.update({
        where: { id: trip.id },
        data: { cost: total },
      });

      auditLog(req, "BILL_AMBULANCE_TRIP", "ambulance_trip", trip.id, {
        baseFare,
        perKmRate,
        km,
        total,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: {
          trip: updated,
          bill: {
            baseFare,
            perKmRate,
            distanceKm: km,
            total: Math.round(total * 100) / 100,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// FUEL LOG
// ───────────────────────────────────────────────────────

router.post(
  "/fuel-logs",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(fuelLogSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const log = await prisma.ambulanceFuelLog.create({
        data: {
          ambulanceId: req.body.ambulanceId,
          litres: req.body.litres,
          costTotal: req.body.costTotal,
          odometerKm: req.body.odometerKm,
          stationName: req.body.stationName,
          notes: req.body.notes,
          filledBy: req.user!.userId,
        },
      });
      auditLog(req, "AMBULANCE_FUEL_LOG", "ambulance_fuel_log", log.id, {
        ambulanceId: req.body.ambulanceId,
        litres: req.body.litres,
      }).catch(console.error);
      res.status(201).json({ success: true, data: log, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/fuel-logs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ambulanceId, from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (ambulanceId) where.ambulanceId = ambulanceId;
      if (from || to) {
        const d: Record<string, Date> = {};
        if (from) d.gte = new Date(from);
        if (to) d.lte = new Date(to);
        where.filledAt = d;
      }
      const logs = await prisma.ambulanceFuelLog.findMany({
        where,
        orderBy: { filledAt: "desc" },
        include: { ambulance: { select: { vehicleNumber: true } } },
        take: 200,
      });
      const totalCost = logs.reduce((s, l) => s + l.costTotal, 0);
      const totalLitres = logs.reduce((s, l) => s + l.litres, 0);
      res.json({
        success: true,
        data: { logs, totalCost: Math.round(totalCost * 100) / 100, totalLitres },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as ambulanceRouter };
