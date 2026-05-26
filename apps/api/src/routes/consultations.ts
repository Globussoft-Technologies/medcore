// Pearl ERP Stage 1 §2.1.3 — backend for the doctor's manual SOAP-tabbed
// consult screen at /dashboard/consult/:appointmentId. Sits parallel to
// /ai/scribe (voice-driven) so doctors who prefer manual entry have a
// dedicated surface backed by the Consultation row (extended with
// SOAP fields + ICD-10/SNOMED coding in migration
// 20260526000001_add_consultation_soap_fields).
//
// Endpoints:
//   GET   /by-appointment/:appointmentId  — fetch or lazy-create draft
//   PATCH /:id                            — save SOAP / codes / notes draft
//   POST  /:id/sign                       — finalize (DRAFT → SIGNED)
import { Router, Request, Response, NextFunction } from "express";
import { prisma, Prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Diagnosis code shape — both ICD-10 and SNOMED items have the same
// surface (code + description), so a single type covers both arrays.
interface DiagnosisCode {
  code: string;
  description: string;
}

function isDiagnosisArray(value: unknown): value is DiagnosisCode[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v != null &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>).code === "string" &&
        typeof (v as Record<string, unknown>).description === "string",
    )
  );
}

// GET /api/v1/consultations/by-patient/:patientId
// Returns ALL consultations for the patient (newest first). Used by:
//   - Doctor patient-profile "Consult History" drawer
//   - Patient self-view "My Appointments → Past" notes drawer
//
// PATIENT role is allowed but per-row self-scoped: we verify the
// :patientId param matches the caller's own patient row (BOLA #511
// pattern — having `Role.PATIENT` in authorize() doesn't exempt the
// handler from row-keyed ownership checks).
router.get(
  "/by-patient/:patientId",
  authorize(
    Role.DOCTOR,
    Role.NURSE,
    Role.ADMIN,
    Role.RECEPTION,
    Role.PATIENT,
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      // Self-scope for PATIENT: only their own consult history.
      if (req.user!.role === "PATIENT") {
        const me = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
          select: { id: true },
        });
        if (!me || me.id !== patientId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Forbidden",
          });
          return;
        }
      }

      const rows = await prisma.consultation.findMany({
        where: {
          appointment: { patientId },
          // Patients see only SIGNED notes — DRAFT in-progress visits
          // shouldn't leak to the patient before the doctor finalizes.
          ...(req.user!.role === "PATIENT" ? { status: "SIGNED" } : {}),
        },
        include: {
          appointment: {
            select: {
              id: true,
              date: true,
              slotStart: true,
              status: true,
              tokenNumber: true,
            },
          },
          doctor: {
            select: {
              id: true,
              specialization: true,
              user: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/consultations/by-appointment/:appointmentId
// Returns the consultation row for an appointment.
//
// Staff (DOCTOR/NURSE/ADMIN): lazy-creates an empty DRAFT row if none
// exists so the consult page always has an id to PATCH against.
//
// PATIENT: read-only. We refuse to lazy-create for them (they
// shouldn't be writing consultation rows by viewing) and instead
// return 404 if no row exists. Additionally we verify the appointment
// belongs to the caller (BOLA self-scope per CLAUDE.md gotcha #14).
// Patients also only see SIGNED rows — DRAFT in-progress edits should
// not leak before the doctor finalizes.
router.get(
  "/by-appointment/:appointmentId",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId } = req.params;
      const isPatient = req.user!.role === "PATIENT";

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          id: true,
          doctorId: true,
          tenantId: true,
          patientId: true,
        },
      });
      if (!appointment) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Appointment not found",
        });
        return;
      }

      // PATIENT self-scope: the appointment must belong to them.
      if (isPatient) {
        const me = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
          select: { id: true },
        });
        if (!me || me.id !== appointment.patientId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Forbidden",
          });
          return;
        }
      }

      let consultation = await prisma.consultation.findUnique({
        where: { appointmentId },
      });

      if (!consultation) {
        if (isPatient) {
          // Read-only for patients — don't create, don't leak.
          res.status(404).json({
            success: false,
            data: null,
            error: "No consultation notes for this appointment",
          });
          return;
        }
        consultation = await prisma.consultation.create({
          data: {
            appointmentId,
            doctorId: appointment.doctorId,
            tenantId: appointment.tenantId,
          },
        });
      } else if (isPatient && consultation.status !== "SIGNED") {
        // Hide DRAFT notes from the patient until signed.
        res.status(404).json({
          success: false,
          data: null,
          error: "Notes not yet finalized",
        });
        return;
      }

      res.json({ success: true, data: consultation, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/consultations/:id — save draft. Accepts any subset of
// SOAP tab text + ICD-10/SNOMED code arrays + free-form notes/findings.
// Refuses edits to rows already SIGNED to preserve clinical integrity.
router.patch(
  "/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.consultation.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Consultation not found",
        });
        return;
      }
      if (existing.status === "SIGNED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Consultation is signed; create an amendment instead.",
        });
        return;
      }

      const {
        subjective,
        objective,
        assessment,
        plan,
        icd10Codes,
        snomedCodes,
        notes,
        findings,
      } = req.body as {
        subjective?: string | null;
        objective?: string | null;
        assessment?: string | null;
        plan?: string | null;
        icd10Codes?: DiagnosisCode[] | null;
        snomedCodes?: DiagnosisCode[] | null;
        notes?: string | null;
        findings?: string | null;
      };

      // Validate shapes for the JSON code arrays so we don't write
      // arbitrary blobs into the column.
      if (icd10Codes != null && !isDiagnosisArray(icd10Codes)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "icd10Codes must be an array of { code, description }",
        });
        return;
      }
      if (snomedCodes != null && !isDiagnosisArray(snomedCodes)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "snomedCodes must be an array of { code, description }",
        });
        return;
      }

      const updated = await prisma.consultation.update({
        where: { id: req.params.id },
        data: {
          ...(subjective !== undefined ? { subjective } : {}),
          ...(objective !== undefined ? { objective } : {}),
          ...(assessment !== undefined ? { assessment } : {}),
          ...(plan !== undefined ? { plan } : {}),
          // Cast to Prisma.InputJsonValue — DiagnosisCode[] is structurally
          // an InputJsonArray (validated above by isDiagnosisArray) but TS
          // doesn't widen named interfaces to the indexable JSON shape.
          ...(icd10Codes !== undefined
            ? { icd10Codes: (icd10Codes ?? []) as unknown as Prisma.InputJsonValue }
            : {}),
          ...(snomedCodes !== undefined
            ? { snomedCodes: (snomedCodes ?? []) as unknown as Prisma.InputJsonValue }
            : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(findings !== undefined ? { findings } : {}),
        },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/consultations/:id/sign — finalize. Stamps signedAt and
// flips status to SIGNED, AND advances the underlying appointment to
// COMPLETED in the same transaction. Signing IS the act of finishing
// the encounter, so the appointment shouldn't keep showing
// IN_CONSULTATION / Re-consult buttons after the doctor signs off.
// Only advances the appointment if it's still in an active state
// (BOOKED / CHECKED_IN / IN_CONSULTATION) — terminal states
// (CANCELLED / NO_SHOW / already COMPLETED) are left as-is.
router.post(
  "/:id/sign",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.consultation.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          status: true,
          appointmentId: true,
          appointment: { select: { status: true } },
        },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Consultation not found",
        });
        return;
      }
      if (existing.status === "SIGNED") {
        // Idempotent — return the full row (re-read because the select
        // above is a projection).
        const fresh = await prisma.consultation.findUnique({
          where: { id: req.params.id },
        });
        res.json({ success: true, data: fresh, error: null });
        return;
      }

      const ADVANCEABLE = new Set([
        "BOOKED",
        "CHECKED_IN",
        "IN_CONSULTATION",
      ]);
      const shouldAdvanceAppointment =
        !!existing.appointment &&
        ADVANCEABLE.has(existing.appointment.status);

      // Transaction so signing + appointment-completion are atomic —
      // a partial state where the consult says SIGNED but the
      // appointment still says IN_CONSULTATION would surface as
      // "Re-consult" + "Complete" buttons on a row that's actually
      // done, which is exactly the bug the user is reporting.
      const [signed] = await prisma.$transaction([
        prisma.consultation.update({
          where: { id: req.params.id },
          data: { status: "SIGNED", signedAt: new Date() },
        }),
        ...(shouldAdvanceAppointment
          ? [
              prisma.appointment.update({
                where: { id: existing.appointmentId },
                data: { status: "COMPLETED" },
              }),
            ]
          : []),
      ]);

      res.json({ success: true, data: signed, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as consultationsRouter };
