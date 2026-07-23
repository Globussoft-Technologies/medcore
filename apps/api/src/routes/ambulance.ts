import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
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

type AmbulanceLogLevel = "log" | "warn" | "error";

function redactPhone(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  return digits.length <= 4 ? digits : `***${digits.slice(-4)}`;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { raw: err };
  }
  const prismaErr = err as Error & {
    code?: string;
    meta?: Record<string, unknown>;
    statusCode?: number;
  };
  return {
    name: prismaErr.name,
    message: prismaErr.message,
    code: prismaErr.code,
    statusCode: prismaErr.statusCode,
    meta: prismaErr.meta,
    stack: prismaErr.stack,
  };
}

function ambulanceLog(
  level: AmbulanceLogLevel,
  req: Request | null,
  event: string,
  details: Record<string, unknown> = {}
): void {
  const prefix = `[ambulance] ${event}`;
  const payload = {
    method: req?.method,
    path: req?.originalUrl ?? req?.path,
    userId: req?.user?.userId,
    role: req?.user?.role,
    tenantId: req?.user?.tenantId ?? null,
    ...details,
  };
  if (level === "error") {
    console.error(prefix, payload);
    return;
  }
  if (level === "warn") {
    console.warn(prefix, payload);
    return;
  }
  console.log(prefix, payload);
}

// ───────────────────────────────────────────────────────
// Trip state machine (gap #10, 2026-05-03 audit).
//
// Mirrors the pattern in `apps/api/src/services/insurance-claims/store.ts`
// (`assertValidTransition` added in 533dd53). The transition guard prevents
// silent acceptance of impossible lifecycle moves at the HTTP boundary —
// e.g. REQUESTED → COMPLETED skipping dispatch/arrival/en-route, or
// COMPLETED → DISPATCHED reviving a closed trip.
//
// Same-state writes (e.g. POST /dispatch on an already-DISPATCHED trip)
// are treated as idempotent no-ops — callers retrying after a flaky
// network shouldn't get a 409.
// ───────────────────────────────────────────────────────

type TripStatus =
  | "REQUESTED"
  | "DISPATCHED"
  | "ARRIVED_SCENE"
  | "EN_ROUTE_HOSPITAL"
  | "COMPLETED"
  | "CANCELLED";

const ALLOWED_TRIP_TRANSITIONS: Readonly<
  Record<TripStatus, ReadonlyArray<TripStatus>>
> = {
  REQUESTED: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["ARRIVED_SCENE", "CANCELLED"],
  ARRIVED_SCENE: ["EN_ROUTE_HOSPITAL", "CANCELLED"],
  EN_ROUTE_HOSPITAL: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

class InvalidTripTransitionError extends Error {
  statusCode = 409;
  constructor(public from: TripStatus, public to: TripStatus) {
    const allowed = ALLOWED_TRIP_TRANSITIONS[from] ?? [];
    super(
      `Invalid ambulance trip transition: ${from} -> ${to}. ` +
        `Valid transitions from ${from}: ${
          allowed.length ? allowed.join(", ") : "(none — terminal state)"
        }`
    );
    this.name = "InvalidTripTransitionError";
  }
}

function assertValidTripTransition(from: TripStatus, to: TripStatus): void {
  if (from === to) return; // idempotent same-state writes are no-ops
  const allowed = ALLOWED_TRIP_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTripTransitionError(from, to);
  }
}

/**
 * Read the current trip status, then assert the requested transition is
 * valid. Returns `{ status: "not-found" }` if the trip doesn't exist, or
 * `{ status: "no-op" }` if the trip is already in the target state, or
 * `{ status: "ok", current }` if the caller should proceed with the
 * Prisma update. Throws `InvalidTripTransitionError` (statusCode 409)
 * when the transition is rejected.
 */
async function precheckTripTransition(
  id: string,
  to: TripStatus
): Promise<
  | { kind: "not-found" }
  | { kind: "no-op"; current: TripStatus; trip: { id: string; status: TripStatus; ambulanceId: string } }
  | { kind: "ok"; current: TripStatus }
