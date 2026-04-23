import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { predictNoShow, batchPredictNoShow } from "../services/ai/no-show-predictor";

const router = Router();

// GET /api/v1/ai/predictions/no-show/batch?date=YYYY-MM-DD
// Must be declared BEFORE /:appointmentId to avoid "batch" being consumed as a param
router.get(
  "/no-show/batch",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;

      if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Query param 'date' is required in YYYY-MM-DD format",
        });
        return;
      }

      const dateObj = new Date(date);

      // Fetch BOOKED appointments with full patient/doctor/user info for the table
      const appointments = await prisma.appointment.findMany({
        where: {
          date: dateObj,
          status: "BOOKED",
        },
        include: {
          patient: {
            include: {
              user: true,
            },
          },
          doctor: {
            include: {
              user: true,
            },
          },
        },
        orderBy: { slotStart: "asc" },
      });

      if (appointments.length === 0) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      // Run predictions in parallel
      const predictions = await Promise.all(
        appointments.map((appt) => predictNoShow(appt.id))
      );

      // Merge prediction data with appointment info
      const apptMap = new Map(appointments.map((a) => [a.id, a]));

      const enriched = predictions
        .sort((a, b) => b.riskScore - a.riskScore)
        .map((pred) => {
          const appt = apptMap.get(pred.appointmentId)!;
          return {
            ...pred,
            appointment: {
              id: appt.id,
              slotStart: appt.slotStart,
              slotEnd: appt.slotEnd,
              date: appt.date,
              patientName: appt.patient.user.name,
              patientId: appt.patientId,
              doctorName: appt.doctor.user.name,
              doctorId: appt.doctorId,
            },
          };
        });

      res.json({ success: true, data: enriched, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/predictions/no-show/:appointmentId
router.get(
  "/no-show/:appointmentId",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId } = req.params;

      const prediction = await predictNoShow(appointmentId);

      res.json({ success: true, data: prediction, error: null });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as aiPredictionsRouter };
