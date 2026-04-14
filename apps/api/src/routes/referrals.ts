import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createReferralSchema,
  updateReferralStatusSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Generate next referral number like REF000001
async function nextReferralNumber(): Promise<string> {
  const last = await prisma.referral.findFirst({
    orderBy: { referralNumber: "desc" },
    select: { referralNumber: true },
  });
  let n = 1;
  if (last?.referralNumber) {
    const m = last.referralNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `REF${String(n).padStart(6, "0")}`;
}

// POST /api/v1/referrals — create referral
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createReferralSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        fromDoctorId,
        toDoctorId,
        externalProvider,
        externalContact,
        specialty,
        reason,
        notes,
      } = req.body;

      const referralNumber = await nextReferralNumber();

      const referral = await prisma.referral.create({
        data: {
          referralNumber,
          patientId,
          fromDoctorId,
          toDoctorId,
          externalProvider,
          externalContact,
          specialty,
          reason,
          notes,
          status: "PENDING",
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          fromDoctor: { include: { user: { select: { name: true } } } },
          toDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "CREATE_REFERRAL", "referral", referral.id, {
        referralNumber,
        patientId,
        fromDoctorId,
        toDoctorId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: referral, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/referrals/inbox?doctorId= — referrals sent TO a doctor
router.get(
  "/inbox",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId, status, page = "1", limit = "20" } = req.query;
      if (!doctorId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId query param is required",
        });
        return;
      }

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: Record<string, unknown> = { toDoctorId: doctorId };
      if (status) where.status = status;

      const [referrals, total] = await Promise.all([
        prisma.referral.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
            fromDoctor: { include: { user: { select: { name: true } } } },
            toDoctor: { include: { user: { select: { name: true } } } },
          },
          skip,
          take,
          orderBy: { referredAt: "desc" },
        }),
        prisma.referral.count({ where }),
      ]);

      res.json({
        success: true,
        data: referrals,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/referrals — list with filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      patientId,
      fromDoctorId,
      toDoctorId,
      status,
      page = "1",
      limit = "20",
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (fromDoctorId) where.fromDoctorId = fromDoctorId;
    if (toDoctorId) where.toDoctorId = toDoctorId;
    if (status) where.status = status;

    // PATIENT role: scope to own patient record
    if (req.user!.role === Role.PATIENT) {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (!patient) {
        res.json({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: take, total: 0 },
        });
        return;
      }
      where.patientId = patient.id;
    }

    const [referrals, total] = await Promise.all([
      prisma.referral.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          fromDoctor: { include: { user: { select: { name: true } } } },
          toDoctor: { include: { user: { select: { name: true } } } },
        },
        skip,
        take,
        orderBy: { referredAt: "desc" },
      }),
      prisma.referral.count({ where }),
    ]);

    res.json({
      success: true,
      data: referrals,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/referrals/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const referral = await prisma.referral.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          fromDoctor: {
            include: { user: { select: { name: true, email: true } } },
          },
          toDoctor: {
            include: { user: { select: { name: true, email: true } } },
          },
        },
      });

      if (!referral) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Referral not found",
        });
        return;
      }

      res.json({ success: true, data: referral, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/referrals/:id — update status
router.patch(
  "/:id",
  validate(updateReferralStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, notes } = req.body;

      const existing = await prisma.referral.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Referral not found",
        });
        return;
      }

      const data: Record<string, unknown> = { status };
      if (notes !== undefined) data.notes = notes;

      // If leaving PENDING and respondedAt not set, set it
      if (
        status !== "PENDING" &&
        existing.status === "PENDING" &&
        !existing.respondedAt
      ) {
        data.respondedAt = new Date();
      }

      const referral = await prisma.referral.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          fromDoctor: { include: { user: { select: { name: true } } } },
          toDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "UPDATE_REFERRAL_STATUS", "referral", referral.id, {
        status,
      }).catch(console.error);

      res.json({ success: true, data: referral, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as referralRouter };
