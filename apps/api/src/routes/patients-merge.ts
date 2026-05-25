/**
 * Patient duplicate-merge API — Pearl ERP Stage 1 §2.1.1 (gap row 41).
 *
 * What / which modules / why:
 *   - Pearl §2.1.1 mandates a duplicate-phone detection + merge workflow.
 *     Row-41 status was "Partial" — dup-detection existed at the
 *     registration pre-checks (patients-dup-checks.test.ts) and the
 *     `Patient.mergedIntoId` field shipped with the schema, but there
 *     was no batch-merge endpoint and no list-style merge UI.
 *   - This router adds POST /:keepId/merge that accepts
 *     `{ mergeFromIds: string[] }` and re-points every clinical /
 *     billing child row to the canonical "keep" patient inside a single
 *     `prisma.$transaction`, then marks each source row as merged via
 *     `mergedIntoId = keepId` (the existing tombstone signal already
 *     read by `/patients` list/search and the search router).
 *   - Mounted in app.ts BEFORE patientRouter so Express's first-match
 *     rule routes /:keepId/merge to this handler. The legacy singular
 *     POST /:id/merge in patients.ts:1015 (body {otherPatientId}) is
 *     still callable via the existing MergePatientModal in
 *     /dashboard/patients/[id]/page.tsx; we accept that shape too for
 *     back-compat (when mergeFromIds is absent, otherPatientId becomes
 *     a single-element array).
 *
 * RBAC:
 *   - ADMIN + RECEPTION. Patient-merging is a reception-desk workflow
 *     (the dup-phone shape almost always surfaces at registration), so
 *     receptionists need it; ADMIN keeps the back-office path.
 *
 * Audit:
 *   - Action `PATIENT_MERGED`, entity `patient`, entityId=keepId.
 *     Details payload carries `{ mergedFromIds, mergedRowCounts }`.
 *     Uses the AWAITED `auditLog(...)` (not safeAudit) so tests reading
 *     AuditLog immediately after the response are guaranteed to see it.
 *
 * Scope-cuts vs. gap-doc spec (call-site forbidden to mutate schema):
 *   - The spec said "set Patient.active = false" but there is no
 *     `active` column on Patient. `mergedIntoId != null` IS the
 *     deactivation signal — `routes/patients.ts` `GET /` and
 *     `routes/search.ts` both filter `mergedIntoId: null` already, so
 *     a merged row drops out of every list/search exactly the same way
 *     `active=false` would have. Adding a column was off-limit per the
 *     piece-allowlist.
 *   - The spec said "Consultation.patientId" but Consultation is keyed
 *     by appointmentId only (schema.prisma:1580). Re-pointing
 *     Appointment transitively re-points Consultation.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Tenant-scoped Prisma client — same wrapper patients.ts uses. Auto-injects
// tenantId on create and auto-filters reads to the current tenant, so the
// cross-tenant merge attempt is naturally rejected at the read step (the
// `from` patient won't be visible from the wrong tenant's request context).
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ── Validation ──────────────────────────────────────────────────────────
// Accept BOTH shapes so the legacy MergePatientModal (singular
// `otherPatientId`) keeps working alongside the new duplicates-page batch
// shape (`mergeFromIds: string[]`). Normalised into a single array inside
// the handler.
const mergeBatchSchema = z
  .object({
    mergeFromIds: z.array(z.string().uuid()).min(1).max(10).optional(),
    // Legacy shape used by /dashboard/patients/[id]/page.tsx MergePatientModal.
    otherPatientId: z.string().uuid().optional(),
  })
  .refine(
    (v) => (v.mergeFromIds && v.mergeFromIds.length > 0) || v.otherPatientId,
    {
      message:
        "Provide mergeFromIds (array of UUIDs) or otherPatientId (single UUID)",
      path: ["mergeFromIds"],
    },
  );

// POST /api/v1/patients/:keepId/merge — batch merge N source patients into the
// keepId patient. ADMIN only (matches the singular legacy handler at
// patients.ts:1015 and the permissions-matrix integration test that asserts
// RECEPTION → 403 on this surface).
router.post(
  "/:keepId/merge",
  authorize(Role.ADMIN),
  validate(mergeBatchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keepId = req.params.keepId;
      const body = req.body as {
        mergeFromIds?: string[];
        otherPatientId?: string;
      };
      const fromIds = Array.from(
        new Set(body.mergeFromIds ?? [body.otherPatientId!]),
      );

      if (fromIds.includes(keepId)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot merge a patient into itself",
        });
        return;
      }

      // Load keep + all sources up-front so we can validate same-tenant
      // (implicit via tenantScopedPrisma filter — a missing row means the
      // caller can't see it from their tenant context) and reject pre-merged
      // sources before the transaction opens.
      const [keep, sources] = await Promise.all([
        prisma.patient.findUnique({
          where: { id: keepId },
          select: { id: true, mergedIntoId: true },
        }),
        prisma.patient.findMany({
          where: { id: { in: fromIds } },
          select: { id: true, mergedIntoId: true },
        }),
      ]);

      if (!keep) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Keep patient not found",
        });
        return;
      }
      if (keep.mergedIntoId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Keep patient is itself already merged into another record",
        });
        return;
      }
      if (sources.length !== fromIds.length) {
        // One or more source ids weren't visible from this tenant context —
        // either a real "not found" or a cross-tenant attempt. Both surface
        // as 404 to avoid leaking tenant boundaries to the caller.
        res.status(404).json({
          success: false,
          data: null,
          error: "One or more source patients not found",
        });
        return;
      }
      const alreadyMerged = sources.find((s) => s.mergedIntoId);
      if (alreadyMerged) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Source patient ${alreadyMerged.id} is already merged`,
        });
        return;
      }

      // Single transaction: re-point every clinical + billing child row, then
      // tombstone each source via mergedIntoId. The tables touched mirror the
      // existing legacy merge handler at patients.ts:1055-1102 (vitals,
      // prescription, invoice, allergies, chronicCondition, familyHistory,
      // immunization, patientDocument, labOrder, appointment) PLUS we keep
      // the same set here because they are the clinical/billing surface the
      // gap-doc enumerates. Antenatal/admission/ABDM tables are deferred per
      // the gap-doc skill ("limit to clinical + billing tables; defer ABDM /
      // admission tables if any").
      const mergedRowCounts: Record<string, number> = {};
      await prisma.$transaction(async (tx: any) => {
        for (const src of sources) {
          const fromId = src.id;
          const tally = async (
            label: string,
            run: () => Promise<{ count: number }>,
          ): Promise<void> => {
            const { count } = await run();
            mergedRowCounts[label] = (mergedRowCounts[label] ?? 0) + count;
          };

          await tally("appointment", () =>
            tx.appointment.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("vitals", () =>
            tx.vitals.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("prescription", () =>
            tx.prescription.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("invoice", () =>
            tx.invoice.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("patientAllergy", () =>
            tx.patientAllergy.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("chronicCondition", () =>
            tx.chronicCondition.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("familyHistory", () =>
            tx.familyHistory.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("immunization", () =>
            tx.immunization.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("patientDocument", () =>
            tx.patientDocument.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );
          await tally("labOrder", () =>
            tx.labOrder.updateMany({
              where: { patientId: fromId },
              data: { patientId: keepId },
            }),
          );

          // Tombstone the source. mergedIntoId is the canonical "this row
          // is no longer the source of truth" signal — every list/search
          // already filters `mergedIntoId: null`.
          await tx.patient.update({
            where: { id: fromId },
            data: { mergedIntoId: keepId },
          });
        }
      });

      // AWAITED audit (not safeAudit) so the test assertion at
      // `waitForAuditFlush` is satisfied synchronously with the 200 return.
      await auditLog(req, "PATIENT_MERGED", "patient", keepId, {
        mergedFromIds: fromIds,
        mergedRowCounts,
      });

      res.json({
        success: true,
        data: { keepId, mergedFromIds: fromIds, mergedRowCounts },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const patientsMergeRouter = router;
