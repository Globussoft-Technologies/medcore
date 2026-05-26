/**
 * Referral commission API — Pearl ERP Stage 1 §4.1 (gap row 101) + §4.4 (row 114).
 *
 * What / which modules / why:
 *   - CRUD surface for the `ReferralCommission` rows auto-created by
 *     the POST /api/v1/billing/invoices handler when the invoice's
 *     `referringDoctorId` resolves to a doctor with a non-null
 *     commissionPercent (Referral override → Doctor default).
 *   - Three endpoints:
 *       GET  /        — list + filter for the BILLING / ADMIN ledger UI
 *       GET  /ledger  — aggregated per-doctor ledger report (§4.4 row 114)
 *                       with JSON (default) + CSV export modes
 *       PATCH /:id    — mark PAID (or manually VOIDED) with audit row
 *
 * RBAC:
 *   - GET / (list) + PATCH /:id (mark-paid): ADMIN only.
 *   - GET /ledger (§4.4 row 114 report): ADMIN + BILLING — widened
 *     2026-05-24 once `BILLING` landed on the shared `Role` enum (Pearl
 *     OPEN_DECISIONS item #4). The list + PATCH stay ADMIN-only to keep
 *     write authority concentrated; the read-only report is the surface
 *     finance staff actually need without bumping them to full ADMIN.
 *
 * Audit:
 *   - REFERRAL_COMMISSION_PAID / REFERRAL_COMMISSION_VOIDED_MANUAL on
 *     entity="referral_commission". Fire-and-forget per the project's
 *     safe-audit convention — tests reading AuditLog immediately after
 *     these actions should use waitForAuditFlush().
 *   - REFERRAL_COMMISSION_LEDGER_EXPORTED on entity="referral_commission"
 *     when the ledger endpoint is hit with format=csv. Read-only JSON
 *     browsing is NOT audited (no project-wide convention to audit
 *     read-only reports — analytics CSV exports are also unaudited).
 */

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { prisma as rawPrisma } from "@medcore/db";
import {
  Role,
  updateReferralCommissionSchema,
} from "@medcore/shared";
import type { UpdateReferralCommissionInput } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ── GET / — list + filter ─────────────────────────────────────────────
router.get(
  "/",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        status,
        referringDoctorId,
        from,
        to,
        page = "1",
        limit = "20",
      } = req.query as Record<string, string | undefined>;

      // Cross-tenant scope (2026-05-27): when the caller has no
      // `req.user.tenantId` (default seed admin), `tenantScopedPrisma` is
      // a no-op — which would let a tenant-less admin see EVERY tenant's
      // commission rows. Pin the where-clause to the caller's tenantId
      // (or `""`, the auto-create handler's empty-string fallback for
      // tenant-less deploys per billing.ts:504) so a default-tenant
      // ADMIN sees only default-tenant rows.
      const callerTenantId = req.user?.tenantId ?? "";
      const where: Record<string, unknown> = { tenantId: callerTenantId };
      if (status) where.status = status;
      if (referringDoctorId) where.referringDoctorId = referringDoctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) {
          const f = new Date(from);
          if (isNaN(f.getTime())) {
            res.status(400).json({
              success: false,
              data: null,
              error: "Invalid `from` date",
            });
            return;
          }
          range.gte = f;
        }
        if (to) {
          const t = new Date(to);
          if (isNaN(t.getTime())) {
            res.status(400).json({
              success: false,
              data: null,
              error: "Invalid `to` date",
            });
            return;
          }
          range.lte = t;
        }
        where.createdAt = range;
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = Math.min(parseInt(limit), 100);

      const [rows, total] = await Promise.all([
        prisma.referralCommission.findMany({
          where,
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                subtotal: true,
                totalAmount: true,
                paymentStatus: true,
                createdAt: true,
              },
            },
            referringDoctor: {
              include: { user: { select: { name: true, email: true } } },
            },
          },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.referralCommission.count({ where }),
      ]);

      res.json({
        success: true,
        data: rows,
        error: null,
        meta: { page: parseInt(page), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── CSV helpers (mirrors apps/api/src/routes/analytics.ts toCsv) ─────
function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(","));
  return [header, ...lines].join("\r\n");
}

// ── GET /ledger — aggregated per-doctor ledger (Pearl §4.4 row 114) ──
//
// Query params (all optional):
//   from               ISO date — defaults to first day of current month
//   to                 ISO date — defaults to today (now)
//   referringDoctorId  UUID — single-doctor filter
//   format             "json" (default) | "csv"
//
// JSON response (default):
//   { dateRange, totals: {total/paid/pending/voided count+amount},
//     byDoctor: [{ referringDoctorId, referringDoctorName, count,
//                  totalAmount, paidAmount, pendingAmount, voidedAmount,
//                  rows: [...] }] }
//
// CSV response (format=csv): one row per ReferralCommission, with a
// summary row at the top. Filename =
//   referral-commissions-<from>-<to>.csv  (Content-Disposition: attachment).
//
// RBAC: ADMIN + BILLING. Tenant-scoped via tenantScopedPrisma (no manual
// where: { tenantId } needed — the per-tenant Prisma extension auto-filters
// on the denormalized `ReferralCommission.tenantId` column).
//
// Audit: REFERRAL_COMMISSION_LEDGER_EXPORTED fired only on format=csv.
router.get(
  "/ledger",
  authorize(Role.ADMIN, Role.BILLING),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        from: fromQ,
        to: toQ,
        referringDoctorId,
        branchId,
        format = "json",
      } = req.query as Record<string, string | undefined>;

      // Defaults: from = first day of current month; to = now.
      const now = new Date();
      let from = fromQ
        ? new Date(fromQ)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      let to = toQ ? new Date(toQ) : now;
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

      // Pearl §4.4 row 120 — optional branchId filter. Validate against
      // the caller's tenant: a Branch from another tenant or a
      // non-existent id both 400 (no information leak — same error msg).
      // Lookup goes through rawPrisma so we can pin tenantId in the WHERE
      // and detect the cross-tenant case rather than just hiding it.
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

      const where: Record<string, unknown> = {
        createdAt: { gte: from, lte: to },
      };
      if (referringDoctorId) where.referringDoctorId = referringDoctorId;
      if (branchId) {
        // ReferralCommission has no direct branchId; scope via its
        // 1-1 invoice. Invoice.branchId is the canonical link
        // (schema.prisma:1738).
        (where as { invoice?: { branchId?: string } }).invoice = {
          branchId,
        };
      }

      const rows = await prisma.referralCommission.findMany({
        where,
        include: {
          referringDoctor: {
            include: { user: { select: { name: true, email: true } } },
          },
          invoice: {
            select: {
              invoiceNumber: true,
              branchId: true,
              branch: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // ── Aggregate per-doctor + top-level totals ────────────────
      const toNum = (v: unknown): number => {
        if (v == null) return 0;
        if (typeof v === "number") return v;
        const anyV = v as { toNumber?: () => number };
        return typeof anyV.toNumber === "function"
          ? anyV.toNumber()
          : Number(v);
      };

      type DoctorBucket = {
        referringDoctorId: string;
        referringDoctorName: string;
        branchId: string | null;
        branchName: string | null;
        count: number;
        totalAmount: number;
        paidAmount: number;
        pendingAmount: number;
        voidedAmount: number;
        rows: Array<{
          id: string;
          invoiceId: string;
          invoiceNumber: string;
          branchId: string | null;
          branchName: string | null;
          commissionPercent: number;
          commissionAmount: number;
          status: string;
          paidAt: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
      };

      const byDoctorMap = new Map<string, DoctorBucket>();
      let totalCount = 0;
      let totalAmount = 0;
      let paidAmount = 0;
      let pendingAmount = 0;
      let voidedAmount = 0;
      let paidCount = 0;
      let pendingCount = 0;
      let voidedCount = 0;

      for (const r of rows) {
        const amt = toNum(r.commissionAmount);
        const docId = r.referringDoctorId;
        const docName = r.referringDoctor?.user?.name || "(unknown)";
        totalCount += 1;
        totalAmount += amt;
        if (r.status === "PAID") {
          paidAmount += amt;
          paidCount += 1;
        } else if (r.status === "VOIDED") {
          voidedAmount += amt;
          voidedCount += 1;
        } else {
          pendingAmount += amt;
          pendingCount += 1;
        }

        let bucket = byDoctorMap.get(docId);
        if (!bucket) {
          bucket = {
            referringDoctorId: docId,
            referringDoctorName: docName,
            // First-seen branch becomes the bucket's label. When the
            // caller filtered by branchId, every row collapses to the
            // resolved branch name (rendered at output time).
            branchId: (r as any).invoice?.branchId ?? null,
            branchName: (r as any).invoice?.branch?.name ?? null,
            count: 0,
            totalAmount: 0,
            paidAmount: 0,
            pendingAmount: 0,
            voidedAmount: 0,
            rows: [],
          };
          byDoctorMap.set(docId, bucket);
        }
        bucket.count += 1;
        bucket.totalAmount += amt;
        if (r.status === "PAID") bucket.paidAmount += amt;
        else if (r.status === "VOIDED") bucket.voidedAmount += amt;
        else bucket.pendingAmount += amt;

        bucket.rows.push({
          id: r.id,
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoice?.invoiceNumber || "",
          branchId: (r as any).invoice?.branchId ?? null,
          branchName: (r as any).invoice?.branch?.name ?? null,
          commissionPercent: toNum(r.commissionPercent),
          commissionAmount: amt,
          status: r.status,
          paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
          createdAt: new Date(r.createdAt).toISOString(),
          updatedAt: new Date(r.updatedAt).toISOString(),
        });
      }

      // Sort doctor buckets by totalAmount desc (top earners first)
      const byDoctor = Array.from(byDoctorMap.values()).sort(
        (a, b) => b.totalAmount - a.totalAmount,
      );

      const fmt = (n: number) => n.toFixed(2);

      // ── CSV export ─────────────────────────────────────────────
      if (format === "csv") {
        const fromIso = from.toISOString().split("T")[0];
        const toIso = to.toISOString().split("T")[0];

        // Summary row at the top (Doctor column carries the label so it
        // reads in any spreadsheet without column re-ordering). Branch
        // column is "All branches" when no filter, else the resolved
        // branch name. Per-row Branch carries the invoice's branch (or
        // "—" when the invoice has none — pre-Pearl-§7.2 legacy rows).
        const summaryBranchLabel = branchId
          ? resolvedBranchName ?? "(branch)"
          : "All branches";
        const summary: Record<string, unknown> = {
          Doctor: `TOTAL (${fromIso} → ${toIso})`,
          Branch: summaryBranchLabel,
          "Invoice #": `${totalCount} row(s)`,
          "Commission %": "",
          "Amount (Rs)": fmt(totalAmount),
          Status: `PAID:${fmt(paidAmount)} PENDING:${fmt(pendingAmount)} VOIDED:${fmt(voidedAmount)}`,
          Created: "",
          "Paid At": "",
        };

        const dataRows = rows.map((r) => ({
          Doctor: r.referringDoctor?.user?.name || "(unknown)",
          Branch: branchId
            ? resolvedBranchName ?? "—"
            : (r as any).invoice?.branch?.name ?? "—",
          "Invoice #": r.invoice?.invoiceNumber || "",
          "Commission %": toNum(r.commissionPercent).toFixed(2),
          "Amount (Rs)": toNum(r.commissionAmount).toFixed(2),
          Status: r.status,
          Created: new Date(r.createdAt).toISOString(),
          "Paid At": r.paidAt ? new Date(r.paidAt).toISOString() : "",
        }));

        const csv = toCsv(
          [summary, ...dataRows],
          [
            "Doctor",
            "Branch",
            "Invoice #",
            "Commission %",
            "Amount (Rs)",
            "Status",
            "Created",
            "Paid At",
          ],
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="referral-commissions-${fromIso}-${toIso}.csv"`,
        );

        auditLog(
          req,
          "REFERRAL_COMMISSION_LEDGER_EXPORTED",
          "referral_commission",
          undefined,
          {
            from: from.toISOString(),
            to: to.toISOString(),
            format: "csv",
            rowCount: rows.length,
            referringDoctorId: referringDoctorId ?? null,
            branchId: branchId ?? null,
          },
        ).catch(console.error);

        res.send(csv);
        return;
      }

      // ── JSON response ──────────────────────────────────────────
      res.json({
        success: true,
        data: {
          dateRange: { from: from.toISOString(), to: to.toISOString() },
          branchId: branchId ?? null,
          branchName: branchId ? resolvedBranchName : null,
          totals: {
            totalCommissions: totalCount,
            totalAmount: fmt(totalAmount),
            paidAmount: fmt(paidAmount),
            pendingAmount: fmt(pendingAmount),
            voidedAmount: fmt(voidedAmount),
            paidCount,
            pendingCount,
            voidedCount,
          },
          byDoctor: byDoctor.map((b) => ({
            referringDoctorId: b.referringDoctorId,
            referringDoctorName: b.referringDoctorName,
            branchId: branchId ?? b.branchId,
            branchName: branchId ? resolvedBranchName : b.branchName,
            count: b.count,
            totalAmount: fmt(b.totalAmount),
            paidAmount: fmt(b.paidAmount),
            pendingAmount: fmt(b.pendingAmount),
            voidedAmount: fmt(b.voidedAmount),
            rows: b.rows,
          })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — mark PAID or VOIDED ─────────────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateReferralCommissionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as UpdateReferralCommissionInput;

      const existing = await prisma.referralCommission.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Referral commission not found",
        });
        return;
      }

      // Idempotency guard: a row that's already PAID/VOIDED can't be
      // transitioned again. Return 409 so accounts UIs render the
      // current state instead of silently no-oping a click.
      if (existing.status !== "PENDING") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Referral commission is already ${existing.status} — no further transitions allowed`,
        });
        return;
      }

      const data: Record<string, unknown> = { status: body.status };
      if (body.status === "PAID") {
        data.paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
      }
      if (body.notes !== undefined) data.notes = body.notes;

      const updated = await prisma.referralCommission.update({
        where: { id: req.params.id },
        data,
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              totalAmount: true,
              paymentStatus: true,
            },
          },
          referringDoctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      auditLog(
        req,
        body.status === "PAID"
          ? "REFERRAL_COMMISSION_PAID"
          : "REFERRAL_COMMISSION_VOIDED_MANUAL",
        "referral_commission",
        updated.id,
        {
          invoiceId: updated.invoiceId,
          referringDoctorId: updated.referringDoctorId,
          commissionAmount: Number(updated.commissionAmount),
        },
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as referralCommissionsRouter };
