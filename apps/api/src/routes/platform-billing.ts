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
import { auditLog } from "../middleware/audit";
import { markInvoicePaid } from "../services/platform-invoice-generator";
import { sendSingleInvoiceReminder } from "../services/platform-invoice-mailer";
import { createPlatformPaymentLink } from "../services/razorpay";
import {
  applyProration,
  cancelSubscription,
  transitionToActive,
} from "../services/platform-subscription-state";
import {
  getPlanByKey,
  listPlans,
  isPlanColumnMigrationError,
  PLAN_MIGRATION_USER_MESSAGE,
} from "../services/plan-catalog";

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
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
    if (role === Role.SUPER_ADMIN) {
      return next();
    }
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
  // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full access
  // including the platform-billing mark-paid mutation. The original Pearl
  // open-decision (#1) carved this out for PLATFORM_OPERATOR only because
  // SUPER_ADMIN did not exist as a distinct role at the time; with the
  // dedicated role landed, SUPER_ADMIN is the true root and supersedes it.
  if (
    role === Role.SUPER_ADMIN ||
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

/**
 * Pearl §8.3 — the dynamic plan CATALOG (create / edit / delete tiers) is
 * managed ONLY by the main super admin, NOT by platform-billing operators.
 * The operators can read the catalog (for change-plan) and run the invoice
 * mutations, but the price/feature definitions of a tier are a higher-trust
 * action reserved for the super-admin shape: `Role.SUPER_ADMIN`, OR a
 * tenant-less `Role.ADMIN`, OR an `ADMIN` on the seeded "default" tenant
 * (mirrors routes/super-admin-users.ts:requireSuperAdmin).
 */
async function requireMainSuperAdmin(
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
    if (role === Role.SUPER_ADMIN) {
      return next();
    }
    if (role !== Role.ADMIN) {
      res.status(403).json({
        success: false,
        data: null,
        error: "Only the super admin can manage plans",
      });
      return;
    }
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
      error: "Only the super admin can manage plans",
    });
    return;
  } catch (err) {
    next(err);
  }
}

// ─── Error helpers ───────────────────────────────────────────────────

/**
 * Surface a clean, actionable message instead of leaking raw Prisma engine
 * internals to the operator UI. Specifically catches the dynamic-plans
 * migration mismatch — the `plan` column still typed as the old Prisma enum
 * while the regenerated client expects `String` (Prisma throws "Error
 * converting field `plan` … incompatible value of `GROWTH`"). Any other
 * error falls through to the global error handler unchanged.
 */
