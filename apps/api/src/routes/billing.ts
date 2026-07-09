import express, { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
// rawPrisma — Invoice.invoiceNumber, CreditNote.noteNumber, and
// AdvancePayment.receiptNumber are all GLOBAL @unique. The next-N
// generators below MUST scan rows across every tenant.
import { prisma as rawPrisma, Prisma } from "@medcore/db";

// ── Issue #901: keep the on-wire JSON contract identical after moving
// Invoice/InvoiceItem money columns from Float to DECIMAL(12,2). Prisma
// returns DECIMAL as Prisma.Decimal (a Decimal.js object) whose default
// .toJSON() yields a quoted string ("743.40"). Every consumer (dashboard
// widgets, GSTR-1 exporter, PDF generator, e2e specs, integration tests)
// currently parses these as numbers. Override the prototype's toJSON to
// return a number so the on-wire contract stays identical without having
// to touch ~80 res.json call-sites. Idempotent via a marker flag so
// multiple route imports don't re-patch (and so test re-imports under
// `singleFork: true` don't pile up wrappers).
const decProto = (Prisma as unknown as { Decimal?: { prototype?: Record<string, unknown> } }).Decimal?.prototype;
if (decProto && !(decProto as Record<string, unknown>).__medcore901Patched) {
  (decProto as Record<string, unknown>).toJSON = function (this: { toNumber: () => number }) {
    return this.toNumber();
  };
  (decProto as Record<string, unknown>).__medcore901Patched = true;
}
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
  computeLineItemTax,
  computeInvoiceTotals,
  hsnSacForCategory,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { sendWhatsApp } from "../services/messaging/whatsapp";
import { patientBillLink } from "../lib/site-link";
import { validate } from "../middleware/validate";
// Issue #139 / #159 / #165 (2026-04-26): all revenue / outstanding / refund
// KPIs route through ../services/revenue so dashboard, billing, reports and
// analytics can never disagree on the definition of "revenue this month".
import {
  getRevenue as svcGetRevenue,
  getRefunds as svcGetRefunds,
  getOutstanding as svcGetOutstanding,
} from "../services/revenue";
import {
  createPaymentOrder,
  verifyPayment,
  fetchOrderAmount,
  verifyWebhookSignature,
  getRazorpayPublicConfig,
  hasRazorpayCredentials,
} from "../services/razorpay";
import { isIntegrationEnabled } from "../services/integration-flags";
import { onBillGenerated, onPaymentReceived } from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { splitGst } from "../services/ops-helpers";
import { generateInvoicePDF } from "../services/pdf";
import { generateInvoicePDFBuffer } from "../services/pdf-generator";

const router = Router();
router.use(authenticate);

// Billing cross-tenant scope for the report/KPI endpoints. Financial data is
// MAIN-super-admin-only. Returns a `tenantFilter` to spread into each report
// query's `where`:
//   • tenant-bound caller        → {}   (tenantScopedPrisma already scopes it)
//   • main super-admin + chosen  → { tenantId }   (the dashboard tenant filter)
//   • main super-admin + "All"   → {}   (cross-tenant aggregate)
//   • any other no-tenant caller → { tenantId: "__no_access__" }  → matches no
//     rows, so the report computes zeros (non-main operators can't see totals).
async function resolveBillingReportScope(
  req: Request,
): Promise<{ tenantFilter: Record<string, string> }> {
  if (req.tenantId) return { tenantFilter: {} };
  const rows = await rawPrisma.$queryRaw<
    Array<{ isMainSuperAdmin: boolean }>
  >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
  if (rows[0]?.isMainSuperAdmin !== true) {
    return { tenantFilter: { tenantId: "__no_access__" } };
  }
  const tp = req.query.tenantId;
  return {
    tenantFilter:
      typeof tp === "string" && tp.trim().length > 0
        ? { tenantId: tp.trim() }
        : {},
  };
}

// IPD running-bill sync — moved to services/ipd-billing-sync.ts on
// 2026-05-25 once a second non-billing caller (discharge handlers in
// admissions.ts) needed the same contract. Idempotency, formula, and
// behavior unchanged. See that file's header for the full rationale.
import { syncIpdInvoiceTotals } from "../services/ipd-billing-sync";

// ─── Decimal → number helper (Issue #901) ────────────────────────
// Coerce a Prisma.Decimal / number / string to a JS number for math
// call-sites where TS would otherwise complain about a Decimal operand
// in arithmetic. JSON serialization is handled by the prototype patch
// above; this helper is only for in-route arithmetic.
function dec(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const anyV = v as { toNumber?: () => number };
  return typeof anyV.toNumber === "function" ? anyV.toNumber() : Number(v);
}

// Coerce an Invoice + items row into the all-number shape that the
// `@medcore/shared#computeInvoiceTotals` helper expects. Centralizes
// the boundary so the helper signature in shared/ does not have to
// know about Prisma.Decimal.
function totalsInput(invoice: {
  items: Array<{ amount: unknown; category?: string | null }>;
  subtotal: unknown;
  taxAmount: unknown;
  cgstAmount?: unknown;
  sgstAmount?: unknown;
  discountAmount: unknown;
  totalAmount: unknown;
}) {
  return {
    items: invoice.items.map((it) => ({ amount: dec(it.amount), category: it.category })),
    persisted: {
      subtotal: dec(invoice.subtotal),
      taxAmount: dec(invoice.taxAmount),
      cgstAmount: invoice.cgstAmount !== undefined ? dec(invoice.cgstAmount) : undefined,
      sgstAmount: invoice.sgstAmount !== undefined ? dec(invoice.sgstAmount) : undefined,
      discountAmount: dec(invoice.discountAmount),
      totalAmount: dec(invoice.totalAmount),
    },
  };
}

// Helper: read integer SystemConfig with fallback. Mirrors the helper
// in appointments.ts; lift to a shared util if a third caller appears.
async function getConfigInt(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Default invoice due-date when the caller didn't pass one.
 * `invoice_default_due_days` SystemConfig overrides per-tenant; default 14.
 * #902: previously this was left null, so receivables never aged + no
 * dunning fired.
 */
async function computeDefaultDueDate(): Promise<Date> {
  const days = await getConfigInt("invoice_default_due_days", 14);
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

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
        // Pearl §4.1 (gap row 101) — referring-doctor commission split.
        // referralId takes precedence: when set, the handler reads the
        // Referral row's fromDoctorId + commissionPercent (override).
        // referringDoctorId is the walk-in shorthand for an invoice
        // that names a referring doctor without a formal Referral.
        referringDoctorId: bodyReferringDoctorId,
        referralId,
      } = req.body;

      // Issue #890: never raise an invoice against a NO_SHOW or CANCELLED
      // appointment — the patient was never seen, so a "consultation" line
      // is phantom revenue (and an insurance-fraud exposure if the invoice
      // is later submitted as a claim). Fail fast before any total maths.
      if (appointmentId) {
        const appt = await prisma.appointment.findUnique({
          where: { id: appointmentId },
          select: { status: true },
        });
        if (appt && (appt.status === "NO_SHOW" || appt.status === "CANCELLED")) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Cannot raise an invoice against a ${appt.status} appointment — the patient was not seen.`,
          });
          return;
        }
      }

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
      // ── Issue #901: GST math is deferred until after discount + tier
      // + package discounts are resolved (see CGST Rule 32 block below).
      // The OLD code called splitGst(subtotal, gstPct) here and charged
      // GST on the PRE-discount base — over-reporting output GST on
      // GSTR-1 for every discounted invoice.

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

      // ── Issue #901: compute taxable base BEFORE applying GST ────
      // taxableAmount = subtotal − every discount that reduces the
      // legal consideration (user, tier, package). Advance is a
      // tender, not a discount, so it does NOT shrink the taxable base.
      // GST is then computed on this taxable base — never on the raw
      // subtotal — so output GST on GSTR-1 matches what the customer
      // actually paid in consideration.
      const userDiscount = (discountAmount || 0) + tierDiscount + packageDiscount;
      const taxableAmount = Math.max(0, +(subtotal - userDiscount).toFixed(2));
      const { taxAmount, cgstAmount, sgstAmount } = splitGst(taxableAmount, gstPct);

      // Advance payment application
      let advanceApplied = 0;
      let advanceToConsume: Array<{ id: string; use: number }> = [];
      if (applyAdvance) {
        const advances = await prisma.advancePayment.findMany({
          where: { patientId, balance: { gt: 0 } },
          orderBy: { createdAt: "asc" },
        });
        // Gross = taxable + GST (the post-Rule-32 charge). Advance can
        // be consumed up to this gross amount.
        const gross = taxableAmount + taxAmount;
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

      // total = taxable + GST − advance. The OLD pre-#901 expression
      // subtracted the user discount here a second time (because it
      // was never folded into the taxable base) — we've now baked it
      // into taxableAmount above, so don't double-count.
      const totalAmount = taxableAmount + taxAmount - advanceApplied;

      // ── Pearl §4.1 (gap row 101) — pre-resolve referring-doctor +
      // commission % before opening the invoice transaction. We do the
      // lookups outside the tx so the hot-path stays short.
      //
      // Resolution order:
      //   1. If referralId is set, load that Referral. The fromDoctorId
      //      becomes the referring doctor; Referral.commissionPercent
      //      (if non-null) wins as the override.
      //   2. Else if referringDoctorId is set, use it directly with no
      //      Referral context.
      //   3. Fall back to Doctor.commissionPercent when neither the
      //      referral nor the body carried a %.
      // If everything resolves to null at the end, no commission row is
      // created (the transaction block below short-circuits).
      let resolvedReferringDoctorId: string | null = null;
      let resolvedReferralId: string | null = null;
      let resolvedCommissionPercent: number | null = null;
      let resolvedDoctorTenantId: string | null = null;
      if (referralId) {
        const refRow = await prisma.referral.findUnique({
          where: { id: referralId },
          select: { id: true, fromDoctorId: true, commissionPercent: true },
        });
        if (refRow) {
          resolvedReferralId = refRow.id;
          resolvedReferringDoctorId = refRow.fromDoctorId;
          if (refRow.commissionPercent !== null && refRow.commissionPercent !== undefined) {
            resolvedCommissionPercent = Number(refRow.commissionPercent);
          }
        }
      } else if (bodyReferringDoctorId) {
        resolvedReferringDoctorId = bodyReferringDoctorId;
      }
      if (resolvedReferringDoctorId) {
        const docRow = await prisma.doctor.findUnique({
          where: { id: resolvedReferringDoctorId },
          select: { tenantId: true, commissionPercent: true },
        });
        if (docRow) {
          resolvedDoctorTenantId = docRow.tenantId ?? null;
          if (
            resolvedCommissionPercent === null &&
            docRow.commissionPercent !== null &&
            docRow.commissionPercent !== undefined
          ) {
            resolvedCommissionPercent = Number(docRow.commissionPercent);
          }
        } else {
          // Doctor row vanished between body validation and lookup —
          // don't try to compute a commission against a non-existent FK.
          resolvedReferringDoctorId = null;
        }
      }

      const invoice = await prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            appointmentId,
            patientId,
            subtotal,
            taxAmount,
            taxableAmount,
            cgstAmount,
            sgstAmount,
            discountAmount: (discountAmount || 0) + tierDiscount,
            packageDiscount,
            advanceApplied,
            totalAmount: Math.max(0, +totalAmount.toFixed(2)),
            // Pearl §4.1 — persist the (resolved) referring doctor +
            // originating referral pointers so the §4.4 ledger report
            // can join back without re-derivation.
            referringDoctorId: resolvedReferringDoctorId,
            referralId: resolvedReferralId,
            // #902: default dueDate to createdAt + 14 days (configurable
            // via `invoice_default_due_days` SystemConfig) when the
            // client didn't pass one. Previously left null on ~50% of
            // PENDING invoices on staging — AR couldn't age, dunning
            // never fired.
            dueDate: dueDate ? new Date(dueDate) : await computeDefaultDueDate(),
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
                }) => {
                  // #894 + #901: persist GST breakdown + HSN/SAC ON EACH
                  // LINE so the printed tax invoice satisfies CGST Rule
                  // 46(g) (per-line HSN) and Rule 46(i)/(j) (per-line
                  // CGST/SGST). The discount factor below (taxable /
                  // subtotal) prorates the header discount across lines
                  // so each line's GST is on its DISCOUNTED share —
                  // matching the Rule 32 header math. Without proration
                  // the sum of line tax would over-state the header tax
                  // by `discount × rate` and #894's reconciliation
                  // assertion would fail.
                  const lineAmount = item.quantity * item.unitPrice;
                  const discountFactor = subtotal > 0 ? taxableAmount / subtotal : 1;
                  const lineTaxable = +(lineAmount * discountFactor).toFixed(2);
                  const lineTax = +((lineTaxable * gstPct) / 100).toFixed(2);
                  const lineCgst = +(lineTax / 2).toFixed(2);
                  const lineSgst = +(lineTax - lineCgst).toFixed(2);
                  return {
                    description: item.description,
                    category: item.category,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    amount: lineAmount,
                    cgst: lineCgst,
                    sgst: lineSgst,
                    gstRate: gstPct,
                    hsnSac: hsnSacForCategory(item.category),
                  };
                }
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

        // ── Pearl §4.1 (gap row 101) — auto-create the commission
        // snapshot in the same transaction as the invoice. If anything
        // in the invoice path rolls back, this row rolls back too.
        // Both `resolvedReferringDoctorId` and `resolvedCommissionPercent`
        // must be set for a row to materialize — a referring doctor with
        // a null commission % is a legitimate "no commission owed"
        // configuration that the report must NOT count.
        if (resolvedReferringDoctorId && resolvedCommissionPercent !== null) {
          const commissionAmount = +(
            (subtotal * resolvedCommissionPercent) / 100
          ).toFixed(2);
          await tx.referralCommission.create({
            data: {
              invoiceId: inv.id,
              referringDoctorId: resolvedReferringDoctorId,
              referralId: resolvedReferralId,
              commissionPercent: resolvedCommissionPercent,
              commissionAmount,
              // Denormalize tenantId so the report query doesn't need to
              // join through Invoice → Doctor. Falls back to "" for the
              // single-tenant deploy (matches DoctorFavouriteMedicine
              // convention).
              tenantId: resolvedDoctorTenantId ?? "",
              status: "PENDING",
            },
          });
        }

        return inv;
      });

      // Fire-and-forget notification
      onBillGenerated(invoice).catch(console.error);
      auditLog(req, "INVOICE_CREATE", "invoice", invoice.id, { invoiceNumber, patientId, totalAmount }).catch(console.error);
      // Pearl §4.1 — separate audit row for the commission snapshot so
      // accounts can grep the trail without pattern-matching invoice
      // metadata. Fire-and-forget per the safe-audit convention.
      if (resolvedReferringDoctorId && resolvedCommissionPercent !== null) {
        auditLog(
          req,
          "REFERRAL_COMMISSION_AUTO_CREATED",
          "referral_commission",
          invoice.id,
          {
            invoiceId: invoice.id,
            referringDoctorId: resolvedReferringDoctorId,
            referralId: resolvedReferralId,
            commissionPercent: resolvedCommissionPercent,
          },
        ).catch(console.error);
      }

      res.status(201).json({ success: true, data: invoice, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices
// RBAC (issue #89): DOCTOR must NOT see all invoices. Restricted to financial
// roles + PATIENT (PATIENT only sees their own — handled inline below).
// #511 audit: VERIFIED-SAFE — PATIENT branch overrides where.patientId to
// caller's own Patient row before findMany.
router.get(
  "/invoices",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Refresh IPD running-bill totals on the DB before listing so the
      // response (and any KPI tile reading directly from totalAmount) reads
      // current values without per-row overlay math.
      await syncIpdInvoiceTotals().catch(() => undefined);
      const { patientId, status, page = "1", limit = "20", search, dateFrom, dateTo } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;

      // Issue #597 (May 2026): patient billing page rendered a flat
      // unfiltered/unsorted list — no way to narrow by date range when
      // the list grew beyond a screen. Add inclusive `dateFrom` / `dateTo`
      // filters on `createdAt`. Inverted ranges and unparseable dates
      // surface as a clean 400 so the form can render an inline error
      // instead of silently returning an empty list.
      if (typeof dateFrom === "string" || typeof dateTo === "string") {
        const range: Record<string, Date> = {};
        if (typeof dateFrom === "string" && dateFrom.length > 0) {
          const f = new Date(dateFrom);
          if (isNaN(f.getTime())) {
            res.status(400).json({
              success: false,
              data: null,
              error: "Invalid dateFrom value",
              details: [{ field: "dateFrom", message: "Invalid date" }],
            });
            return;
          }
          range.gte = f;
        }
        if (typeof dateTo === "string" && dateTo.length > 0) {
          const t = new Date(dateTo);
          if (isNaN(t.getTime())) {
            res.status(400).json({
              success: false,
              data: null,
              error: "Invalid dateTo value",
              details: [{ field: "dateTo", message: "Invalid date" }],
            });
            return;
          }
          range.lte = t;
        }
        if (range.gte && range.lte && range.gte.getTime() > range.lte.getTime()) {
          res.status(400).json({
            success: false,
            data: null,
            error: "dateFrom must be on or before dateTo",
            details: [{ field: "dateTo", message: "dateFrom must be on or before dateTo" }],
          });
          return;
        }
        if (Object.keys(range).length > 0) where.createdAt = range;
      }
      // Issue #479: the patient dashboard widget requests
      // `?status=PENDING,PARTIAL` as a comma-separated list. Passing the
      // literal "PENDING,PARTIAL" string straight into Prisma's
      // `paymentStatus` (a `PaymentStatus` enum) raised an enum-validation
      // exception that bubbled up as a 500. Match the convention already in
      // appointments/ai-scribe routes: split on comma into a `{ in: [...] }`
      // clause and validate each entry against the enum so unknown values
      // surface as a clean 400 instead of crashing the handler.
      const VALID_STATUSES = ["PENDING", "PAID", "PARTIAL", "REFUNDED"] as const;
      if (typeof status === "string" && status.length > 0) {
        const parts = status
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const invalid = parts.filter(
          (s) => !VALID_STATUSES.includes(s as (typeof VALID_STATUSES)[number])
        );
        if (invalid.length > 0) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Invalid status value(s): ${invalid.join(", ")}`,
          });
          return;
        }
        where.paymentStatus = parts.length === 1 ? parts[0] : { in: parts };
      }

      // Billing cross-tenant visibility is MAIN-super-admin-only (financial
      // data). Tenant-bound callers are already scoped to their own tenant by
      // tenantScopedPrisma. A no-tenant-context caller (super-admin/platform,
      // who otherwise bypasses scoping) only sees every tenant's invoices when
      // they are the MAIN super-admin; any other no-tenant caller gets an empty
      // list. The main super-admin may narrow the view with ?tenantId=<id>.
      // NOTE: runs AFTER query-param validation above so a malformed
      // ?status=/dateFrom= still returns a clean 400 (not a 200 empty list).
      if (!req.tenantId) {
        const callerMainRows = await rawPrisma.$queryRaw<
          Array<{ isMainSuperAdmin: boolean }>
        >`SELECT "isMainSuperAdmin" FROM users WHERE id = ${req.user!.userId}`;
        if (callerMainRows[0]?.isMainSuperAdmin !== true) {
          res.json({
            success: true,
            data: [],
            error: null,
            meta: { page: parseInt(page as string), limit: take, total: 0 },
          });
          return;
        }
        const tenantIdParam = req.query.tenantId;
        if (
          typeof tenantIdParam === "string" &&
          tenantIdParam.trim().length > 0
        ) {
          where.tenantId = tenantIdParam.trim();
        }
      }

      // Issue #82: support `?search=<invoiceNumber|patient name>` so the
      // EntityPicker on the Insurance Claims modal can find an invoice by
      // typing. Falls through to no-op when search is missing/empty.
      const q = typeof search === "string" ? search.trim() : "";
      if (q.length >= 1) {
        where.OR = [
          { invoiceNumber: { contains: q, mode: "insensitive" } },
          { patient: { user: { name: { contains: q, mode: "insensitive" } } } },
          { patient: { mrNumber: { contains: q, mode: "insensitive" } } },
        ];
      }

      // Patients can only see their own invoices
      if (req.user!.role === "PATIENT") {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (patient) where.patientId = patient.id;
      }

      // Pharmacists see ONLY the pharmacy bills (standalone invoices linked to a
      // prescription) — not consultation / IPD / other invoices.
      if (req.user!.role === "PHARMACIST") {
        where.prescriptionId = { not: null };
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

      // 2026-05-27: lazy paymentStatus reconciliation.
      //
      // We've seen invoices where the persisted `paymentStatus` lags the
      // truth (e.g. a row flipped to PAID under the old pre-GST math is
      // now PARTIAL with a small GST gap once the totals were corrected,
      // OR a manual payment was inserted via a path that bypassed the
      // flip-on-payment logic). The payments[] array sums to ≥ the
      // GST-corrected total but the column still says PENDING/PARTIAL,
      // so the patient sees a red OVERDUE pill on a fully-settled bill.
      //
      // The pay-online endpoint (line 1044) already uses the same
      // computeInvoiceTotals math as the authority for "already paid".
      // Doing the same here closes the inconsistency: the list reflects
      // the same truth the payment endpoint enforces. Per-row reconcile
      // is fire-and-forget (don't block the response on the writes; the
      // returned data is the corrected shape either way).
      const reconciledIds: string[] = [];
      for (const inv of invoices) {
        if (inv.paymentStatus === "PAID" || inv.paymentStatus === "REFUNDED") continue;
        const ti = totalsInput(inv);
        const correctedTotal = computeInvoiceTotals(ti.items, ti.persisted).totalAmount;
        const paidSum = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        if (paidSum + 0.01 >= correctedTotal) {
          inv.paymentStatus = "PAID";
          reconciledIds.push(inv.id);
        }
      }
      if (reconciledIds.length > 0) {
        // Persist in the background — best-effort. A failed write just
        // means the next list-load will reconcile again; nothing is lost.
        void prisma.invoice
          .updateMany({
            where: { id: { in: reconciledIds } },
            data: { paymentStatus: "PAID" },
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[billing] paymentStatus reconcile write failed for ${reconciledIds.length} row(s):`,
              err,
            );
          });
      }

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

// GET /api/v1/billing/hospital-profile
// The "seller" identity printed on every invoice (web + PDF): name, address,
// phone, email, GSTIN, tagline, logo. This is PER TENANT — sourced from the
// hospital's own config (Settings → Branding), which the tenant admin edits
// and which is stored under tenant-scoped SystemConfig keys
// `tenant:<id>:hospital_*` (+ `tenant:<id>:branding_logo_url`). Tenant.name is
// the canonical hospital name and is preferred over the mirror. Previously this
// read GLOBAL `hospital_*` keys, so every tenant's invoice showed the seeded
// demo hospital ("MedCore Hospital …") instead of its own details.
router.get(
  "/hospital-profile",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? null;
      const suffixes = [
        "hospital_name",
        "hospital_address",
        "hospital_phone",
        "hospital_email",
        "hospital_gstin",
        "hospital_registration",
        "hospital_tagline",
        "branding_logo_url",
      ];
      const map: Record<string, string> = {};
      let tenantName: string | null = null;
      let isDefaultTenant = false;

      if (tenantId) {
        const prefix = `tenant:${tenantId}:`;
        const rows = await prisma.systemConfig.findMany({
          where: { key: { in: suffixes.map((s) => `${prefix}${s}`) } },
        });
        rows.forEach((r) => (map[r.key.slice(prefix.length)] = r.value));

        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true, subdomain: true },
        });
        tenantName = tenant?.name ?? null;
        isDefaultTenant = tenant?.subdomain === "default";
      }

      // Fallback to the seeded GLOBAL hospital config ONLY for the platform's
      // default/demo tenant (whose identity lives in global keys, not
      // tenant-scoped) or when there's no tenant context. A real tenant does
      // NOT inherit the demo — an unconfigured field stays blank so its invoice
      // never prints another hospital's address / GSTIN.
      if (isDefaultTenant || !tenantId) {
        const globalRows = await prisma.systemConfig.findMany({
          where: { key: { in: suffixes } },
        });
        globalRows.forEach((r) => {
          if (map[r.key] === undefined) map[r.key] = r.value;
        });
      }

      res.json({
        success: true,
        data: {
          // Canonical Tenant.name first, then the config mirror, then neutral.
          name: tenantName || map.hospital_name || "Hospital",
          address: map.hospital_address || "",
          phone: map.hospital_phone || "",
          email: map.hospital_email || "",
          gstin: map.hospital_gstin || "",
          registration: map.hospital_registration || "",
          tagline: map.hospital_tagline || "",
          logoUrl: map.branding_logo_url || "",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/billing/invoices/:id
// RBAC (issue #89): DOCTOR must NOT see invoice detail. PATIENT allowed for
// own-record access only. PHARMACIST may view the bill they generate from the
// pharmacy dispense / Kanban "Generate Bill" flow (read-only — invoice
// mutations stay ADMIN/RECEPTION).
// Issue #511 (BOLA): PATIENT must only fetch own invoices. The earlier
// "further checked at object level by upstream consumers" comment did
// not actually translate into any per-row check; assertPatientOwnsResource
// closes the gap here so every consumer is uniformly gated.
router.get(
  "/invoices/:id",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Refresh IPD running-bill items + totals before reading so an opened
      // admission invoice always reflects the latest bed-days / doses / labs
      // (auto-generated + auto-updated from the admission). No-op for
      // non-IPD invoices and idempotent when nothing drifted.
      await syncIpdInvoiceTotals().catch(() => undefined);
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

      if (!(await assertPatientOwnsResource(req, res, invoice.patientId))) return;

      // 2026-05-27: same lazy paymentStatus reconciliation as the list
      // endpoint (line 671) — see that block for the full rationale. A
      // detail-view consumer (patient bills detail page, web admin
      // invoice modal) should never see PENDING/PARTIAL on a row whose
      // payments[] already covers the GST-corrected total.
      if (invoice.paymentStatus !== "PAID" && invoice.paymentStatus !== "REFUNDED") {
        const ti = totalsInput(invoice);
        const correctedTotal = computeInvoiceTotals(ti.items, ti.persisted).totalAmount;
        const paidSum = invoice.payments.reduce((s, p) => s + Number(p.amount), 0);
        if (paidSum + 0.01 >= correctedTotal) {
          invoice.paymentStatus = "PAID";
          void prisma.invoice
            .update({ where: { id: invoice.id }, data: { paymentStatus: "PAID" } })
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(
                `[billing] paymentStatus reconcile (detail) write failed for ${invoice.id}:`,
                err,
              );
            });
        }
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
        include: { payments: true, items: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      // Legacy-seed correction (same pattern as /pay-online + /verify-payment):
      // some Invoice.totalAmount rows were persisted pre-GST. Without this,
      // a manual ₹234 payment to close the GST gap on a row whose raw
      // totalAmount is ₹1,300 would 400 with "Payment exceeds invoice
      // balance". Trust computeInvoiceTotals as the single source of truth.
      const recPayTotalsIn = totalsInput(invoice);
      const recPayTotals = computeInvoiceTotals(recPayTotalsIn.items, recPayTotalsIn.persisted);
      const recPayCorrectedTotal = recPayTotals.totalAmount;
      const totalPaid =
        invoice.payments.reduce((sum, p) => sum + p.amount, 0) + amount;

      // Issue #559: reject payments that would push paid > totalAmount.
      // Allow a 1-paisa rounding tolerance so legitimate cash settlements
      // computed against tax/discount split don't false-positive.
      if (totalPaid > recPayCorrectedTotal + 0.01) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Payment exceeds invoice balance. Outstanding is Rs ${(recPayCorrectedTotal - (totalPaid - amount)).toFixed(2)}.`,
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: { invoiceId, amount, mode, transactionId },
        });

        // Update invoice payment status
        const newStatus =
          totalPaid >= recPayCorrectedTotal ? "PAID" : "PARTIAL";
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { paymentStatus: newStatus },
        });

        return payment;
      });

      // Fire-and-forget notification
      onPaymentReceived(result, invoice).catch(console.error);
      auditLog(req, "PAYMENT_CREATE", "payment", result.id, { invoiceId, amount, mode }).catch(console.error);

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
// RBAC (issue #90): RECEPTION must NOT see "Today's Revenue" / collection
// totals. Restricted to ADMIN.
router.get(
  "/reports/daily",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantFilter } = await resolveBillingReportScope(req);
      const { date } = req.query;
      const dateObj = date ? new Date(date as string) : new Date();
      const startOfDay = new Date(dateObj);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(dateObj);
      endOfDay.setHours(23, 59, 59, 999);

      const payments = await prisma.payment.findMany({
        where: {
          ...tenantFilter,
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

      // Issue #139 — canonical revenue: positive payments only; refunds
      // (negative-amount rows) are excluded. The previous implementation
      // summed every row including refunds, which made daily collection
      // disagree with the reports module by exactly the refund total.
      const totalCollection = payments.reduce(
        (sum, p) => (p.amount > 0 ? sum + p.amount : sum),
        0
      );
      const byMode = payments.reduce(
        (acc, p) => {
          if (p.amount > 0) acc[p.mode] = (acc[p.mode] || 0) + p.amount;
          return acc;
        },
        {} as Record<string, number>
      );

      const pendingInvoices = await prisma.invoice.count({
        where: {
          ...tenantFilter,
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

// GET /api/v1/billing/razorpay-config — public-safe Razorpay status for the UI.
// Returns whether online payments are configured + whether we're on a test key.
// Never returns the secret; the Key ID is delivered per-order via /pay-online.
router.get(
  "/razorpay-config",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Per-tenant: resolve THIS hospital's own Razorpay keys (env only as a
      // last-resort fallback), exactly as the payment endpoints do. Previously
      // this read env vars only, so a tenant with no keys was told "enabled"
      // (if the platform env happened to have a key) and then hit an opaque
      // failure at pay-online — the bug behind "no proper message".
      const status = await getRazorpayPublicConfig(req.tenantId);
      // Respect the Settings → Integrations "Razorpay" master switch: if the
      // admin turned it off, report disabled even when keys are on file, so the
      // UI hides/greys the Pay Online action.
      const gatewayOn = await isIntegrationEnabled(req.tenantId, "razorpay");
      res.json({
        success: true,
        data: { ...status, enabled: status.enabled && gatewayOn },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/billing/pay-online — create Razorpay order for an invoice
// RBAC (issue #89): DOCTOR excluded.
router.post(
  "/pay-online",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `amount` is OPTIONAL — when present, the caller wants a partial
      // payment of that exact rupee value (≤ remaining balance). When
      // absent, we charge the full GST-corrected remaining as before. The
      // server still enforces the cap so a tampered browser can't ask for
      // a negative or oversized partial.
      const { invoiceId, amount: requestedAmount } = req.body as {
        invoiceId?: string;
        amount?: number;
      };

      if (!invoiceId) {
        res.status(400).json({ success: false, data: null, error: "invoiceId is required" });
        return;
      }

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true, items: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      // Issue #511 (BOLA): a PATIENT can only initiate the Razorpay
      // pay-online flow on an invoice that belongs to them. Without
      // this check a patient could create payment orders against a
      // stranger's invoice and stamp razorpayOrderId on it.
      if (!(await assertPatientOwnsResource(req, res, invoice.patientId))) return;

      // Settings → Integrations master switch. If the admin turned Razorpay
      // OFF, block online payments regardless of whether keys exist — with a
      // message that points at exactly the toggle to flip.
      if (!(await isIntegrationEnabled(req.tenantId, "razorpay"))) {
        res.status(503).json({
          success: false,
          data: null,
          error:
            "Online payments are turned off for this hospital. An administrator can re-enable Razorpay under Settings → Integrations.",
        });
        return;
      }

      // Per-tenant gateway guard. Online payments use THIS hospital's own
      // Razorpay keys (see services/razorpay.ts). If none are configured for
      // the tenant (and no platform env fallback), fail fast with a clear,
      // actionable message instead of letting createPaymentOrder throw a
      // generic 500 (whose real cause the prod error handler hides). This is
      // the "show a proper message to the tenant" path: the admin is told
      // exactly where to fix it. Only in production — non-prod keeps the mock
      // order so dev/CI can exercise the checkout flow without real keys.
      if (
        process.env.NODE_ENV === "production" &&
        !(await hasRazorpayCredentials(req.tenantId))
      ) {
        res.status(503).json({
          success: false,
          data: null,
          error:
            "Online payments aren't set up for this hospital yet. An administrator can add the Razorpay keys under Settings → Payments.",
        });
        return;
      }

      // Legacy seed path: some Invoice.totalAmount rows were persisted as
      // subtotal (pre-GST). The detail page renders the GST-corrected total
      // via computeInvoiceTotals; we MUST charge that same number through
      // Razorpay or the patient pays less than they see and the invoice
      // settles short by the GST amount. Single source of truth lives in
      // @medcore/shared so list/detail/checkout always agree.
      //
      // We also use the corrected math as the authority for "already paid"
      // — the persisted `paymentStatus` column can lag the truth (a row
      // that was flipped to PAID under the old pre-GST math is now really
      // PARTIAL with the GST gap outstanding). Trusting the column would
      // refuse a legitimate "pay the remaining ₹234" attempt with a
      // confusing "Invoice is already paid" error.
      const totalsIn = totalsInput(invoice);
      const totals = computeInvoiceTotals(totalsIn.items, totalsIn.persisted);
      const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = totals.totalAmount - totalPaid;

      if (remaining <= 0) {
        res
          .status(400)
          .json({ success: false, data: null, error: "Invoice is already paid" });
        return;
      }

      // Partial-payment selection. If the caller supplied an `amount`, validate
      // it falls in (0, remaining] (1 paisa rounding tolerance to match the
      // manual-payment endpoint at line 535). Otherwise charge the full
      // remaining balance — preserves existing "Pay Online" full-balance UX
      // for callers that don't pass an amount.
      let chargeAmount = remaining;
      if (requestedAmount !== undefined && requestedAmount !== null) {
        const n = Number(requestedAmount);
        if (!Number.isFinite(n) || n <= 0) {
          res.status(400).json({
            success: false,
            data: null,
            error: "amount must be a positive number",
          });
          return;
        }
        if (n > remaining + 0.01) {
          res.status(400).json({
            success: false,
            data: null,
            error: `amount cannot exceed remaining balance of Rs ${remaining.toFixed(2)}`,
          });
          return;
        }
        chargeAmount = Math.min(n, remaining);
      }

      // Stale-order detection: if this invoice already has a razorpayOrderId
      // whose STATED amount no longer matches our current chargeAmount (e.g.
      // a partial payment was recorded since, the GST-corrected total
      // changed, or the user is now asking to pay a different partial),
      // discard the stale id. Without this the user pays the stale amount
      // and /verify-payment can't reconcile.
      const expectedPaiseForNewOrder = Math.round(chargeAmount * 100);
      if (invoice.razorpayOrderId) {
        const existingPaise = await fetchOrderAmount(invoice.razorpayOrderId, req.tenantId);
        if (existingPaise !== null && existingPaise !== expectedPaiseForNewOrder) {
          console.warn("[billing] discarding stale razorpayOrderId", {
            invoiceId,
            staleOrderId: invoice.razorpayOrderId,
            staleAmountPaise: existingPaise,
            newAmountPaise: expectedPaiseForNewOrder,
          });
          // Fall through — createPaymentOrder below will mint a fresh order
          // and the razorpayOrderId update will overwrite the stale one.
        }
      }

      const order = await createPaymentOrder(invoiceId, chargeAmount, req.tenantId);

      // Persist the order id on the invoice so the webhook handler can look up
      // the invoice in O(1) and the /verify-payment route can sanity-check
      // that the browser-supplied orderId actually belongs to this invoice.
      try {
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { razorpayOrderId: order.orderId },
        });
      } catch (e) {
        // Non-fatal: order creation succeeded, fall back to existing flow.
        console.warn("[billing] failed to persist razorpayOrderId", e);
      }

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
// RBAC (issue #89): DOCTOR excluded.
router.post(
  "/verify-payment",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
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

      // Issue #511 (BOLA): a PATIENT can only verify Razorpay payments
      // against their own invoice. Done BEFORE signature verification so
      // a stranger's invoiceId always 403s on ownership and never on
      // signature — i.e. the gate is independent of payload validity.
      const ownerInvoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { patientId: true },
      });
      if (!ownerInvoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, ownerInvoice.patientId))) return;

      const isValid = await verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature, req.tenantId);

      if (!isValid) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Payment verification failed — invalid signature",
        });
        return;
      }

      // Idempotency: if we've already recorded this paymentId (e.g. webhook
      // beat the browser callback), return success without re-charging.
      const existing = await prisma.payment.findUnique({
        where: { transactionId: razorpayPaymentId },
      });
      if (existing) {
        res.json({
          success: true,
          data: { ...existing, alreadyProcessed: true },
          error: null,
        });
        return;
      }

      // Record the payment
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true, items: true },
      });

      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }

      // Cross-check that the orderId belongs to this invoice. Without this a
      // signed callback for a *different* (cheaper) invoice could be replayed
      // against an expensive invoice.
      if (invoice.razorpayOrderId && invoice.razorpayOrderId !== razorpayOrderId) {
        console.warn("[billing] orderId mismatch for invoice", {
          invoiceId,
          expected: invoice.razorpayOrderId,
          got: razorpayOrderId,
        });
        res.status(400).json({
          success: false,
          data: null,
          error: "Order id does not belong to this invoice",
        });
        return;
      }

      // Same legacy-seed correction as /pay-online: trust the GST-inclusive
      // total from computeInvoiceTotals, not the raw `invoice.totalAmount`.
      const verifyTotalsIn = totalsInput(invoice);
      const verifyTotals = computeInvoiceTotals(verifyTotalsIn.items, verifyTotalsIn.persisted);
      const correctedTotal = verifyTotals.totalAmount;
      const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);

      // Trust the HMAC signature as proof of payment. The signature was checked
      // above (verifyPayment) — only Razorpay's secret can sign a valid one, and
      // they only sign when a real payment authorized on their end.
      //
      // For the captured amount we ask Razorpay what the ORDER was created for
      // (its stated `amount`, not the laggy `amount_paid` field that caused
      // the prior 400-on-success bug). This works correctly for both full and
      // partial payments — the order was minted at /pay-online time with the
      // exact rupee amount the user agreed to pay, and Razorpay's modal won't
      // accept a different amount. If the lookup fails (mock mode / network
      // blip), fall back to charging the full remaining as before.
      const orderStatedPaise = await fetchOrderAmount(razorpayOrderId, req.tenantId).catch(
        () => null
      );
      const capturedAmount =
        orderStatedPaise !== null
          ? orderStatedPaise / 100
          : Math.max(0, correctedTotal - totalPaid);

      if (capturedAmount <= 0) {
        // Invoice already settled by a prior capture (idempotency fast-path
        // for webhook + browser-callback races). Return success so the UI
        // doesn't show a confusing red toast on what is effectively a
        // duplicate-success.
        res.json({
          success: true,
          data: { alreadyPaid: true },
          error: null,
        });
        return;
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const payment = await tx.payment.create({
            data: {
              invoiceId,
              // Record the EXACT amount Razorpay captured — preserves audit
              // trail accuracy even when it's a short payment against the
              // corrected total (invoice will stay PARTIAL, not flip to PAID).
              amount: capturedAmount,
              mode: "ONLINE",
              transactionId: razorpayPaymentId,
              status: "CAPTURED",
            },
          });

          const newTotalPaid = totalPaid + capturedAmount;
          // Compare against the GST-corrected total so the status flip is
          // consistent with what was actually charged. A short payment via
          // a stale order leaves the invoice as PARTIAL with the residual
          // owed — the next Pay Online click creates a fresh order for the
          // remaining balance.
          const newStatus = newTotalPaid >= correctedTotal ? "PAID" : "PARTIAL";

          await tx.invoice.update({
            where: { id: invoiceId },
            data: { paymentStatus: newStatus },
          });

          return payment;
        });

        res.json({ success: true, data: result, error: null });
      } catch (e: unknown) {
        // P2002 = unique constraint failed — another concurrent request (most
        // likely the webhook) recorded this payment first. Treat as success.
        if (
          e &&
          typeof e === "object" &&
          (e as { code?: string }).code === "P2002"
        ) {
          const dup = await prisma.payment.findUnique({
            where: { transactionId: razorpayPaymentId },
          });
          res.json({
            success: true,
            data: { ...dup, alreadyProcessed: true },
            error: null,
          });
          return;
        }
        throw e;
      }
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
            // The transactionId column is `@unique` on the Payment model
            // (idempotency for Razorpay-style webhook replays). Two
            // legitimate refunds with the same reason text MUST be able
            // to coexist on the same invoice, so suffix with a fresh
            // UUID. Reason is preserved verbatim in the audit-log
            // payload below — it's not the right column for ID anyway.
            transactionId: `${REFUND_PREFIX}${reason}:${crypto.randomUUID()}`,
          },
        });

        const netPaid = totalPaid - amount;
        let newStatus: "PENDING" | "PARTIAL" | "PAID" | "REFUNDED";
        if (netPaid <= 0) {
          newStatus = netPaid === 0 && totalPaid > 0 ? "REFUNDED" : "PENDING";
        } else if (netPaid >= dec(invoice.totalAmount)) {
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

      auditLog(req, "REFUND_CREATE", "payment", result.id, {
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
      const { tenantFilter } = await resolveBillingReportScope(req);
      const { from, to } = req.query;
      const where: Record<string, unknown> = {
        ...tenantFilter,
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

      // ── Issue #901: derive original rate from snapshot, apply
      // Rule-32 sequence when recomputing totals.
      const invSubN = dec(invoice.subtotal);
      const invTaxN = dec(invoice.taxAmount);
      const taxPercentage = invSubN > 0 ? (invTaxN / invSubN) * 100 : 0;

      const updated = await prisma.$transaction(async (tx) => {
        // Persist the per-line GST snapshot at create time so historical
        // invoices retain the exact tax presented to the patient even if
        // rates change later (issue #43 / GSTR-1 audit trail).
        const lineAmount = quantity * unitPrice;
        const tax = computeLineItemTax(lineAmount, category);
        await tx.invoiceItem.create({
          data: {
            invoiceId: invoice.id,
            description,
            category,
            quantity,
            unitPrice,
            amount: lineAmount,
            cgst: tax.cgst,
            sgst: tax.sgst,
            gstRate: tax.gstRate,
            hsnSac: tax.hsnSac,
          },
        });
        const current = await tx.invoice.findUnique({
          where: { id: invoice.id },
          include: { items: true },
        });
        if (!current) return null;
        const subtotal = current.items.reduce((s, i) => s + dec(i.amount), 0);
        const discountN = dec(current.discountAmount) + dec(current.packageDiscount);
        const taxable = Math.max(0, +(subtotal - discountN).toFixed(2));
        const taxAmount = +((taxable * taxPercentage) / 100).toFixed(2);
        const totalAmount = +(taxable + taxAmount).toFixed(2);
        const cgst = +(taxAmount / 2).toFixed(2);
        const sgst = +(taxAmount - cgst).toFixed(2);
        return tx.invoice.update({
          where: { id: invoice.id },
          data: {
            subtotal,
            taxableAmount: taxable,
            taxAmount,
            cgstAmount: cgst,
            sgstAmount: sgst,
            totalAmount,
          },
          include: { items: true, payments: true },
        });
      });

      auditLog(req, "INVOICE_ITEM_CREATE", "invoice", invoice.id, {
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

      // ── Issue #901: Rule-32 recompute on item removal (same as add).
      const delSubN = dec(invoice.subtotal);
      const delTaxN = dec(invoice.taxAmount);
      const taxPercentage = delSubN > 0 ? (delTaxN / delSubN) * 100 : 0;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.invoiceItem.delete({ where: { id: itemId } });
        const current = await tx.invoice.findUnique({
          where: { id },
          include: { items: true },
        });
        if (!current) return null;
        const subtotal = current.items.reduce((s, i) => s + dec(i.amount), 0);
        const discountN = dec(current.discountAmount) + dec(current.packageDiscount);
        const taxable = Math.max(0, +(subtotal - discountN).toFixed(2));
        const taxAmount = +((taxable * taxPercentage) / 100).toFixed(2);
        const totalAmount = +(taxable + taxAmount).toFixed(2);
        const cgst = +(taxAmount / 2).toFixed(2);
        const sgst = +(taxAmount - cgst).toFixed(2);
        return tx.invoice.update({
          where: { id },
          data: {
            subtotal,
            taxableAmount: taxable,
            taxAmount,
            cgstAmount: cgst,
            sgstAmount: sgst,
            totalAmount,
          },
          include: { items: true, payments: true },
        });
      });

      auditLog(req, "INVOICE_ITEM_DELETE", "invoice", id, { itemId }).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/billing/invoices/:id — delete a whole PENDING invoice.
// Used when the only line can't be removed individually (the items endpoint
// blocks removing the last item) — e.g. an auto-raised consultation bill the
// staff wants to discard entirely. Guarded to PENDING invoices with no
// payments so we never delete anything with money already recorded against it.
router.delete(
  "/invoices/:id",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!invoice) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (invoice.paymentStatus !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only PENDING invoices can be deleted",
        });
        return;
      }
      if (invoice.payments.length > 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot delete an invoice that has payments recorded",
        });
        return;
      }

      // Delete the line items first, then the invoice (no FK cascade on
      // InvoiceItem). Any other related record (credit note, claim, …) would
      // make the final delete throw — caught below as a clean 400.
      await prisma.$transaction(async (tx) => {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
        await tx.invoice.delete({ where: { id } });
      });

      auditLog(req, "INVOICE_DELETE", "invoice", id, {
        invoiceNumber: invoice.invoiceNumber,
      }).catch(console.error);

      res.json({ success: true, data: { id }, error: null });
    } catch (err) {
      if (err instanceof Error && /Foreign key|constraint/i.test(err.message)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot delete an invoice with related records",
        });
        return;
      }
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

      // ── Issue #901: discount is applied to the TAXABLE base (subtotal),
      // not the GST-inclusive gross. CGST Rule 32 requires GST to be
      // computed on the post-discount taxable base. Derive the rate
      // from the existing tax/subtotal snapshot so we preserve whatever
      // rate the invoice was originally raised at.
      const subtotalN = dec(invoice.subtotal);
      const oldTaxN = dec(invoice.taxAmount);
      const gstPct = subtotalN > 0 ? (oldTaxN / subtotalN) * 100 : 0;

      let discountAmount = 0;
      if (flatAmount !== undefined) {
        discountAmount = flatAmount;
      } else if (percentage !== undefined) {
        discountAmount = +((subtotalN * percentage) / 100).toFixed(2);
      }
      if (discountAmount > subtotalN) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Discount cannot exceed subtotal",
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
          : subtotalN > 0
            ? (discountAmount / subtotalN) * 100
            : 0;

      const requiresApproval =
        req.user!.role !== Role.ADMIN &&
        req.user!.role !== Role.SUPER_ADMIN &&
        effPct > threshold;

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
        auditLog(req, "DISCOUNT_APPROVAL_REQUEST", "discount_approval", approval.id, {
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

      // CGST Rule 32 sequence: taxable = subtotal − discount; tax =
      // taxable × rate; total = taxable + tax. The persisted taxAmount,
      // cgst, sgst, and taxableAmount all need to be re-snapshotted so
      // GSTR-1 line totals reconcile with what the patient actually paid.
      const packageDiscountN = dec(invoice.packageDiscount);
      const newTaxable = Math.max(0, +(subtotalN - discountAmount - packageDiscountN).toFixed(2));
      const { taxAmount: newTax, cgstAmount: newCgst, sgstAmount: newSgst } = splitGst(
        newTaxable,
        gstPct,
      );
      const newTotal = +(newTaxable + newTax).toFixed(2);
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
          taxableAmount: newTaxable,
          taxAmount: newTax,
          cgstAmount: newCgst,
          sgstAmount: newSgst,
          totalAmount: newTotal,
          paymentStatus: newStatus,
          notes: invoice.notes
            ? `${invoice.notes}\n${discountNote}`
            : discountNote,
        },
        include: { items: true, payments: true },
      });

      auditLog(req, "DISCOUNT_APPLY", "invoice", invoice.id, {
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
      // ── Issue #901: same Rule-32 sequence as POST /:id/discount.
      // Recompute taxable, GST, total from the persisted rate snapshot
      // so the approved discount lands on the post-Rule-32 base.
      const subtotalN = dec(inv.subtotal);
      const oldTaxN = dec(inv.taxAmount);
      const packageDiscountN = dec(inv.packageDiscount);
      const gstPct = subtotalN > 0 ? (oldTaxN / subtotalN) * 100 : 0;
      const newTaxable = Math.max(
        0,
        +(subtotalN - approval.amount - packageDiscountN).toFixed(2),
      );
      const { taxAmount: newTax, cgstAmount: newCgst, sgstAmount: newSgst } = splitGst(
        newTaxable,
        gstPct,
      );
      const newTotal = +(newTaxable + newTax).toFixed(2);
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
            taxableAmount: newTaxable,
            taxAmount: newTax,
            cgstAmount: newCgst,
            sgstAmount: newSgst,
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

      auditLog(req, "DISCOUNT_APPROVE", "discount_approval", approval.id, {
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
      auditLog(req, "DISCOUNT_REJECT", "discount_approval", updated.id, {
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
        const invTotalN = dec(inv.totalAmount);
        const invSubN = dec(inv.subtotal);
        const lateFee = pct > 0 ? +((invTotalN * pct) / 100).toFixed(2) : flat;
        await prisma.$transaction(async (tx) => {
          // Late fees are not a supply of goods/services so GST does not
          // apply — computeLineItemTax for "LATE_FEE" returns rate=0 which
          // writes zero cgst/sgst/gstRate, matching the spec.
          const lateTax = computeLineItemTax(lateFee, "LATE_FEE");
          await tx.invoiceItem.create({
            data: {
              invoiceId: inv.id,
              description: `Late fee (${graceDays}+ days overdue)`,
              category: "LATE_FEE",
              quantity: 1,
              unitPrice: lateFee,
              amount: lateFee,
              cgst: lateTax.cgst,
              sgst: lateTax.sgst,
              gstRate: lateTax.gstRate,
              hsnSac: lateTax.hsnSac,
            },
          });
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              lateFeeAmount: lateFee,
              lateFeeAppliedAt: new Date(),
              totalAmount: invTotalN + lateFee,
              subtotal: invSubN + lateFee,
            },
          });
        });
        applied++;
      }

      auditLog(req, "LATE_FEE_APPLY", "invoice", undefined, {
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
            totalPaid >= dec(inv.totalAmount) ? "PAID" : "PARTIAL";
          await tx.invoice.update({
            where: { id: p.invoiceId },
            data: { paymentStatus: newStatus },
          });
          created.push(pay);
        }
        return created;
      });

      auditLog(req, "PAYMENT_BULK_CREATE", "patient", patientId, {
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
// RBAC (issue #89): DOCTOR excluded; PATIENT path enforced inline.
// #511 audit: VERIFIED-SAFE — PATIENT branch explicitly compares
// caller's own Patient.id to URL :patientId and 403s on mismatch.
router.get(
  "/patients/:patientId/outstanding",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Same refresh as /reports/outstanding — patient drill-down must
      // agree with the staff-wide aggregate.
      await syncIpdInvoiceTotals().catch(() => undefined);
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
        const balance = Math.max(0, dec(inv.totalAmount) - paid);
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
      // Refresh IPD running-bill totals so the outstanding report (and the
      // Total Outstanding KPI tile that consumes its `totalOutstanding`
      // aggregate) reflect today's bed charges, not the stale zero stored
      // at admit-time.
      await syncIpdInvoiceTotals().catch(() => undefined);
      const { tenantFilter } = await resolveBillingReportScope(req);
      const { from, to, minAmount } = req.query;
      const min = minAmount ? parseFloat(minAmount as string) : 0;

      const where: Record<string, unknown> = {
        ...tenantFilter,
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
          const balance = Math.max(0, dec(inv.totalAmount) - paid);
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

      // Issue #159 — canonical outstanding helper. The earlier inline
      // reduce (sum of clamped balances) gave the same result for the
      // same row set, but other call sites (KPI tile, patient drill-down)
      // were independently reducing and occasionally diverged. Route
      // every consumer through the same helper.
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
// RBAC (issue #90): ADMIN-only revenue series. RECEPTION removed.
router.get(
  "/reports/revenue",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantFilter } = await resolveBillingReportScope(req);
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
          ...tenantFilter,
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
  const last = await rawPrisma.creditNote.findFirst({
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

      auditLog(req, "CREDIT_NOTE_CREATE", "credit_note", note.id, {
        noteNumber,
        invoiceId,
        amount,
      }).catch(console.error);

      // ── Pearl §4.1 (gap row 101) — void-cascade. When the cumulative
      // credit-note total covers the full invoice (effectively a void),
      // mark the linked ReferralCommission as VOIDED so the §4.4 ledger
      // doesn't accrue commission on revenue that was reversed. We use
      // an updateMany with a status guard so a previously-PAID commission
      // (already settled in accounts) is NOT clawed back automatically —
      // accounts must do that manually with a PATCH if needed.
      const cumulativeCredits = alreadyCredited + Number(amount);
      const invoiceTotalNum = Number(invoice.totalAmount);
      if (cumulativeCredits >= invoiceTotalNum && invoiceTotalNum > 0) {
        const cascade = await prisma.referralCommission.updateMany({
          where: { invoiceId, status: "PENDING" },
          data: { status: "VOIDED" },
        });
        if (cascade.count > 0) {
          auditLog(
            req,
            "REFERRAL_COMMISSION_VOIDED_BY_CREDIT_NOTE",
            "referral_commission",
            invoiceId,
            { noteNumber, cumulativeCredits, invoiceTotal: invoiceTotalNum },
          ).catch(console.error);
        }
      }

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
  const last = await rawPrisma.advancePayment.findFirst({
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
// RBAC (issue #89): DOCTOR excluded; PATIENT path enforced inline.
// #511 audit: VERIFIED-SAFE — PATIENT branch returns only advances scoped
// to caller's own Patient row (via dedicated findMany on me.id).
router.get(
  "/advances",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
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
      auditLog(req, "ADVANCE_APPLY", "advance_payment", advanceId, {
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
      // ── Issue #901: Rule-32 sequence for consolidated IPD invoice ──
      // taxable = subtotal − discount; tax = taxable × rate; total =
      // taxable + tax − advance. Mirrors the POST /invoices path.
      const taxableAmount = Math.max(0, +(subtotal - (discountAmount || 0)).toFixed(2));
      const { taxAmount, cgstAmount, sgstAmount } = splitGst(taxableAmount, taxPercentage);

      // Advance
      let advanceApplied = 0;
      const consume: Array<{ id: string; use: number }> = [];
      if (applyAdvance) {
        const advances = await prisma.advancePayment.findMany({
          where: { patientId: admission.patientId, balance: { gt: 0 } },
          orderBy: { createdAt: "asc" },
        });
        let remaining = Math.max(0, taxableAmount + taxAmount);
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
        +(taxableAmount + taxAmount - advanceApplied).toFixed(2)
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

      // #902: IPD auto-invoice also needs the default dueDate so the
      // admission invoice ages just like a walk-in invoice.
      const ipdDueDate = await computeDefaultDueDate();
      const invoice = await prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            appointmentId: appt.id,
            patientId: admission.patientId,
            subtotal: +subtotal.toFixed(2),
            taxAmount,
            taxableAmount,
            cgstAmount,
            sgstAmount,
            discountAmount: discountAmount || 0,
            advanceApplied: +advanceApplied.toFixed(2),
            totalAmount,
            dueDate: ipdDueDate,
            notes: notes ? `[IPD ${admission.admissionNumber}] ${notes}` : `[IPD ${admission.admissionNumber}]`,
            paymentStatus: totalAmount === 0 ? "PAID" : "PENDING",
            items: {
              create: safeItems.map((it) => {
                // #894 + #901: per-line GST proration follows Rule 32 —
                // each line's tax is on its DISCOUNTED share (lineAmount
                // × discountFactor), where discountFactor = taxable /
                // subtotal. This keeps sum(line.cgst) == header.cgstAmount
                // after the post-discount sequence and preserves the #894
                // reconciliation assertion.
                const lineAmount = it.quantity * it.unitPrice;
                const discountFactor = subtotal > 0 ? taxableAmount / subtotal : 1;
                const lineTaxable = +(lineAmount * discountFactor).toFixed(2);
                const lineTax = +((lineTaxable * taxPercentage) / 100).toFixed(2);
                const lineCgst = +(lineTax / 2).toFixed(2);
                const lineSgst = +(lineTax - lineCgst).toFixed(2);
                return {
                  description: it.description,
                  category: it.category,
                  quantity: it.quantity,
                  unitPrice: it.unitPrice,
                  amount: lineAmount,
                  cgst: lineCgst,
                  sgst: lineSgst,
                  gstRate: taxPercentage,
                  hsnSac: hsnSacForCategory(it.category),
                };
              }),
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
        // #900: accumulate the IPD invoice total into the admission so
        // the admissions list shows accurate cost-to-date instead of
        // 0 for the entire stay. Atomic with the invoice create — if
        // the invoice rolls back, the increment rolls back too.
        // Deeper accumulator (per-day bed/nursing, drug-dispense,
        // lab-order, OT) is separate build work; this closes the
        // immediate gap where IPD-consolidated invoices were already
        // being raised but the admission column didn't reflect them.
        await tx.admission.update({
          where: { id: admission.id },
          data: { totalBillAmount: { increment: dec(inv.totalAmount) } },
        });
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
      const balance = dec(invoice.totalAmount) - paid;
      const channel = (req.body.channel || "WHATSAPP") as
        | "SMS"
        | "EMAIL"
        | "WHATSAPP";

      // Send the bill DIRECTLY over WhatsApp with a tappable link to the
      // bill, mirroring how prescriptions are shared (routes/prescriptions.ts
      // /:id/share). The link points at the patient portal bill page where
      // they can view + download the PDF. No more "queue a reminder" stub —
      // this delivers the bill on the spot. Falls back to the prod domain
      // when PUBLIC_APP_URL is unset (same convention as rx share + pdf.ts).
      const phone = invoice.patient.user.phone;
      if (channel === "WHATSAPP" || channel === "SMS") {
        if (!phone) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Patient has no phone on file. Add one to the patient record before sending the bill.",
          });
          return;
        }
        // Derive the link from the request host so it points at whichever
        // environment the staff member is on (software / demos) — same helper
        // booking + reschedule use. Falls back to the demos domain if no host.
        const billUrl = patientBillLink(req, invoice.id);
        const body =
          `Hi ${invoice.patient.user.name}, here is your bill ${invoice.invoiceNumber} ` +
          `from MedCore — amount due Rs.${balance.toFixed(2)}.\n\n` +
          `View & download it here: ${billUrl}`;
        const result = await sendWhatsApp({ to: phone, body });
        if (!result.ok) {
          auditLog(req, "PAYMENT_REMINDER_FAILED", "invoice", invoice.id, {
            channel,
            error: result.error,
          }).catch(console.error);
          res.status(502).json({
            success: false,
            data: null,
            error: `WhatsApp delivery failed: ${result.error}`,
          });
          return;
        }
      } else {
        // EMAIL path not yet wired for bills — keep parity with the rx-share
        // 501 rather than silently faking success.
        res.status(501).json({
          success: false,
          data: null,
          error: `${channel} delivery is not yet available for bills. Use WHATSAPP.`,
        });
        return;
      }

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
// RBAC (issue #89): DOCTOR excluded.
// Issue #511 (BOLA): PATIENT must only fetch tax-breakdown for own invoice.
router.get(
  "/invoices/:id/tax-breakdown",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!inv) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, inv.patientId))) return;
      // If legacy row didn't split, derive 50/50 on the fly.
      const cgN = dec(inv.cgstAmount);
      const sgN = dec(inv.sgstAmount);
      const taxN = dec(inv.taxAmount);
      const subN = dec(inv.subtotal);
      const cg = cgN > 0 || sgN > 0 ? cgN : +(taxN / 2).toFixed(2);
      const sg = cgN > 0 || sgN > 0 ? sgN : +(taxN - cg).toFixed(2);
      const effectivePct = subN > 0 ? +((taxN / subN) * 100).toFixed(2) : 0;
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
// RBAC (issue #89): DOCTOR excluded.
// Issue #511 (BOLA): PATIENT must only fetch own invoice PDF/HTML.
// Minimal findUnique up front so we can ownership-check before delegating
// to the PDF generator service (which loads the row separately).
router.get(
  "/invoices/:id/pdf",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id: req.params.id },
        select: { patientId: true },
      });
      if (!inv) {
        res.status(404).json({ success: false, data: null, error: "Invoice not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, inv.patientId))) return;

      // `?format=pdf` -> real PDF, default -> legacy HTML print view.
      if (req.query.format === "pdf") {
        const buffer = await generateInvoicePDFBuffer(req.params.id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=invoice-${req.params.id}.pdf`
        );
        res.setHeader("Content-Length", String(buffer.length));
        res.end(buffer);
        return;
      }
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

// ── CSV helpers — mirror analytics.ts / referral-commissions.ts toCsv ────
function tdsCsvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function tdsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(tdsCsvEscape).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => tdsCsvEscape(row[c])).join(","),
  );
  return [header, ...lines].join("\r\n");
}

// ── GET /tds-report — TDS on professional fees (Pearl §4.4 row 119) ──
//
// India IT-Act §194J withholds 10% TDS on professional fees paid to
// medical consultants. Accountants need a per-doctor monthly summary
// to file returns. This is a REPORT-ONLY endpoint — no automatic
// withholding from invoices is performed; the value is computed at
// query time from the paid InvoiceItem consultation rows.
//
// Query params (all optional):
//   from       ISO date — defaults to first day of current month
//   to         ISO date — defaults to today (now)
//   doctorId   UUID — single-doctor filter (Appointment.doctorId)
//   tdsRate    number 0-30 — defaults to 10 (India §194J default %)
//   format     "json" (default) | "csv"
//
// Aggregation:
//   - Invoices in window where paymentStatus IN ["PAID","PARTIAL"]
//     (Invoice has no `paidDate` — `updatedAt` is the closest
//     post-payment timestamp Prisma persists today, so we range on
//     `createdAt` for consistency with the other billing reports;
//     the from/to default to a month and the typical billing flow
//     creates+pays invoices in the same day, so the practical drift
//     is small. Documented for reviewers.).
//   - For each invoice, sum its InvoiceItem rows where
//     category = "CONSULTATION" (factories.ts:178 + the
//     referral-commission test fixtures + the seed data all use
//     UPPERCASE — confirmed via grep).
//   - Group by the doctor on the originating Appointment
//     (Invoice has no direct doctorId; Invoice.appointmentId →
//     Appointment.doctorId is the canonical doctor link.).
//
// JSON response shape mirrors the §4.4 spec from the gap doc:
//   { dateRange, tdsRate, totals: {totalGross, totalTds, totalNet,
//     doctorCount, invoiceCount}, byDoctor: [{ doctorId, doctorName,
//     totalGrossFees, tdsRate, tdsAmount, netPayable, invoiceCount }] }
//
// RBAC: ADMIN only — mirrors the §4.4 referral-commission ledger
// posture. Spec called for ADMIN + BILLING but the shared `Role` enum
// (packages/shared/src/types/roles.ts) doesn't yet expose BILLING
// even though the Prisma enum does. Widening is a one-line follow-up
// once the shared enum catches up.
//
// Tenant scope: tenantScopedPrisma auto-filters on the denormalized
// `Invoice.tenantId` column for every authed caller with a non-null
// `req.user.tenantId`. Super-admins (tenantId === null) see the full
// cross-tenant view by design.
//
// Audit: TDS_REPORT_EXPORTED fires only on format=csv (read-only JSON
// browsing is unaudited per the analytics / billing convention,
// matching the referral-commission ledger).
router.get(
  "/tds-report",
  authorize(Role.ADMIN, Role.BILLING),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        from: fromQ,
        to: toQ,
        doctorId,
        branchId,
        tdsRate: tdsRateQ,
        format = "json",
      } = req.query as Record<string, string | undefined>;

      // Defaults: from = first day of current month; to = now.
      const now = new Date();
      const from = fromQ
        ? new Date(fromQ)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const to = toQ ? new Date(toQ) : now;
      if (isNaN(from.getTime())) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid `from` date",
        });
        return;
      }
      if (isNaN(to.getTime())) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid `to` date",
        });
        return;
      }

      // tdsRate: 0 < rate ≤ 30 (sanity guard — §194J default 10%,
      // some clinics negotiate 5%, audit edge cases up to 30%).
      let tdsRate = 10;
      if (tdsRateQ !== undefined && tdsRateQ !== "") {
        const parsed = Number(tdsRateQ);
        if (isNaN(parsed) || parsed < 0 || parsed > 30) {
          res.status(400).json({
            success: false,
            data: null,
            error: "`tdsRate` must be a number between 0 and 30",
          });
          return;
        }
        tdsRate = parsed;
      }

      // Pearl §4.4 row 120 — optional branchId filter. Validate against
      // the caller's tenant: a Branch from another tenant or a
      // non-existent id both 400 (no information leak — same error msg).
      // Lookup goes through rawPrisma so we can pin the tenantId in the
      // WHERE explicitly; tenantScopedPrisma would already hide cross-
      // tenant rows and we want to detect that case to 400 cleanly.
      let resolvedBranchName: string | null = null;
      if (branchId) {
        const callerTenantId = req.user?.tenantId ?? null;
        const branch = await rawPrisma.branch.findFirst({
          where: callerTenantId
            ? { id: branchId, tenantId: callerTenantId }
            : { id: branchId },
          select: { id: true, name: true },
        });
        if (!branch) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Branch not found in current tenant",
          });
          return;
        }
        resolvedBranchName = branch.name;
      }

      // Load invoices in window, paid or partially paid, with their
      // CONSULTATION line items + the appointment (for doctorId) +
      // the doctor user (for the report's display name).
      const where: Record<string, unknown> = {
        createdAt: { gte: from, lte: to },
        paymentStatus: { in: ["PAID", "PARTIAL"] },
      };
      if (doctorId) {
        // Filter by the originating appointment's doctor.
        where.appointment = { doctorId };
      }
      if (branchId) {
        // Invoice has a direct branchId column (schema.prisma:1738,
        // Pearl §7.2 piece 2b). Existing/legacy invoices land NULL and
        // are excluded when a branchId filter is in effect — correct.
        where.branchId = branchId;
      }

      const invoices = await prisma.invoice.findMany({
        where,
        include: {
          items: {
            where: { category: "CONSULTATION" },
            select: { amount: true },
          },
          appointment: {
            select: {
              doctorId: true,
              doctor: {
                select: {
                  id: true,
                  user: { select: { name: true } },
                },
              },
            },
          },
          branch: { select: { id: true, name: true } },
        },
      });

      // ── Aggregate per-doctor ─────────────────────────────────
      // branchNames carries the doctor → first-seen branch label so the
      // CSV's per-row Branch column is useful when callers don't supply
      // a branchId filter. When they do, every row collapses to the
      // resolved branch name (computed above).
      type DoctorBucket = {
        doctorId: string;
        doctorName: string;
        invoiceCount: number;
        totalGrossFees: number;
        branchId: string | null;
        branchName: string | null;
      };
      const byDoctorMap = new Map<string, DoctorBucket>();

      for (const inv of invoices) {
        const lineSum = inv.items.reduce(
          (acc, it) => acc + dec(it.amount),
          0,
        );
        if (lineSum <= 0) continue; // no consultation line on this invoice
        const docId = inv.appointment?.doctor?.id;
        if (!docId) continue; // orphan invoice with no appointment link
        const docName = inv.appointment?.doctor?.user?.name || "(unknown)";

        let bucket = byDoctorMap.get(docId);
        if (!bucket) {
          bucket = {
            doctorId: docId,
            doctorName: docName,
            invoiceCount: 0,
            totalGrossFees: 0,
            branchId: inv.branch?.id ?? null,
            branchName: inv.branch?.name ?? null,
          };
          byDoctorMap.set(docId, bucket);
        }
        bucket.invoiceCount += 1;
        bucket.totalGrossFees += lineSum;
      }

      // Round to 2dp, compute per-doctor TDS + net, sort by gross desc.
      const round2 = (n: number): number =>
        Math.round((n + Number.EPSILON) * 100) / 100;

      const byDoctor = Array.from(byDoctorMap.values())
        .map((b) => {
          const tdsAmount = round2((b.totalGrossFees * tdsRate) / 100);
          const totalGrossFees = round2(b.totalGrossFees);
          const netPayable = round2(totalGrossFees - tdsAmount);
          // When a branchId filter is in effect, every row collapses to
          // the resolved branch. Otherwise the row carries whatever
          // branch the first invoice in the bucket was stamped with
          // (Doctor.branchId is the home branch; an itinerant doctor
          // could span multiple — out of scope for the rollup display).
          const branchName = branchId
            ? resolvedBranchName
            : b.branchName;
          return {
            doctorId: b.doctorId,
            doctorName: b.doctorName,
            branchId: branchId ?? b.branchId,
            branchName,
            totalGrossFees: totalGrossFees.toFixed(2),
            tdsRate,
            tdsAmount: tdsAmount.toFixed(2),
            netPayable: netPayable.toFixed(2),
            invoiceCount: b.invoiceCount,
          };
        })
        .sort(
          (a, b) =>
            parseFloat(b.totalGrossFees) - parseFloat(a.totalGrossFees),
        );

      const totalGross = round2(
        byDoctor.reduce((s, b) => s + parseFloat(b.totalGrossFees), 0),
      );
      const totalTds = round2(
        byDoctor.reduce((s, b) => s + parseFloat(b.tdsAmount), 0),
      );
      const totalNet = round2(totalGross - totalTds);
      const totalInvoiceCount = byDoctor.reduce(
        (s, b) => s + b.invoiceCount,
        0,
      );

      // ── CSV export ──────────────────────────────────────────
      if (format === "csv") {
        const fromIso = from.toISOString().split("T")[0];
        const toIso = to.toISOString().split("T")[0];

        // When the caller filtered to a single branch, the summary row's
        // Branch cell carries that branch's name; otherwise it reads as
        // "All branches" so a spreadsheet review can spot the scope.
        const summaryBranchLabel = branchId
          ? resolvedBranchName ?? "(branch)"
          : "All branches";
        const summary: Record<string, unknown> = {
          Doctor: `TOTAL (${fromIso} → ${toIso})`,
          Branch: summaryBranchLabel,
          "Invoice Count": totalInvoiceCount,
          "Gross Fees (Rs)": totalGross.toFixed(2),
          "TDS Rate (%)": tdsRate,
          "TDS Amount (Rs)": totalTds.toFixed(2),
          "Net Payable (Rs)": totalNet.toFixed(2),
        };

        const dataRows = byDoctor.map((b) => ({
          Doctor: b.doctorName,
          Branch: b.branchName ?? "—",
          "Invoice Count": b.invoiceCount,
          "Gross Fees (Rs)": b.totalGrossFees,
          "TDS Rate (%)": b.tdsRate,
          "TDS Amount (Rs)": b.tdsAmount,
          "Net Payable (Rs)": b.netPayable,
        }));

        const csv = tdsToCsv(
          [summary, ...dataRows],
          [
            "Doctor",
            "Branch",
            "Invoice Count",
            "Gross Fees (Rs)",
            "TDS Rate (%)",
            "TDS Amount (Rs)",
            "Net Payable (Rs)",
          ],
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="tds-report-${fromIso}-${toIso}.csv"`,
        );

        auditLog(req, "TDS_REPORT_EXPORTED", "invoice", undefined, {
          from: from.toISOString(),
          to: to.toISOString(),
          tdsRate,
          doctorCount: byDoctor.length,
          branchId: branchId ?? null,
          format: "csv",
        }).catch(console.error);

        res.send(csv);
        return;
      }

      // ── JSON response ───────────────────────────────────────
      res.json({
        success: true,
        data: {
          dateRange: { from: from.toISOString(), to: to.toISOString() },
          branchId: branchId ?? null,
          branchName: branchId ? resolvedBranchName : null,
          tdsRate,
          totals: {
            totalGross: totalGross.toFixed(2),
            totalTds: totalTds.toFixed(2),
            totalNet: totalNet.toFixed(2),
            doctorCount: byDoctor.length,
            invoiceCount: totalInvoiceCount,
          },
          byDoctor,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as billingRouter };

// ─── RAZORPAY WEBHOOK ────────────────────────────────────
//
// Razorpay sends server-to-server callbacks for payment events. Unlike the
// browser /verify-payment flow these are NOT authenticated by JWT — they are
// authenticated by HMAC over the raw request body.
//
// This router is exported separately so it can be mounted BEFORE the auth
// middleware on the main billing router. It also uses `express.raw` so we can
// hash the un-parsed body — JSON.stringify on a parsed body would break HMAC
// because key order / whitespace are not preserved.

const webhookRouter = Router();

interface WebhookPaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number; // paise
  status?: string;
  error_description?: string;
  notes?: Record<string, string>;
}
interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: WebhookPaymentEntity };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
  };
}

// Result shape so the route can decide whether to 200-ack (default) or
// surface a non-200 (e.g. fraud guard rejection). Returning undefined =
// normal idempotent ack.
type CapturedResult = { fraudSuspect: true; invoiceId: string } | undefined;

async function handlePaymentCaptured(
  entity: WebhookPaymentEntity,
  req: Request
): Promise<CapturedResult> {
  const orderId = entity.order_id;
  const paymentId = entity.id;
  const amountPaise = entity.amount;
  if (!orderId || !paymentId || typeof amountPaise !== "number") return;

  // Idempotency check up front — Razorpay retries failed webhooks.
  const existing = await prisma.payment.findUnique({
    where: { transactionId: paymentId },
  });
  if (existing) return;

  const invoice = await prisma.invoice.findFirst({
    where: { razorpayOrderId: orderId },
    include: { payments: true },
  });
  if (!invoice) {
    console.warn("[razorpay-webhook] invoice not found for order", orderId);
    return;
  }

  // Fraud guard: a DIFFERENT transactionId arriving against an invoice
  // that's already PAID is suspicious. Payment.transactionId @unique only
  // catches duplicate deliveries of the SAME id; a forged webhook with a
  // fresh id would otherwise slip past the amountPaise < remainingPaise
  // check below as a silent no-op (remainingPaise = 0).
  if (invoice.paymentStatus === "PAID") {
    // Same transactionId already on this invoice → legitimate Razorpay
    // retry. The `existing` check above is global; this is the
    // per-invoice scoping the fraud-guard branch needs.
    const sameTxn = await prisma.payment.findFirst({
      where: { invoiceId: invoice.id, transactionId: paymentId },
      select: { id: true },
    });
    if (sameTxn) {
      console.log(
        "[razorpay-webhook] retry of known transactionId on PAID invoice — idempotent ack",
        { invoiceId: invoice.id, transactionId: paymentId }
      );
      return;
    }

    // Different transactionId on a settled invoice — Razorpay should
    // never legitimately do this. Audit + reject.
    await auditLog(req, "RAZORPAY_WEBHOOK_FRAUD_SUSPECT", "Invoice", invoice.id, {
      incomingTransactionId: paymentId,
      invoiceStatus: "PAID",
      amountPaise,
      orderId,
    });
    console.error(
      "[razorpay-webhook] FRAUD SUSPECT: different transactionId on PAID invoice",
      {
        invoiceId: invoice.id,
        incomingTransactionId: paymentId,
        amountPaise,
        orderId,
      }
    );
    return { fraudSuspect: true, invoiceId: invoice.id };
  }

  const totalPaid = invoice.payments.reduce((s, p) => s + p.amount, 0);
  const invTotalN = dec(invoice.totalAmount);
  const remainingPaise = Math.round((invTotalN - totalPaid) * 100);
  if (amountPaise < remainingPaise) {
    console.warn("[razorpay-webhook] captured amount less than remaining", {
      invoiceId: invoice.id,
      amountPaise,
      remainingPaise,
    });
    return;
  }

  const amountRupees = amountPaise / 100;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: amountRupees,
          mode: "ONLINE",
          transactionId: paymentId,
          status: "CAPTURED",
        },
      });
      const newTotalPaid = totalPaid + amountRupees;
      const newStatus = newTotalPaid >= invTotalN ? "PAID" : "PARTIAL";
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paymentStatus: newStatus },
      });
    });

    // Fire-and-forget notification — do NOT await; we want to ack the webhook
    // quickly so Razorpay doesn't retry.
    onPaymentReceived(
      { id: paymentId, amount: amountRupees, mode: "ONLINE" },
      {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: invoice.totalAmount,
        patientId: invoice.patientId,
      }
    ).catch((e) => console.error("[razorpay-webhook] notify failed", e));
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
      // Lost the race against /verify-payment — the row already exists. Ack OK.
      return;
    }
    throw e;
  }
}

