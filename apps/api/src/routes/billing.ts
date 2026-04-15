import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createInvoiceSchema,
  recordPaymentSchema,
  insuranceClaimSchema,
  updateClaimStatusSchema,
  refundSchema,
  addInvoiceItemSchema,
  applyDiscountSchema,
  bulkPaymentSchema,
  createCreditNoteSchema,
  createAdvancePaymentSchema,
  applyAdvanceSchema,
  consolidatedInvoiceSchema,
  sendReminderSchema,
  INVOICE_NUMBER_PREFIX,
  CREDIT_NOTE_PREFIX,
  ADVANCE_RECEIPT_PREFIX,
  DEFAULT_GST_PERCENT,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createPaymentOrder, verifyPayment } from "../services/razorpay";
import { onBillGenerated, onPaymentReceived } from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { splitGst } from "../services/ops-helpers";
import { generateInvoicePDF } from "../services/pdf";

const router = Router();
router.use(authenticate);

// POST /api/v1/billing/invoices — create invoice (with GST split, package discount, advance)
router.post(
  "/invoices",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(createInvoiceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        appointmentId,
        patientId,
        items,
        taxPercentage,
        discountAmount,
        applyPackageDiscount,
        applyAdvance,
        dueDate,
        notes,
      } = req.body;

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
      const gstPct = taxPercentage != null ? taxPercentage : 0;
      const { taxAmount, cgstAmount, sgstAmount } = splitGst(subtotal, gstPct);

      // Package discount — if patient has an active HealthPackage matching any
      // item description / category, apply 10% on matching items.
      let packageDiscount = 0;
      let appliedPackageId: string | null = null;
      if (applyPackageDiscount) {
        const activePurchase = await prisma.packagePurchase.findFirst({
          where: {
            patientId,
            expiresAt: { gt: new Date() },
            isFullyUsed: false,
          },
          include: { package: true },
          orderBy: { purchasedAt: "desc" },
        });
        if (activePurchase?.package?.services) {
          const covered = activePurchase.package.services
            .toLowerCase()
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const it of items as Array<{
            description: string;
            category: string;
            quantity: number;
            unitPrice: number;
          }>) {
            const hay = `${it.description} ${it.category}`.toLowerCase();
            if (covered.some((c) => c && hay.includes(c))) {
              packageDiscount += it.quantity * it.unitPrice * 0.1;
            }
          }
          appliedPackageId = activePurchase.id;
          packageDiscount = +packageDiscount.toFixed(2);
        }
      }

      // ─── Patient pricing-tier discount (Apr 2026) ────────
      const patientRec = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { pricingTier: true },
      });
      const tier = patientRec?.pricingTier || "STANDARD";
      let tierDiscount = 0;
      if (tier !== "STANDARD") {
        const tierCfg = await prisma.systemConfig.findUnique({
          where: { key: `tier_discount_${tier}` },
        });
        const pct = tierCfg ? parseFloat(tierCfg.value) : 0;
        if (pct > 0) {
          tierDiscount = +((subtotal * pct) / 100).toFixed(2);
        }
      }

      // Advance payment application
      let advanceApplied = 0;
      let advanceToConsume: Array<{ id: string; use: number }> = [];
      if (applyAdvance) {
        const advances = await prisma.advancePayment.findMany({
          where: { patientId, balance: { gt: 0 } },
          orderBy: { createdAt: "asc" },
        });
        const gross = subtotal + taxAmount - (discountAmount || 0) - packageDiscount;
        let remaining = Math.max(0, gross);
        for (const adv of advances) {
          if (remaining <= 0) break;
          const use = Math.min(adv.balance, remaining);
          advanceToConsume.push({ id: adv.id, use });
          advanceApplied += use;
          remaining -= use;
        }
        advanceApplied = +advanceApplied.toFixed(2);
      }

      const totalAmount =
        subtotal +
        taxAmount -
        (discountAmount || 0) -
        packageDiscount -
        tierDiscount -
        advanceApplied;

      const invoice = await prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            appointmentId,
            patientId,
            subtotal,
            taxAmount,
            cgstAmount,
            sgstAmount,
            discountAmount: (discountAmount || 0) + tierDiscount,
            packageDiscount,
            advanceApplied,
            totalAmount: Math.max(0, +totalAmount.toFixed(2)),
            dueDate: dueDate ? new Date(dueDate) : undefined,
            notes:
              tierDiscount > 0
                ? `${notes ? notes + "\n" : ""}[TIER ${tier}] auto-discount Rs.${tierDiscount.toFixed(
                    2
                  )}`
                : notes,
            paymentStatus: advanceApplied >= totalAmount && totalAmount >= 0 ? "PAID" : "PENDING",
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

        // Record advance consumption (as negative-balance adjustment)
        for (const a of advanceToConsume) {
          await tx.advancePayment.update({
            where: { id: a.id },
            data: { balance: { decrement: a.use } },
          });
          await tx.payment.create({
            data: {
              invoiceId: inv.id,
              amount: a.use,
              mode: "CASH", // placeholder — advance-backed
              transactionId: `ADVANCE:${a.id}`,
            },
          });
        }

        // Record package consumption
        if (appliedPackageId && packageDiscount > 0) {
          const pp = await tx.packagePurchase.findUnique({
            where: { id: appliedPackageId },
          });
          if (pp) {
            const existing = pp.servicesUsed
              ? (JSON.parse(pp.servicesUsed) as unknown[])
              : [];
            existing.push({
              invoiceId: inv.id,
              usedAt: new Date().toISOString(),
              discount: packageDiscount,
              services: items.map(
                (it: { description: string }) => it.description
              ),
            });
            await tx.packagePurchase.update({
              where: { id: appliedPackageId },
              data: { servicesUsed: JSON.stringify(existing) },
            });
          }
        }

        if (config) {
          await tx.systemConfig.update({
            where: { key: "next_invoice_number" },
            data: { value: String(invSeq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: "next_invoice_number", value: String(invSeq + 1) },
          });
        }

        return inv;
      });

      // Fire-and-forget notification
      onBillGenerated(invoice).catch(console.error);
      auditLog(req, "CREATE_INVOICE", "invoice", invoice.id, { invoiceNumber, patientId, totalAmount }).catch(console.error);

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
      auditLog(req, "RECORD_PAYMENT", "payment", result.id, { invoiceId, amount, mode }).catch(console.error);

      // Real-time event for billing dashboard + reception home
      const io = req.app.get("io");
      if (io) {
        io.emit("payment:received", {
          invoiceId,
          amount,
          mode,
          paymentId: result.id,
          patientId: invoice.patientId,
        });
      }

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

