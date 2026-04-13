import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createInvoiceSchema,
  recordPaymentSchema,
  insuranceClaimSchema,
  updateClaimStatusSchema,
  INVOICE_NUMBER_PREFIX,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createPaymentOrder, verifyPayment } from "../services/razorpay";
import { onBillGenerated, onPaymentReceived } from "../services/notification-triggers";

const router = Router();
router.use(authenticate);

// POST /api/v1/billing/invoices — create invoice
router.post(
  "/invoices",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(createInvoiceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId, patientId, items, taxPercentage, discountAmount, notes } = req.body;

      // Generate invoice number
      const config = await prisma.systemConfig.findUnique({
        where: { key: "next_invoice_number" },
      });
      const invSeq = config ? parseInt(config.value) : 1;
      const invoiceNumber = `${INVOICE_NUMBER_PREFIX}${String(invSeq).padStart(6, "0")}`;

      // Calculate totals
      const subtotal = items.reduce(
        (sum: number, item: { quantity: number; unitPrice: number }) =>
          sum + item.quantity * item.unitPrice,
        0
      );
      const taxAmount = (subtotal * (taxPercentage || 0)) / 100;
      const totalAmount = subtotal + taxAmount - (discountAmount || 0);

      const invoice = await prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            appointmentId,
            patientId,
            subtotal,
            taxAmount,
            discountAmount: discountAmount || 0,
            totalAmount,
            notes,
            items: {
              create: items.map(
                (item: {
                  description: string;
                  category: string;
                  quantity: number;
                  unitPrice: number;
                }) => ({
                  description: item.description,
                  category: item.category,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                  amount: item.quantity * item.unitPrice,
                })
              ),
            },
          },
          include: { items: true },
        });

        await tx.systemConfig.update({
          where: { key: "next_invoice_number" },
          data: { value: String(invSeq + 1) },
        });

        return inv;
      });

      // Fire-and-forget notification
      onBillGenerated(invoice).catch(console.error);

      res.status(201).json({ success: true, data: invoice, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices
router.get(
  "/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, status, page = "1", limit = "20" } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.paymentStatus = status;

      // Patients can only see their own invoices
      if (req.user!.role === "PATIENT") {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (patient) where.patientId = patient.id;
      }

      const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          include: {
            items: true,
            payments: true,
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.invoice.count({ where }),
      ]);

      res.json({
        success: true,
        data: invoices,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices/:id
router.get(
  "/invoices/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: req.params.id },
        include: {
          items: true,
          payments: true,
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
          appointment: {
            include: {
              doctor: { include: { user: { select: { name: true } } } },
            },
          },
          insuranceClaims: true,
        },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      res.json({ success: true, data: invoice, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/payments — record payment
router.post(
  "/payments",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(recordPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId, amount, mode, transactionId } = req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      const totalPaid =
        invoice.payments.reduce((sum, p) => sum + p.amount, 0) + amount;

      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: { invoiceId, amount, mode, transactionId },
        });

        // Update invoice payment status
        const newStatus =
          totalPaid >= invoice.totalAmount ? "PAID" : "PARTIAL";
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { paymentStatus: newStatus },
        });

        return payment;
      });

      // Fire-and-forget notification
      onPaymentReceived(result, invoice).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/claims — submit insurance claim
router.post(
  "/claims",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(insuranceClaimSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claim = await prisma.insuranceClaim.create({
        data: req.body,
      });

      res.status(201).json({ success: true, data: claim, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/billing/claims/:id — update claim status
router.patch(
  "/claims/:id",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(updateClaimStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claim = await prisma.insuranceClaim.update({
        where: { id: req.params.id },
        data: {
          status: req.body.status,
          approvedAmount: req.body.approvedAmount,
          resolvedAt:
            req.body.status === "SETTLED" || req.body.status === "REJECTED"
              ? new Date()
              : undefined,
        },
      });

      res.json({ success: true, data: claim, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/reports/daily — daily collection summary
router.get(
  "/reports/daily",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;
      const dateObj = date ? new Date(date as string) : new Date();
      const startOfDay = new Date(dateObj);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(dateObj);
      endOfDay.setHours(23, 59, 59, 999);

      const payments = await prisma.payment.findMany({
        where: {
          paidAt: { gte: startOfDay, lte: endOfDay },
        },
        include: {
          invoice: {
            include: {
              patient: {
                include: { user: { select: { name: true } } },
              },
            },
          },
        },
      });

      const totalCollection = payments.reduce((sum, p) => sum + p.amount, 0);
      const byMode = payments.reduce(
        (acc, p) => {
          acc[p.mode] = (acc[p.mode] || 0) + p.amount;
          return acc;
        },
        {} as Record<string, number>
      );

      const pendingInvoices = await prisma.invoice.count({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          paymentStatus: { in: ["PENDING", "PARTIAL"] },
        },
      });

      res.json({
        success: true,
        data: {
          date: dateObj.toISOString().split("T")[0],
          totalCollection,
          byMode,
          transactionCount: payments.length,
          pendingInvoices,
          payments,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/pay-online — create Razorpay order for an invoice
router.post(
  "/pay-online",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.body;

      if (!invoiceId) {
        res.status(400).json({ success: false, data: null, error: "invoiceId is required" });
        return;
      }

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      if (invoice.paymentStatus === "PAID") {
        res.status(400).json({ success: false, data: null, error: "Invoice is already paid" });
        return;
      }

      // Calculate remaining amount
      const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = invoice.totalAmount - totalPaid;

      if (remaining <= 0) {
        res.status(400).json({ success: false, data: null, error: "No balance due" });
        return;
      }

      const order = await createPaymentOrder(invoiceId, remaining);

      res.json({
        success: true,
        data: {
          orderId: order.orderId,
          amount: order.amount,
          currency: order.currency,
          keyId: order.keyId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/verify-payment — verify Razorpay payment and record it
router.post(
  "/verify-payment",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, invoiceId } =
        req.body;

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !invoiceId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "razorpayOrderId, razorpayPaymentId, razorpaySignature, and invoiceId are required",
        });
        return;
      }

      const isValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);

      if (!isValid) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Payment verification failed — invalid signature",
        });
        return;
      }

      // Record the payment
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = invoice.totalAmount - totalPaid;

      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            invoiceId,
            amount: remaining,
            mode: "ONLINE",
            transactionId: razorpayPaymentId,
          },
        });

        const newTotalPaid = totalPaid + remaining;
        const newStatus = newTotalPaid >= invoice.totalAmount ? "PAID" : "PARTIAL";

        await tx.invoice.update({
          where: { id: invoiceId },
          data: { paymentStatus: newStatus },
        });

        return payment;
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as billingRouter };