async function handlePaymentFailed(entity: WebhookPaymentEntity): Promise<void> {
  const orderId = entity.order_id;
  const paymentId = entity.id;
  if (!orderId || !paymentId) return;

  const existing = await prisma.payment.findUnique({
    where: { transactionId: paymentId },
  });
  if (existing) return;

  const invoice = await prisma.invoice.findFirst({
    where: { razorpayOrderId: orderId },
  });
  if (!invoice) return;

  try {
    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: 0,
        mode: "ONLINE",
        transactionId: paymentId,
        status: "FAILED",
      },
    });
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") return;
    throw e;
  }
}

// Refund webhook handler — Razorpay's `refund.processed` event.
//
// What it does: writes a negative-amount Payment row (status=REFUNDED,
// transactionId=`RZP_REFUND:<refundId>`) against the original payment's
// invoice and recomputes the invoice's paymentStatus.
//
// Surfaces touched: prisma.payment, prisma.invoice, audit log; routed
// from POST /api/v1/billing/razorpay-webhook (refund.processed case).
//
// Fraud guards (mirror of the captured-side guard in
// handlePaymentCaptured): a forged or replayed Razorpay webhook can
// arrive with a fresh `id` but pointing at (a) an original payment that
// is FAILED or already REFUNDED, or (b) an `amount` greater than the
// payment it claims to refund. Either is non-physical: Razorpay never
// legitimately refunds beyond what was captured. Both cases audit and
// surface a 409 to the route so the response carries a structured
// fraud-suspect code instead of silently writing a fictitious refund.
type RefundResult =
  | {
      fraudSuspect: true;
      invoiceId: string;
      reason:
        | "REFUND_AGAINST_NON_CAPTURED_PAYMENT"
        | "REFUND_EXCEEDS_PAYMENT"
        | "REFUND_CUMULATIVE_EXCEEDS_PAYMENT";
    }
  | undefined;