// ─── REFUNDS ──────────────────────────────────────────────
// Refunds stored as negative-amount Payment records with a transactionId
// prefixed "REFUND:<reason>" so we can distinguish them from normal payments.

const REFUND_PREFIX = "REFUND:";

// POST /api/v1/billing/refunds — issue a refund
router.post(
  "/refunds",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(refundSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId, amount, reason, mode } = req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      const totalPaid = invoice.payments.reduce((s, p) => s + p.amount, 0);
      if (amount > totalPaid) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Refund amount (${amount}) exceeds total paid (${totalPaid})`,
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const refund = await tx.payment.create({
          data: {
            invoiceId,
            amount: -Math.abs(amount),
            mode,
            transactionId: `${REFUND_PREFIX}${reason}`,
          },
        });

        const netPaid = totalPaid - amount;
        let newStatus: "PENDING" | "PARTIAL" | "PAID" | "REFUNDED";
        if (netPaid <= 0) {
          newStatus = netPaid === 0 && totalPaid > 0 ? "REFUNDED" : "PENDING";
        } else if (netPaid >= invoice.totalAmount) {
          newStatus = "PAID";
        } else {
          newStatus = "PARTIAL";
        }

        await tx.invoice.update({
          where: { id: invoiceId },
          data: { paymentStatus: newStatus },
        });

        return refund;
      });

      auditLog(req, "ISSUE_REFUND", "payment", result.id, {
        invoiceId,
        amount,
        reason,
        mode,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/reports/refunds — list refunds issued
router.get(
  "/reports/refunds",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query;
      const where: Record<string, unknown> = {
        amount: { lt: 0 },
      };
      if (from || to) {
        where.paidAt = {
          ...(from ? { gte: new Date(from as string) } : {}),
          ...(to ? { lte: new Date(to as string) } : {}),
        };
      }

      const refunds = await prisma.payment.findMany({
        where,
        include: {
          invoice: {
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
            },
          },
        },
        orderBy: { paidAt: "desc" },
      });

      const totalRefunded = refunds.reduce((s, r) => s + Math.abs(r.amount), 0);

      res.json({
        success: true,
        data: {
          refunds: refunds.map((r) => ({
            id: r.id,
            paidAt: r.paidAt,
            amount: Math.abs(r.amount),
            mode: r.mode,
            reason: r.transactionId?.startsWith(REFUND_PREFIX)
              ? r.transactionId.slice(REFUND_PREFIX.length)
              : "",
            invoice: {
              id: r.invoice.id,
              invoiceNumber: r.invoice.invoiceNumber,
              totalAmount: r.invoice.totalAmount,
              patient: r.invoice.patient,
            },
          })),
          totalRefunded,
          count: refunds.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── INVOICE ITEMS (add / remove on pending invoices) ────
// Recalculate subtotal/tax/total from current items.
// Preserves originally-applied tax % by deriving it from snapshot (taxAmount / subtotal).

// POST /api/v1/billing/invoices/:id/items
router.post(
  "/invoices/:id/items",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(addInvoiceItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: req.params.id },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (invoice.paymentStatus !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Line items can only be added to PENDING invoices",
        });
        return;
      }

      const { description, category, quantity, unitPrice } = req.body;

      const taxPercentage =
        invoice.subtotal > 0 ? (invoice.taxAmount / invoice.subtotal) * 100 : 0;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.invoiceItem.create({
          data: {
            invoiceId: invoice.id,
            description,
            category,
            quantity,
            unitPrice,
            amount: quantity * unitPrice,
          },
        });
        const current = await tx.invoice.findUnique({
          where: { id: invoice.id },
          include: { items: true },
        });
        if (!current) return null;
        const subtotal = current.items.reduce((s, i) => s + i.amount, 0);
        const taxAmount = (subtotal * taxPercentage) / 100;
        const totalAmount = subtotal + taxAmount - current.discountAmount;
        return tx.invoice.update({
          where: { id: invoice.id },
          data: { subtotal, taxAmount, totalAmount },
          include: { items: true, payments: true },
        });
      });

      auditLog(req, "ADD_INVOICE_ITEM", "invoice", invoice.id, {
        description,
        quantity,
        unitPrice,
      }).catch(console.error);

      res.status(201).json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/billing/invoices/:id/items/:itemId
router.delete(
  "/invoices/:id/items/:itemId",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, itemId } = req.params;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (invoice.paymentStatus !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Line items can only be removed from PENDING invoices",
        });
        return;
      }
      const exists = invoice.items.find((i) => i.id === itemId);
      if (!exists) {
        res.status(404).json({ success: false, data: null, error: "Item not found" });
        return;
      }
      if (invoice.items.length <= 1) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot remove the only line item from an invoice",
        });
        return;
      }

      const taxPercentage =
        invoice.subtotal > 0 ? (invoice.taxAmount / invoice.subtotal) * 100 : 0;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.invoiceItem.delete({ where: { id: itemId } });
        const current = await tx.invoice.findUnique({
          where: { id },
          include: { items: true },
        });
        if (!current) return null;
        const subtotal = current.items.reduce((s, i) => s + i.amount, 0);
        const taxAmount = (subtotal * taxPercentage) / 100;
        const totalAmount = subtotal + taxAmount - current.discountAmount;
        return tx.invoice.update({
          where: { id },
          data: { subtotal, taxAmount, totalAmount },
          include: { items: true, payments: true },
        });
      });

      auditLog(req, "REMOVE_INVOICE_ITEM", "invoice", id, { itemId }).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/invoices/:id/discount
router.post(
  "/invoices/:id/discount",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(applyDiscountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { percentage, flatAmount, reason } = req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id: req.params.id },
        include: { payments: true },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (invoice.paymentStatus === "PAID" || invoice.paymentStatus === "REFUNDED") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot apply discount to a paid or refunded invoice",
        });
        return;
      }

      const gross = invoice.subtotal + invoice.taxAmount;
      let discountAmount = 0;
      if (flatAmount !== undefined) {
        discountAmount = flatAmount;
      } else if (percentage !== undefined) {
        discountAmount = (gross * percentage) / 100;
      }
      if (discountAmount > gross) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Discount cannot exceed gross amount",
        });
        return;
      }

      // ─── Approval threshold check (Apr 2026) ─────────────
      const thresholdCfg = await prisma.systemConfig.findUnique({
        where: { key: "discount_auto_approve_threshold" },
      });
      const threshold = thresholdCfg ? parseFloat(thresholdCfg.value) : 10; // default 10%
      const effPct =
        percentage !== undefined
          ? percentage
          : gross > 0
            ? (discountAmount / gross) * 100
            : 0;

      const requiresApproval =
        req.user!.role !== Role.ADMIN && effPct > threshold;

      if (requiresApproval) {
        const approval = await prisma.discountApproval.create({
          data: {
            invoiceId: invoice.id,
            amount: discountAmount,
            percentage: percentage ?? null,
            reason,
            requestedBy: req.user!.userId,
          },
        });
        auditLog(req, "REQUEST_DISCOUNT_APPROVAL", "discount_approval", approval.id, {
          invoiceId: invoice.id,
          discountAmount,
          percentage,
        }).catch(console.error);
        res.status(202).json({
          success: true,
          data: { approval, pending: true },
          error: null,
        });
        return;
      }

      const newTotal = gross - discountAmount;
      const totalPaid = invoice.payments.reduce((s, p) => s + p.amount, 0);
      const newStatus =
        totalPaid >= newTotal && newTotal > 0
          ? "PAID"
          : totalPaid > 0
            ? "PARTIAL"
            : "PENDING";

      const discountNote = `[DISCOUNT ${new Date().toISOString()}] ${
        percentage !== undefined ? `${percentage}%` : `Rs.${flatAmount}`
      } — ${reason}`;

      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          discountAmount,
          totalAmount: newTotal,
          paymentStatus: newStatus,
          notes: invoice.notes
            ? `${invoice.notes}\n${discountNote}`
            : discountNote,
        },
        include: { items: true, payments: true },
      });

      auditLog(req, "APPLY_DISCOUNT", "invoice", invoice.id, {
        percentage,
        flatAmount,
        discountAmount,
        reason,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DISCOUNT APPROVAL WORKFLOW (Apr 2026) ────────────────
// GET /api/v1/billing/discount-approvals?status=PENDING
router.get(
  "/discount-approvals",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, invoiceId } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (invoiceId) where.invoiceId = invoiceId;
      const rows = await prisma.discountApproval.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              totalAmount: true,
              patient: {
                select: {
                  mrNumber: true,
                  user: { select: { name: true, phone: true } },
                },
              },
            },
          },
        },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/discount-approvals/:id/approve
router.post(
  "/discount-approvals/:id/approve",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const approval = await prisma.discountApproval.findUnique({
        where: { id: req.params.id },
        include: { invoice: { include: { payments: true } } },
      });
      if (!approval) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Approval not found" });
        return;
      }
      if (approval.status !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Approval already ${approval.status.toLowerCase()}`,
        });
        return;
      }

      const inv = approval.invoice;
      const gross = inv.subtotal + inv.taxAmount;
      const newTotal = Math.max(0, gross - approval.amount);
      const totalPaid = inv.payments.reduce((s, p) => s + p.amount, 0);
      const newStatus =
        totalPaid >= newTotal && newTotal > 0
          ? "PAID"
          : totalPaid > 0
            ? "PARTIAL"
            : "PENDING";
      const discountNote = `[DISCOUNT APPROVED ${new Date().toISOString()}] ${
        approval.percentage ? `${approval.percentage}%` : `Rs.${approval.amount}`
      } — ${approval.reason}`;

      await prisma.$transaction(async (tx) => {
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            discountAmount: approval.amount,
            totalAmount: newTotal,
            paymentStatus: newStatus,
            notes: inv.notes ? `${inv.notes}\n${discountNote}` : discountNote,
          },
        });
        await tx.discountApproval.update({
          where: { id: approval.id },
          data: {
            status: "APPROVED",
            approvedBy: req.user!.userId,
            approvedAt: new Date(),
          },
        });
      });

      auditLog(req, "APPROVE_DISCOUNT", "discount_approval", approval.id, {
        invoiceId: inv.id,
        amount: approval.amount,
      }).catch(console.error);

      res.json({ success: true, data: { approved: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/discount-approvals/:id/reject
router.post(
  "/discount-approvals/:id/reject",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rejectionReason } = req.body as { rejectionReason?: string };
      const updated = await prisma.discountApproval.update({
        where: { id: req.params.id },
        data: {
          status: "REJECTED",
          rejectionReason: rejectionReason ?? "Not approved",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
        },
      });
      auditLog(req, "REJECT_DISCOUNT", "discount_approval", updated.id, {
        rejectionReason,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── LATE-FEE AUTOMATION (Apr 2026) ───────────────────────
// POST /api/v1/billing/apply-late-fees — can be run on cron
router.post(
  "/apply-late-fees",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const graceCfg = await prisma.systemConfig.findUnique({
        where: { key: "late_fee_grace_days" },
      });
      const graceDays = graceCfg ? parseInt(graceCfg.value) : 30;
      const flatCfg = await prisma.systemConfig.findUnique({
        where: { key: "late_fee_amount" },
      });
      const pctCfg = await prisma.systemConfig.findUnique({
        where: { key: "late_fee_percent" },
      });
      const flat = flatCfg ? parseFloat(flatCfg.value) : 100;
      const pct = pctCfg ? parseFloat(pctCfg.value) : 0;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - graceDays);

      const candidates = await prisma.invoice.findMany({
        where: {
          paymentStatus: { in: ["PENDING", "PARTIAL"] },
          lateFeeAppliedAt: null,
          createdAt: { lt: cutoff },
        },
        include: { patient: { include: { user: true } } },
      });

      let applied = 0;
      for (const inv of candidates) {
        const lateFee = pct > 0 ? +((inv.totalAmount * pct) / 100).toFixed(2) : flat;
        await prisma.$transaction(async (tx) => {
          await tx.invoiceItem.create({
            data: {
              invoiceId: inv.id,
              description: `Late fee (${graceDays}+ days overdue)`,
              category: "LATE_FEE",
              quantity: 1,
              unitPrice: lateFee,
              amount: lateFee,
            },
          });
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              lateFeeAmount: lateFee,
              lateFeeAppliedAt: new Date(),
              totalAmount: inv.totalAmount + lateFee,
              subtotal: inv.subtotal + lateFee,
            },
          });
        });
        applied++;
      }

      auditLog(req, "APPLY_LATE_FEES", "invoice", undefined, {
        applied,
        graceDays,
      }).catch(console.error);

      res.json({
        success: true,
        data: { applied, totalScanned: candidates.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── BULK PAYMENTS ────────────────────────────────────────
// POST /api/v1/billing/payments/bulk — apply payments across multiple invoices
router.post(
  "/payments/bulk",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(bulkPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, payments } = req.body;

      // Validate all invoices belong to this patient
      const invoiceIds = payments.map(
        (p: { invoiceId: string }) => p.invoiceId
      );
      const invoices = await prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        include: { payments: true },
      });
      const mismatched = invoices.find((i) => i.patientId !== patientId);
      if (mismatched) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Invoice ${mismatched.invoiceNumber} does not belong to patient ${patientId}`,
        });
        return;
      }
      if (invoices.length !== invoiceIds.length) {
        res.status(400).json({
          success: false,
          data: null,
          error: "One or more invoices not found",
        });
        return;
      }

      const results = await prisma.$transaction(async (tx) => {
        const created = [];
        for (const p of payments as Array<{
          invoiceId: string;
          amount: number;
          mode: "CASH" | "CARD" | "UPI" | "ONLINE" | "INSURANCE";
          transactionId?: string;
        }>) {
          const inv = invoices.find((i) => i.id === p.invoiceId)!;
          const pay = await tx.payment.create({
            data: {
              invoiceId: p.invoiceId,
              amount: p.amount,
              mode: p.mode,
              transactionId: p.transactionId,
            },
          });
          const totalPaid =
            inv.payments.reduce((s, x) => s + x.amount, 0) + p.amount;
          const newStatus =
            totalPaid >= inv.totalAmount ? "PAID" : "PARTIAL";
          await tx.invoice.update({
            where: { id: p.invoiceId },
            data: { paymentStatus: newStatus },
          });
          created.push(pay);
        }
        return created;
      });

      auditLog(req, "BULK_PAYMENT", "patient", patientId, {
        count: results.length,
        total: results.reduce((s, r) => s + r.amount, 0),
      }).catch(console.error);

      res.status(201).json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── OUTSTANDING REPORTS ──────────────────────────────────

// GET /api/v1/billing/patients/:patientId/outstanding
router.get(
  "/patients/:patientId/outstanding",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      // Patient can only see their own
      if (req.user!.role === "PATIENT") {
        const me = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (!me || me.id !== patientId) {
          res.status(403).json({ success: false, data: null, error: "Forbidden" });
          return;
        }
      }

      const invoices = await prisma.invoice.findMany({
        where: {
          patientId,
          paymentStatus: { in: ["PENDING", "PARTIAL"] },
        },
        include: {
          items: true,
          payments: true,
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const enriched = invoices.map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
        const balance = Math.max(0, inv.totalAmount - paid);
        const daysOverdue = Math.floor(
          (Date.now() - new Date(inv.createdAt).getTime()) / 86400000
        );
        return { ...inv, totalPaid: paid, balance, daysOverdue };
      });

      const totalOutstanding = enriched.reduce((s, i) => s + i.balance, 0);

      res.json({
        success: true,
        data: {
          patientId,
          totalOutstanding,
          invoiceCount: enriched.length,
          invoices: enriched,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/reports/outstanding?from=&to=&minAmount=
router.get(
  "/reports/outstanding",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, minAmount } = req.query;
      const min = minAmount ? parseFloat(minAmount as string) : 0;

      const where: Record<string, unknown> = {
        paymentStatus: { in: ["PENDING", "PARTIAL"] },
      };
      if (from || to) {
        where.createdAt = {
          ...(from ? { gte: new Date(from as string) } : {}),
          ...(to ? { lte: new Date(to as string) } : {}),
        };
      }

      const invoices = await prisma.invoice.findMany({
        where,
        include: {
          payments: true,
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const rows = invoices
        .map((inv) => {
          const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
          const balance = Math.max(0, inv.totalAmount - paid);
          const daysOverdue = Math.floor(
            (Date.now() - new Date(inv.createdAt).getTime()) / 86400000
          );
          return {
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            patientId: inv.patientId,
            patient: inv.patient,
            totalAmount: inv.totalAmount,
            paid,
            balance,
            daysOverdue,
            paymentStatus: inv.paymentStatus,
            createdAt: inv.createdAt,
          };
        })
        .filter((r) => r.balance >= min);

      const totalOutstanding = rows.reduce((s, r) => s + r.balance, 0);

      res.json({
        success: true,
        data: {
          rows,
          totalOutstanding,
          count: rows.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/reports/revenue?from=&to=&groupBy=day|month&doctorId=
router.get(
  "/reports/revenue",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        from,
        to,
        groupBy = "day",
        doctorId,
      } = req.query as {
        from?: string;
        to?: string;
        groupBy?: "day" | "month";
        doctorId?: string;
      };

      const start = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
      const end = to ? new Date(to) : new Date();

      const payments = await prisma.payment.findMany({
        where: {
          paidAt: { gte: start, lte: end },
          ...(doctorId
            ? { invoice: { appointment: { doctorId } } }
            : {}),
        },
        include: {
          invoice: {
            include: {
              appointment: { select: { doctorId: true } },
            },
          },
        },
      });

      const buckets: Record<string, { inflow: number; refunds: number; net: number }> = {};
      for (const p of payments) {
        const d = new Date(p.paidAt);
        const key =
          groupBy === "month"
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
            : d.toISOString().slice(0, 10);
        if (!buckets[key]) buckets[key] = { inflow: 0, refunds: 0, net: 0 };
        if (p.amount >= 0) buckets[key].inflow += p.amount;
        else buckets[key].refunds += Math.abs(p.amount);
        buckets[key].net += p.amount;
      }

      const series = Object.entries(buckets)
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const totals = series.reduce(
        (acc, s) => ({
          inflow: acc.inflow + s.inflow,
          refunds: acc.refunds + s.refunds,
          net: acc.net + s.net,
        }),
        { inflow: 0, refunds: 0, net: 0 }
      );

      res.json({
        success: true,
        data: { series, totals, groupBy, from: start, to: end },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: CREDIT NOTES
// ═══════════════════════════════════════════════════════

async function nextCreditNoteNumber(): Promise<string> {
  const last = await prisma.creditNote.findFirst({
    orderBy: { noteNumber: "desc" },
    select: { noteNumber: true },
  });
  let n = 1;
  if (last?.noteNumber) {
    const m = last.noteNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${CREDIT_NOTE_PREFIX}${String(n).padStart(6, "0")}`;
}

// POST /api/v1/billing/credit-notes — issue a credit note against a PAID invoice
router.post(
  "/credit-notes",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createCreditNoteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId, amount, reason } = req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true, creditNotes: true },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      const alreadyCredited = invoice.creditNotes.reduce((s, c) => s + c.amount, 0);
      if (alreadyCredited + amount > invoice.totalAmount) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Total credit notes cannot exceed invoice total",
        });
        return;
      }

      const noteNumber = await nextCreditNoteNumber();
      const note = await prisma.creditNote.create({
        data: {
          noteNumber,
          invoiceId,
          amount,
          reason,
          issuedBy: req.user!.userId,
        },
      });

      auditLog(req, "ISSUE_CREDIT_NOTE", "credit_note", note.id, {
        noteNumber,
        invoiceId,
        amount,
      }).catch(console.error);

      res.status(201).json({ success: true, data: note, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/credit-notes — list
router.get(
  "/credit-notes",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId, from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (invoiceId) where.invoiceId = invoiceId;
      if (from || to) {
        where.createdAt = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }
      const notes = await prisma.creditNote.findMany({
        where,
        include: {
          invoice: {
            include: {
              patient: { include: { user: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      const total = notes.reduce((s, n) => s + n.amount, 0);
      res.json({ success: true, data: { notes, total, count: notes.length }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: ADVANCE PAYMENTS / DEPOSITS
// ═══════════════════════════════════════════════════════

async function nextAdvanceReceiptNumber(): Promise<string> {
  const last = await prisma.advancePayment.findFirst({
    orderBy: { receiptNumber: "desc" },
    select: { receiptNumber: true },
  });
  let n = 1;
  if (last?.receiptNumber) {
    const m = last.receiptNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${ADVANCE_RECEIPT_PREFIX}${String(n).padStart(6, "0")}`;
}

// POST /api/v1/billing/advances — patient prepays a deposit
router.post(
  "/advances",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createAdvancePaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, amount, mode, transactionId, notes } = req.body;
      const receiptNumber = await nextAdvanceReceiptNumber();
      const adv = await prisma.advancePayment.create({
        data: {
          receiptNumber,
          patientId,
          amount,
          balance: amount,
          mode,
          transactionId,
          notes,
          receivedBy: req.user!.userId,
        },
      });
      auditLog(req, "ADVANCE_RECEIVED", "advance_payment", adv.id, {
        receiptNumber,
        patientId,
        amount,
      }).catch(console.error);
      res.status(201).json({ success: true, data: adv, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/advances?patientId=
router.get(
  "/advances",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.query as Record<string, string | undefined>;

      // Patients can only see their own
      if (req.user!.role === "PATIENT") {
        const me = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (!me) {
          res.json({ success: true, data: [], error: null });
          return;
        }
        const mine = await prisma.advancePayment.findMany({
          where: { patientId: me.id },
          orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: mine, error: null });
        return;
      }

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      const advances = await prisma.advancePayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: advances, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/advances/apply — manually apply an advance to an invoice
router.post(
  "/advances/apply",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(applyAdvanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { advanceId, invoiceId, amount } = req.body;
      const adv = await prisma.advancePayment.findUnique({
        where: { id: advanceId },
      });
      if (!adv) {
        res.status(404).json({ success: false, data: null, error: "Advance not found" });
        return;
      }
      if (amount > adv.balance) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Amount exceeds available advance balance (${adv.balance})`,
        });
        return;
      }
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (inv.patientId !== adv.patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Advance belongs to a different patient",
        });
        return;
      }
      const result = await prisma.$transaction(async (tx) => {
        await tx.advancePayment.update({
          where: { id: advanceId },
          data: { balance: { decrement: amount } },
        });
        const pay = await tx.payment.create({
          data: {
            invoiceId,
            amount,
            mode: "CASH",
            transactionId: `ADVANCE:${advanceId}`,
          },
        });
        const totalPaid =
          inv.payments.reduce((s, p) => s + p.amount, 0) + amount;
        const newStatus =
          totalPaid >= inv.totalAmount ? "PAID" : "PARTIAL";
        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            paymentStatus: newStatus,
            advanceApplied: { increment: amount },
          },
        });
        return pay;
      });
      auditLog(req, "ADVANCE_APPLIED", "advance_payment", advanceId, {
        invoiceId,
        amount,
      }).catch(console.error);
      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: CONSOLIDATED IPD BILL (on discharge)
// ═══════════════════════════════════════════════════════
// Aggregates bed charges, medication costs, lab orders, and surgeries for an admission.

router.post(
  "/consolidated",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(consolidatedInvoiceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId, taxPercentage, discountAmount, applyAdvance, notes } = req.body;
      const admission = await prisma.admission.findUnique({
        where: { id: admissionId },
        include: {
          bed: true,
          patient: true,
        },
      });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      // Bed charges — (discharge or now) − admittedAt days × dailyRate
      const start = admission.admittedAt.getTime();
      const endTs = (admission.dischargedAt || new Date()).getTime();
      const days = Math.max(1, Math.ceil((endTs - start) / (86400000)));
      const bedAmount = days * admission.bed.dailyRate;

      // Medication cost — simplified: count MedicationAdministration with cost 10 rs each (placeholder)
      const adminCount = await prisma.medicationAdministration.count({
        where: { medicationOrder: { admissionId }, status: "ADMINISTERED" },
      });
      const medAmount = adminCount * 10;

      // Labs — sum of LabOrderItem test prices
      const labOrders = await prisma.labOrder.findMany({
        where: { admissionId },
        include: { items: { include: { test: true } } },
      });
      const labAmount = labOrders.reduce(
        (s, lo) => s + lo.items.reduce((x, it) => x + (it.test?.price || 0), 0),
        0
      );

      // Surgeries for this patient during this stay
      const surgeries = await prisma.surgery.findMany({
        where: {
          patientId: admission.patientId,
          scheduledAt: { gte: admission.admittedAt, lte: admission.dischargedAt || new Date() },
        },
      });
      const surgeryAmount = surgeries.reduce((s, sg) => s + (sg.cost || 0), 0);

      const lineItems = [
        {
          description: `Bed charges (${days} day${days > 1 ? "s" : ""}, ${admission.bed.bedNumber})`,
          category: "BED",
          quantity: days,
          unitPrice: admission.bed.dailyRate,
        },
        {
          description: `Medication administrations (${adminCount})`,
          category: "MEDICATION",
          quantity: adminCount || 1,
          unitPrice: adminCount > 0 ? 10 : medAmount,
        },
        ...labOrders.flatMap((lo) =>
          lo.items.map((it) => ({
            description: `Lab: ${it.test?.name || "Test"} (Order ${lo.orderNumber})`,
            category: "LAB",
            quantity: 1,
            unitPrice: it.test?.price || 0,
          }))
        ),
        ...surgeries.map((s) => ({
          description: `Surgery: ${s.procedure} (${s.caseNumber})`,
          category: "SURGERY",
          quantity: 1,
          unitPrice: s.cost || 0,
        })),
      ].filter((i) => i.unitPrice > 0 || i.quantity > 0);

      // Ensure at least one item
      const safeItems = lineItems.length > 0
        ? lineItems
        : [{ description: "IPD Admission", category: "BED", quantity: 1, unitPrice: bedAmount }];

      const subtotal = safeItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
      const { taxAmount, cgstAmount, sgstAmount } = splitGst(subtotal, taxPercentage);

      // Advance
      let advanceApplied = 0;
      const consume: Array<{ id: string; use: number }> = [];
      if (applyAdvance) {
        const advances = await prisma.advancePayment.findMany({
          where: { patientId: admission.patientId, balance: { gt: 0 } },
          orderBy: { createdAt: "asc" },
        });
        let remaining = Math.max(0, subtotal + taxAmount - (discountAmount || 0));
        for (const adv of advances) {
          if (remaining <= 0) break;
          const use = Math.min(adv.balance, remaining);
          consume.push({ id: adv.id, use });
          advanceApplied += use;
          remaining -= use;
        }
      }

      const totalAmount = Math.max(
        0,
        +(subtotal + taxAmount - (discountAmount || 0) - advanceApplied).toFixed(2)
      );

      // Create a synthetic "discharge" appointment reference if needed
      const appt = await prisma.appointment.findFirst({
        where: { patientId: admission.patientId },
        orderBy: { createdAt: "desc" },
      });
      if (!appt) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot create consolidated invoice without any patient appointment reference",
        });
        return;
      }

      // Generate invoice number
      const config = await prisma.systemConfig.findUnique({
        where: { key: "next_invoice_number" },
      });
      const invSeq = config ? parseInt(config.value) : 1;
      const invoiceNumber = `${INVOICE_NUMBER_PREFIX}${String(invSeq).padStart(6, "0")}`;

      // If an invoice already exists for this appointment, append items instead of failing
      const existing = await prisma.invoice.findUnique({
        where: { appointmentId: appt.id },
      });
      if (existing) {
        res.status(400).json({
          success: false,
          data: null,
          error:
            "An invoice already exists against the patient's latest appointment. Use add-item endpoints instead.",
        });
        return;
      }

      const invoice = await prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            appointmentId: appt.id,
            patientId: admission.patientId,
            subtotal: +subtotal.toFixed(2),
            taxAmount,
            cgstAmount,
            sgstAmount,
            discountAmount: discountAmount || 0,
            advanceApplied: +advanceApplied.toFixed(2),
            totalAmount,
            notes: notes ? `[IPD ${admission.admissionNumber}] ${notes}` : `[IPD ${admission.admissionNumber}]`,
            paymentStatus: totalAmount === 0 ? "PAID" : "PENDING",
            items: {
              create: safeItems.map((it) => ({
                description: it.description,
                category: it.category,
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                amount: it.quantity * it.unitPrice,
              })),
            },
          },
          include: { items: true },
        });
        for (const c of consume) {
          await tx.advancePayment.update({
            where: { id: c.id },
            data: { balance: { decrement: c.use } },
          });
          await tx.payment.create({
            data: {
              invoiceId: inv.id,
              amount: c.use,
              mode: "CASH",
              transactionId: `ADVANCE:${c.id}`,
            },
          });
        }
        if (config) {
          await tx.systemConfig.update({
            where: { key: "next_invoice_number" },
            data: { value: String(invSeq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: "next_invoice_number", value: String(invSeq + 1) },
          });
        }
        return inv;
      });

      auditLog(req, "IPD_CONSOLIDATED_INVOICE", "invoice", invoice.id, {
        admissionId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: invoice, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: PAYMENT REMINDERS
// ═══════════════════════════════════════════════════════

router.post(
  "/invoices/:id/reminder",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(sendReminderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: req.params.id },
        include: {
          payments: true,
          patient: { include: { user: true } },
        },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (invoice.paymentStatus === "PAID") {
        res.status(400).json({ success: false, data: null, error: "Invoice already paid" });
        return;
      }
      const paid = invoice.payments.reduce((s, p) => s + p.amount, 0);
      const balance = invoice.totalAmount - paid;
      const channel = (req.body.channel || "SMS") as "SMS" | "EMAIL" | "WHATSAPP";

      // Stub: create a Notification row; any real gateway would pick it up.
      await prisma.notification.create({
        data: {
          userId: invoice.patient.userId,
          type: "BILL_GENERATED",
          channel: channel === "WHATSAPP" ? "WHATSAPP" : channel === "EMAIL" ? "EMAIL" : "SMS",
          title: `Payment reminder for ${invoice.invoiceNumber}`,
          message: `Dear ${invoice.patient.user.name}, a balance of Rs.${balance.toFixed(
            2
          )} is due on invoice ${invoice.invoiceNumber}. Kindly settle it at the earliest.`,
          data: { invoiceId: invoice.id, balance },
          deliveryStatus: "QUEUED",
        },
      });

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { reminderSentAt: new Date() },
      });

      auditLog(req, "PAYMENT_REMINDER", "invoice", invoice.id, { channel }).catch(
        console.error
      );

      res.status(201).json({
        success: true,
        data: { invoiceId: invoice.id, channel, balance },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices/:id/tax-breakdown — GST (CGST + SGST) breakdown
router.get(
  "/invoices/:id/tax-breakdown",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!inv) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      // If legacy row didn't split, derive 50/50 on the fly.
      const cg = inv.cgstAmount > 0 || inv.sgstAmount > 0
        ? inv.cgstAmount
        : +(inv.taxAmount / 2).toFixed(2);
      const sg = inv.cgstAmount > 0 || inv.sgstAmount > 0
        ? inv.sgstAmount
        : +(inv.taxAmount - cg).toFixed(2);
      const effectivePct =
        inv.subtotal > 0 ? +((inv.taxAmount / inv.subtotal) * 100).toFixed(2) : 0;
      res.json({
        success: true,
        data: {
          invoiceId: inv.id,
          subtotal: inv.subtotal,
          taxAmount: inv.taxAmount,
          cgstAmount: cg,
          sgstAmount: sg,
          effectivePct,
          defaultGstPct: DEFAULT_GST_PERCENT,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices/:id/pdf
router.get(
  "/invoices/:id/pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generateInvoicePDF(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Invoice not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as billingRouter };
