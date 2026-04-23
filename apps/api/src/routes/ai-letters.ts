import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { generateReferralLetter, generateDischargeSummary } from "../services/ai/letter-generator";

export const aiLettersRouter = Router();

aiLettersRouter.use(authenticate);

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

      const letter = await generateReferralLetter({
        patientName,
        patientAge,
        patientGender,
        fromDoctorName,
        fromHospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
        toSpecialty,
        toDoctorName,
        clinicalSummary,
        relevantHistory,
        currentMedications: medications,
        urgency,
        date: formatDate(new Date()),
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

      const summary = await generateDischargeSummary({
        patientName,
        patientAge,
        admissionDate: formatDate(admission.admittedAt),
        dischargeDate: admission.dischargedAt ? formatDate(admission.dischargedAt) : formatDate(new Date()),
        admittingDiagnosis,
        dischargeDiagnosis,
        proceduresPerformed,
        medicationsOnDischarge,
        followUpInstructions,
        doctorName,
        hospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
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

      const letter = await generateReferralLetter({
        patientName: patient?.user?.name ?? "Unknown Patient",
        patientAge: patient?.age ?? undefined,
        patientGender: patient?.gender ?? undefined,
        fromDoctorName: doctor?.user?.name ?? "Unknown Doctor",
        fromHospital: process.env.HOSPITAL_NAME ?? "MedCore Hospital",
        toSpecialty,
        toDoctorName,
        clinicalSummary,
        relevantHistory,
        currentMedications: medications,
        urgency,
        date: formatDate(new Date()),
      });

      res.json({ success: true, data: { letter, generatedAt: new Date().toISOString() }, error: null });
    } catch (err) {
      next(err);
    }
  }
);