> {
  const current = await prisma.ambulanceTrip.findUnique({
    where: { id },
    select: { id: true, status: true, ambulanceId: true },
  });
  if (!current) return { kind: "not-found" };
  const from = current.status as TripStatus;
  if (from === to) {
    return {
      kind: "no-op",
      current: from,
      trip: {
        id: current.id,
        status: from,
        ambulanceId: current.ambulanceId,
      },
    };
  }
  assertValidTripTransition(from, to);
  return { kind: "ok", current: from };
}

// Issue #87 — Single source of truth for ambulance fleet status.
// If any trip on the ambulance is still active (anything other than COMPLETED
// or CANCELLED), the ambulance must read as ON_TRIP in the fleet view; once
// every trip is closed, it returns to AVAILABLE.
//
// NOTE: the prisma `AmbulanceStatus` enum has no `IN_USE` value (only
// AVAILABLE | ON_TRIP | MAINTENANCE | OUT_OF_SERVICE), so we use ON_TRIP as
// the "in-use" marker. This helper is idempotent — calling it twice in a row
// produces the same row. MAINTENANCE / OUT_OF_SERVICE are sticky and never
// flipped automatically by this helper.
export async function recomputeAmbulanceStatus(
  ambulanceId: string
): Promise<"AVAILABLE" | "ON_TRIP" | "MAINTENANCE" | "OUT_OF_SERVICE" | null> {
  const ambulance = await prisma.ambulance.findUnique({
    where: { id: ambulanceId },
    select: { id: true, status: true },
  });
  if (!ambulance) return null;
  // Don't override sticky operational states.
  if (
    ambulance.status === "MAINTENANCE" ||
    ambulance.status === "OUT_OF_SERVICE"
  ) {
    return ambulance.status;
  }
  const activeTrip = await prisma.ambulanceTrip.findFirst({
    where: {
      ambulanceId,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: { id: true },
  });
  const target: "AVAILABLE" | "ON_TRIP" = activeTrip ? "ON_TRIP" : "AVAILABLE";
  if (ambulance.status !== target) {
    await prisma.ambulance.update({
      where: { id: ambulanceId },
      data: { status: target },
    });
  }
  return target;
}

async function generateTripNumber(): Promise<string> {
  // See apps/api/src/routes/bloodbank.ts:generateDonorNumber for the
  // longer rationale. Demo data contains 'AMB-DEMO-0012' style legacy
  // numbers that the original /TRP(\\d+)/ regex never matched, plus
  // post-seed 'TRPNNNNNN' rows from previous E2E runs. orderBy
  // createdAt:desc + LIMIT 1 was racing both shapes — when it returned
  // the legacy row 'next' silently reset to 1 and collided with the
  // existing TRP000001 row → P2002 → 500.
  //
  // Replace with a full scan + max(prefix-tolerant parse). Trip volumes
  // are small enough that the linear scan is fine.
  const rows = await prisma.ambulanceTrip.findMany({ select: { tripNumber: true } });
  let max = 0;
  for (const r of rows) {
    const m = r.tripNumber?.match(/TRP-?(\d+)/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return "TRP" + String(max + 1).padStart(6, "0");
}

// ───────────────────────────────────────────────────────
// TRIPS (defined first to avoid /:id catching "trips")
// ───────────────────────────────────────────────────────

router.get(
  "/trips",
  // Issue #174 (Apr 30 2026): trip list exposes caller phone, pickup address,
  // chief complaint. Restrict to clinical/dispatch staff (no PATIENT).
  authorize(Role.ADMIN, Role.RECEPTION, Role.NURSE, Role.DOCTOR),
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

      ambulanceLog("log", req, "list_trips.start", {
        filters: { status, ambulanceId, from, to },
        page: parseInt(page || "1"),
        limit: take,
      });

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
      ambulanceLog("error", req, "list_trips.failed", {
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.post(
  "/trips",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  validate(tripRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "create_trip.start", {
        ambulanceId: req.body.ambulanceId,
        patientId: req.body.patientId ?? null,
        hasCallerName: !!req.body.callerName,
        callerPhone: redactPhone(req.body.callerPhone),
        pickupAddressLength:
          typeof req.body.pickupAddress === "string"
            ? req.body.pickupAddress.trim().length
            : null,
        dropAddressLength:
          typeof req.body.dropAddress === "string"
            ? req.body.dropAddress.trim().length
            : null,
        hasChiefComplaint: !!req.body.chiefComplaint,
        priority: req.body.priority ?? null,
      });
      const ambulance = await prisma.ambulance.findUnique({
        where: { id: req.body.ambulanceId },
      });
      if (!ambulance) {
        ambulanceLog("warn", req, "create_trip.ambulance_not_found", {
          ambulanceId: req.body.ambulanceId,
        });
        res.status(404).json({
          success: false,
          data: null,
          error: "Ambulance not found",
        });
        return;
      }
      if (ambulance.status !== "AVAILABLE") {
        ambulanceLog("warn", req, "create_trip.ambulance_unavailable", {
          ambulanceId: ambulance.id,
          ambulanceStatus: ambulance.status,
          vehicleNumber: ambulance.vehicleNumber,
        });
        res.status(400).json({
          success: false,
          data: null,
          error: `Ambulance is ${ambulance.status}`,
        });
        return;
      }

      // Issue #739 — driver double-booking guard. The Ambulance schema
      // has `driverName` (string, no FK). Two distinct ambulances may
      // share a driverName (driver moonlighting / data-entry typo /
      // legacy roster). If the named driver is already on an active
      // trip on another vehicle, refuse the new dispatch. Active =
      // anything before COMPLETED/CANCELLED.
      if (ambulance.driverName && ambulance.driverName.trim() !== "") {
        const conflict = await prisma.ambulanceTrip.findFirst({
          where: {
            status: { notIn: ["COMPLETED", "CANCELLED"] },
            ambulance: {
              is: {
                driverName: ambulance.driverName,
                NOT: { id: ambulance.id },
              },
            },
          },
          select: {
            id: true,
            tripNumber: true,
            ambulance: { select: { vehicleNumber: true } },
          },
        });
        if (conflict) {
          ambulanceLog("warn", req, "create_trip.driver_conflict", {
            ambulanceId: ambulance.id,
            driverName: ambulance.driverName,
            conflictTripId: conflict.id,
            conflictTripNumber: conflict.tripNumber,
            conflictVehicleNumber: conflict.ambulance.vehicleNumber,
          });
          res.status(400).json({
            success: false,
            data: null,
            error: `Driver ${ambulance.driverName} is already on active dispatch ${conflict.tripNumber} (vehicle ${conflict.ambulance.vehicleNumber})`,
          });
          return;
        }
      }

      const tripNumber = await generateTripNumber();
      ambulanceLog("log", req, "create_trip.trip_number_generated", {
        ambulanceId: req.body.ambulanceId,
        tripNumber,
      });

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
      ambulanceLog("log", req, "create_trip.transaction_committed", {
        tripId: trip.id,
        tripNumber: trip.tripNumber,
        ambulanceId: trip.ambulanceId,
        patientId: trip.patientId ?? null,
      });

      // Defensive recompute outside the txn — keeps fleet status in sync even
      // if a concurrent mutation slipped in. Idempotent.
      const recomputed = await recomputeAmbulanceStatus(req.body.ambulanceId);
      ambulanceLog("log", req, "create_trip.recompute_status_done", {
        ambulanceId: req.body.ambulanceId,
        recomputedStatus: recomputed,
      });

      auditLog(req, "AMBULANCE_TRIP_CREATE", "ambulance_trip", trip.id, {
        tripNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: trip, error: null });
    } catch (err) {
      ambulanceLog("error", req, "create_trip.failed", {
        ambulanceId: req.body?.ambulanceId,
        patientId: req.body?.patientId ?? null,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.get(
  "/trips/:id",
  // Issue #174: trip detail = caller PII + chief complaint.
  authorize(Role.ADMIN, Role.RECEPTION, Role.NURSE, Role.DOCTOR),
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
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "trip_dispatch.start", {
        tripId: req.params.id,
      });
      const pre = await precheckTripTransition(req.params.id, "DISPATCHED");
      if (pre.kind === "not-found") {
        ambulanceLog("warn", req, "trip_dispatch.not_found", {
          tripId: req.params.id,
        });
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      if (pre.kind === "no-op") {
        ambulanceLog("log", req, "trip_dispatch.no_op", {
          tripId: req.params.id,
          ambulanceId: pre.trip.ambulanceId,
          currentStatus: pre.current,
        });
        // Idempotent — already DISPATCHED. Return the row as-is.
        const existing = await prisma.ambulanceTrip.findUnique({
          where: { id: req.params.id },
        });
        res.json({ success: true, data: existing, error: null });
        return;
      }
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { dispatchedAt: new Date(), status: "DISPATCHED" },
      });
      const recomputed = await recomputeAmbulanceStatus(trip.ambulanceId);
      ambulanceLog("log", req, "trip_dispatch.success", {
        tripId: trip.id,
        ambulanceId: trip.ambulanceId,
        recomputedStatus: recomputed,
      });
      auditLog(req, "TRIP_DISPATCH", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      if (err instanceof InvalidTripTransitionError) {
        res
          .status(409)
          .json({ success: false, data: null, error: err.message });
        return;
      }
      ambulanceLog("error", req, "trip_dispatch.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/arrived",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "trip_arrived.start", {
        tripId: req.params.id,
      });
      const pre = await precheckTripTransition(req.params.id, "ARRIVED_SCENE");
      if (pre.kind === "not-found") {
        ambulanceLog("warn", req, "trip_arrived.not_found", {
          tripId: req.params.id,
        });
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      if (pre.kind === "no-op") {
        ambulanceLog("log", req, "trip_arrived.no_op", {
          tripId: req.params.id,
          ambulanceId: pre.trip.ambulanceId,
          currentStatus: pre.current,
        });
        const existing = await prisma.ambulanceTrip.findUnique({
          where: { id: req.params.id },
        });
        res.json({ success: true, data: existing, error: null });
        return;
      }
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { arrivedAt: new Date(), status: "ARRIVED_SCENE" },
      });
      const recomputed = await recomputeAmbulanceStatus(trip.ambulanceId);
      ambulanceLog("log", req, "trip_arrived.success", {
        tripId: trip.id,
        ambulanceId: trip.ambulanceId,
        recomputedStatus: recomputed,
      });
      auditLog(req, "TRIP_ARRIVED_SCENE", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      if (err instanceof InvalidTripTransitionError) {
        res
          .status(409)
          .json({ success: false, data: null, error: err.message });
        return;
      }
      ambulanceLog("error", req, "trip_arrived.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/enroute",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "trip_enroute.start", {
        tripId: req.params.id,
      });
      const pre = await precheckTripTransition(
        req.params.id,
        "EN_ROUTE_HOSPITAL"
      );
      if (pre.kind === "not-found") {
        ambulanceLog("warn", req, "trip_enroute.not_found", {
          tripId: req.params.id,
        });
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      if (pre.kind === "no-op") {
        ambulanceLog("log", req, "trip_enroute.no_op", {
          tripId: req.params.id,
          ambulanceId: pre.trip.ambulanceId,
          currentStatus: pre.current,
        });
        const existing = await prisma.ambulanceTrip.findUnique({
          where: { id: req.params.id },
        });
        res.json({ success: true, data: existing, error: null });
        return;
      }
      const trip = await prisma.ambulanceTrip.update({
        where: { id: req.params.id },
        data: { status: "EN_ROUTE_HOSPITAL" },
      });
      const recomputed = await recomputeAmbulanceStatus(trip.ambulanceId);
      ambulanceLog("log", req, "trip_enroute.success", {
        tripId: trip.id,
        ambulanceId: trip.ambulanceId,
        recomputedStatus: recomputed,
      });
      auditLog(req, "TRIP_EN_ROUTE_MARK", "ambulance_trip", trip.id).catch(
        console.error
      );
      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      if (err instanceof InvalidTripTransitionError) {
        res
          .status(409)
          .json({ success: false, data: null, error: err.message });
        return;
      }
      ambulanceLog("error", req, "trip_enroute.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/complete",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  validate(completeTripSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "trip_complete.start", {
        tripId: req.params.id,
        hasActualEndTime: !!req.body.actualEndTime,
        finalDistance: req.body.finalDistance,
        finalCost: req.body.finalCost,
      });
      const existing = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        ambulanceLog("warn", req, "trip_complete.not_found", {
          tripId: req.params.id,
        });
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }

      // gap #10 (2026-05-03): enforce state-machine guard so REQUESTED →
      // COMPLETED, ARRIVED_SCENE → DISPATCHED rewinds, and post-terminal
      // moves are rejected with 409.
      if (existing.status === "COMPLETED") {
        ambulanceLog("log", req, "trip_complete.no_op", {
          tripId: existing.id,
          ambulanceId: existing.ambulanceId,
        });
        // Idempotent — already complete. No-op return; do not re-run the
        // recomputeAmbulanceStatus / audit side-effects.
        res.json({ success: true, data: existing, error: null });
        return;
      }
      try {
        assertValidTripTransition(
          existing.status as TripStatus,
          "COMPLETED"
        );
      } catch (err) {
        if (err instanceof InvalidTripTransitionError) {
          res
            .status(409)
            .json({ success: false, data: null, error: err.message });
          return;
        }
        throw err;
      }

      // Issue #87: completeTripSchema mandates actualEndTime, finalDistance,
      // finalCost, notes. Map onto persisted columns (distanceKm/cost/notes/
      // completedAt). Empty payloads are already rejected by the validator.
      const trip = await prisma.$transaction(async (tx) => {
        const t = await tx.ambulanceTrip.update({
          where: { id: req.params.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(req.body.actualEndTime),
            distanceKm: req.body.finalDistance,
            cost: req.body.finalCost,
            notes: req.body.notes,
          },
        });

        await tx.ambulance.update({
          where: { id: existing.ambulanceId },
          data: { status: "AVAILABLE" },
        });

        return t;
      });

      // Idempotent — handles the rare case of multiple active trips on the
      // same ambulance (we still want the fleet view to be honest).
      const recomputed = await recomputeAmbulanceStatus(existing.ambulanceId);
      ambulanceLog("log", req, "trip_complete.success", {
        tripId: trip.id,
        ambulanceId: existing.ambulanceId,
        recomputedStatus: recomputed,
      });

      auditLog(req, "TRIP_COMPLETE", "ambulance_trip", trip.id, {
        distanceKm: req.body.finalDistance,
        cost: req.body.finalCost,
      }).catch(console.error);

      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      ambulanceLog("error", req, "trip_complete.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.patch(
  "/trips/:id/cancel",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "trip_cancel.start", {
        tripId: req.params.id,
      });
      const existing = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        ambulanceLog("warn", req, "trip_cancel.not_found", {
          tripId: req.params.id,
        });
        res
          .status(404)
          .json({ success: false, data: null, error: "Trip not found" });
        return;
      }

      // gap #10 (2026-05-03): a CANCELLED trip is terminal. Re-cancelling
      // is treated as an idempotent no-op; cancelling a COMPLETED trip is
      // a domain error (409).
      if (existing.status === "CANCELLED") {
        ambulanceLog("log", req, "trip_cancel.no_op", {
          tripId: existing.id,
          ambulanceId: existing.ambulanceId,
        });
        res.json({ success: true, data: existing, error: null });
        return;
      }
      try {
        assertValidTripTransition(
          existing.status as TripStatus,
          "CANCELLED"
        );
      } catch (err) {
        if (err instanceof InvalidTripTransitionError) {
          res
            .status(409)
            .json({ success: false, data: null, error: err.message });
          return;
        }
        throw err;
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

      const recomputed = await recomputeAmbulanceStatus(existing.ambulanceId);
      ambulanceLog("log", req, "trip_cancel.success", {
        tripId: trip.id,
        ambulanceId: existing.ambulanceId,
        recomputedStatus: recomputed,
      });

      auditLog(req, "TRIP_CANCEL", "ambulance_trip", trip.id).catch(
        console.error
      );

      res.json({ success: true, data: trip, error: null });
    } catch (err) {
      ambulanceLog("error", req, "trip_cancel.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// AMBULANCES
// ───────────────────────────────────────────────────────

router.get("/", authorize(Role.ADMIN, Role.RECEPTION, Role.NURSE, Role.DOCTOR), async (req: Request, res: Response, next: NextFunction) => {
  // Issue #174: ambulance fleet view — operational, restrict to clinical/dispatch.
  try {
    const { status } = req.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    ambulanceLog("log", req, "list_ambulances.start", {
      status: status ?? null,
      nodeEnv: process.env.NODE_ENV,
    });

    // Issue #738: hide test/demo ambulance rows in production. Local seed
    // data ships rows with `TEST-*` / `DEMO*` / `AMB-DEMO-*` vehicle
    // numbers and "Demo Driver" driver names so the dev/test fleet view
    // has data to render. Those rows must NEVER surface on a production
    // dispatch console where they confuse real dispatchers and inflate
    // fleet counts. The 20260508000003_cleanup_attacker_test_users_and_
    // test_ambulances migration removes them at rest, but the runtime
    // filter is a defensive belt-and-braces in case ops ever loads a
    // demo-shaped row into prod accidentally.
    if (process.env.NODE_ENV === "production") {
      where.AND = [
        { NOT: { vehicleNumber: { startsWith: "TEST-", mode: "insensitive" } } },
        { NOT: { vehicleNumber: { startsWith: "DEMO", mode: "insensitive" } } },
        {
          NOT: {
            vehicleNumber: { startsWith: "AMB-DEMO-", mode: "insensitive" },
          },
        },
        { NOT: { driverName: { equals: "Demo Driver", mode: "insensitive" } } },
      ];
    }

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
    ambulanceLog("error", req, "list_ambulances.failed", {
      error: serializeError(err),
    });
    next(err);
  }
});

router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createAmbulanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ambulanceLog("log", req, "create_ambulance.start", {
        vehicleNumber: req.body.vehicleNumber,
        type: req.body.type,
        driverPhone: redactPhone(req.body.driverPhone),
      });
      const { lastServiceDate, nextServiceDate, ...rest } = req.body;
      const ambulance = await prisma.ambulance.create({
        data: {
          ...rest,
          lastServiceDate: lastServiceDate ? new Date(lastServiceDate) : null,
          nextServiceDate: nextServiceDate ? new Date(nextServiceDate) : null,
        },
      });

      auditLog(req, "AMBULANCE_CREATE", "ambulance", ambulance.id, {
        vehicleNumber: ambulance.vehicleNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: ambulance, error: null });
    } catch (err) {
      ambulanceLog("error", req, "create_ambulance.failed", {
        vehicleNumber: req.body?.vehicleNumber,
        error: serializeError(err),
      });
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
      ambulanceLog("log", req, "update_ambulance.start", {
        ambulanceId: req.params.id,
        keys: Object.keys(req.body ?? {}),
      });
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

      auditLog(req, "AMBULANCE_UPDATE", "ambulance", ambulance.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: ambulance, error: null });
    } catch (err) {
      ambulanceLog("error", req, "update_ambulance.failed", {
        ambulanceId: req.params.id,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

// IMPORTANT — must come BEFORE GET /:id below. Express matches in
// declaration order and `/fuel-logs` would otherwise be eaten by `/:id`
// with id="fuel-logs", returning 404 for "Ambulance not found" instead of
// the fuel-logs payload (caught by the rbac-hardening test on
// 2026-04-30 — was returning 404 to DOCTOR instead of the expected 403).
router.get(
  "/fuel-logs",
  // Issue #174: fuel logs = financial data, ops only.
  authorize(Role.ADMIN, Role.RECEPTION),
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
      ambulanceLog("log", req, "list_fuel_logs.start", {
        ambulanceId: ambulanceId ?? null,
        from: from ?? null,
        to: to ?? null,
      });
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
      ambulanceLog("error", req, "list_fuel_logs.failed", {
        error: serializeError(err),
      });
      next(err);
    }
  }
);

router.get("/:id", authorize(Role.ADMIN, Role.RECEPTION, Role.NURSE, Role.DOCTOR), async (req: Request, res: Response, next: NextFunction) => {
  // Issue #174: ambulance detail includes recent trips (caller PII).
  try {
    ambulanceLog("log", req, "get_ambulance.start", {
      ambulanceId: req.params.id,
    });
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
    ambulanceLog("error", req, "get_ambulance.failed", {
      ambulanceId: req.params.id,
      error: serializeError(err),
    });
    next(err);
  }
});

// ───────────────────────────────────────────────────────
// GPS / TRIP LOCATION UPDATE
// ───────────────────────────────────────────────────────

router.patch(
  "/trips/:id/location",
  // RBAC (issue #89): DOCTOR removed from ambulance write/dispatch paths.
  authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pickupLat, pickupLng, dropLat, dropLng } = req.body as {
        pickupLat?: number;
        pickupLng?: number;
        dropLat?: number;
        dropLng?: number;
      };
      ambulanceLog("log", req, "trip_location_update.start", {
        tripId: req.params.id,
        pickupLat: pickupLat ?? null,
        pickupLng: pickupLng ?? null,
        dropLat: dropLat ?? null,
        dropLng: dropLng ?? null,
      });
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
      ambulanceLog("error", req, "trip_location_update.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
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
      ambulanceLog("log", req, "equipment_check.start", {
        tripId: req.params.id,
        equipmentChecked: req.body.equipmentChecked,
      });
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
      ambulanceLog("error", req, "equipment_check.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
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
      ambulanceLog("log", req, "trip_bill.start", {
        tripId: req.params.id,
        baseFare: req.body.baseFare,
        perKmRate: req.body.perKmRate,
      });
      const trip = await prisma.ambulanceTrip.findUnique({
        where: { id: req.params.id },
      });
      if (!trip) {
        ambulanceLog("warn", req, "trip_bill.not_found", {
          tripId: req.params.id,
        });
        res.status(404).json({ success: false, data: null, error: "Trip not found" });
        return;
      }
      if (!trip.patientId) {
        ambulanceLog("warn", req, "trip_bill.missing_patient", {
          tripId: req.params.id,
        });
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

      auditLog(req, "AMBULANCE_TRIP_BILL", "ambulance_trip", trip.id, {
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
      ambulanceLog("error", req, "trip_bill.failed", {
        tripId: req.params.id,
        error: serializeError(err),
      });
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
      ambulanceLog("log", req, "fuel_log_create.start", {
        ambulanceId: req.body.ambulanceId,
        litres: req.body.litres,
        costTotal: req.body.costTotal,
        odometerKm: req.body.odometerKm ?? null,
        hasFilledAt: !!req.body.filledAt,
      });
      // gap #10 (2026-05-03): honour the client-supplied `filledAt` when
      // provided (validator already enforces it cannot be in the future).
      // Falling through to undefined lets Prisma's `@default(now())` fire.
      const log = await prisma.ambulanceFuelLog.create({
        data: {
          ambulanceId: req.body.ambulanceId,
          litres: req.body.litres,
          costTotal: req.body.costTotal,
          odometerKm: req.body.odometerKm,
          stationName: req.body.stationName,
          notes: req.body.notes,
          filledBy: req.user!.userId,
          ...(req.body.filledAt
            ? { filledAt: new Date(req.body.filledAt) }
            : {}),
        },
      });
      auditLog(req, "AMBULANCE_FUEL_LOG", "ambulance_fuel_log", log.id, {
        ambulanceId: req.body.ambulanceId,
        litres: req.body.litres,
      }).catch(console.error);
      res.status(201).json({ success: true, data: log, error: null });
    } catch (err) {
      ambulanceLog("error", req, "fuel_log_create.failed", {
        ambulanceId: req.body?.ambulanceId,
        error: serializeError(err),
      });
      next(err);
    }
  }
);

export { router as ambulanceRouter };
