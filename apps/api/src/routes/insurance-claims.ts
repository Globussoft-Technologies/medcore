// Insurance TPA Claims router — submit / status / docs / cancel / list.
//
// Mounts at `/api/v1/claims`.
//
// Persistence: delegates to `services/insurance-claims/store.ts`, which is now
// a thin wrapper over Prisma (`InsuranceClaim`, `ClaimDocument`,
// `ClaimStatusEvent`). Store functions are async — all calls here await them.

import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import { z } from "zod";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";
import { uploadFile } from "../services/storage";
import { getAdapter } from "../services/insurance-claims/registry";
import { reconcilePendingClaims } from "../services/insurance-claims/reconciliation";
import {
  ClaimDocumentType,
  NormalisedClaimStatus,
  TpaProvider,
} from "../services/insurance-claims/adapter";
import {
  createClaim,
  getClaim,
  updateStatus,
  syncFromProvider,
  listClaims,
  addDocument,
  getDocuments,
  addEvent,
  getEvents,
  ClaimsQuery,
  InsuranceClaimRow,
} from "../services/insurance-claims/store";

const router = Router();

// Raise the body limit on this router because doc uploads arrive as base64
// JSON (same convention as the existing `/api/v1/uploads` route).
router.use(express.json({ limit: "14mb" }));
router.use(authenticate);

// ── Zod schemas ─────────────────────────────────────────────────────────────

const TPA_PROVIDERS = [
  "MEDI_ASSIST",
  "PARAMOUNT",
  "VIDAL",
  "FHPL",
  "ICICI_LOMBARD",
  "STAR_HEALTH",
  "MOCK",
] as const;

const DOC_TYPES = [
  "DISCHARGE_SUMMARY",
  "INVESTIGATION_REPORT",
  "PRESCRIPTION",
  "BILL",
  "ID_PROOF",
  "CONSENT_FORM",
  "OTHER",
] as const;

const submitClaimSchema = z.object({
  billId: z.string().uuid(),
  patientId: z.string().uuid(),
  tpaProvider: z.enum(TPA_PROVIDERS),
  insurerName: z.string().min(1),
  policyNumber: z.string().min(1),
  memberId: z.string().optional(),
  preAuthRequestId: z.string().uuid().optional(),
  diagnosis: z.string().min(1),
  icd10Codes: z.array(z.string()).optional(),
  procedureName: z.string().optional(),
  admissionDate: z.string().optional(),
  dischargeDate: z.string().optional(),
  amountClaimed: z.number().positive(),
  notes: z.string().optional(),
});

const uploadDocSchema = z.object({
  type: z.enum(DOC_TYPES),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  /** base64-encoded file bytes. */
  content: z.string().min(1),
});

const cancelSchema = z.object({
  reason: z.string().min(1),
});

// security(2026-04-23-med): F-CLM-1 — validate GET /claims query params so
// malformed status / tpa values produce a clean 400 rather than being
// forwarded to Prisma where they'd surface as a generic 500.
const NORMALISED_STATUSES = [
  "SUBMITTED",
  "IN_REVIEW",
  "APPROVED",
  "SETTLED",
  "DENIED",
  "CANCELLED",
] as const satisfies readonly NormalisedClaimStatus[];