function handlePlanRouteError(
  res: Response,
  next: NextFunction,
  scope: string,
  err: unknown,
): void {
  if (isPlanColumnMigrationError(err)) {
    // Developer-facing hint stays in the server log; the operator sees a
    // clean, non-technical message.
    console.error(
      `[platform-billing] ${scope}: plan column not migrated — run \`npx prisma db push\` + reseed. Detail:`,
      err instanceof Error ? err.message : String(err),
    );
    res
      .status(503)
      .json({ success: false, data: null, error: PLAN_MIGRATION_USER_MESSAGE });
    return;
  }
  next(err);
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
      handlePlanRouteError(res, next, "subscriptions", err);
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
      handlePlanRouteError(res, next, "invoices", err);
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

// ─── Pearl §8.3 — generate a Razorpay payment link ─────────────────
//
// POST /api/v1/platform-billing/invoices/:id/payment-link
//
// Creates a Razorpay Payment Link for the invoice's outstanding amount
// using the platform operator's own merchant account (env-level
// RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Returns the short URL the
// operator opens in a new tab — the hospital sees a Razorpay-hosted
// payment page pre-filled with the invoice amount, and on success the
// platform webhook flips the invoice to PAID automatically (no
// operator follow-up needed).
//
// Refuses on already-PAID / VOID invoices (409). Non-production
// fallback returns a synthetic short URL so the UI flow can be
// exercised without Razorpay configured.
router.post(
  "/invoices/:id/payment-link",
  requirePlatformOperatorStrict,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalInPaise: true,
          tenantId: true,
          tenant: {
            select: { name: true, billingContactEmail: true },
          },
        },
      });
      if (!invoice) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Invoice not found",
        });
        return;
      }
      if (invoice.status !== "ISSUED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot create a payment link for a ${invoice.status} invoice`,
        });
        return;
      }

      let link;
      try {
        link = await createPlatformPaymentLink({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amountInPaise: invoice.totalInPaise,
          contactName: invoice.tenant?.name ?? "Tenant",
          contactEmail: invoice.tenant?.billingContactEmail ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({
          success: false,
          data: null,
          error: message,
        });
        return;
      }

      auditLog(
        req,
        "PLATFORM_INVOICE_PAYMENT_LINK_CREATED",
        "platform_invoice",
        invoice.id,
        {
          invoiceNumber: invoice.invoiceNumber,
          tenantId: invoice.tenantId,
          paymentLinkId: link.paymentLinkId,
          amountInPaise: link.amountInPaise,
        },
      ).catch(console.error);

      res.status(200).json({
        success: true,
        data: {
          paymentLinkId: link.paymentLinkId,
          shortUrl: link.shortUrl,
          amountInPaise: link.amountInPaise,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 — operator discount on a platform invoice ──────────
//
// POST /api/v1/platform-billing/invoices/:id/apply-discount
// Body: { amountInPaise: number, reason: string }
//
// Writes a negative-amount `PlatformInvoiceLineItem` (descriptive label
// includes the operator's reason), then recomputes the parent invoice's
// subtotal + GST split + total off the full line-item set. Same GST
// rate the original line items carry — operator can't bypass GST by
// using this surface. Refuses to land if the discount >= invoice total
// (operator should `mark-paid` in that case). Writes a
// PLATFORM_INVOICE_DISCOUNT_APPLIED audit row.
const applyDiscountSchema = z.object({
  amountInPaise: z.number().int().positive().max(10_000_000),
  reason: z.string().trim().min(3).max(200),
});

router.post(
  "/invoices/:id/apply-discount",
  requirePlatformOperatorStrict,
  validate(applyDiscountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof applyDiscountSchema>;
      const inv = await prisma.platformInvoice.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          invoiceNumber: true,
          tenantId: true,
          status: true,
          totalInPaise: true,
          hsnSacCode: true,
          lineItems: {
            select: { cgstRate: true, sgstRate: true, igstRate: true },
            take: 1,
          },
        },
      });
      if (!inv) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Invoice not found",
        });
        return;
      }
      if (inv.status !== "ISSUED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot apply a discount on a ${inv.status} invoice`,
        });
        return;
      }
      if (body.amountInPaise >= inv.totalInPaise) {
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Discount cannot equal or exceed the invoice total. Mark Paid instead.",
        });
        return;
      }

      const firstLine = inv.lineItems[0] ?? {
        cgstRate: 0,
        sgstRate: 0,
        igstRate: 0,
      };
      const discountPaise = -Math.abs(body.amountInPaise);

      // Create the negative line item.
      await prisma.platformInvoiceLineItem.create({
        data: {
          invoiceId: inv.id,
          description: `Discount — ${body.reason}`,
          unitPriceInPaise: discountPaise,
          quantity: 1,
          amountInPaise: discountPaise,
          hsnSacCode: inv.hsnSacCode,
          cgstRate: firstLine.cgstRate,
          sgstRate: firstLine.sgstRate,
          igstRate: firstLine.igstRate,
        },
      });

      // Recompute invoice subtotal + GST + total from ALL line items
      // (existing + new discount). Per-line GST rates are persisted so
      // we trust them as the source of truth.
      const lines = await prisma.platformInvoiceLineItem.findMany({
        where: { invoiceId: inv.id },
        select: {
          amountInPaise: true,
          cgstRate: true,
          sgstRate: true,
          igstRate: true,
        },
      });
      let subtotalInPaise = 0;
      let cgstInPaise = 0;
      let sgstInPaise = 0;
      let igstInPaise = 0;
      for (const li of lines) {
        subtotalInPaise += li.amountInPaise;
        cgstInPaise += Math.round((li.amountInPaise * li.cgstRate) / 100);
        sgstInPaise += Math.round((li.amountInPaise * li.sgstRate) / 100);
        igstInPaise += Math.round((li.amountInPaise * li.igstRate) / 100);
      }
      const totalInPaise =
        subtotalInPaise + cgstInPaise + sgstInPaise + igstInPaise;

      const updated = await prisma.platformInvoice.update({
        where: { id: inv.id },
        data: {
          subtotalInPaise,
          cgstInPaise,
          sgstInPaise,
          igstInPaise,
          totalInPaise,
        },
        select: {
          id: true,
          invoiceNumber: true,
          subtotalInPaise: true,
          cgstInPaise: true,
          sgstInPaise: true,
          igstInPaise: true,
          totalInPaise: true,
        },
      });

      await auditLog(
        req,
        "PLATFORM_INVOICE_DISCOUNT_APPLIED",
        "platform_invoice",
        inv.id,
        {
          invoiceNumber: inv.invoiceNumber,
          tenantId: inv.tenantId,
          discountInPaise: body.amountInPaise,
          reason: body.reason,
          newTotalInPaise: updated.totalInPaise,
        },
      );

      res.status(200).json({
        success: true,
        data: { invoice: updated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 piece 3f — operator-initiated reminder ───────────────
//
// POST /api/v1/platform-billing/invoices/:id/send-reminder
//
// Re-emails an ISSUED PlatformInvoice to the tenant's billingContactEmail.
// Unlike the daily mailer cron this is NOT idempotency-gated — operators
// can fire it multiple times deliberately (e.g. after a contact update).
// Writes a PLATFORM_INVOICE_REMINDER_SENT audit row carrying the
// operator's userId so the trail distinguishes manual reminders from the
// automated `PLATFORM_INVOICE_EMAILED` row written by the cron.
router.post(
  "/invoices/:id/send-reminder",
  requirePlatformOperatorStrict,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const callerUserId = req.user?.userId ?? null;
      const result = await sendSingleInvoiceReminder(
        prisma,
        req.params.id,
        callerUserId,
      );
      if (!result.sent) {
        const status =
          result.reason === "NOT_FOUND"
            ? 404
            : result.reason === "NO_CONTACT"
              ? 412 // billingContactEmail not configured
              : result.reason === "NOT_ISSUED"
                ? 409
                : 502; // SEND_FAILED
        const errorMessage =
          result.reason === "NOT_FOUND"
            ? "Invoice not found"
            : result.reason === "NO_CONTACT"
              ? "Tenant has no billing contact email configured"
              : result.reason === "NOT_ISSUED"
                ? "Only ISSUED invoices can be reminded — already paid or voided"
                : (result.error ?? "Email provider rejected the message");
        res.status(status).json({
          success: false,
          data: { sent: false, to: result.to },
          error: errorMessage,
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: { sent: true, to: result.to },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 piece 3d — change-plan with proration ────────────────
//
// POST /api/v1/platform-billing/subscriptions/:id/change-plan
// Body: { plan: <PlatformPlan.key> }
//
// Upgrades or downgrades a tenant's subscription mid-cycle:
//   1) calls `applyProration()` which writes a single-line `PlatformInvoice`
//      (negative line item if downgrade), preserving GST traceability;
//   2) updates `TenantSubscription.plan`;
//   3) writes a `PLATFORM_SUBSCRIPTION_PLAN_CHANGED` audit row.
//
// Same-plan no-op is allowed (returns deltaInPaise=0, no invoice). Strict
// RBAC (PLATFORM_OPERATOR / PLATFORM_BILLING_OPERATOR / SUPER_ADMIN) —
// matches the mark-paid mutation gate.
//
// Plans are dynamic (DB-backed `PlatformPlan`), so the schema only checks the
// key SHAPE; the handler verifies it resolves to an existing ACTIVE plan.
const changePlanBodySchema = z.object({
  plan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,40}$/, "Invalid plan key"),
});

router.post(
  "/subscriptions/:id/change-plan",
  requirePlatformOperatorStrict,
  validate(changePlanBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof changePlanBodySchema>;
      const sub = await prisma.tenantSubscription.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          tenantId: true,
          plan: true,
          status: true,
        },
      });
      if (!sub) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Subscription not found",
        });
        return;
      }
      if (sub.status === "cancelled" || sub.status === "suspended") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot change plan on a ${sub.status} subscription`,
        });
        return;
      }

      // The target plan must resolve to an existing ACTIVE catalog tier.
      const targetPlan = await getPlanByKey(prisma, body.plan);
      if (!targetPlan || !targetPlan.active) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unknown or inactive plan "${body.plan}". Pick an active plan from the catalog.`,
        });
        return;
      }

      const fromPlan = sub.plan;
      const toPlan = body.plan;

      // Proration first (idempotent on same-plan no-op; the line below
      // still updates the plan column on a same-plan call which is a
      // harmless no-op write).
      const proration = await applyProration(prisma, sub.id, fromPlan, toPlan);

      // Custom-price overrides apply only to the source plan — clear
      // when the plan actually changes so the new plan uses its tier
      // default. Enterprise bespoke deals re-set their custom price
      // via a separate UI flow after the change-plan call.
      const planActuallyChanged = fromPlan !== toPlan;
      await prisma.tenantSubscription.update({
        where: { id: sub.id },
        data: {
          plan: toPlan,
          ...(planActuallyChanged ? { customPriceMonthlyInPaise: null } : {}),
        },
      });

      await auditLog(
        req,
        "PLATFORM_SUBSCRIPTION_PLAN_CHANGED",
        "tenant_subscription",
        sub.id,
        {
          tenantId: sub.tenantId,
          fromPlan,
          toPlan,
          prorationInvoiceId: proration?.invoiceId || null,
          prorationDeltaInPaise: proration?.deltaInPaise ?? 0,
        },
      );

      res.status(200).json({
        success: true,
        data: {
          subscriptionId: sub.id,
          fromPlan,
          toPlan,
          proration,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 piece 3d — explicit cancel + reactivate ──────────────
//
// POST /api/v1/platform-billing/subscriptions/:id/cancel
// POST /api/v1/platform-billing/subscriptions/:id/reactivate
//
// Cancel is operator-initiated termination (stamps cancelledAt; no further
// invoices generated). Reactivate brings a `trial`/`past_due` row back to
// `active` (clears pastDueSince). Both call the idempotent helpers in
// platform-subscription-state.ts so a webhook + UI click reconverge.
router.post(
  "/subscriptions/:id/cancel",
  requirePlatformOperatorStrict,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let result;
      try {
        result = await cancelSubscription(prisma, req.params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          res.status(404).json({
            success: false,
            data: null,
            error: "Subscription not found",
          });
          return;
        }
        throw err;
      }
      res.status(200).json({
        success: true,
        data: result,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/subscriptions/:id/reactivate",
  requirePlatformOperatorStrict,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let result;
      try {
        result = await transitionToActive(prisma, req.params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          res.status(404).json({
            success: false,
            data: null,
            error: "Subscription not found",
          });
          return;
        }
        throw err;
      }
      res.status(200).json({
        success: true,
        data: result,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 piece 3e — usage events read surface ─────────────────
//
// GET /api/v1/platform-billing/usage?tenantId=&from=&to=&kind=
//
// Aggregated counts of UsageEvent rows by tenant + kind for a given
// window. Drives the dashboard tile that shows operators how much
// WhatsApp/SMS/LLM-token/ABDM usage will land on next month's invoice.
const usageQuerySchema = z.object({
  tenantId: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  kind: z
    .enum(["WHATSAPP_SENT", "SMS_SENT", "LLM_TOKENS", "ABDM_MESSAGE"])
    .optional(),
});

router.get(
  "/usage",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = usageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { tenantId, from, to, kind } = parsed.data;
      const where: Record<string, unknown> = {};
      if (tenantId) where.tenantId = tenantId;
      if (kind) where.kind = kind;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lt = new Date(to);
        where.createdAt = range;
      }
      const grouped = await prisma.usageEvent.groupBy({
        by: ["tenantId", "kind"],
        where,
        _sum: { quantity: true },
        _count: { _all: true },
      });
      res.status(200).json({
        success: true,
        data: {
          rows: grouped.map((g) => ({
            tenantId: g.tenantId,
            kind: g.kind,
            totalQuantity: g._sum.quantity ?? 0,
            eventCount: g._count._all,
          })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Pearl §8.3 — dynamic plan catalog CRUD ──────────────────────────
//
// The platform plan tiers are DB-backed (`PlatformPlan`), so the super-admin
// can create / edit / deactivate / delete tiers at runtime with no code
// change. Every billing path (provisioning, change-plan, proration, invoice
// generation) resolves price + features from this catalog.
//
//   GET    /plans          — list (all tiers incl. inactive; ?activeOnly=true)
//   POST   /plans          — create a tier
//   PATCH  /plans/:id      — edit name/price/features/active/sortOrder (key immutable)
//   DELETE /plans/:id      — delete an UNUSED tier; in-use tiers are blocked
//                            (deactivate via PATCH active=false instead).
//
// Reads ride the router-level operator-or-super-admin gate; mutations use the
// strict gate (PLATFORM_OPERATOR / PLATFORM_BILLING_OPERATOR / SUPER_ADMIN).

const PLAN_KEY_REGEX = /^[A-Z0-9_]{2,40}$/;

const createPlanBodySchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      PLAN_KEY_REGEX,
      "Plan key must be 2-40 uppercase letters, digits or underscores",
    ),
  name: z.string().trim().min(2, "Name too short").max(120),
  monthlyPriceInPaise: z
    .number()
    .int("Price must be a whole number of paise")
    .min(0, "Price cannot be negative"),
  includedFeatures: z.array(z.string().trim().min(1).max(64)).default([]),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const updatePlanBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    monthlyPriceInPaise: z.number().int().min(0).optional(),
    includedFeatures: z.array(z.string().trim().min(1).max(64)).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field must be provided",
  });

router.get("/plans", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const activeOnly = req.query.activeOnly === "true";
    const plans = await listPlans(prisma, { activeOnly });
    res.status(200).json({ success: true, data: plans, error: null });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/plans",
  requireMainSuperAdmin,
  validate(createPlanBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createPlanBodySchema>;
      const existing = await getPlanByKey(prisma, body.key);
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `A plan with key "${body.key}" already exists`,
        });
        return;
      }
      const created = await prisma.platformPlan.create({
        data: {
          key: body.key,
          name: body.name,
          monthlyPriceInPaise: body.monthlyPriceInPaise,
          includedFeatures: body.includedFeatures,
          sortOrder: body.sortOrder ?? 0,
        },
      });
      await auditLog(req, "PLATFORM_PLAN_CREATED", "platform_plan", created.id, {
        key: created.key,
        monthlyPriceInPaise: created.monthlyPriceInPaise,
      });
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/plans/:id",
  requireMainSuperAdmin,
  validate(updatePlanBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof updatePlanBodySchema>;
      const plan = await prisma.platformPlan.findUnique({
        where: { id: req.params.id },
      });
      if (!plan) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Plan not found" });
        return;
      }
      const updated = await prisma.platformPlan.update({
        where: { id: plan.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.monthlyPriceInPaise !== undefined
            ? { monthlyPriceInPaise: body.monthlyPriceInPaise }
            : {}),
          ...(body.includedFeatures !== undefined
            ? { includedFeatures: body.includedFeatures }
            : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        },
      });
      await auditLog(req, "PLATFORM_PLAN_UPDATED", "platform_plan", updated.id, {
        key: updated.key,
        changed: Object.keys(body),
      });
      res.status(200).json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/plans/:id",
  requireMainSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await prisma.platformPlan.findUnique({
        where: { id: req.params.id },
      });
      if (!plan) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Plan not found" });
        return;
      }
      // Block deletion when any tenant or subscription is still on this key —
      // removing it would orphan those rows. The operator should deactivate
      // (PATCH active=false) instead so existing tenants keep paying their tier
      // while it disappears from the create/change dropdowns.
      const [tenantCount, subCount] = await Promise.all([
        prisma.tenant.count({ where: { plan: plan.key } }),
        prisma.tenantSubscription.count({ where: { plan: plan.key } }),
      ]);
      const inUse = tenantCount + subCount;
      if (inUse > 0) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot delete plan "${plan.key}" — ${inUse} tenant(s)/subscription(s) still use it. Deactivate it instead.`,
        });
        return;
      }
      await prisma.platformPlan.delete({ where: { id: plan.id } });
      await auditLog(req, "PLATFORM_PLAN_DELETED", "platform_plan", plan.id, {
        key: plan.key,
      });
      res.status(200).json({
        success: true,
        data: { id: plan.id, key: plan.key, deleted: true },
        error: null,
      });
    } catch (err) {
      handlePlanRouteError(res, next, "plan-delete", err);
    }
  },
);

export const platformBillingRouter = router;
