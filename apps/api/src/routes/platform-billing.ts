/**
 * Operator-facing platform-billing API — Pearl ERP Stage 1 §8.3
 * (gap rows 215-218 closure piece 3-UI, 2026-05-25).
 *
 * What / which modules / why:
 *   - This is the read + mark-paid surface the super-admin / platform-
 *     billing-operator UI at /super-admin/platform-billing consumes.
 *     Piece 3a (commit 7f9f2a1) shipped the schema; piece 3b
 *     (`platform-invoice-generator.ts`) shipped the monthly cron +
 *     `markInvoicePaid` helper. This route ships the HTTP surface.
 *
 *   - Endpoints (all mounted at /api/v1/platform-billing):
 *       GET  /subscriptions     — cross-tenant TenantSubscription list with
 *                                 tenant name + plan + status + trial-end +
 *                                 current-period-end.
 *       GET  /invoices          — cross-tenant PlatformInvoice list, default
 *                                 filtered to status=ISSUED (the un-paid
 *                                 work queue). Supports ?status=PAID|all.
 *       GET  /invoices/:id      — single PlatformInvoice with line items +
 *                                 tenant info (for the detail page).
 *       POST /invoices/:id/mark-paid — operator marks invoice paid; calls
 *                                 platform-invoice-generator.markInvoicePaid
 *                                 which writes a PLATFORM_INVOICE_MARKED_PAID
 *                                 audit row. Body: { paymentReference }.
 *
 *   - RBAC: super-admin gate identical to routes/super-admin-users.ts
 *     (`requireSuperAdmin`: tenant-less caller OR ADMIN on the seeded
 *     "default" tenant) UNIONED with the new platform roles `PLATFORM_
 *     OPERATOR` and `PLATFORM_BILLING_OPERATOR` (from migration
 *     `20260524000003_add_platform_and_billing_roles`). Any non-platform
 *     tenant role (DOCTOR/NURSE/RECEPTION/PATIENT/...) gets 403 at the
 *     `authorize()` gate. Tenant-bound ADMINs hit `requireSuperAdmin`
 *     and get 403.
 *
 *   - Audit: GETs are read-only and do NOT write audit rows (otherwise
 *     a list-refresh would flood the trail). The POST mark-paid path
 *     defers audit emission to `markInvoicePaid()` in the generator
 *     service — single source of truth so a Razorpay webhook retry +
 *     an operator click both produce the same audit shape.
 *
 *   - Pearl §8.3 operator-only rule (`PEARL_OPEN_DECISIONS.md` #1): the
 *     "Mark Paid" action is gated on PLATFORM_OPERATOR + PLATFORM_
 *     BILLING_OPERATOR. The READ surfaces additionally accept the
 *     existing super-admin shape (tenant-less ADMIN) so existing Pearl
 *     ops who hold ADMIN+nullTenant can read the queue without a role
 *     migration. This mirrors the requireSuperAdmin pattern used by
 *     every other /api/v1/super-admin/* route in this codebase.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { markInvoicePaid } from "../services/platform-invoice-generator";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Allow PLATFORM_OPERATOR + PLATFORM_BILLING_OPERATOR through (Pearl
 * §8.3 operator-only rule) AND allow the legacy super-admin shape
 * (tenant-less ADMIN OR ADMIN on the seeded "default" tenant — mirrors
 * routes/super-admin-users.ts:requireSuperAdmin). Anything else 403s.
 */
async function requirePlatformOperatorOrSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, data: null, error: "Unauthorized" });
      return;
    }
    const role = req.user.role as Role;
    if (
      role === Role.PLATFORM_OPERATOR ||
      role === Role.PLATFORM_BILLING_OPERATOR
    ) {
      return next();
    }
    if (role !== Role.ADMIN) {
      res
        .status(403)
        .json({ success: false, data: null, error: "Forbidden" });
      return;
    }
    // Legacy super-admin shape: tenantId == null OR caller is ADMIN on
    // the seeded "default" tenant. Mirrors routes/super-admin-users.ts.
    const callerTenantId = req.user.tenantId ?? null;
    if (callerTenantId == null) {
      return next();
    }
    const callerTenant = await prisma.tenant.findUnique({
      where: { id: callerTenantId },
      select: { subdomain: true },
    });
    if (callerTenant?.subdomain === "default") {
      return next();
    }
    res.status(403).json({
      success: false,
      data: null,
      error: "Only platform operators can access platform billing",
    });
    return;
  } catch (err) {
    next(err);
  }
}

/**
 * Stricter gate for the mutating mark-paid endpoint. Only the new
 * platform roles may flip an invoice to PAID — the legacy super-admin
 * shape can READ the queue but not record payments (Pearl
 * `PEARL_OPEN_DECISIONS.md` #1: "ONLY PLATFORM_OPERATOR can mark
 * invoices paid"). PLATFORM_BILLING_OPERATOR is the dedicated billing
 * role; PLATFORM_OPERATOR is the super-set.
 */
function requirePlatformOperatorStrict(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    res
      .status(401)
      .json({ success: false, data: null, error: "Unauthorized" });
    return;
  }
  const role = req.user.role as Role;
  if (
    role === Role.PLATFORM_OPERATOR ||
    role === Role.PLATFORM_BILLING_OPERATOR
  ) {
    return next();
  }
  res.status(403).json({
    success: false,
    data: null,
    error:
      "Only PLATFORM_OPERATOR or PLATFORM_BILLING_OPERATOR can mark invoices paid",
  });
  return;
}

// ─── Schemas ─────────────────────────────────────────────────────────

const invoiceListQuerySchema = z.object({
  status: z
    .enum(["ISSUED", "PAID", "DRAFT", "VOID", "all"])
    .optional()
    .transform((v) => (v == null ? "ISSUED" : v)),
});

const markPaidBodySchema = z.object({
  paymentReference: z
    .string()
    .trim()
    .min(1, "paymentReference is required")
    .max(200, "paymentReference too long"),
});

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
router.use(requirePlatformOperatorOrSuperAdmin);

/**
 * GET /api/v1/platform-billing/subscriptions — list every
 * TenantSubscription with its tenant name/subdomain/active + plan +
 * status + trial-end + current-period-end. Newest-subscription-first.
 * No pagination (operator population is bounded by the number of
 * hospitals, which is small enough that a single fetch is acceptable
 * through Stage 1).
 */
router.get(
  "/subscriptions",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.tenantSubscription.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          tenantId: true,
          plan: true,
          status: true,
          trialEndsAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          customPriceMonthlyInPaise: true,
          razorpaySubscriptionId: true,
          pastDueSince: true,
          cancelledAt: true,
          createdAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              subdomain: true,
              active: true,
            },
          },
        },
        take: 500,
      });
      res.status(200).json({
        success: true,
        data: { subscriptions: rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/platform-billing/invoices?status=ISSUED|PAID|all
 * Default is `ISSUED` — the un-paid work queue the operator opens to.
 * Newest-issued-first so the most recent invoice is at the top.
 */
router.get(
  "/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = invoiceListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { status } = parsed.data;
      const where: Record<string, unknown> = {};
      if (status !== "all") where.status = status;

      const rows = await prisma.platformInvoice.findMany({
        where,
        orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
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
          createdAt: true,
          tenant: {
            select: { id: true, name: true, subdomain: true },
          },
        },
        take: 500,
      });
      res.status(200).json({
        success: true,
        data: { invoices: rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/platform-billing/invoices/:id — full invoice incl. line
 * items + tenant info, for the detail page (renders the printable
 * invoice + the Mark Paid modal).
 */
router.get(
  "/invoices/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          invoiceNumber: true,
          tenantId: true,
          subscriptionId: true,
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
          paidByUserId: true,
          paymentReference: true,
          hsnSacCode: true,
          createdAt: true,
          updatedAt: true,
          tenant: {
            select: { id: true, name: true, subdomain: true, active: true },
          },
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
      if (!invoice) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Platform invoice not found",
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: { invoice },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/v1/platform-billing/invoices/:id/mark-paid
 * Body: { paymentReference: string }
 * Stricter RBAC than the read surfaces — only PLATFORM_OPERATOR or
 * PLATFORM_BILLING_OPERATOR may mark paid. Delegates to
 * `markInvoicePaid()` in `services/platform-invoice-generator.ts` so
 * that webhook + UI paths share one transition path (and one audit
 * row shape).
 */
router.post(
  "/invoices/:id/mark-paid",
  requirePlatformOperatorStrict,
  validate(markPaidBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof markPaidBodySchema>;
      const callerUserId = req.user!.userId;
      let result;
      try {
        result = await markInvoicePaid(
          prisma,
          req.params.id,
          callerUserId,
          body.paymentReference,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found")) {
          res.status(404).json({
            success: false,
            data: null,
            error: "Platform invoice not found",
          });
          return;
        }
        throw err;
      }

      const updated = await prisma.platformInvoice.findUnique({
        where: { id: result.invoiceId },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          paidAt: true,
          paymentReference: true,
          paidByUserId: true,
          totalInPaise: true,
          tenantId: true,
        },
      });

      res.status(200).json({
        success: true,
        data: {
          transition: result.status, // "PAID" or "ALREADY_PAID"
          invoice: updated,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const platformBillingRouter = router;