const listClaimsQuerySchema = z.object({
  status: z.enum(NORMALISED_STATUSES).optional(),
  tpa: z.enum(TPA_PROVIDERS).optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  patientId: z.string().uuid().optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function notFound(res: Response, msg = "Claim not found"): void {
  res.status(404).json({ success: false, data: null, error: msg });
}

/**
 * Map an AdapterError.code to an HTTP status. Keeps route handlers terse.
 */
function mapErrorStatus(code: string): number {
  switch (code) {
    case "AUTH_FAILED":
      return 401;
    case "INVALID_INPUT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "RATE_LIMITED":
      return 429;
    case "TPA_UNAVAILABLE":
      return 502;
    case "BUSINESS_RULE":
      return 422;
    default:
      return 500;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/claims — submit a claim from a Bill (Invoice) + optional pre-auth.
 *
 * Flow:
 *   1. Validate bill + patient exist.
 *   2. Insert a draft claim row (status=SUBMITTED in-memory).
 *   3. Call adapter.submitClaim — on success, set providerClaimRef; on failure,
 *      bubble up the adapter error (the row stays in the store for retry).
 *   4. Audit log + return.
 */
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(submitClaimSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof submitClaimSchema>;

      // Validate the underlying Invoice + Patient actually exist.
      const invoice = await prisma.invoice.findUnique({
        where: { id: body.billId },
        include: { patient: { include: { user: true } } },
      });
      if (!invoice) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Bill (invoice) not found" });
        return;
      }
      if (invoice.patientId !== body.patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId does not match the invoice owner",
        });
        return;
      }

      // Optional pre-auth lookup for linkage.
      let preAuth = null;
      if (body.preAuthRequestId) {
        preAuth = await prisma.preAuthRequest.findUnique({
          where: { id: body.preAuthRequestId },
        });
        if (!preAuth) {
          res.status(404).json({
            success: false,
            data: null,
            error: "Pre-authorization not found",
          });
          return;
        }
      }

      // Write the draft row first so we have a stable internalClaimId for
      // adapter idempotency.
      const row = await createClaim({
        billId: body.billId,
        patientId: body.patientId,
        tpaProvider: body.tpaProvider,
        providerClaimRef: null,
        insurerName: body.insurerName,
        policyNumber: body.policyNumber,
        memberId: body.memberId ?? null,
        preAuthRequestId: body.preAuthRequestId ?? null,
        diagnosis: body.diagnosis,
        icd10Codes: body.icd10Codes ?? [],
        procedureName: body.procedureName ?? null,
        admissionDate: body.admissionDate ?? null,
        dischargeDate: body.dischargeDate ?? null,
        amountClaimed: body.amountClaimed,
        amountApproved: null,
        status: "SUBMITTED",
        deniedReason: null,
        notes: body.notes ?? null,
        submittedAt: new Date().toISOString(),
        approvedAt: null,
        settledAt: null,
        cancelledAt: null,
        lastSyncedAt: null,
        createdBy: req.user!.userId,
      });

      const adapter = getAdapter(body.tpaProvider);
      const result = await adapter.submitClaim({
        internalClaimId: row.id,
        invoiceId: invoice.id,
        patient: {
          name: invoice.patient.user.name,
          gender: invoice.patient.gender as "MALE" | "FEMALE" | "OTHER",
          dob: invoice.patient.dateOfBirth?.toISOString(),
          phone: invoice.patient.user.phone ?? undefined,
          address: invoice.patient.address ?? undefined,
        },
        policy: {
          policyNumber: body.policyNumber,
          insurerName: body.insurerName,
          tpaProvider: body.tpaProvider,
          memberId: body.memberId,
        },
        preAuthorization: preAuth
          ? {
              requestNumber: preAuth.requestNumber,
              claimReferenceNumber: preAuth.claimReferenceNumber ?? undefined,
              approvedAmount: preAuth.approvedAmount ?? undefined,
            }
          : undefined,
        diagnosis: body.diagnosis,
        icd10Codes: body.icd10Codes,
        procedureName: body.procedureName,
        admissionDate: body.admissionDate,
        dischargeDate: body.dischargeDate,
        amountClaimed: body.amountClaimed,
        notes: body.notes,
      });

      if (!result.ok) {
        res.status(mapErrorStatus(result.error.code)).json({
          success: false,
          data: { claimId: row.id },
          error: result.error.message,
          code: result.error.code,
        });
        return;
      }

      const updated = (await updateStatus(row.id, {
        status: result.data.status,
        providerClaimRef: result.data.providerRef,
        lastSyncedAt: new Date().toISOString(),
        note: `Submitted to ${body.tpaProvider}`,
        source: "API",
        createdBy: req.user!.userId,
      }))!;

      auditLog(req, "SUBMIT_CLAIM", "insurance_claim", row.id, {
        tpaProvider: body.tpaProvider,
        providerRef: result.data.providerRef,
        amountClaimed: body.amountClaimed,
      }).catch(console.error);

      res.status(201).json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/claims — list with filters.
 * Query params: status, tpa, from (ISO date), to (ISO date), patientId.
 */
// security(2026-04-23): role guard added — claims list contains PHI
// (diagnosis/ICD/amount/patientId) and was previously readable by any
// authenticated role, including PATIENT. Only billing-facing roles may list.
router.get("/", authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // security(2026-04-23-med): F-CLM-1 — validate query shape before building
    // the Prisma filter. Malformed values now produce a 400 instead of a 500
    // from Prisma at the driver layer.
    const parsed = listClaimsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        data: null,
        error: parsed.error.issues[0]?.message ?? "Invalid query",
      });
      return;
    }
    const { status, tpa, from, to, patientId } = parsed.data;
    const q: ClaimsQuery = {};
    if (status) q.status = status as NormalisedClaimStatus;
    if (tpa) q.tpa = tpa as TpaProvider;
    if (patientId) q.patientId = patientId;
    if (from) q.from = new Date(from);
    if (to) q.to = new Date(to);
    const rows = await listClaims(q);

    // PHI read — claims list reveals patient IDs, diagnoses, ICD codes. Audit
    // non-blocking so a transient DB blip on audit_logs can't take GETs down.
    auditLog(req, "INSURANCE_CLAIMS_LIST", "insurance_claim", undefined, {
      status: status ?? null,
      tpa: tpa ?? null,
      patientId: patientId ?? null,
      from: from ?? null,
      to: to ?? null,
      resultCount: rows.length,
    }).catch((err) => {
      console.warn(
        `[audit] INSURANCE_CLAIMS_LIST failed (non-fatal):`,
        (err as Error)?.message ?? err
      );
    });

    res.json({ success: true, data: rows, error: null });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/claims/:id — detail + timeline.
 * Optionally refreshes from the TPA when `?sync=1` is passed.
 */
