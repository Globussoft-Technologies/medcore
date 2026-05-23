/**
 * Cross-tenant DPDP erasure-request workbench — Pearl ERP Stage 1 §8.6
 * (gap row 224 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Surfaces `DPDPErasureRequest` rows across all tenants to the
 *     super-admin on `/super-admin/dpdp`. Patients (PWA), DPOs (external
 *     contact), and super-admins themselves can file a ticket via POST.
 *     A super-admin executes (runs the purge transaction in
 *     services/dpdp-purge.ts) or rejects a PENDING request.
 *   - RBAC mirrors `routes/scheduled-jobs.ts:requireSuperAdmin` —
 *     `Role.ADMIN` with `tenantId == null` OR membership on the seeded
 *     "default" tenant. A tenant-scoped ADMIN cannot see / execute
 *     other tenants' purges. The POST endpoint additionally accepts
 *     PATIENT-role callers but only for self-filed requests.
 *   - Each mutating action writes an AuditLog row:
 *       DPDP_ERASURE_REQUESTED  → on POST /
 *       DPDP_ERASURE_EXECUTED   → on POST /:id/execute (includes receipt)
 *       DPDP_ERASURE_REJECTED   → on POST /:id/reject
 *
 * Mount at /api/v1/dpdp-workbench (see app.ts).
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { purgePatient, DPDPPurgeError } from "../services/dpdp-purge";
import {
  generateErasureReceipt,
  renderErasureReceiptPdf,
  ErasureReceiptNotFoundError,
} from "../services/dpdp-receipt";

const router = Router();

// ─── Super-admin guard ───────────────────────────────────────────────
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const callerTenantId = req.user?.tenantId ?? null;
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
      error: "Only super-admins can access the DPDP erasure workbench",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const erasureStatusEnum = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "REJECTED",
]);

const listQuerySchema = z.object({
  status: erasureStatusEnum.optional(),
  tenantId: z.string().trim().min(1).max(64).optional(),
  from: z
    .string()
    .datetime()
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z
    .string()
    .datetime()
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

const createSchema = z.object({
  patientId: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(2000).optional(),
  requestedByRole: z.enum(["PATIENT", "DPO_EXTERNAL", "SUPER_ADMIN"]),
  // DPO_EXTERNAL must supply an email since they don't have a User row.
  dpoEmail: z.string().email().max(200).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

const executeSchema = z.object({});

// ─── GET /api/v1/dpdp-workbench/requests ─────────────────────────────
// Super-admin: list across all tenants. Tenant-scoped admins are
// rejected by requireSuperAdmin before this handler runs.
router.get(
  "/requests",
  authenticate,
  authorize(Role.ADMIN),
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { status, tenantId, from, to, limit, cursor } = parsed.data;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (tenantId) where.tenantId = tenantId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.requestedAt = range;
      }
      const take = limit ?? 50;
      const rows = await prisma.dPDPErasureRequest.findMany({
        where,
        orderBy: { requestedAt: "desc" },
        take: take + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      res.status(200).json({
        success: true,
        data: {
          requests: slice,
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/dpdp-workbench/requests ────────────────────────────
// File a new erasure request. Three caller shapes:
//   - PATIENT (self): role guard allows; we verify the patientId belongs
//     to the caller before accepting.
//   - DPO_EXTERNAL: only super-admin can submit on behalf of (we store
//     the DPO's email in requestedBy).
//   - SUPER_ADMIN: filed by the operator themselves.
router.post(
  "/requests",
  authenticate,
  validate(createSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createSchema>;
      const callerRole = req.user?.role;

      // PATIENT-self file path: must own the row.
      if (body.requestedByRole === "PATIENT") {
        if (callerRole !== Role.PATIENT) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Only the patient can file a self request as PATIENT",
          });
          return;
        }
        const callerPatient = await prisma.patient.findFirst({
          where: { userId: req.user?.userId },
          select: { id: true, tenantId: true },
        });
        if (!callerPatient || callerPatient.id !== body.patientId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "You can only file an erasure request for yourself",
          });
          return;
        }
      } else {
        // DPO_EXTERNAL + SUPER_ADMIN routes are super-admin-only.
        if (callerRole !== Role.ADMIN) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Only super-admins can file DPO / SUPER_ADMIN requests",
          });
          return;
        }
        // Reuse the super-admin guard logic inline.
        const callerTenantId = req.user?.tenantId ?? null;
        if (callerTenantId != null) {
          const callerTenant = await prisma.tenant.findUnique({
            where: { id: callerTenantId },
            select: { subdomain: true },
          });
          if (callerTenant?.subdomain !== "default") {
            res.status(403).json({
              success: false,
              data: null,
              error: "Only super-admins can access the DPDP erasure workbench",
            });
            return;
          }
        }
      }

      // Patient existence check (also gives us tenantId for the row).
      const patient = await prisma.patient.findUnique({
        where: { id: body.patientId },
        select: { id: true, tenantId: true },
      });
      if (!patient) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Patient not found",
        });
        return;
      }

      // requestedBy: User.id for PATIENT/SUPER_ADMIN; DPO email otherwise.
      let requestedBy: string;
      if (body.requestedByRole === "DPO_EXTERNAL") {
        if (!body.dpoEmail) {
          res.status(400).json({
            success: false,
            data: null,
            error: "DPO_EXTERNAL requests require dpoEmail",
          });
          return;
        }
        requestedBy = body.dpoEmail;
      } else {
        requestedBy = req.user!.userId;
      }

      const row = await prisma.dPDPErasureRequest.create({
        data: {
          tenantId: patient.tenantId ?? "",
          patientId: patient.id,
          requestedBy,
          requestedByRole: body.requestedByRole,
          reason: body.reason ?? null,
          status: "PENDING",
        },
      });

      await auditLog(
        req,
        "DPDP_ERASURE_REQUESTED",
        "dpdp_erasure_request",
        row.id,
        {
          patientId: row.patientId,
          tenantId: row.tenantId,
          requestedByRole: row.requestedByRole,
        },
      );

      res.status(201).json({
        success: true,
        data: row,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/dpdp-workbench/requests/:id/execute ───────────────
// Run the purge. Super-admin only. Idempotent guard: 409 on
// COMPLETED/REJECTED rows.
router.post(
  "/requests/:id/execute",
  authenticate,
  authorize(Role.ADMIN),
  requireSuperAdmin,
  validate(executeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.dPDPErasureRequest.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Erasure request not found",
        });
        return;
      }
      if (row.status === "COMPLETED" || row.status === "REJECTED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Request is ${row.status}; cannot execute`,
        });
        return;
      }

      // Flip to IN_PROGRESS so the workbench reflects work in flight.
      await prisma.dPDPErasureRequest.update({
        where: { id: row.id },
        data: { status: "IN_PROGRESS" },
      });

      try {
        // PrismaClient cast: tenantScopedPrisma's extended client has
        // additional methods, but purgePatient only uses the standard
        // CRUD surface — the cast keeps the service free of the
        // tenant-scoped surface so workers can reuse it too.
        const receipt = await purgePatient(
          row.patientId,
          req.user!.userId,
          prisma as never,
        );
        const updated = await prisma.dPDPErasureRequest.update({
          where: { id: row.id },
          data: {
            status: "COMPLETED",
            executedAt: new Date(),
            executedBy: req.user!.userId,
            executionReceipt: receipt as never,
          },
        });

        await auditLog(
          req,
          "DPDP_ERASURE_EXECUTED",
          "dpdp_erasure_request",
          updated.id,
          {
            patientId: row.patientId,
            tenantId: row.tenantId,
            receipt,
          },
        );

        res.status(200).json({
          success: true,
          data: updated,
          error: null,
        });
      } catch (purgeErr) {
        const msg =
          purgeErr instanceof Error ? purgeErr.message : String(purgeErr);
        const receipt =
          purgeErr instanceof DPDPPurgeError ? purgeErr.receipt : undefined;
        const updated = await prisma.dPDPErasureRequest.update({
          where: { id: row.id },
          data: {
            status: "FAILED",
            failureReason: msg.slice(0, 5000),
            executionReceipt: (receipt as never) ?? undefined,
            executedAt: new Date(),
            executedBy: req.user!.userId,
          },
        });

        await auditLog(
          req,
          "DPDP_ERASURE_EXECUTED",
          "dpdp_erasure_request",
          updated.id,
          {
            patientId: row.patientId,
            tenantId: row.tenantId,
            status: "FAILED",
            failureReason: msg.slice(0, 500),
          },
        );

        res.status(500).json({
          success: false,
          data: updated,
          error: `Purge failed: ${msg}`,
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/dpdp-workbench/requests/:id/reject ────────────────
// Mark a PENDING request REJECTED with a reason. Super-admin only.
router.post(
  "/requests/:id/reject",
  authenticate,
  authorize(Role.ADMIN),
  requireSuperAdmin,
  validate(rejectSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.dPDPErasureRequest.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Erasure request not found",
        });
        return;
      }
      if (row.status !== "PENDING") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Only PENDING requests can be rejected (status is ${row.status})`,
        });
        return;
      }
      const body = req.body as z.infer<typeof rejectSchema>;

      const updated = await prisma.dPDPErasureRequest.update({
        where: { id: row.id },
        data: {
          status: "REJECTED",
          failureReason: body.reason,
          executedAt: new Date(),
          executedBy: req.user!.userId,
        },
      });

      await auditLog(
        req,
        "DPDP_ERASURE_REJECTED",
        "dpdp_erasure_request",
        updated.id,
        {
          patientId: row.patientId,
          tenantId: row.tenantId,
          reason: body.reason,
        },
      );

      res.status(200).json({
        success: true,
        data: updated,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/dpdp-workbench/requests/:id/receipt.json ───────────
// Pearl §12 row 382 — DPDP §17 right-to-erasure auditable receipt.
// Returns the structured JSON receipt (derived from the persisted
// DPDPErasureRequest + AuditLog rows) with a SHA-256 receiptHash so the
// document is tamper-evident. Super-admin only (mirrors workbench
// guard); writes a DPDP_RECEIPT_DOWNLOADED audit row.
router.get(
  "/requests/:id/receipt.json",
  authenticate,
  authorize(Role.ADMIN),
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receipt = await generateErasureReceipt(req.params.id, prisma);
      await auditLog(
        req,
        "DPDP_RECEIPT_DOWNLOADED",
        "dpdp_erasure_request",
        receipt.requestId,
        { format: "json", receiptHash: receipt.receiptHash },
      );
      res.status(200).json({
        success: true,
        data: receipt,
        error: null,
      });
    } catch (err) {
      if (err instanceof ErasureReceiptNotFoundError) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Erasure request not found",
        });
        return;
      }
      next(err);
    }
  },
);

// ─── GET /api/v1/dpdp-workbench/requests/:id/receipt.pdf ────────────
// Same surface as /receipt.json but renders a printable PDF
// (application/pdf) via pdfkit — matches the library used by
// services/pdf-generator.ts.
router.get(
  "/requests/:id/receipt.pdf",
  authenticate,
  authorize(Role.ADMIN),
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receipt = await generateErasureReceipt(req.params.id, prisma);
      const pdf = await renderErasureReceiptPdf(receipt);
      await auditLog(
        req,
        "DPDP_RECEIPT_DOWNLOADED",
        "dpdp_erasure_request",
        receipt.requestId,
        { format: "pdf", receiptHash: receipt.receiptHash, bytes: pdf.length },
      );
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="dpdp-receipt-${receipt.requestId}.pdf"`,
      );
      res.setHeader("Content-Length", String(pdf.length));
      res.end(pdf);
    } catch (err) {
      if (err instanceof ErasureReceiptNotFoundError) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Erasure request not found",
        });
        return;
      }
      next(err);
    }
  },
);

export const dpdpWorkbenchRouter = router;
