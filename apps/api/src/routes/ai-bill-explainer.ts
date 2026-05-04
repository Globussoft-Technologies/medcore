import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read. We alias it to
// `prisma` so call sites don't need to change.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, NotificationType } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { generateBillExplanation } from "../services/ai/bill-explainer";
import { sendNotification } from "../services/notification";

function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

const router = Router();
router.use(authenticate);

// ── POST /api/v1/ai/bill-explainer/:invoiceId/generate ────────────────────────
// Generates (or regenerates) a DRAFT BillExplanation for an invoice. Reception,
// admin and the owning patient can trigger generation; only admin/reception can
// approve + send.

router.post(
  "/:invoiceId/generate",
  validateUuidParams(["invoiceId"]),
  authorize(Role.PATIENT, Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { patient: { select: { id: true, userId: true } } },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      // #511 audit: VERIFIED-SAFE via assertPatientOwnsResource — ensures the
      // PATIENT caller's own Patient row matches the invoice's patientId.
      // Refactored from an inline `invoice.patient?.userId !== req.user.userId`
      // check for drift prevention (see medcore-bola-sweep skill section 3).
      if (!(await assertPatientOwnsResource(req, res, invoice.patientId))) return;

      const { content, flaggedItems, language } = await generateBillExplanation(
        invoiceId
      );

      // Upsert keyed on invoiceId — regenerating re-drafts and resets approval.
      const record = await prisma.billExplanation.upsert({
        where: { invoiceId },
        create: {
          invoiceId,
          patientId: invoice.patientId,
          content,
          flaggedItems: flaggedItems as any,
          language,
          status: "DRAFT",
        },
        update: {
          content,
          flaggedItems: flaggedItems as any,
          language,
          status: "DRAFT",
          approvedBy: null,
          approvedAt: null,
          sentAt: null,
        },
      });

      await auditLog(req, "AI_BILL_EXPLANATION_GENERATE", "BillExplanation", record.id, {
        invoiceId,
        language,
        flaggedCount: flaggedItems.length,
      });

      res.status(201).json({
        success: true,
        data: record,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/v1/ai/bill-explainer/:id/approve ────────────────────────────────
// Flips DRAFT -> APPROVED and dispatches notification to the patient.

router.post(
  "/:id/approve",
  validateUuidParams(["id"]),
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const existing = await prisma.billExplanation.findUnique({
        where: { id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Explanation not found" });
        return;
      }
      if (existing.status === "SENT") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Explanation has already been sent",
        });
        return;
      }

      const approved = await prisma.billExplanation.update({
        where: { id },
        data: {
          status: "APPROVED",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
        },
      });

      // Fetch patient user for notification
      const patient = await prisma.patient.findUnique({
        where: { id: approved.patientId },
        select: { userId: true },
      });

      if (patient?.userId) {
        try {
          await sendNotification({
            userId: patient.userId,
            type: NotificationType.BILL_GENERATED,
            title: "Your Bill Explanation is Ready",
            message:
              approved.content.slice(0, 240) +
              (approved.content.length > 240 ? "..." : ""),
            data: {
              billExplanationId: approved.id,
              invoiceId: approved.invoiceId,
            },
          });
        } catch (notifyErr) {
          console.error("[bill-explainer] notification failed:", notifyErr);
        }
      }

      const sent = await prisma.billExplanation.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      await auditLog(req, "AI_BILL_EXPLANATION_APPROVE", "BillExplanation", id, {
        invoiceId: approved.invoiceId,
      });

      res.json({ success: true, data: sent, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/bill-explainer/pending ─────────────────────────────────────

router.get(
  "/pending",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await prisma.billExplanation.findMany({
        where: { status: "DRAFT" },
        orderBy: { createdAt: "desc" },
      });

      safeAudit(req, "AI_BILL_EXPLANATION_READ", "BillExplanation", undefined, {
        filter: "DRAFT",
        resultCount: pending.length,
      });

      res.json({ success: true, data: pending, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/bill-explainer/:id ─────────────────────────────────────────
// Owner patient OR admin/reception may read.

router.get(
  "/:id",
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const explanation = await prisma.billExplanation.findUnique({
        where: { id },
      });
      if (!explanation) {
        res.status(404).json({ success: false, data: null, error: "Explanation not found" });
        return;
      }

      // #511 audit: VERIFIED-SAFE via assertPatientOwnsResource — staff roles
      // (ADMIN/RECEPTION/DOCTOR) pass through, PATIENT must own the row.
      // Refactored from an inline patient-userId compare for drift prevention.
      if (!(await assertPatientOwnsResource(req, res, explanation.patientId))) return;

      safeAudit(req, "AI_BILL_EXPLANATION_READ", "BillExplanation", id, {
        status: explanation.status,
      });

      res.json({ success: true, data: explanation, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiBillExplainerRouter };
