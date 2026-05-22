/**
 * Doctor favourite-medicine quick-add API — Pearl ERP Stage 1 §2.1.4
 * (gap item #50).
 *
 * What / which modules / why:
 *   - Pearl §2.1.4 mandates a per-doctor "favourites" list that surfaces
 *     a doctor's frequently-prescribed medicines as one-tap chips above
 *     the medicine-search results in the Rx writer. Optional per-favourite
 *     dosage / frequency / duration presets load full Rx items in one click.
 *   - DoctorFavouriteMedicine model shipped in migration
 *     `20260522000002_pearl_doctor_favourite_medicine`.
 *   - 5 endpoints, all scoped to /api/v1/doctors/me/favourites (doctor-
 *     self only — caller's Doctor row is resolved from req.user.userId):
 *       GET    /            list (sorted by position ASC)
 *       POST   /            add one (validates medicine exists, 409 on dup)
 *       PATCH  /:id         update presets / position (404 if not owned)
 *       DELETE /:id         remove (404 if not owned)
 *       PATCH  /reorder     bulk reorder via single transaction
 *
 * The /reorder route is declared BEFORE PATCH /:id so Express's
 * static-before-dynamic ordering picks it up first (CLAUDE.md gotcha §14).
 *
 * Audit:
 *   - DOCTOR_FAVOURITE_MEDICINE_ADD / UPDATE / REMOVE / REORDER on
 *     entity="doctor_favourite_medicine". Uses `auditLog(...).catch(...)`
 *     per the project's safe-audit convention — tests reading AuditLog
 *     immediately after these actions should use waitForAuditFlush().
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  addFavouriteMedicineSchema,
  updateFavouriteMedicineSchema,
  reorderFavouritesSchema,
} from "@medcore/shared";
import type {
  AddFavouriteMedicineInput,
  UpdateFavouriteMedicineInput,
  ReorderFavouritesInput,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.DOCTOR));

/**
 * Resolve the caller's Doctor row from their JWT userId. Returns null
 * if the User has the DOCTOR role but no Doctor profile (an inconsistent
 * but technically possible seed state); routes treat that as 403.
 */
async function getCallerDoctor(req: Request): Promise<{ id: string; tenantId: string | null } | null> {
  const doc = await prisma.doctor.findFirst({
    where: { userId: req.user!.userId },
    select: { id: true, tenantId: true },
  });
  return doc;
}

// ── GET / — list this doctor's favourites ─────────────────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doctor = await getCallerDoctor(req);
    if (!doctor) {
      res.status(403).json({
        success: false,
        data: null,
        error: "No doctor profile linked to this user",
      });
      return;
    }
    const favourites = await prisma.doctorFavouriteMedicine.findMany({
      where: { doctorId: doctor.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { medicine: true },
    });
    res.json({ success: true, data: favourites, error: null });
  } catch (err) {
    next(err);
  }
});

// ── POST / — add a favourite ──────────────────────────────────────────
router.post(
  "/",
  validate(addFavouriteMedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doctor = await getCallerDoctor(req);
      if (!doctor) {
        res.status(403).json({
          success: false,
          data: null,
          error: "No doctor profile linked to this user",
        });
        return;
      }
      const body = req.body as AddFavouriteMedicineInput;

      // Verify the Medicine exists. The Medicine model has no tenantId
      // column (it's a global catalog), so no cross-tenant check is needed.
      const medicine = await prisma.medicine.findUnique({
        where: { id: body.medicineId },
        select: { id: true },
      });
      if (!medicine) {
        res.status(422).json({
          success: false,
          data: null,
          error: "Medicine not found",
        });
        return;
      }

      const created = await prisma.doctorFavouriteMedicine.create({
        data: {
          doctorId: doctor.id,
          medicineId: medicine.id,
          position: body.position ?? 0,
          defaultDosage: body.defaultDosage ?? null,
          defaultFrequency: body.defaultFrequency ?? null,
          defaultDuration: body.defaultDuration ?? null,
          // Denormalize tenantId. Falls back to empty string only if the
          // doctor has no tenant (single-tenant deploy) — that's still
          // a deterministic value the per-tenant index can group on.
          tenantId: doctor.tenantId ?? "",
        },
        include: { medicine: true },
      });

      auditLog(
        req,
        "DOCTOR_FAVOURITE_MEDICINE_ADD",
        "doctor_favourite_medicine",
        created.id,
        { medicineId: created.medicineId },
      ).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Unique constraint") ||
        msg.includes("doctor_favourite_medicines_doctorId_medicineId_key")
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Medicine already in your favourites",
        });
        return;
      }
      next(err);
    }
  },
);

// ── PATCH /reorder — bulk reorder (declared BEFORE PATCH /:id) ───────
router.patch(
  "/reorder",
  validate(reorderFavouritesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doctor = await getCallerDoctor(req);
      if (!doctor) {
        res.status(403).json({
          success: false,
          data: null,
          error: "No doctor profile linked to this user",
        });
        return;
      }
      const body = req.body as ReorderFavouritesInput;

      // Verify every id in the payload belongs to this doctor. Drop any
      // id that doesn't — we don't error the whole transaction on a
      // single stale id (the UI may have lagged a delete), we just skip.
      const ownedIds = new Set(
        (
          await prisma.doctorFavouriteMedicine.findMany({
            where: {
              id: { in: body.items.map((i) => i.id) },
              doctorId: doctor.id,
            },
            select: { id: true },
          })
        ).map((r) => r.id),
      );
      const valid = body.items.filter((i) => ownedIds.has(i.id));

      const updated = await prisma.$transaction(
        valid.map((i) =>
          prisma.doctorFavouriteMedicine.update({
            where: { id: i.id },
            data: { position: i.position },
          }),
        ),
      );

      auditLog(
        req,
        "DOCTOR_FAVOURITE_MEDICINE_REORDER",
        "doctor_favourite_medicine",
        doctor.id,
        { count: updated.length, ids: valid.map((i) => i.id) },
      ).catch(console.error);

      res.json({ success: true, data: { updated: updated.length }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — update one favourite ─────────────────────────────────
router.patch(
  "/:id",
  validate(updateFavouriteMedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doctor = await getCallerDoctor(req);
      if (!doctor) {
        res.status(403).json({
          success: false,
          data: null,
          error: "No doctor profile linked to this user",
        });
        return;
      }
      // Scope by doctorId AND id — cross-doctor PATCH attempts surface
      // as 404 (don't even acknowledge the row exists).
      const owned = await prisma.doctorFavouriteMedicine.findFirst({
        where: { id: req.params.id, doctorId: doctor.id },
        select: { id: true },
      });
      if (!owned) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Favourite not found",
        });
        return;
      }
      const body = req.body as UpdateFavouriteMedicineInput;

      const updated = await prisma.doctorFavouriteMedicine.update({
        where: { id: owned.id },
        data: {
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.defaultDosage !== undefined
            ? { defaultDosage: body.defaultDosage }
            : {}),
          ...(body.defaultFrequency !== undefined
            ? { defaultFrequency: body.defaultFrequency }
            : {}),
          ...(body.defaultDuration !== undefined
            ? { defaultDuration: body.defaultDuration }
            : {}),
        },
        include: { medicine: true },
      });

      auditLog(
        req,
        "DOCTOR_FAVOURITE_MEDICINE_UPDATE",
        "doctor_favourite_medicine",
        updated.id,
        body as Record<string, unknown>,
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /:id — remove one favourite ────────────────────────────────
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doctor = await getCallerDoctor(req);
    if (!doctor) {
      res.status(403).json({
        success: false,
        data: null,
        error: "No doctor profile linked to this user",
      });
      return;
    }
    const owned = await prisma.doctorFavouriteMedicine.findFirst({
      where: { id: req.params.id, doctorId: doctor.id },
      select: { id: true, medicineId: true },
    });
    if (!owned) {
      res.status(404).json({
        success: false,
        data: null,
        error: "Favourite not found",
      });
      return;
    }

    await prisma.doctorFavouriteMedicine.delete({ where: { id: owned.id } });

    auditLog(
      req,
      "DOCTOR_FAVOURITE_MEDICINE_REMOVE",
      "doctor_favourite_medicine",
      owned.id,
      { medicineId: owned.medicineId },
    ).catch(console.error);

    res.json({
      success: true,
      data: { id: owned.id, removed: true },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

export { router as doctorFavouritesRouter };
