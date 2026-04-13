import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role, createPrescriptionSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { generatePrescriptionPDF } from "../services/pdf";
import { onPrescriptionReady } from "../services/notification-triggers";

const router = Router();
router.use(authenticate);

// POST /api/v1/prescriptions — create prescription (doctor)
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createPrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId, patientId, diagnosis, items, advice, followUpDate } =
        req.body;

      // Get doctor record from user
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });

      if (!doctor && req.user!.role !== "ADMIN") {
        res.status(403).json({
          success: false,
          data: null,
          error: "Doctor profile not found",
        });
        return;
      }

      const doctorId = doctor?.id || req.user!.userId;

      const prescription = await prisma.prescription.create({
        data: {
          appointmentId,
          patientId,
          doctorId,
          diagnosis,
          advice,
          followUpDate: followUpDate ? new Date(followUpDate) : undefined,
          signatureUrl: doctor?.signatureUrl,
          items: {
            create: items,
          },
        },
        include: {
          items: true,
          doctor: { include: { user: { select: { name: true } } } },
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      // Fire-and-forget notification
      onPrescriptionReady(prescription as any).catch(console.error);

      res.status(201).json({ success: true, data: prescription, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions — list prescriptions
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { patientId, doctorId, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;

    // Patients see only their own
    if (req.user!.role === "PATIENT") {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
    }

    // Doctors see only their own
    if (req.user!.role === "DOCTOR") {
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });
      if (doctor) where.doctorId = doctor.id;
    }

    const [prescriptions, total] = await Promise.all([
      prisma.prescription.findMany({
        where,
        include: {
          items: true,
          doctor: { include: { user: { select: { name: true } } } },
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.prescription.count({ where }),
    ]);

    res.json({
      success: true,
      data: prescriptions,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/prescriptions/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prescription = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        include: {
          items: true,
          doctor: {
            include: { user: { select: { name: true, email: true } } },
          },
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          appointment: true,
        },
      });

      if (!prescription) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }

      res.json({ success: true, data: prescription, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions/:id/pdf — render prescription as printable HTML
router.get(
  "/:id/pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generatePrescriptionPDF(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Prescription not found") {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      next(err);
    }
  }
);

export { router as prescriptionRouter };
