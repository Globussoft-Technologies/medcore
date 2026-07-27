/**
 * Tenant-facing "My Subscription" — a hospital ADMIN sees ONLY their OWN
 * platform subscription + invoices (their plan, price, status, trial/period
 * dates, and their platform invoice history). This is the tenant-side mirror
 * of the super-admin cross-tenant /platform-billing surface, scoped hard to
 * `req.user.tenantId` so one tenant can never read another's billing.
 *
 * Read-only: plan changes / mark-paid / discounts stay operator-only on the
 * /platform-billing router.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { getPlanByKey } from "../services/plan-catalog";
import { createPaymentOrder, verifyPayment } from "../services/razorpay";
import { markInvoicePaid, ensureCurrentPeriodInvoiceForSubscription } from "../services/platform-invoice-generator";
import { generatePlatformInvoicePDFBuffer } from "../services/pdf-generator";
import { renewSubscriptionPeriodIfNeeded } from "../services/platform-subscription-state";

const router = Router();

router.use(authenticate);
// Tenant ADMINs only — their own billing is sensitive. (Other tenant roles
// don't get the sidebar entry; this is the server-side enforcement.)
router.use(authorize(Role.ADMIN));

async function synchronizeTenantBilling(tenantId: string, now: Date = new Date()): Promise<void> {
  const subscription = await prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: { id: true, status: true, currentPeriodEnd: true },
  });
  if (!subscription || subscription.status !== "active") return;

  if (subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    await renewSubscriptionPeriodIfNeeded(prisma, subscription.id, now);
  }
  await ensureCurrentPeriodInvoiceForSubscription(prisma, subscription.id, now);
}

// GET /api/v1/my-subscription — the caller's own subscription + resolved plan
// price/label. Returns `{ data: null }` for a tenant-less caller.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) {
      res.json({ success: true, data: null, error: null });
      return;
    }

    await synchronizeTenantBilling(tenantId);

    const [tenant, subscription] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, subdomain: true },
      }),
      prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          plan: true,
          status: true,
          trialEndsAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          customPriceMonthlyInPaise: true,
          cancelledAt: true,
          pastDueSince: true,
        },
      }),
    ]);

    // Resolve the plan's catalog price/label so the UI can show the tier name
    // and ₹/mo without the tenant ever touching the cross-tenant plan list.
    const plan = subscription
      ? await getPlanByKey(prisma, subscription.plan)
      : null;
    const effectivePriceInPaise = subscription
      ? subscription.customPriceMonthlyInPaise ??
        plan?.monthlyPriceInPaise ??
        null
      : null;

    res.json({
      success: true,
      data: {
        tenant,
        subscription,
        plan: plan
          ? { key: plan.key, name: plan.name, monthlyPriceInPaise: plan.monthlyPriceInPaise }
          : null,
        effectivePriceInPaise,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/my-subscription/invoices — the caller's own platform invoices.
// DRAFT invoices are internal-only, so the tenant sees ISSUED/PAID/VOID.
router.get(
  "/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId ?? null;
      if (!tenantId) {
        res.json({ success: true, data: { invoices: [] }, error: null });
        return;
      }

      await synchronizeTenantBilling(tenantId);

      const invoices = await prisma.platformInvoice.findMany({
        where: { tenantId, status: { not: "DRAFT" } },
        orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          invoiceNumber: true,
          periodStart: true,
          periodEnd: true,
          subtotalInPaise: true,
          cgstInPaise: true,
          sgstInPaise: true,
          igstInPaise: true,
          totalInPaise: true,
          status: true,
          issuedAt: true,
          paidAt: true,
          paymentReference: true,
        },
        take: 200,
      });

      res.json({ success: true, data: { invoices }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// Load an invoice and assert it belongs to the caller's tenant. Returns the
// invoice or null; a null means "not found OR not yours" → callers 404 so a
// tenant can't probe other tenants' invoice ids (BOLA-safe).
async function ownInvoiceOr404<T>(
  invoice: (T & { tenantId: string }) | null,
  callerTenantId: string | null,
): Promise<T | null> {
  if (!invoice || invoice.tenantId !== callerTenantId) return null;
  return invoice;
}

// GET /api/v1/my-subscription/invoices/:id — full invoice incl. line items +
// GST breakdown, for the printable bill. Scoped to the caller's tenant.
router.get(
  "/invoices/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId ?? null;
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          invoiceNumber: true,
          tenantId: true,
          periodStart: true,
          periodEnd: true,
          subtotalInPaise: true,
          cgstInPaise: true,
          sgstInPaise: true,
          igstInPaise: true,
          totalInPaise: true,
          status: true,
          issuedAt: true,
          paidAt: true,
          paymentReference: true,
          hsnSacCode: true,
          createdAt: true,
          tenant: { select: { name: true, subdomain: true } },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              description: true,
              unitPriceInPaise: true,
              quantity: true,
              amountInPaise: true,
              hsnSacCode: true,
              cgstRate: true,
              sgstRate: true,
              igstRate: true,
            },
          },
        },
      });
      const owned = await ownInvoiceOr404(invoice, tenantId);
      // DRAFT invoices are internal — never expose to the tenant.
      if (!owned || owned.status === "DRAFT") {
        res.status(404).json({
          success: false,
          data: null,
          error: "Invoice not found",
        });
        return;
      }
      res.json({ success: true, data: { invoice: owned }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/my-subscription/invoices/:id/pdf — one-click PDF download of the
// caller's own invoice (real application/pdf, attachment). Scoped to tenant.
router.get(
  "/invoices/:id/pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId ?? null;
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          invoiceNumber: true,
          tenantId: true,
          status: true,
          periodStart: true,
          periodEnd: true,
          issuedAt: true,
          paidAt: true,
          hsnSacCode: true,
          subtotalInPaise: true,
          cgstInPaise: true,
          sgstInPaise: true,
          igstInPaise: true,
          totalInPaise: true,
          tenant: { select: { name: true, subdomain: true } },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              description: true,
              quantity: true,
              unitPriceInPaise: true,
              amountInPaise: true,
            },
          },
        },
      });
      const owned = await ownInvoiceOr404(invoice, tenantId);
      if (!owned || owned.status === "DRAFT") {
        res.status(404).json({
          success: false,
          data: null,
          error: "Invoice not found",
        });
        return;
      }

      const pdf = await generatePlatformInvoicePDFBuffer(owned);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${owned.invoiceNumber}.pdf"`,
      );
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/my-subscription/invoices/:id/pay-online — start a Razorpay
// order for the caller's own ISSUED invoice. Returns the order + public key
// so the browser can open Razorpay checkout.
router.post(
  "/invoices/:id/pay-online",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId ?? null;
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalInPaise: true,
          tenantId: true,
        },
      });
      const owned = await ownInvoiceOr404(invoice, tenantId);
      if (!owned) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (owned.status !== "ISSUED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot pay a ${owned.status.toLowerCase()} invoice`,
        });
        return;
      }

      let order;
      try {
        // Platform subscription payments collect into the platform Razorpay
        // account (tenantId null), exactly like the operator pay-online path.
        order = await createPaymentOrder(owned.id, owned.totalInPaise / 100, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ success: false, data: null, error: message });
        return;
      }

      auditLog(
        req,
        "PLATFORM_INVOICE_TENANT_PAY_ONLINE_ORDER_CREATED",
        "platform_invoice",
        owned.id,
        {
          invoiceNumber: owned.invoiceNumber,
          tenantId: owned.tenantId,
          orderId: order.orderId,
          amount: order.amount,
        },
      ).catch(console.error);

      res.json({
        success: true,
        data: {
          orderId: order.orderId,
          amount: order.amount,
          currency: order.currency,
          keyId: order.keyId,
          invoiceNumber: owned.invoiceNumber,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1).max(200),
  razorpayPaymentId: z.string().min(1).max(200),
  razorpaySignature: z.string().min(1).max(400),
});

// POST /api/v1/my-subscription/invoices/:id/verify-payment — verify the
// Razorpay signature and mark the caller's own invoice paid.
router.post(
  "/invoices/:id/verify-payment",
  validate(verifyPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId ?? null;
      const body = req.body as z.infer<typeof verifyPaymentSchema>;

      // Ownership check BEFORE touching payment state.
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: { id: true, tenantId: true, status: true },
      });
      const owned = await ownInvoiceOr404(invoice, tenantId);
      if (!owned) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      const ok = await verifyPayment(
        body.razorpayOrderId,
        body.razorpayPaymentId,
        body.razorpaySignature,
        null,
      );
      if (!ok) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Payment signature verification failed",
        });
        return;
      }

      const result = await markInvoicePaid(
        prisma,
        owned.id,
        req.user!.userId,
        body.razorpayPaymentId,
      );

      res.json({
        success: true,
        data: { transition: result.status },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as mySubscriptionRouter };
