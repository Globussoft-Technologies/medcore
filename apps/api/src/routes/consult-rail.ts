/**
 * Consult right-rail API — Pearl ERP Stage 1 §2.1.3 (gap row 46).
 *
 * What / which modules / why:
 *   - Pearl §2.1.3 mandates a 3-column consult screen on `/dashboard/scribe`:
 *     left = patient/appointment context, center = SOAP draft, right rail =
 *     doctor-derived "favourites" + this patient's last 3 visits, with
 *     click-to-paste into the active note. The right rail is the gap this
 *     route closes — the favourites/visits feed it consumes.
 *   - DERIVED favourites here are distinct from the user-curated
 *     `DoctorFavouriteMedicine` list (managed by `routes/doctor-favourites.ts`,
 *     gap row 50). Those are explicit one-tap chips for the Rx writer;
 *     these are computed-on-the-fly aggregates from the doctor's past 50
 *     prescriptions so a freshly-onboarded doctor sees something useful
 *     before they've curated anything. No new schema models; pure read.
 *   - 2 endpoints, scoped to /api/v1/consult-rail:
 *       GET /favourites/:doctorId  — top 5 diagnoses + top 5 medicines
 *                                    computed from the doctor's last 50 Rx.
 *       GET /visits/:patientId     — this patient's last 3 prescriptions
 *                                    (date + diagnosis + Rx item summary).
 *
 * Tenant scoping:
 *   - `tenantScopedPrisma` auto-filters Prescription rows by tenantId, so a
 *     doctor in one tenant cannot derive favourites from another tenant's
 *     prescriptions and a cross-tenant `:patientId` returns an empty array
 *     rather than leaking visit history.
 *
 * RBAC: DOCTOR, ADMIN, NURSE — same surface as the scribe page itself.
 *
 * Audit:
 *   - CONSULT_RAIL_FAVOURITES_READ / CONSULT_RAIL_VISITS_READ on
 *     entity="consult_rail". Fire-and-forget via .catch(console.error) per
 *     the project's safe-audit convention — tests reading AuditLog
 *     immediately after these GETs should use waitForAuditFlush().
 */

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE));

// Sample window for deriving favourites. 50 rows is enough signal for the
// frequency ranking without scanning the doctor's lifetime history on every
// request — at ~20 Rx/day this is ~2-3 weeks back, which matches what most
// doctors think of as "what I've been prescribing lately".
const FAVOURITES_SAMPLE = 50;
// Top-K per category. 5 keeps the rail compact on a 320-px column without
// scrolling and matches the gap-doc acceptance ("top 5 favourites").
const FAVOURITES_TOP_K = 5;
// Visit history depth from the gap-doc acceptance ("last 3 visits").
const VISITS_DEPTH = 3;

/**
 * Bucket-count strings (case-insensitive, trimmed) and return the top-K
 * sorted by descending frequency. Ties broken by first-seen order so the
 * output is deterministic across calls with identical input.
 */
function topK(values: Array<string | null | undefined>, k: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number; firstSeen: number }>();
  let order = 0;
  for (const raw of values) {
    if (!raw) continue;
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { value: v, count: 1, firstSeen: order });
    }
    order += 1;
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
    .slice(0, k)
    .map(({ value, count }) => ({ value, count }));
}

// ── GET /favourites/:doctorId ────────────────────────────────────────────
// Derived favourites: top diagnoses + top medicines from this doctor's
// recent prescriptions. No new schema. Tenant-scoped via the wrapper.
router.get(
  "/favourites/:doctorId",
  validateUuidParams(["doctorId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId } = req.params;
      const recent = await prisma.prescription.findMany({
        where: { doctorId },
        orderBy: { createdAt: "desc" },
        take: FAVOURITES_SAMPLE,
        select: {
          diagnosis: true,
          items: { select: { medicineName: true } },
        },
      });

      const diagnoses = topK(
        recent.map((r) => r.diagnosis),
        FAVOURITES_TOP_K,
      );
      const medicines = topK(
        recent.flatMap((r) => r.items.map((i) => i.medicineName)),
        FAVOURITES_TOP_K,
      );

      auditLog(
        req,
        "CONSULT_RAIL_FAVOURITES_READ",
        "consult_rail",
        doctorId,
        { sampled: recent.length, diagnoses: diagnoses.length, medicines: medicines.length },
      ).catch(console.error);

      res.json({
        success: true,
        data: { diagnoses, medicines, sampledFrom: recent.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /visits/:patientId ───────────────────────────────────────────────
// Last 3 visits for this patient — unifies the two surfaces that
// represent "a doctor encounter":
//   1. Prescription rows (the original surface — Rx written for a visit)
//   2. SIGNED Consultation rows (Pearl §2.1.3 — SOAP note finalized
//      without a Rx, e.g. follow-up, counseling, lifestyle advice)
//
// Both are deduped by appointmentId: when the same visit produced both
// a Rx and a signed SOAP note we keep the Rx (richer item list) and
// suppress the consultation duplicate. Tenant-scoped via the wrapper.
router.get(
  "/visits/:patientId",
  validateUuidParams(["patientId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      const [prescriptions, consultations] = await Promise.all([
        prisma.prescription.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
          take: VISITS_DEPTH * 2, // over-fetch; we dedupe below
          select: {
            id: true,
            appointmentId: true,
            createdAt: true,
            diagnosis: true,
            advice: true,
            followUpDate: true,
            items: {
              select: {
                medicineName: true,
                dosage: true,
                frequency: true,
                duration: true,
              },
            },
          },
        }),
        prisma.consultation.findMany({
          where: {
            appointment: { patientId },
            status: "SIGNED",
          },
          orderBy: { signedAt: "desc" },
          take: VISITS_DEPTH * 2,
          select: {
            id: true,
            appointmentId: true,
            createdAt: true,
            signedAt: true,
            subjective: true,
            objective: true,
            assessment: true,
            plan: true,
            icd10Codes: true,
          },
        }),
      ]);

      // Suppress consultations whose appointment already has a Rx —
      // the Rx surface is richer (item list with dose/frequency).
      const rxAppointmentIds = new Set(
        prescriptions.map((p) => p.appointmentId),
      );

      // Normalize consultations into the same Visit shape the client
      // already renders.
      interface DiagCode {
        code: string;
        description: string;
      }
      const consultVisits = consultations
        .filter((c) => !rxAppointmentIds.has(c.appointmentId))
        .map((c) => {
          const codes = Array.isArray(c.icd10Codes)
            ? (c.icd10Codes as unknown as DiagCode[])
            : [];
          const diagnosis =
            codes[0]?.description ??
            // Fall back to the assessment's first non-empty line, or
            // a generic label so the card never shows "(no diagnosis)"
            // when the doctor did record an assessment.
            (c.assessment
              ? c.assessment
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .find((s) => s && !s.startsWith("## ")) ?? "Consultation note"
              : "Consultation note");
          return {
            id: c.id,
            createdAt: (c.signedAt ?? c.createdAt).toISOString(),
            diagnosis,
            subjective: c.subjective,
            objective: c.objective,
            assessment: c.assessment,
            advice: c.plan,
            followUpDate: null,
            items: [] as Array<{
              medicineName: string;
              dosage: string;
              frequency: string;
              duration: string;
            }>,
          };
        });

      // Merge, sort by date desc, take VISITS_DEPTH.
      const merged = [
        ...prescriptions.map((p) => ({
          id: p.id,
          createdAt: p.createdAt.toISOString(),
          diagnosis: p.diagnosis,
          // Prescriptions have no SOAP sections — keep the shape consistent
          // with consultation visits so the merged array is homogeneous.
          subjective: null as string | null,
          objective: null as string | null,
          assessment: null as string | null,
          advice: p.advice,
          followUpDate: p.followUpDate
            ? p.followUpDate.toISOString()
            : null,
          items: p.items,
        })),
        ...consultVisits,
      ]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, VISITS_DEPTH);

      auditLog(
        req,
        "CONSULT_RAIL_VISITS_READ",
        "consult_rail",
        patientId,
        {
          count: merged.length,
          prescriptions: prescriptions.length,
          consultations: consultVisits.length,
        },
      ).catch(console.error);

      res.json({ success: true, data: merged, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as consultRailRouter };
