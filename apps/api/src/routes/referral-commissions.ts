/**
 * Referral commission API — Pearl ERP Stage 1 §4.1 (gap row 101).
 *
 * What / which modules / why:
 *   - CRUD surface for the `ReferralCommission` rows auto-created by
 *     the POST /api/v1/billing/invoices handler when the invoice's
 *     `referringDoctorId` resolves to a doctor with a non-null
 *     commissionPercent (Referral override → Doctor default).
 *   - Two endpoints only this tick:
 *       GET  /  — list + filter for the BILLING / ADMIN ledger UI
 *       PATCH /:id — mark PAID (or manually VOIDED) with audit row
 *   - NO ledger-rollup report endpoint — that's the §4.4 row 114 piece.
 *     This file just owns the persistence surface.
 *
 * RBAC:
 *   - Both endpoints: ADMIN only. (RECEPTION can raise invoices but
 *     can't see who got paid what — that's a financial-controls
 *     boundary. ACCOUNTANT / BILLING role exists in the codebase
 *     under different names — we standardise on ADMIN here and let
 *     the §4.4 piece widen the gate when the role model is firmer.)
 *
 * Audit:
 *   - REFERRAL_COMMISSION_PAID / REFERRAL_COMMISSION_VOIDED_MANUAL on
 *     entity="referral_commission". Fire-and-forget per the project's
 *     safe-audit convention — tests reading AuditLog immediately after
 *     these actions should use waitForAuditFlush().
 */

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
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

      const where: Record<string, unknown> = {};
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