async function handleRefundProcessed(
  entity: {
    id?: string;
    payment_id?: string;
    amount?: number;
  },
  req: Request
): Promise<RefundResult> {
  const refundId = entity.id;
  const paymentId = entity.payment_id;
  if (!refundId || !paymentId) return;

  const original = await prisma.payment.findUnique({
    where: { transactionId: paymentId },
  });
  if (!original) return;

  const refundTxnId = `RZP_REFUND:${refundId}`;
  const dup = await prisma.payment.findUnique({
    where: { transactionId: refundTxnId },
  });
  if (dup) return;

  // Fraud guard 1: refund.processed should only ever arrive against a
  // CAPTURED payment. If the original is FAILED or already REFUNDED,
  // this is either a bug in the upstream system or a forged webhook.
  if (original.status !== "CAPTURED") {
    await auditLog(req, "RAZORPAY_WEBHOOK_FRAUD_SUSPECT", "Payment", original.id, {
      kind: "REFUND_AGAINST_NON_CAPTURED_PAYMENT",
      incomingRefundId: refundId,
      originalTransactionId: paymentId,
      originalStatus: original.status,
      amountPaise: entity.amount,
    });
    console.error(
      "[razorpay-webhook] FRAUD SUSPECT: refund.processed against non-CAPTURED payment",
      {
        invoiceId: original.invoiceId,
        originalPaymentId: original.id,
        originalStatus: original.status,
        incomingRefundId: refundId,
      }
    );
    return {
      fraudSuspect: true,
      invoiceId: original.invoiceId,
      reason: "REFUND_AGAINST_NON_CAPTURED_PAYMENT",
    };
  }

  const refundAmount =
    typeof entity.amount === "number" ? entity.amount / 100 : original.amount;

  // Fraud guard 2: a single refund cannot exceed the payment it refunds.
  // Razorpay never legitimately does this; per-event sanity check that
  // catches the obvious forgery before we look at cumulative.
  if (refundAmount > original.amount) {
    await auditLog(req, "RAZORPAY_WEBHOOK_FRAUD_SUSPECT", "Payment", original.id, {
      kind: "REFUND_EXCEEDS_PAYMENT",
      incomingRefundId: refundId,
      originalTransactionId: paymentId,
      originalAmount: original.amount,
      refundAmount,
      amountPaise: entity.amount,
    });
    console.error(
      "[razorpay-webhook] FRAUD SUSPECT: refund amount exceeds original payment",
      {
        invoiceId: original.invoiceId,
        originalPaymentId: original.id,
        originalAmount: original.amount,
        refundAmount,
        incomingRefundId: refundId,
      }
    );
    return {
      fraudSuspect: true,
      invoiceId: original.invoiceId,
      reason: "REFUND_EXCEEDS_PAYMENT",
    };
  }

  // Fraud guard 3: cumulative refunds against the same parent CAPTURED
  // payment must not exceed the original amount. Catches the "many small
  // partial refunds totalling > 100%" forgery class that guard 2 lets
  // through (each event is < original; only the sum is over).
  //
  // Sums prior refund-Payment rows whose `parentPaymentId === original.id`.
  // Refund Payment rows store the refund amount as a NEGATIVE float; we
  // sum-of-abs to keep the math obvious. Status filter excludes any
  // FAILED retry attempts (current code never writes FAILED on a refund
  // Payment but we keep the filter for defence in depth).
  const priorRefunds = await prisma.payment.findMany({
    where: { parentPaymentId: original.id, status: "REFUNDED" },
    select: { amount: true },
  });
  const priorRefundTotal = priorRefunds.reduce(
    (sum, p) => sum + Math.abs(p.amount),
    0
  );
  if (priorRefundTotal + refundAmount > original.amount) {
    await auditLog(
      req,
      "RAZORPAY_WEBHOOK_FRAUD_SUSPECT",
      "Payment",
      original.id,
      {
        kind: "REFUND_CUMULATIVE_EXCEEDS_PAYMENT",
        incomingRefundId: refundId,
        originalTransactionId: paymentId,
        originalAmount: original.amount,
        priorRefundTotal,
        incomingRefundAmount: refundAmount,
        cumulativeAfter: priorRefundTotal + refundAmount,
        amountPaise: entity.amount,
      }
    );
    console.error(
      "[razorpay-webhook] FRAUD SUSPECT: cumulative refunds exceed original payment",
      {
        invoiceId: original.invoiceId,
        originalPaymentId: original.id,
        originalAmount: original.amount,
        priorRefundTotal,
        incomingRefundAmount: refundAmount,
        incomingRefundId: refundId,
      }
    );
    return {
      fraudSuspect: true,
      invoiceId: original.invoiceId,
      reason: "REFUND_CUMULATIVE_EXCEEDS_PAYMENT",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          invoiceId: original.invoiceId,
          amount: -Math.abs(refundAmount),
          mode: "ONLINE",
          transactionId: refundTxnId,
          status: "REFUNDED",
          // Stamp the FK so the next refund event can sum prior refunds
          // against this captured payment (fraud guard 3 above).
          parentPaymentId: original.id,
        },
      });
      const after = await tx.payment.findMany({
        where: { invoiceId: original.invoiceId },
      });
      const net = after.reduce(
        (s, p) => s + (p.status === "FAILED" ? 0 : p.amount),
        0
      );
      const inv = await tx.invoice.findUnique({
        where: { id: original.invoiceId },
      });
      if (!inv) return;
      let newStatus: "PENDING" | "PARTIAL" | "PAID" | "REFUNDED";
      if (net <= 0) newStatus = "REFUNDED";
      else if (net >= dec(inv.totalAmount)) newStatus = "PAID";
      else newStatus = "PARTIAL";
      await tx.invoice.update({
        where: { id: inv.id },
        data: { paymentStatus: newStatus },
      });
    });
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") return;
    throw e;
  }
}

