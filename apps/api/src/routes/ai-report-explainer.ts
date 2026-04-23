import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { explainLabReport } from "../services/ai/report-explainer";
import { sendNotification } from "../services/notification";
import { NotificationType } from "@medcore/shared";

const router = Router();

// POST /api/v1/ai/reports/explain
router.post(
  "/explain",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labOrderId, language = "en" } = req.body as {
        labOrderId: string;
        language?: "en" | "hi";
      };

      if (!labOrderId) {
        res.status(400).json({ success: false, data: null, error: "labOrderId is required" });
        return;
      }

      // 1. Fetch LabOrder with items.results and patient info
      const labOrder = await prisma.labOrder.findUnique({
        where: { id: labOrderId },
        include: {
          items: {
            include: {
              results: true,
            },
          },
          patient: {
            select: {
              id: true,
              userId: true,
              age: true,
              gender: true,
            },
          },
        },
      });

      if (!labOrder) {
        res.status(404).json({ success: false, data: null, error: "Lab order not found" });
        return;
      }

      // 2. Flatten results from all order items
      const labResults = labOrder.items.flatMap((item) =>
        item.results.map((r) => ({
          parameter: r.parameter,
          value: r.value,
          unit: r.unit ?? undefined,
          normalRange: r.normalRange ?? undefined,
          flag: r.flag as string,
        }))
      );

      if (labResults.length === 0) {
        res.status(400).json({ success: false, data: null, error: "No lab results found for this order" });
        return;
      }

      // 3. Call AI explainer
      const { explanation, flaggedValues } = await explainLabReport({
        labResults,
        patientAge: labOrder.patient.age ?? undefined,
        patientGender: labOrder.patient.gender as string | undefined,
        language,
      });

      // 4. Upsert LabReportExplanation keyed on labOrderId
      const record = await prisma.labReportExplanation.upsert({
        where: { labOrderId },
        create: {
          labOrderId,
          patientId: labOrder.patient.id,
          explanation,
          flaggedValues: flaggedValues as any,
          language,
          status: "PENDING_REVIEW",
        },
        update: {
          explanation,
          flaggedValues: flaggedValues as any,
          language,
          status: "PENDING_REVIEW",
          approvedBy: null,
          approvedAt: null,
          sentAt: null,
        },
      });

      // 5. Return the explanation + status
      res.status(201).json({
        success: true,
        data: {
          id: record.id,
          labOrderId: record.labOrderId,
          explanation: record.explanation,
          flaggedValues: record.flaggedValues,
          language: record.language,
          status: record.status,
          createdAt: record.createdAt,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/ai/reports/:explanationId/approve
router.patch(
  "/:explanationId/approve",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { explanationId } = req.params;

      // 1. Update to APPROVED
      const approved = await prisma.labReportExplanation.update({
        where: { id: explanationId },
        data: {
          status: "APPROVED",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
        },
      });

      // 2. Fetch patient userId for notification
      const patient = await prisma.patient.findUnique({
        where: { id: approved.patientId },
        select: { userId: true },
      });

      if (patient?.userId) {
        // 3. Send notification to patient
        await sendNotification({
          userId: patient.userId,
          type: NotificationType.APPOINTMENT_REMINDER, // closest available type as fallback
          title: "Your Lab Report Explanation is Ready",
          message:
            approved.explanation.slice(0, 200) +
            (approved.explanation.length > 200 ? "..." : ""),
          data: { labOrderId: approved.labOrderId },
        });
      }

      // 4. Update to SENT
      const sent = await prisma.labReportExplanation.update({
        where: { id: explanationId },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      res.json({
        success: true,
        data: sent,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/reports/pending
router.get(
  "/pending",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await prisma.labReportExplanation.findMany({
        where: { status: "PENDING_REVIEW" },
        orderBy: { createdAt: "desc" },
      });

      res.json({
        success: true,
        data: pending,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/reports/:labOrderId
router.get(
  "/:labOrderId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labOrderId } = req.params;

      const explanation = await prisma.labReportExplanation.findUnique({
        where: { labOrderId },
      });

      if (!explanation) {
        res.status(404).json({ success: false, data: null, error: "Explanation not found for this lab order" });
        return;
      }

      // Authorization: patient can only view their own, doctors/admins can view any
      if (req.user?.role === Role.PATIENT) {
        const patient = await prisma.patient.findFirst({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        if (!patient || patient.id !== explanation.patientId) {
          res.status(403).json({ success: false, data: null, error: "Forbidden" });
          return;
        }
      }

      res.json({
        success: true,
        data: explanation,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiReportExplainerRouter };
