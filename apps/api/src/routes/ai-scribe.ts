import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  startScribeSessionSchema,
  addTranscriptChunkSchema,
  scribeSignOffSchema,
  NotificationType,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { generateSOAPNote } from "../services/ai/sarvam";
import { checkDrugSafety } from "../services/ai/drug-interactions";
import { auditLog } from "../middleware/audit";
import { sendNotification } from "../services/notification";

const router = Router();
router.use(authenticate);

// POST /api/v1/ai/scribe/start — start a scribe session (doctor only)
router.post(
  "/start",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(startScribeSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId, audioRetentionDays } = req.body;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          patient: {
            include: {
              allergies: { select: { allergen: true } },
              chronicConditions: { select: { condition: true } },
            },
          },
          doctor: true,
        },
      });

      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      // Ensure caller is the attending doctor (or admin)
      if (req.user?.role === Role.DOCTOR) {
        const doctor = await prisma.doctor.findFirst({ where: { userId: req.user.userId } });
        if (doctor?.id !== appointment.doctorId) {
          res.status(403).json({ success: false, data: null, error: "Not the attending doctor" });
          return;
        }
      }

      // Prevent duplicate sessions
      const existing = await prisma.aIScribeSession.findUnique({ where: { appointmentId } });
      if (existing && existing.status === "ACTIVE") {
        res.json({ success: true, data: { sessionId: existing.id, resumed: true }, error: null });
        return;
      }

      const retainUntil = audioRetentionDays > 0
        ? new Date(Date.now() + audioRetentionDays * 86400000)
        : null;

      const session = await prisma.aIScribeSession.create({
        data: {
          appointmentId,
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          consentObtained: req.body.consentObtained,
          consentAt: new Date(),
          audioRetainUntil: retainUntil,
          modelVersion: "claude-sonnet-4-6",
        },
      });

      await auditLog(req, "AI_SCRIBE_SESSION_STARTED", "AIScribeSession", session.id, { appointmentId, audioRetentionDays });

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          patientContext: {
            allergies: appointment.patient.allergies.map((a: any) => a.allergen),
            chronicConditions: appointment.patient.chronicConditions.map((c: any) => c.condition),
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/scribe/:sessionId/transcript — add transcript chunks
router.post(
  "/:sessionId/transcript",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(addTranscriptChunkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { entries } = req.body;

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (session.status !== "ACTIVE") {
        res.status(400).json({ success: false, data: null, error: `Session is ${session.status}` });
        return;
      }

      const existingTranscript = (session.transcript as any[]) || [];
      const updatedTranscript = [...existingTranscript, ...entries];

      // Regenerate SOAP draft every time transcript is updated
      // Fetch patient context for drug interaction checks
      const appointment = await prisma.appointment.findUnique({
        where: { id: session.appointmentId },
        include: {
          patient: {
            include: {
              allergies: { select: { allergen: true } },
              chronicConditions: { select: { condition: true } },
              prescriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { items: { select: { medicineName: true } } },
              },
            },
          },
        },
      });

      const patientContext = {
        allergies: appointment?.patient.allergies.map((a: any) => a.allergen) || [],
        currentMedications:
          appointment?.patient.prescriptions[0]?.items.map((i: any) => i.medicineName) || [],
        chronicConditions: appointment?.patient.chronicConditions.map((c: any) => c.condition) || [],
        age: appointment?.patient.age ?? undefined,
        gender: appointment?.patient.gender ?? undefined,
      };

      let soapDraft = session.soapDraft;
      let rxSafetyReport = (session.rxDraft as any) || null;

      // Only regenerate if we have substantial transcript (3+ entries)
      if (updatedTranscript.length >= 3) {
        try {
          soapDraft = await generateSOAPNote(updatedTranscript, patientContext) as any;
        } catch {
          // Non-fatal — keep previous draft
        }

        // Run drug safety checks whenever we have a fresh SOAP draft with medications
        const proposedMeds = (soapDraft as any)?.plan?.medications ?? [];
        if (proposedMeds.length > 0) {
          try {
            rxSafetyReport = await checkDrugSafety(
              proposedMeds,
              patientContext.currentMedications,
              patientContext.allergies,
              patientContext.chronicConditions,
              { age: patientContext.age, gender: patientContext.gender }
            );
          } catch {
            // Non-fatal — continue without safety report
          }
        }
      }

      await prisma.aIScribeSession.update({
        where: { id: sessionId },
        data: {
          transcript: updatedTranscript as any,
          soapDraft: soapDraft as any,
          rxDraft: rxSafetyReport as any,
        },
      });

      res.json({
        success: true,
        data: {
          transcriptLength: updatedTranscript.length,
          soapDraftUpdated: !!soapDraft,
          soapDraft,
          rxSafetyReport,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/scribe/:sessionId/soap — get current SOAP draft
router.get(
  "/:sessionId/soap",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.aIScribeSession.findUnique({
        where: { id: req.params.sessionId },
        select: {
          id: true,
          status: true,
          soapDraft: true,
          soapFinal: true,
          icd10Codes: true,
          rxDraft: true,
          transcript: true,
          signedOffAt: true,
          signedOffBy: true,
        },
      });

      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/scribe/:sessionId/finalize — doctor signs off
router.post(
  "/:sessionId/finalize",
  authorize(Role.DOCTOR),
  validate(scribeSignOffSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { soapFinal, icd10Codes, rxApproved, doctorEdits } = req.body;

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const doctor = await prisma.doctor.findFirst({ where: { userId: req.user!.userId } });
      if (doctor?.id !== session.doctorId) {
        res.status(403).json({ success: false, data: null, error: "Not the attending doctor" });
        return;
      }

      // Compute diff between AI draft and doctor's final version
      let computedEdits: { section: string; field: string; from: unknown; to: unknown }[] = [];
      if (session.soapDraft && soapFinal) {
        const draft = session.soapDraft as Record<string, any>;
        const final = soapFinal as Record<string, any>;
        for (const section of ["subjective", "objective", "assessment", "plan"] as const) {
          if (!draft[section] || !final[section]) continue;
          for (const field of Object.keys(final[section])) {
            const fromVal = draft[section]?.[field];
            const toVal = final[section]?.[field];
            if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
              computedEdits.push({ section, field, from: fromVal ?? null, to: toVal });
            }
          }
        }
      }

      const finalSession = await prisma.aIScribeSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          soapFinal: soapFinal as any,
          icd10Codes: icd10Codes as any,
          doctorEdits: computedEdits as any,
          signedOffAt: new Date(),
          signedOffBy: req.user!.userId,
        },
      });

      // Write SOAP note to EHR (consultation record)
      if (soapFinal) {
        const existingConsultation = await prisma.consultation.findUnique({
          where: { appointmentId: session.appointmentId },
        });

        const notes = `[AI Scribe — Doctor Approved]\n\nSubjective: ${JSON.stringify(soapFinal.subjective)}\n\nObjective: ${JSON.stringify(soapFinal.objective)}\n\nAssessment: ${soapFinal.assessment?.impression}\n\nPlan: ${JSON.stringify(soapFinal.plan)}`;

        if (existingConsultation) {
          await prisma.consultation.update({
            where: { appointmentId: session.appointmentId },
            data: { notes },
          });
        } else {
          await prisma.consultation.create({
            data: {
              appointmentId: session.appointmentId,
              doctorId: session.doctorId,
              notes,
              findings: soapFinal.objective?.examinationFindings || "",
            },
          });
        }
      }

      // Auto-create draft lab orders from SOAP plan.investigations
      const investigations: string[] = (soapFinal as any)?.plan?.investigations ?? [];
      let draftLabOrdersCount = 0;
      if (investigations.length > 0) {
        for (const testName of investigations) {
          try {
            // Check if a draft order for this test already exists for this patient/doctor
            const existingOrder = await prisma.labOrder.findFirst({
              where: {
                patientId: session.patientId,
                doctorId: session.doctorId,
                notes: `[AI Scribe Draft] ${testName}`,
                status: "ORDERED",
              },
            });
            if (!existingOrder) {
              const orderNumber = `SCRIBE-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
              await prisma.labOrder.create({
                data: {
                  orderNumber,
                  patientId: session.patientId,
                  doctorId: session.doctorId,
                  status: "ORDERED",
                  notes: `[AI Scribe Draft] ${testName}`,
                  orderedAt: new Date(),
                },
              });
              draftLabOrdersCount++;
            }
          } catch {
            // Non-fatal — continue
          }
        }
      }

      // Auto-create draft referrals from SOAP plan.referrals
      const referrals: string[] = (soapFinal as any)?.plan?.referrals ?? [];
      let draftReferralsCount = 0;
      if (referrals.length > 0) {
        for (const referralText of referrals) {
          try {
            // Parse specialty from referral text, e.g. "Refer to Cardiologist" → "Cardiologist"
            const specialty = referralText.replace(/refer\s+(to|for)\s+/i, "").trim();
            const referralNumber = `SCRIBE-REF-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
            await prisma.referral.create({
              data: {
                referralNumber,
                patientId: session.patientId,
                fromDoctorId: session.doctorId,
                specialty,
                reason: `[AI Scribe Draft] ${referralText}`,
                status: "PENDING",
              },
            });
            draftReferralsCount++;
          } catch {
            // Non-fatal — continue
          }
        }
      }

      // Notify patient with a plain-language visit summary (non-fatal)
      try {
        const patientRecord = await prisma.patient.findUnique({
          where: { id: session.patientId },
          select: { userId: true },
        });
        if (patientRecord?.userId && soapFinal) {
          const impression = (soapFinal as any)?.assessment?.impression || "your consultation";
          const followUp = (soapFinal as any)?.plan?.followUpTimeline || "";
          const instructions = (soapFinal as any)?.plan?.patientInstructions || "";
          const summaryMsg = [
            `Your consultation has been completed.`,
            impression ? `Diagnosis: ${impression}.` : "",
            followUp ? `Follow-up: ${followUp}.` : "",
            instructions ? `Instructions: ${instructions}` : "",
          ].filter(Boolean).join(" ");

          await sendNotification({
            userId: patientRecord.userId,
            type: NotificationType.PRESCRIPTION_READY,
            title: "Your Visit Summary is Ready",
            message: summaryMsg,
            data: { scribeSessionId: sessionId },
          });
        }
      } catch (notifyErr) {
        console.error("[AI Scribe] Patient notification failed (non-fatal):", notifyErr);
      }

      await auditLog(req, "AI_SCRIBE_SIGNED_OFF", "AIScribeSession", sessionId, { rxApproved, editCount: doctorEdits?.length || 0 });

      res.json({
        success: true,
        data: {
          session: finalSession,
          draftLabOrders: draftLabOrdersCount,
          draftReferrals: draftReferralsCount,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/scribe/:sessionId/drafts — get draft lab orders and referrals for this session
router.get(
  "/:sessionId/drafts",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const [labOrders, referrals] = await Promise.all([
        prisma.labOrder.findMany({
          where: {
            patientId: session.patientId,
            doctorId: session.doctorId,
            notes: { startsWith: "[AI Scribe Draft]" },
          },
        }),
        prisma.referral.findMany({
          where: {
            patientId: session.patientId,
            fromDoctorId: session.doctorId,
            reason: { startsWith: "[AI Scribe Draft]" },
          },
        }),
      ]);

      res.json({ success: true, data: { labOrders, referrals }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/ai/scribe/:sessionId — withdraw consent, purge transcript
router.delete(
  "/:sessionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.aIScribeSession.update({
        where: { id: req.params.sessionId },
        data: {
          status: "CONSENT_WITHDRAWN",
          transcript: [] as any,
          soapDraft: undefined,
        },
      });

      await auditLog(req, "AI_SCRIBE_CONSENT_WITHDRAWN", "AIScribeSession", req.params.sessionId, {});

      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiScribeRouter };
