import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  paymentPlanSchema,
  installmentPaymentSchema,
  PAYMENT_PLAN_PREFIX,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";

const router = Router();
router.use(authenticate);

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function nextDue(start: Date, frequency: string, i: number): Date {
  if (frequency === "WEEKLY") return addDays(start, i * 7);
  if (frequency === "BIWEEKLY") return addDays(start, i * 14);
  return addMonths(start, i);
}

// POST /api/v1/payment-plans — create a plan from an invoice
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(paymentPlanSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId, downPayment, installments, frequency, startDate } =
        req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!invoice) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Invoice not found",
        });
        return;
      }
      if (downPayment > invoice.totalAmount) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Down payment cannot exceed invoice total",
        });
        return;
      }

      // Generate plan number
      const cfgKey = "next_payment_plan_number";
      const cfg = await prisma.systemConfig.findUnique({
        where: { key: cfgKey },
      });
      const seq = cfg ? parseInt(cfg.value) : 1;
      const planNumber = `${PAYMENT_PLAN_PREFIX}${String(seq).padStart(6, "0")}`;

      // Issue #901: Invoice.totalAmount is Prisma.Decimal — coerce.
      const invTotalN = typeof (invoice.totalAmount as unknown) === "number"
        ? (invoice.totalAmount as unknown as number)
        : (invoice.totalAmount as unknown as { toNumber: () => number }).toNumber();
      const remainder = Math.max(0, invTotalN - downPayment);
      const installmentAmount = +(remainder / installments).toFixed(2);
      const start = new Date(startDate + "T00:00:00.000Z");

      const plan = await prisma.$transaction(async (tx) => {
        const p = await tx.paymentPlan.create({
          data: {
            planNumber,
            invoiceId,
            patientId: invoice.patientId,
            totalAmount: invTotalN,
            downPayment,
            installments,
            installmentAmount,
            frequency,
            startDate: start,
          },
        });

        const records = [];
        let allocated = 0;
        for (let i = 0; i < installments; i++) {
          // make sure last one balances any rounding
          const amt =
            i === installments - 1
              ? +(remainder - allocated).toFixed(2)
              : installmentAmount;
          allocated += amt;
          records.push({
            planId: p.id,
            dueDate: nextDue(start, frequency, i),
            amount: amt,
          });
        }
        await tx.paymentPlanInstallment.createMany({ data: records });

        if (cfg) {
          await tx.systemConfig.update({
            where: { key: cfgKey },
            data: { value: String(seq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: cfgKey, value: String(seq + 1) },
          });
        }

        // If a down payment was provided, record it as an invoice payment
        if (downPayment > 0) {
          await tx.payment.create({
            data: {
              invoiceId,
              amount: downPayment,
              mode: "CASH",
            },
          });
          const totalPaid =
            invoice.payments.reduce((s, x) => s + x.amount, 0) + downPayment;
          const status =
            totalPaid >= invoice.totalAmount ? "PAID" : "PARTIAL";
          await tx.invoice.update({
            where: { id: invoiceId },
            data: { paymentStatus: status },
          });
        }

        return p;
      });

      const full = await prisma.paymentPlan.findUnique({
        where: { id: plan.id },
        include: { installmentRecords: true },
      });

      auditLog(req, "PAYMENT_PLAN_CREATE", "payment_plan", plan.id, {
        planNumber,
        invoiceId,
        installments,
      }).catch(console.error);

      res.status(201).json({ success: true, data: full, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/payment-plans?patientId=&status=
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, status } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      // #511 audit: PATIENT callers are auto-scoped to their own patientId
      // regardless of any client-supplied ?patientId= filter — payment plans
      // carry financial PHI per patient. Staff roles see all rows (or filter
      // via the query param).
      if (req.user?.role === "PATIENT") {
        const self = await prisma.patient.findFirst({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        if (!self) {
          res.status(403).json({ success: false, data: null, error: "Forbidden" });
          return;
        }
        where.patientId = self.id;
      } else if (patientId) {
        where.patientId = patientId;
      }
      if (status) where.status = status;

      // Issue #728 — make the "Active" tab mutually exclusive with the
      // "Overdue" tab. A plan that has any past-due, still-pending
      // installment is considered Overdue, not Active. Without this
      // exclusion the same plan rendered in BOTH tabs (the dashboard
      // overdue list comes from /payment-plans/overdue, while this
      // endpoint with status=ACTIVE used to return the same plan).
      // The fix narrows the WHERE only when the caller explicitly
      // asked for the Active tab; status=COMPLETED / DEFAULTED /
      // CANCELLED stay untouched.
      if (status === "ACTIVE") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        where.installmentRecords = {
          none: {
            status: { in: ["PENDING", "OVERDUE"] },
            dueDate: { lt: today },
          },
        };
      }

      const plans = await prisma.paymentPlan.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          installmentRecords: true,
          invoice: { select: { id: true, invoiceNumber: true, totalAmount: true } },
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { name: true, phone: true } },
            },
          },
        },
      });

      // derive aggregate
      const shaped = plans.map((p) => {
        const paid = p.installmentRecords.filter((r) => r.status === "PAID").length;
        const nextDueRec = p.installmentRecords
          .filter((r) => r.status !== "PAID" && r.status !== "WAIVED")
          .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];
        return {
          ...p,
          paidCount: paid,
          nextDue: nextDueRec?.dueDate ?? null,
        };
      });

      res.json({ success: true, data: shaped, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/payment-plans/overdue
router.get(
  "/overdue",
  // #511 audit: STAFF-ONLY — exposes overdue installments across ALL
  // patients (financial PHI). Not a patient-facing surface.
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const overdue = await prisma.paymentPlanInstallment.findMany({
        where: {
          status: { in: ["PENDING", "OVERDUE"] },
          dueDate: { lt: today },
        },
        orderBy: { dueDate: "asc" },
        include: {
          plan: {
            include: {
              patient: {
                select: {
                  id: true,
                  mrNumber: true,
                  user: { select: { name: true, phone: true } },
                },
              },
              invoice: { select: { id: true, invoiceNumber: true } },
            },
          },
        },
      });

      res.json({ success: true, data: overdue, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/payment-plans/due-reminders — cron stub
router.post(
  "/due-reminders",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + 3);

      const due = await prisma.paymentPlanInstallment.findMany({
        where: {
          status: "PENDING",
          dueDate: { gte: today, lte: horizon },
          reminderSentAt: null,
        },
        include: {
          plan: {
            include: {
              patient: { include: { user: true } },
              invoice: { select: { invoiceNumber: true } },
            },
          },
        },
      });

      // Mark as reminded (stub: real email would be sent here)
      await prisma.paymentPlanInstallment.updateMany({
        where: { id: { in: due.map((d) => d.id) } },
        data: { reminderSentAt: new Date() },
      });

      auditLog(req, "PAYMENT_PLAN_REMINDERS_SENT", "payment_plan", undefined, {
        count: due.length,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          count: due.length,
          reminders: due.map((d) => ({
            installmentId: d.id,
            patientName: d.plan.patient.user.name,
            phone: d.plan.patient.user.phone,
            invoiceNumber: d.plan.invoice.invoiceNumber,
            amount: d.amount,
            dueDate: d.dueDate,
          })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/payment-plans/:id — detail
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await prisma.paymentPlan.findUnique({
        where: { id: req.params.id },
        include: {
          installmentRecords: { orderBy: { dueDate: "asc" } },
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              totalAmount: true,
              paymentStatus: true,
            },
          },
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { name: true, phone: true, email: true } },
            },
          },
        },
      });
      if (!plan) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Payment plan not found",
        });
        return;
      }
      // #511 audit: PATCHED — payment plans carry financial PHI per patient.
      // Without this, any PATIENT-A could fetch any PATIENT-B's plan by id.
      if (!(await assertPatientOwnsResource(req, res, plan.patientId))) return;
      res.json({ success: true, data: plan, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/payment-plans/:id/pay-installment
router.patch(
  "/:id/pay-installment",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(installmentPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { installmentId, amount, mode, transactionId } = req.body;
      const plan = await prisma.paymentPlan.findUnique({
        where: { id: req.params.id },
        include: { installmentRecords: true, invoice: true },
      });
      if (!plan) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Plan not found" });
        return;
      }
      const inst = plan.installmentRecords.find((r) => r.id === installmentId);
      if (!inst) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Installment not found",
        });
        return;
      }
      if (inst.status === "PAID") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Installment already paid",
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            invoiceId: plan.invoiceId,
            amount,
            mode,
            transactionId: transactionId ?? null,
          },
        });

        await tx.paymentPlanInstallment.update({
          where: { id: installmentId },
          data: {
            status: "PAID",
            paidAt: new Date(),
            paymentId: payment.id,
          },
        });

        // Update invoice status
        const payments = await tx.payment.findMany({
          where: { invoiceId: plan.invoiceId },
        });
        const paid = payments.reduce((s, p) => s + p.amount, 0);
        // Issue #901: Invoice.totalAmount is Prisma.Decimal — coerce.
        const planInvTotal = typeof (plan.invoice.totalAmount as unknown) === "number"
          ? (plan.invoice.totalAmount as unknown as number)
          : (plan.invoice.totalAmount as unknown as { toNumber: () => number }).toNumber();
        const newStatus =
          paid >= planInvTotal
            ? "PAID"
            : paid > 0
              ? "PARTIAL"
              : "PENDING";
        await tx.invoice.update({
          where: { id: plan.invoiceId },
          data: { paymentStatus: newStatus },
        });

        // Mark plan COMPLETED if all installments paid or waived
        const allDone = plan.installmentRecords.every(
          (r) => r.id === installmentId || r.status === "PAID" || r.status === "WAIVED"
        );
        if (allDone) {
          await tx.paymentPlan.update({
            where: { id: plan.id },
            data: { status: "COMPLETED" },
          });
        }

        return payment;
      });

      auditLog(req, "INSTALLMENT_PAY", "payment_plan_installment", installmentId, {
        planId: plan.id,
        amount,
        mode,
      }).catch(console.error);

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/payment-plans/:id/cancel
router.patch(
  "/:id/cancel",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await prisma.paymentPlan.update({
        where: { id: req.params.id },
        data: { status: "CANCELLED" },
      });
      auditLog(req, "PAYMENT_PLAN_CANCEL", "payment_plan", plan.id).catch(
        console.error
      );
      res.json({ success: true, data: plan, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as paymentPlansRouter };