// security(2026-04-23): role guard added — same rationale as GET /.
router.get("/:id", authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  // security(2026-04-23-med): F-CLM-3 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await getClaim(req.params.id);
    if (!row) {
      notFound(res);
      return;
    }

    if (req.query.sync === "1" && row.providerClaimRef) {
      const adapter = getAdapter(row.tpaProvider);
      const result = await adapter.getClaimStatus(row.providerClaimRef);
      if (result.ok) {
        const patch: Partial<InsuranceClaimRow> = {
          status: result.data.status,
          amountApproved: result.data.amountApproved ?? row.amountApproved,
          deniedReason: result.data.deniedReason ?? row.deniedReason,
          lastSyncedAt: new Date().toISOString(),
        };
        if (result.data.status === "APPROVED" && !row.approvedAt)
          patch.approvedAt = new Date().toISOString();
        if (result.data.status === "SETTLED" && !row.settledAt)
          patch.settledAt = new Date().toISOString();
        // Atomic: claim patch + timeline append in a single tx so we can't
        // end up with a new status and no matching event rows (or vice versa).
        await syncFromProvider(row.id, {
          patch,
          timeline: result.data.timeline.map((ev) => ({
            status: ev.status,
            timestamp: ev.timestamp,
            note: ev.note ?? null,
          })),
        });
      }
    }

    const fresh = (await getClaim(req.params.id))!;
    const [docs, timeline] = await Promise.all([
      getDocuments(fresh.id),
      getEvents(fresh.id),
    ]);

    auditLog(req, "INSURANCE_CLAIM_READ", "insurance_claim", fresh.id, {
      status: fresh.status,
      tpa: fresh.tpaProvider,
      synced: req.query.sync === "1",
    }).catch((err) => {
      console.warn(
        `[audit] INSURANCE_CLAIM_READ failed (non-fatal):`,
        (err as Error)?.message ?? err
      );
    });

    res.json({
      success: true,
      data: {
        ...fresh,
        documents: docs,
        timeline,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/claims/:id/documents — attach a supporting doc.
 * Body: { type, filename, contentType, content (base64) }.
 * We persist the file through the existing storage service and then forward
 * it to the TPA adapter.
 */
router.post(
  "/:id/documents",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  // security(2026-04-23-med): F-CLM-3 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
  validate(uploadDocSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await getClaim(req.params.id);
      if (!row) {
        notFound(res);
        return;
      }
      if (!row.providerClaimRef) {
        res.status(409).json({
          success: false,
          data: null,
          error:
            "Claim has not been accepted by the TPA yet — retry submit before uploading docs",
        });
        return;
      }

      const body = req.body as z.infer<typeof uploadDocSchema>;
      const buffer = Buffer.from(body.content, "base64");
      if (buffer.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Empty document content",
        });
        return;
      }

      // Persist locally so we always have a copy even if the TPA call later fails.
      const storage = await uploadFile(
        buffer,
        `claim-${row.id}-${Date.now()}-${body.filename}`,
        body.contentType
      );

      const adapter = getAdapter(row.tpaProvider);
      const result = await adapter.uploadDocument(
        row.providerClaimRef,
        body.type as ClaimDocumentType,
        buffer,
        body.filename,
        body.contentType
      );

      if (!result.ok) {
        res.status(mapErrorStatus(result.error.code)).json({
          success: false,
          data: null,
          error: result.error.message,
          code: result.error.code,
        });
        return;
      }

      const doc = await addDocument({
        claimId: row.id,
        type: body.type as ClaimDocumentType,
        fileKey: storage.key,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: buffer.length,
        providerDocId: result.data.providerDocId,
        uploadedBy: req.user!.userId,
      });
      await addEvent({
        claimId: row.id,
        status: row.status,
        note: `Document uploaded: ${body.type} (${body.filename})`,
        source: "API",
        createdBy: req.user!.userId,
      });

      auditLog(req, "CLAIM_DOCUMENT_UPLOAD", "insurance_claim", row.id, {
        type: body.type,
        providerDocId: result.data.providerDocId,
        sizeBytes: buffer.length,
      }).catch(console.error);

      res.status(201).json({ success: true, data: doc, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/claims/:id/cancel — withdraw the claim.
 */
router.post(
  "/:id/cancel",
  authorize(Role.ADMIN, Role.RECEPTION),
  // security(2026-04-23-med): F-CLM-3 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
  validate(cancelSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await getClaim(req.params.id);
      if (!row) {
        notFound(res);
        return;
      }
      const { reason } = req.body as z.infer<typeof cancelSchema>;
      if (!row.providerClaimRef) {
        // Never actually left our side — cancel locally only.
        const updated = (await updateStatus(row.id, {
          status: "CANCELLED",
          cancelledAt: new Date().toISOString(),
          note: `Cancelled before TPA submission: ${reason}`,
          source: "MANUAL",
          createdBy: req.user!.userId,
        }))!;
        res.json({ success: true, data: updated, error: null });
        return;
      }

      const adapter = getAdapter(row.tpaProvider);
      const result = await adapter.cancelClaim(row.providerClaimRef, reason);
      if (!result.ok) {
        res.status(mapErrorStatus(result.error.code)).json({
          success: false,
          data: null,
          error: result.error.message,
          code: result.error.code,
        });
        return;
      }

      const updated = (await updateStatus(row.id, {
        status: "CANCELLED",
        cancelledAt: result.data.cancelledAt,
        note: `Cancelled via TPA: ${reason}`,
        source: "API",
        createdBy: req.user!.userId,
      }))!;

      auditLog(req, "CANCEL_CLAIM", "insurance_claim", row.id, { reason }).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/claims/reconcile — manual trigger for the reconciliation
 * worker. ADMIN only. Runs the same code path the hourly scheduler calls so
 * ops can force a sync without waiting for the next tick (e.g. after a TPA
 * outage recovers, or to verify a fix).
 */
router.post(
  "/reconcile",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reconcilePendingClaims();
      auditLog(req, "RECONCILE_CLAIMS", "insurance_claim", undefined, {
        checked: result.checked,
        updated: result.updated,
        errorCount: result.errors.length,
      }).catch(console.error);
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as insuranceClaimsRouter };
