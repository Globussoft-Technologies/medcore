import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { generateReferralLetter, generateDischargeSummary } from "../services/ai/letter-generator";
import { sanitizeUserInput } from "../services/ai/prompt-safety";

// security(2026-05-04): F-LET-2 — Sarvam model used for letter generation.
// Stamped onto the AI_LETTERS_INFERENCE audit row so model rollouts are
// observable independently of route-state audit rows.
const SARVAM_MODEL = "sarvam-105b";

/**
 * Best-effort audit wrapper: PHI audit writes must never take a GET response
 * down with them. If prisma is unavailable (e.g. transient DB blip), log a
 * warning and allow the request to complete.
 */
function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

export const aiLettersRouter = Router();

aiLettersRouter.use(authenticate);
// security(2026-04-23-med): F-LET-* — letter generation is Sarvam-backed (one
// LLM call per request). Cap to 20/min/IP so one caller can't burn budget.
if (process.env.NODE_ENV !== "test") {
  aiLettersRouter.use(rateLimit(20, 60_000));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

// ── POST /referral ────────────────────────────────────────────────────────────

aiLettersRouter.post(
  "/referral",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        scribeSessionId,
        toSpecialty,
        toDoctorName,
        urgency = "ROUTINE",
      } = req.body as {
        scribeSessionId: string;
        toSpecialty: string;
        toDoctorName?: string;
        urgency?: "ROUTINE" | "URGENT" | "EMERGENCY";
      };

      if (!scribeSessionId || !toSpecialty) {
        res.status(400).json({
          success: false,
          data: null,
          error: "scribeSessionId and toSpecialty are required",
        });
        return;
      }

      const session = await prisma.aIScribeSession.findUnique({
        where: { id: scribeSessionId },
        include: {
          appointment: {
            include: {
              patient: {
                include: { user: { select: { name: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          },
        },
      });

      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Scribe session not found" });
        return;
      }

      if (!session.soapFinal) {
        res.status(422).json({ success: false, data: null, error: "SOAP note not yet finalised for this session" });
        return;
      }

      const soap = session.soapFinal as Record<string, any>;
      const clinicalSummary: string = soap?.assessment?.impression ?? "Not available";
      const relevantHistory: string = soap?.subjective?.hpi ?? "Not available";
      const medications: string[] = Array.isArray(soap?.plan?.medications)
        ? soap.plan.medications.map((m: any) => m.name).filter(Boolean)
        : [];

      const patient = session.appointment?.patient;
      const doctor = session.appointment?.doctor;

      const patientName: string = patient?.user?.name ?? "Unknown Patient";
      const patientAge: number | undefined = patient?.age ?? undefined;
      const patientGender: string | undefined = patient?.gender ?? undefined;
      const fromDoctorName: string = doctor?.user?.name ?? "Unknown Doctor";

      // security(2026-05-04): F-INJ-1 — defense-in-depth sanitisation of the
      // request-body free-text fields BEFORE they reach the letter generator.
      // letter-generator.ts already sanitizes internally, but doing it here
      // too means an injected `toSpecialty` is neutralised even if a future
      // refactor strips the service-layer pass.
      const safeToSpecialty = sanitizeUserInput(toSpecialty, { maxLen: 100 });
      const safeToDoctorName = toDoctorName
        ? sanitizeUserInput(toDoctorName, { maxLen: 100 })
        : undefined;

      const inferenceStartedAt = Date.now();
      const letter = await generateReferralLetter({
        patientName,
        patientAge,
        patientGender,
        fromDoctorName,
        fromHospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
        toSpecialty: safeToSpecialty,
        toDoctorName: safeToDoctorName,
        clinicalSummary,
        relevantHistory,
        currentMedications: medications,
        urgency,
        date: formatDate(new Date()),
      });

      // security(2026-05-04): F-LET-2 — audit Sarvam inference with model,
      // prompt/response sizes and latency for budget + perf observability.
      // No prompt content; the route layer never sees PHI in the audit row.
      safeAudit(req, "AI_LETTERS_INFERENCE", "AIScribeSession", scribeSessionId, {
        kind: "referral",
        model: SARVAM_MODEL,
        promptSize:
          (clinicalSummary?.length ?? 0) +
          (relevantHistory?.length ?? 0) +
          safeToSpecialty.length +
          (safeToDoctorName?.length ?? 0),
        responseSize: letter.length,
        latencyMs: Date.now() - inferenceStartedAt,
        urgency,
      });

      res.json({ success: true, data: { letter, generatedAt: new Date().toISOString() }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /discharge ───────────────────────────────────────────────────────────

aiLettersRouter.post(
  "/discharge",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId } = req.body as { admissionId: string };

      if (!admissionId) {
        res.status(400).json({ success: false, data: null, error: "admissionId is required" });
        return;
      }

      const admission = await prisma.admission.findUnique({
        where: { id: admissionId },
        include: {
          patient: {
            include: { user: { select: { name: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          medicationOrders: {
            where: { isActive: true },
            select: { medicineName: true, dosage: true, frequency: true },
          },
        },
      });

      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const patientName: string = admission.patient?.user?.name ?? "Unknown Patient";
      const patientAge: number | undefined = admission.patient?.age ?? undefined;
      const patientGender: string | undefined = admission.patient?.gender ?? undefined;
      const doctorName: string = admission.doctor?.user?.name ?? "Unknown Doctor";

      const admittingDiagnosis: string = admission.reason ?? admission.diagnosis ?? "Not recorded";
      const dischargeDiagnosis: string =
        admission.finalDiagnosis ?? admission.diagnosis ?? "Not recorded";

      const proceduresPerformed: string[] =
        admission.treatmentGiven
          ? admission.treatmentGiven.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)
          : [];

      const medicationsOnDischarge: string[] = admission.dischargeMedications
        ? admission.dischargeMedications.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)
        : admission.medicationOrders.map(
            (m) => `${m.medicineName} ${m.dosage} ${m.frequency}`
          );

      const followUpInstructions: string =
        admission.followUpInstructions ?? "To be advised by treating physician";

      // security(2026-05-04): F-INJ-1 — sanitize the multi-line free-text
      // fields the discharge summary concatenates into the Sarvam prompt.
      // letter-generator.ts also sanitizes internally; this route-layer pass
      // is defense-in-depth.
      const safeAdmittingDx = sanitizeUserInput(admittingDiagnosis, { maxLen: 1000 });
      const safeDischargeDx = sanitizeUserInput(dischargeDiagnosis, { maxLen: 1000 });
      const safeFollowUp = sanitizeUserInput(followUpInstructions, { maxLen: 3000 });

      const inferenceStartedAt = Date.now();
      const summary = await generateDischargeSummary({
        patientName,
        patientAge,
        patientGender,
        admissionDate: formatDate(admission.admittedAt),
        dischargeDate: admission.dischargedAt ? formatDate(admission.dischargedAt) : formatDate(new Date()),
        admittingDiagnosis: safeAdmittingDx,
        dischargeDiagnosis: safeDischargeDx,
        proceduresPerformed,
        medicationsOnDischarge,
        followUpInstructions: safeFollowUp,
        doctorName,
        hospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
      });

      // security(2026-05-04): F-LET-2 — companion AI_LETTERS_INFERENCE row
      // (model + sizes + latency) for the discharge generation path.
      safeAudit(req, "AI_LETTERS_INFERENCE", "Admission", admissionId, {
        kind: "discharge",
        model: SARVAM_MODEL,
        promptSize:
          safeAdmittingDx.length + safeDischargeDx.length + safeFollowUp.length,
        responseSize: summary.length,
        latencyMs: Date.now() - inferenceStartedAt,
      });

      res.json({ success: true, data: { summary, generatedAt: new Date().toISOString() }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /referral/:scribeSessionId/preview ────────────────────────────────────

aiLettersRouter.get(
  "/referral/:scribeSessionId/preview",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scribeSessionId } = req.params;
      const toSpecialty: string = (req.query.toSpecialty as string) ?? "General Medicine";
      const toDoctorName: string | undefined = req.query.toDoctorName as string | undefined;
      const urgency = ((req.query.urgency as string) ?? "ROUTINE") as
        | "ROUTINE"
        | "URGENT"
        | "EMERGENCY";

      const session = await prisma.aIScribeSession.findUnique({
        where: { id: scribeSessionId },
        include: {
          appointment: {
            include: {
              patient: {
                include: { user: { select: { name: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          },
        },
      });

      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Scribe session not found" });
        return;
      }

      if (!session.soapFinal) {
        res.status(422).json({ success: false, data: null, error: "SOAP note not yet finalised for this session" });
        return;
      }

      const soap = session.soapFinal as Record<string, any>;
      const clinicalSummary: string = soap?.assessment?.impression ?? "Not available";
      const relevantHistory: string = soap?.subjective?.hpi ?? "Not available";
      const medications: string[] = Array.isArray(soap?.plan?.medications)
        ? soap.plan.medications.map((m: any) => m.name).filter(Boolean)
        : [];

      const patient = session.appointment?.patient;
      const doctor = session.appointment?.doctor;

      // security(2026-05-04): F-INJ-1 — query-string fields are user-controlled;
      // sanitize before they enter the Sarvam payload.
      const safeToSpecialty = sanitizeUserInput(toSpecialty, { maxLen: 100 });
      const safeToDoctorName = toDoctorName
        ? sanitizeUserInput(toDoctorName, { maxLen: 100 })
        : undefined;

      const inferenceStartedAt = Date.now();
      const letter = await generateReferralLetter({
        patientName: patient?.user?.name ?? "Unknown Patient",
        patientAge: patient?.age ?? undefined,
        patientGender: patient?.gender ?? undefined,
        fromDoctorName: doctor?.user?.name ?? "Unknown Doctor",
        fromHospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
        toSpecialty: safeToSpecialty,
        toDoctorName: safeToDoctorName,
        clinicalSummary,
        relevantHistory,
        currentMedications: medications,
        urgency,
        date: formatDate(new Date()),
      });

      safeAudit(req, "AI_LETTER_READ", "AIScribeSession", scribeSessionId, {
        kind: "referral-preview",
        toSpecialty: safeToSpecialty,
        urgency,
      });

      // security(2026-05-04): F-LET-2 — preview path also fires Sarvam, so
      // it gets a companion AI_LETTERS_INFERENCE row.
      safeAudit(req, "AI_LETTERS_INFERENCE", "AIScribeSession", scribeSessionId, {
        kind: "referral-preview",
        model: SARVAM_MODEL,
        promptSize:
          (clinicalSummary?.length ?? 0) +
          (relevantHistory?.length ?? 0) +
          safeToSpecialty.length +
          (safeToDoctorName?.length ?? 0),
        responseSize: letter.length,
        latencyMs: Date.now() - inferenceStartedAt,
        urgency,
      });

      res.json({ success: true, data: { letter, generatedAt: new Date().toISOString() }, error: null });
    } catch (err) {
      next(err);
    }
  }
);
