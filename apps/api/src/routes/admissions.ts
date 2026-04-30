import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  admitPatientSchema,
  dischargeSchema,
  transferBedSchema,
  recordIpdVitalsSchema,
  intakeOutputSchema,
  isolationStatusSchema,
  belongingsSchema,
  updateBelongingsSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { generateDischargeSummaryHTML } from "../services/pdf";
import { generateDischargeSummaryPDFBuffer } from "../services/pdf-generator";

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

      // Issue #37 — data-integrity guard: one ACTIVE admission per patient.
      // Before touching the bed, reject with 409 if this patient already has
      // an ADMITTED admission anywhere in the hospital. This is the
      // service-layer half of the fix; a partial unique DB index is the
      // schema-layer half (see services/.prisma-models-admission-unique.md).
      const existingActive = await prisma.admission.findFirst({
        where: { patientId, status: "ADMITTED" },
        select: { id: true, admissionNumber: true, bedId: true },
      });
      if (existingActive) {
        res.status(409).json({
          success: false,
          data: null,
          error:
            "Patient already has an active admission. Discharge or transfer the existing admission before creating a new one.",
          existingAdmission: {
            id: existingActive.id,
            admissionNumber: existingActive.admissionNumber,
            bedId: existingActive.bedId,
          },
        });
        return;
      }

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

      // Issue #421: defensive race-handling. The findFirst pre-check above
      // closes the common case but two concurrent admission POSTs for the
      // same patient can both pass it (TOCTOU window). The partial-unique
      // index `one_active_admission_per_patient` (migration
      // 20260424000001) is the authoritative DB-level guard, but Prisma
      // surfaces it as a generic P2002 that bubbles to the global error
      // handler as a 500. Catch it here and convert to a clean 409 so the
      // second concurrent caller gets the same already-admitted contract
      // as the synchronous pre-check path.
      let admission;
      try {
        admission = await prisma.$transaction(async (tx) => {
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
      } catch (e: unknown) {
        const code = (e as { code?: string } | null)?.code;
        if (code === "P2002") {
          // Partial unique index `one_active_admission_per_patient` fired —
          // a parallel request beat us to it.
          const existing = await prisma.admission.findFirst({
            where: { patientId, status: "ADMITTED" },
            select: { id: true, admissionNumber: true, bedId: true },
          });
          res.status(409).json({
            success: false,
            data: null,
            error:
              "Patient already has an active admission. Discharge or transfer the existing admission before creating a new one.",
            existingAdmission: existing
              ? {
                  id: existing.id,
                  admissionNumber: existing.admissionNumber,
                  bedId: existing.bedId,
                }
              : null,
          });
          return;
        }
        throw e;
      }

      auditLog(req, "PATIENT_ADMIT", "admission", admission.id, {
        admissionNumber,
        patientId,
        doctorId,
        bedId,
      }).catch(console.error);

      // Realtime: notify wards dashboard
      const io = req.app.get("io");
      if (io) {
        io.emit("admission:status", {
          admissionId: admission.id,
          status: "ADMITTED",
          ward: null,
          bedId,
        });
      }

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

      auditLog(req, "PATIENT_DISCHARGE", "admission", admission.id, {
        admissionNumber: admission.admissionNumber,
      }).catch(console.error);

      // Realtime: notify wards dashboard + admission listeners
      const io = req.app.get("io");
      if (io) {
        io.emit("admission:status", {
          admissionId: admission.id,
          status: "DISCHARGED",
          ward: admission.bed?.ward?.name ?? null,
          bedId: existing.bedId,
        });
      }

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

      auditLog(req, "BED_TRANSFER", "admission", admission.id, {
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

      auditLog(req, "IPD_VITALS_CREATE", "ipdVitals", vitals.id, { admissionId }).catch(console.error);
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

      auditLog(req, "INTAKE_OUTPUT_CREATE", "ipdIntakeOutput", io.id, {
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

// ═══════════════════════════════════════════════════════
// BED OCCUPANCY FORECAST
// ═══════════════════════════════════════════════════════

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// GET /api/v1/admissions/forecast?days=7
router.get(
  "/forecast",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = Math.max(1, Math.min(30, parseInt((req.query.days as string) || "7", 10)));
      const today = startOfDay(new Date());
      const horizon = addDays(today, days);

      const [totalBeds, activeAdmissions, scheduledSurgeries, admissionAppts] = await Promise.all([
        prisma.bed.count(),
        prisma.admission.findMany({
          where: { status: "ADMITTED" },
          select: { id: true, admittedAt: true, expectedLosDays: true },
        }),
        prisma.surgery.findMany({
          where: {
            scheduledAt: { gte: today, lt: horizon },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
          },
          select: { id: true, scheduledAt: true },
        }),
        prisma.appointment.findMany({
          where: {
            date: { gte: today, lt: horizon },
            notes: { contains: "admission", mode: "insensitive" },
          },
          select: { id: true, date: true },
        }),
      ]);

      const result: Array<{
        date: string;
        predictedOccupancy: number;
        totalBeds: number;
        occupancyPercent: number;
        incomingAdmissions: number;
        expectedDischarges: number;
      }> = [];

      for (let i = 0; i < days; i++) {
        const day = addDays(today, i);
        const nextDay = addDays(day, 1);

        // Current admitted still present = their admit date <= day AND expected discharge > day
        const stillAdmitted = activeAdmissions.filter((a) => {
          const admit = startOfDay(a.admittedAt);
          const los = a.expectedLosDays ?? 3;
          const expectedDC = addDays(admit, los);
          return admit <= day && expectedDC > day;
        }).length;

        const expectedDischarges = activeAdmissions.filter((a) => {
          const admit = startOfDay(a.admittedAt);
          const los = a.expectedLosDays ?? 3;
          const expectedDC = startOfDay(addDays(admit, los));
          return expectedDC.getTime() === day.getTime();
        }).length;

        const incomingFromSurgery = scheduledSurgeries.filter((s) => {
          const d = startOfDay(s.scheduledAt);
          return d.getTime() === day.getTime();
        }).length;

        const incomingFromAppt = admissionAppts.filter((a) => {
          const d = startOfDay(a.date);
          return d.getTime() === day.getTime();
        }).length;

        const incomingAdmissions = incomingFromSurgery + incomingFromAppt;
        const predictedOccupancy = Math.max(0, stillAdmitted + incomingAdmissions);
        const occupancyPercent = totalBeds > 0 ? Math.round((predictedOccupancy / totalBeds) * 100) : 0;

        result.push({
          date: isoDate(day),
          predictedOccupancy,
          totalBeds,
          occupancyPercent,
          incomingAdmissions,
          expectedDischarges,
        });
      }

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// LOS PREDICTION
// ═══════════════════════════════════════════════════════

// GET /api/v1/admissions/:id/los-prediction
router.get(
  "/:id/los-prediction",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admission = await prisma.admission.findUnique({
        where: { id: req.params.id },
        include: {
          patient: { select: { dateOfBirth: true } },
          bed: { include: { ward: { select: { type: true } } } },
        },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      // Find similar historical cases (same ward type, similar keywords in diagnosis)
      const keywords = (admission.diagnosis || admission.reason || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4)
        .slice(0, 5);

      const historical = await prisma.admission.findMany({
        where: {
          status: "DISCHARGED",
          dischargedAt: { not: null },
          bed: { ward: { type: admission.bed.ward.type } },
          admissionType: admission.admissionType ?? undefined,
          id: { not: admission.id },
        },
        select: { admittedAt: true, dischargedAt: true, diagnosis: true, finalDiagnosis: true },
        take: 500,
        orderBy: { admittedAt: "desc" },
      });

      const matches = historical.filter((h) => {
        if (keywords.length === 0) return true;
        const txt = `${h.diagnosis || ""} ${h.finalDiagnosis || ""}`.toLowerCase();
        return keywords.some((k) => txt.includes(k));
      });

      const pool = matches.length >= 5 ? matches : historical;
      const losArr = pool
        .filter((h) => h.dischargedAt)
        .map((h) => {
          const ms = h.dischargedAt!.getTime() - h.admittedAt.getTime();
          return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
        })
        .sort((a, b) => a - b);

      let expectedDays = 3;
      let confidence: "low" | "medium" | "high" = "low";
      if (losArr.length > 0) {
        const median = losArr[Math.floor(losArr.length / 2)];
        expectedDays = Math.max(1, median);
        confidence = losArr.length >= 20 ? "high" : losArr.length >= 5 ? "medium" : "low";
      }

      res.json({
        success: true,
        data: {
          expectedDays,
          confidence,
          basedOn: "historical_median",
          similar_cases_count: pool.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ISOLATION STATUS
// ═══════════════════════════════════════════════════════

// GET /api/v1/admissions/isolation/active
router.get(
  "/isolation/active",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.admission.findMany({
        where: {
          status: "ADMITTED",
          isolationType: { not: null },
        },
        include: {
          patient: { include: { user: { select: { name: true } } } },
          bed: { include: { ward: true } },
        },
        orderBy: { isolationStartDate: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/admissions/:id/isolation
router.patch(
  "/:id/isolation",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(isolationStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        isolationType?: string | null;
        isolationReason?: string;
        isolationStartDate?: string;
        isolationEndDate?: string;
        clear?: boolean;
      };

      const data: Record<string, unknown> = {};
      if (body.clear) {
        data.isolationType = null;
        data.isolationReason = null;
        data.isolationStartDate = null;
        data.isolationEndDate = new Date();
      } else {
        if (body.isolationType !== undefined) data.isolationType = body.isolationType;
        if (body.isolationReason !== undefined) data.isolationReason = body.isolationReason;
        if (body.isolationStartDate) data.isolationStartDate = new Date(body.isolationStartDate);
        else if (body.isolationType && !body.isolationStartDate) data.isolationStartDate = new Date();
        if (body.isolationEndDate) data.isolationEndDate = new Date(body.isolationEndDate);
      }

      const updated = await prisma.admission.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "ISOLATION_UPDATE", "admission", updated.id, body).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// PATIENT BELONGINGS
// ═══════════════════════════════════════════════════════

// GET /api/v1/admissions/:id/belongings
router.get(
  "/:id/belongings",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await prisma.patientBelongings.findUnique({
        where: { admissionId: req.params.id },
      });
      res.json({ success: true, data: rec, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/admissions/:id/belongings
router.post(
  "/:id/belongings",
  authorize(Role.ADMIN, Role.NURSE, Role.RECEPTION),
  validate(belongingsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admissionId = req.params.id;
      const existing = await prisma.patientBelongings.findUnique({
        where: { admissionId },
      });
      const data = {
        items: req.body.items ?? [],
        notes: req.body.notes ?? null,
      };
      const rec = existing
        ? await prisma.patientBelongings.update({
            where: { admissionId },
            data,
          })
        : await prisma.patientBelongings.create({
            data: {
              admissionId,
              ...data,
              checkedInBy: req.user!.userId,
            },
          });
      auditLog(req, "BELONGINGS_UPSERT", "patient_belongings", rec.id, {
        admissionId,
      }).catch(console.error);
      res.status(existing ? 200 : 201).json({ success: true, data: rec, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/admissions/:id/belongings
router.patch(
  "/:id/belongings",
  authorize(Role.ADMIN, Role.NURSE, Role.RECEPTION),
  validate(updateBelongingsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admissionId = req.params.id;
      const data: Record<string, unknown> = {};
      if (req.body.items !== undefined) data.items = req.body.items;
      if (req.body.notes !== undefined) data.notes = req.body.notes;
      const rec = await prisma.patientBelongings.update({
        where: { admissionId },
        data,
      });
      auditLog(req, "BELONGINGS_UPDATE", "patient_belongings", rec.id, {
        admissionId,
      }).catch(console.error);
      res.json({ success: true, data: rec, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/admissions/:id/belongings/checkout — checkout all belongings
router.post(
  "/:id/belongings/checkout",
  authorize(Role.ADMIN, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admissionId = req.params.id;
      const existing = await prisma.patientBelongings.findUnique({
        where: { admissionId },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "No belongings record found" });
        return;
      }
      const items = Array.isArray(existing.items) ? (existing.items as any[]) : [];
      const now = new Date().toISOString();
      const updatedItems = items.map((it) => ({
        ...it,
        checkedIn: false,
        checkedOutAt: it.checkedOutAt || now,
      }));
      const rec = await prisma.patientBelongings.update({
        where: { admissionId },
        data: {
          items: updatedItems,
          checkedOutBy: req.user!.userId,
        },
      });
      auditLog(req, "BELONGINGS_CHECKOUT", "patient_belongings", rec.id, {
        admissionId,
      }).catch(console.error);
      res.json({ success: true, data: rec, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// DAILY CENSUS
// ═══════════════════════════════════════════════════════

// GET /api/v1/admissions/census/daily?date=YYYY-MM-DD
router.get(
  "/census/daily",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dateStr = (req.query.date as string) || isoDate(new Date());
      const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const [totalBeds, admittedAtStart, newAdmissions, discharges, allDischarged] = await Promise.all([
        prisma.bed.count(),
        prisma.admission.count({
          where: {
            admittedAt: { lt: dayStart },
            OR: [
              { dischargedAt: null },
              { dischargedAt: { gte: dayStart } },
            ],
          },
        }),
        prisma.admission.count({
          where: { admittedAt: { gte: dayStart, lt: dayEnd } },
        }),
        prisma.admission.findMany({
          where: { dischargedAt: { gte: dayStart, lt: dayEnd } },
          select: { conditionAtDischarge: true },
        }),
        prisma.admission.count({
          where: { dischargedAt: { gte: dayStart, lt: dayEnd } },
        }),
      ]);

      const deaths = discharges.filter((d) => d.conditionAtDischarge === "DECEASED").length;
      const admittedAtEndOfDay = admittedAtStart + newAdmissions - allDischarged;
      const occupancyPercent = totalBeds > 0
        ? Math.round((admittedAtEndOfDay / totalBeds) * 100)
        : 0;

      res.json({
        success: true,
        data: {
          date: dateStr,
          totalBeds,
          admittedAtStartOfDay: admittedAtStart,
          newAdmissions,
          discharges: allDischarged,
          deaths,
          transfers_in: 0,
          transfers_out: 0,
          admittedAtEndOfDay,
          occupancyPercent,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/census/range?from=&to=
router.get(
  "/census/range",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = (req.query.from as string) || isoDate(addDays(new Date(), -7));
      const to = (req.query.to as string) || isoDate(new Date());
      const fromD = new Date(`${from}T00:00:00.000Z`);
      const toD = new Date(`${to}T00:00:00.000Z`);
      const totalBeds = await prisma.bed.count();
      const results: any[] = [];

      for (let d = new Date(fromD); d <= toD; d.setUTCDate(d.getUTCDate() + 1)) {
        const dayStart = new Date(d);
        const dayEnd = new Date(dayStart);
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        const [admittedAtStart, newAdmissions, dischargesRec] = await Promise.all([
          prisma.admission.count({
            where: {
              admittedAt: { lt: dayStart },
              OR: [
                { dischargedAt: null },
                { dischargedAt: { gte: dayStart } },
              ],
            },
          }),
          prisma.admission.count({
            where: { admittedAt: { gte: dayStart, lt: dayEnd } },
          }),
          prisma.admission.findMany({
            where: { dischargedAt: { gte: dayStart, lt: dayEnd } },
            select: { conditionAtDischarge: true },
          }),
        ]);
        const deaths = dischargesRec.filter((x) => x.conditionAtDischarge === "DECEASED").length;
        const admittedAtEnd = admittedAtStart + newAdmissions - dischargesRec.length;
        results.push({
          date: isoDate(dayStart),
          totalBeds,
          admittedAtStartOfDay: admittedAtStart,
          newAdmissions,
          discharges: dischargesRec.length,
          deaths,
          admittedAtEndOfDay: admittedAtEnd,
          occupancyPercent: totalBeds > 0 ? Math.round((admittedAtEnd / totalBeds) * 100) : 0,
        });
      }

      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/admissions/:id/discharge-summary-pdf
router.get(
  "/:id/discharge-summary-pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `?format=pdf` -> real PDF, default -> legacy HTML print view.
      if (req.query.format === "pdf") {
        const buffer = await generateDischargeSummaryPDFBuffer(req.params.id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=discharge-summary-${req.params.id}.pdf`
        );
        res.setHeader("Content-Length", String(buffer.length));
        res.end(buffer);
        return;
      }
      const html = await generateDischargeSummaryHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Admission not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as admissionRouter };