webhookRouter.post(
  "/razorpay-webhook",
  // raw-body: HMAC must be computed over the bytes Razorpay signed. Express's
  // default JSON parser would discard whitespace + reorder keys, breaking the
  // signature. Restrict the raw parser to ONLY this route.
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req: Request, res: Response) => {
    const signature = req.header("x-razorpay-signature");
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const raw: Buffer = (req.body as Buffer) ?? Buffer.from("");

    if (!signature) {
      res.status(401).json({ success: false, error: "missing signature" });
      return;
    }
    if (!verifyWebhookSignature(raw, signature, secret)) {
      res.status(401).json({ success: false, error: "invalid signature" });
      return;
    }

    let event: WebhookEvent;
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      event = JSON.parse(text);
    } catch {
      res.status(400).json({ success: false, error: "invalid json" });
      return;
    }

    // Ack quickly — do work synchronously only for idempotent state updates.
    // Slow side-effects (notifications) are fire-and-forget inside handlers.
    try {
      switch (event.event) {
        case "payment.captured":
          if (event.payload?.payment?.entity) {
            const result = await handlePaymentCaptured(
              event.payload.payment.entity,
              req
            );
            if (result?.fraudSuspect) {
              res.status(409).json({
                success: false,
                data: null,
                error: "Invoice already settled",
                code: "INVOICE_ALREADY_PAID_DIFFERENT_TXN",
              });
              return;
            }
          }
          break;
        case "payment.failed":
          if (event.payload?.payment?.entity) {
            await handlePaymentFailed(event.payload.payment.entity);
          }
          break;
        case "refund.processed":
          if (event.payload?.refund?.entity) {
            const result = await handleRefundProcessed(
              event.payload.refund.entity,
              req
            );
            if (result?.fraudSuspect) {
              const errorByReason: Record<typeof result.reason, string> = {
                REFUND_AGAINST_NON_CAPTURED_PAYMENT:
                  "Refund against non-CAPTURED payment",
                REFUND_EXCEEDS_PAYMENT: "Refund amount exceeds original payment",
                REFUND_CUMULATIVE_EXCEEDS_PAYMENT:
                  "Cumulative refunds exceed original payment",
              };
              res.status(409).json({
                success: false,
                data: null,
                error: errorByReason[result.reason],
                code: result.reason,
              });
              return;
            }
          }
          break;
        default:
          // Unknown / unhandled event — still 200 so Razorpay doesn't retry.
          break;
      }
    } catch (e) {
      console.error("[razorpay-webhook] handler error", e);
      // Still 200: avoid an infinite Razorpay retry loop on handler bugs.
      // Errors are logged for ops to investigate.
    }

    res.status(200).json({ success: true });
  }
);

export { webhookRouter as razorpayWebhookRouter };
