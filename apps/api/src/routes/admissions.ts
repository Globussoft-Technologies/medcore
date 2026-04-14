import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  admitPatientSchema,
  dischargeSchema,
  transferBedSchema,
  recordIpdVitalsSchema,
  intakeOutputSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Generate next admission number like IPD000001
async function nextAdmissionNumber(): Promise<string> {
  const last = await prisma.admission.findFirst({
    orderBy: { admissionNumber: "desc" },
    select: { admissionNumber: true },
  });
  let n = 1;
  if (last?.admissionNumber) {
    const m = last.admissionNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `IPD${String(n).padStart(6, "0")}`;
}

// GET /api/v1/admissions — list admissions with filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, patientId, doctorId, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;

    // If patient role, only show own admissions
    if (req.user!.role === Role.PATIENT) {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
      else {
        res.json({ success: true, data: [], error: null, meta: { page: 1, limit: take, total: 0 } });
        return;
      }
    }

    const [admissions, total] = await Promise.all([
      prisma.admission.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          bed: {
            include: { ward: true },
          },
        },
        skip,
        take,
        orderBy: { admittedAt: "desc" },
      }),
      prisma.admission.count({ where }),
    ]);

    res.json({
      success: true,
      data: admissions,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admissions/:id — admission detail
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admission = await prisma.admission.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          bed: {
            include: { ward: true },
          },
          ipdVitals: {
            orderBy: { recordedAt: "desc" },
            take: 20,
          },
          medicationOrders: {
            orderBy: { createdAt: "desc" },
            include: {
              administrations: {
                orderBy: { scheduledAt: "asc" },
                take: 10,
              },
            },
          },
          nurseRounds: {
            orderBy: { performedAt: "desc" },
            take: 20,
            include: {
              nurse: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      res.json({ success: true, data: admission, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/admissions — admit patient
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(admitPatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        doctorId,
        bedId,
        reason,
        diagnosis,
        admissionType,
        referredByDoctor,
      } = req.body;

      const bed = await prisma.bed.findUnique({ where: { id: bedId } });
      if (!bed) {
        res.status(404).json({ success: false, data: null, error: "Bed not found" });
        return;
      }
      if (bed.status !== "AVAILABLE") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Bed is not available (current status: ${bed.status})`,
        });
        return;
      }

      const admissionNumber = await nextAdmissionNumber();

      const admission = await prisma.$transaction(async (tx) => {
        const created = await tx.admission.create({
          data: {
            admissionNumber,
            patientId,
            doctorId,
            bedId,
            reason,
            diagnosis,
            admissionType: admissionType ?? null,
            referredByDoctor: referredByDoctor ?? null,
            status: "ADMITTED",
          },
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
            doctor: {
              include: { user: { select: { name: true } } },
            },
            bed: { include: { ward: true } },
          },
        });
        await tx.bed.update({
          where: { id: bedId },
          data: { status: "OCCUPIED" },
        });
        return created;
      });

      auditLog(req, "ADMIT_PATIENT", "admission", admission.id, {
        admissionNumber,
        patientId,
        doctorId,
        bedId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: admission, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/discharge-readiness — checklist before discharge
router.get(
  "/:id/discharge-readiness",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admissionId = req.params.id;
      const admission = await prisma.admission.findUnique({
        where: { id: admissionId },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      // Outstanding bills
      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          patientId: admission.patientId,
          paymentStatus: { in: ["PENDING", "PARTIAL"] },
        },
        select: { id: true, invoiceNumber: true, totalAmount: true },
      });
      const payments = pendingInvoices.length
        ? await prisma.payment.findMany({
            where: { invoiceId: { in: pendingInvoices.map((i) => i.id) } },
          })
        : [];
      const paidByInv: Record<string, number> = {};
      for (const p of payments) {
        paidByInv[p.invoiceId] = (paidByInv[p.invoiceId] || 0) + p.amount;
      }
      let outstandingAmount = 0;
      for (const inv of pendingInvoices) {
        outstandingAmount += Math.max(0, inv.totalAmount - (paidByInv[inv.id] || 0));
      }

      // Pending lab results (lab orders on this admission not COMPLETED/CANCELLED)
      const pendingLabs = await prisma.labOrder.count({
        where: {
          admissionId,
          status: { notIn: ["COMPLETED", "CANCELLED"] },
        },
      });

      // Pending medications — active orders with no recent administration (last 12h)
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const activeOrders = await prisma.medicationOrder.findMany({
        where: { admissionId, isActive: true },
        include: {
          administrations: {
            where: { administeredAt: { gte: twelveHoursAgo } },
            select: { id: true },
            take: 1,
          },
        },
      });
      const pendingMedications = activeOrders.filter((o) => o.administrations.length === 0).length;

      // Summary / follow-up / meds-on-discharge
      const dischargeSummaryWritten = Boolean(admission.dischargeSummary);
      const followUpGiven = Boolean(admission.followUpInstructions);
      const medsOnDischargeSpecified = Boolean(admission.dischargeMedications);

      const ready =
        outstandingAmount <= 0 &&
        pendingLabs === 0 &&
        pendingMedications === 0 &&
        dischargeSummaryWritten &&
        medsOnDischargeSpecified;

      res.json({
        success: true,
        data: {
          admissionId,
          ready,
          outstandingBillsCount: pendingInvoices.length,
          outstandingAmount,
          pendingInvoices,
          pendingLabOrders: pendingLabs,
          pendingMedications,
          dischargeSummaryWritten,
          followUpGiven,
          medsOnDischargeSpecified,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/admissions/:id/discharge
router.patch(
  "/:id/discharge",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(dischargeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.admission.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }
      if (existing.status === "DISCHARGED") {
        res.status(409).json({ success: false, data: null, error: "Admission already discharged" });
        return;
      }

      // Outstanding bill guard unless forceDischarge=true
      const forceDischarge = req.body.forceDischarge === true;
      if (!forceDischarge) {
        const pendingInvoices = await prisma.invoice.findMany({
          where: {
            patientId: existing.patientId,
            paymentStatus: { in: ["PENDING", "PARTIAL"] },
          },
          select: { id: true, totalAmount: true },
        });
        if (pendingInvoices.length > 0) {
          const payments = await prisma.payment.findMany({
            where: { invoiceId: { in: pendingInvoices.map((i) => i.id) } },
          });
          const paidByInv: Record<string, number> = {};
          for (const p of payments) {
            paidByInv[p.invoiceId] = (paidByInv[p.invoiceId] || 0) + p.amount;
          }
          let outstanding = 0;
          for (const inv of pendingInvoices) {
            outstanding += Math.max(0, inv.totalAmount - (paidByInv[inv.id] || 0));
          }
          if (outstanding > 0) {
            res.status(400).json({
              success: false,
              data: null,
              error: `Outstanding bill balance of Rs. ${outstanding.toFixed(2)}. Settle bills or pass forceDischarge: true.`,
              outstanding,
            });
            return;
          }
        }
      }

      // Compute bill before closing
      const bed = await prisma.bed.findUnique({ where: { id: existing.bedId } });
      const days = Math.max(
        1,
        Math.ceil(
          (Date.now() - new Date(existing.admittedAt).getTime()) /
            (24 * 60 * 60 * 1000)
        )
      );
      const totalBill = (bed?.dailyRate ?? 0) * days;

      const admission = await prisma.$transaction(async (tx) => {
        const updated = await tx.admission.update({
          where: { id: req.params.id },
          data: {
            status: "DISCHARGED",
            dischargedAt: new Date(),
            dischargeSummary: req.body.dischargeSummary,
            dischargeNotes: req.body.dischargeNotes,
            finalDiagnosis: req.body.finalDiagnosis,
            treatmentGiven: req.body.treatmentGiven,
            conditionAtDischarge: req.body.conditionAtDischarge,
            dischargeMedications: req.body.dischargeMedications,
            followUpInstructions: req.body.followUpInstructions,
            totalBillAmount: totalBill,
          },
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
            doctor: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
        });
        await tx.bed.update({
          where: { id: existing.bedId },
          data: { status: "AVAILABLE" },
        });
        // deactivate remaining medication orders
        await tx.medicationOrder.updateMany({
          where: { admissionId: existing.id, isActive: true },
          data: { isActive: false },
        });
        return updated;
      });

      auditLog(req, "DISCHARGE_PATIENT", "admission", admission.id, {
        admissionNumber: admission.admissionNumber,
      }).catch(console.error);

      res.json({ success: true, data: admission, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/admissions/:id/transfer — transfer to new bed
router.patch(
  "/:id/transfer",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(transferBedSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.admission.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }
      if (existing.status !== "ADMITTED") {
        res.status(409).json({ success: false, data: null, error: "Only ADMITTED admissions can be transferred" });
        return;
      }

      const newBed = await prisma.bed.findUnique({ where: { id: req.body.newBedId } });
      if (!newBed) {
        res.status(404).json({ success: false, data: null, error: "Target bed not found" });
        return;
      }
      if (newBed.status !== "AVAILABLE") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Target bed is not available (status: ${newBed.status})`,
        });
        return;
      }

      const oldBedId = existing.bedId;

      const admission = await prisma.$transaction(async (tx) => {
        await tx.bed.update({ where: { id: oldBedId }, data: { status: "AVAILABLE" } });
        await tx.bed.update({ where: { id: newBed.id }, data: { status: "OCCUPIED" } });
        const updated = await tx.admission.update({
          where: { id: req.params.id },
          data: {
            bedId: newBed.id,
            status: "TRANSFERRED",
          },
          include: {
            patient: { include: { user: { select: { name: true, phone: true } } } },
            doctor: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
        });
        // Re-set status to ADMITTED after transfer move recorded
        return tx.admission.update({
          where: { id: updated.id },
          data: { status: "ADMITTED" },
          include: {
            patient: { include: { user: { select: { name: true, phone: true } } } },
            doctor: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
        });
      });

      auditLog(req, "TRANSFER_BED", "admission", admission.id, {
        fromBedId: oldBedId,
        toBedId: newBed.id,
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: admission, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/admissions/:id/vitals — record IPD vitals
router.post(
  "/:id/vitals",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(recordIpdVitalsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admissionId = req.params.id;
      const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const vitals = await prisma.ipdVitals.create({
        data: {
          admissionId,
          recordedBy: req.user!.userId,
          bloodPressureSystolic: req.body.bloodPressureSystolic,
          bloodPressureDiastolic: req.body.bloodPressureDiastolic,
          temperature: req.body.temperature,
          pulseRate: req.body.pulseRate,
          respiratoryRate: req.body.respiratoryRate,
          spO2: req.body.spO2,
          painScore: req.body.painScore,
          bloodSugar: req.body.bloodSugar,
          notes: req.body.notes,
        },
      });

      auditLog(req, "RECORD_IPD_VITALS", "ipdVitals", vitals.id, { admissionId }).catch(console.error);
      res.status(201).json({ success: true, data: vitals, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/vitals — list vitals
router.get(
  "/:id/vitals",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vitals = await prisma.ipdVitals.findMany({
        where: { admissionId: req.params.id },
        orderBy: { recordedAt: "desc" },
      });
      res.json({ success: true, data: vitals, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/bill — running daily bill
router.get(
  "/:id/bill",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admission = await prisma.admission.findUnique({
        where: { id: req.params.id },
        include: { bed: { include: { ward: true } } },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const startMs = new Date(admission.admittedAt).getTime();
      const endMs = admission.dischargedAt
        ? new Date(admission.dischargedAt).getTime()
        : Date.now();
      const days = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)));
      const dailyRate = admission.bed?.dailyRate ?? 0;
      const bedCharges = dailyRate * days;

      // Fetch pharmacy/lab sub-totals if linked invoices exist — omitted for now
      // Simple breakdown
      const breakdown = [
        {
          label: `Bed Charges (${admission.bed?.ward?.name ?? "Ward"} / ${admission.bed?.bedNumber ?? "-"})`,
          days,
          ratePerDay: dailyRate,
          amount: bedCharges,
        },
      ];

      res.json({
        success: true,
        data: {
          admissionId: admission.id,
          admissionNumber: admission.admissionNumber,
          admittedAt: admission.admittedAt,
          dischargedAt: admission.dischargedAt,
          days,
          breakdown,
          grandTotal: bedCharges,
          currentTotal: admission.totalBillAmount ?? bedCharges,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/admissions/:id/intake-output — record I/O event
router.post(
  "/:id/intake-output",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = intakeOutputSchema.safeParse({
        ...req.body,
        admissionId: req.params.id,
      });
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
        return;
      }
      const admission = await prisma.admission.findUnique({
        where: { id: req.params.id },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const io = await prisma.ipdIntakeOutput.create({
        data: {
          admissionId: req.params.id,
          type: parsed.data.type,
          amountMl: parsed.data.amountMl,
          description: parsed.data.description,
          notes: parsed.data.notes,
          recordedBy: req.user!.userId,
        },
      });

      auditLog(req, "RECORD_INTAKE_OUTPUT", "ipdIntakeOutput", io.id, {
        admissionId: req.params.id,
        type: io.type,
        amountMl: io.amountMl,
      }).catch(console.error);

      res.status(201).json({ success: true, data: io, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/intake-output?date=YYYY-MM-DD — daily I/O summary
router.get(
  "/:id/intake-output",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;
      const where: Record<string, unknown> = { admissionId: req.params.id };
      if (date) {
        const start = new Date(date as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        where.recordedAt = { gte: start, lt: end };
      }
      const rows = await prisma.ipdIntakeOutput.findMany({
        where,
        orderBy: { recordedAt: "desc" },
      });

      let totalIntake = 0;
      let totalOutput = 0;
      for (const r of rows) {
        if (r.type.startsWith("INTAKE")) totalIntake += r.amountMl;
        else if (r.type.startsWith("OUTPUT")) totalOutput += r.amountMl;
      }

      res.json({
        success: true,
        data: {
          rows,
          totalIntake,
          totalOutput,
          balance: totalIntake - totalOutput,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/mar — Medication Administration Record grid
// Returns a grid keyed by order -> list of administrations for the day
router.get(
  "/:id/mar",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;
      const admission = await prisma.admission.findUnique({
        where: { id: req.params.id },
        select: { id: true, admissionNumber: true, status: true },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const dateStart = date ? new Date(date as string) : new Date();
      dateStart.setHours(0, 0, 0, 0);
      const dateEnd = new Date(dateStart);
      dateEnd.setDate(dateEnd.getDate() + 1);

      const orders = await prisma.medicationOrder.findMany({
        where: { admissionId: req.params.id },
        orderBy: { createdAt: "asc" },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          administrations: {
            where: { scheduledAt: { gte: dateStart, lt: dateEnd } },
            orderBy: { scheduledAt: "asc" },
            include: {
              nurse: { select: { id: true, name: true } },
            },
          },
        },
      });

      res.json({
        success: true,
        data: {
          admissionId: admission.id,
          admissionNumber: admission.admissionNumber,
          date: dateStart.toISOString().slice(0, 10),
          orders,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as admissionRouter };
