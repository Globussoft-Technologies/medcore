// Patient-scoped grab-bag router mounted at `/api/v1` for endpoints that
// don't merit their own dedicated module. Today it covers vitals
// baseline, certificate PDFs (id card, fitness, death) and the CCDA
// export.
//
// Heads-up: user-management handlers (PATCH /users/:id, list, reset-pw,
// service-cert, dashboard-preferences) used to live here but were moved
// to `routes/users.ts` (TODO.md A6 — discoverability). URLs are
// identical, only the source file changed.

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { computePatientBaseline } from "../services/vitals-baseline";
import {
  generatePatientIdCardHTML,
  generateVitalsHistoryHTML,
  generateFitnessCertificateHTML,
  generateDeathCertificateHTML,
} from "../services/pdf";

const router = Router();
router.use(authenticate);

// ─── GET /patients/:id/vitals-baseline ────────────────

router.get(
  "/patients/:id/vitals-baseline",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const baseline = await computePatientBaseline(req.params.id);
      res.json({ success: true, data: baseline, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /patients/:id/vitals/pdf ─────────────────────

router.get(
  "/patients/:id/vitals/pdf",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generateVitalsHistoryHTML(
        req.params.id,
        req.query.from as string | undefined,
        req.query.to as string | undefined
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Patient not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /patients/:id/id-card ────────────────────────
router.get(
  "/patients/:id/id-card",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generatePatientIdCardHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Patient not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /patients/:id/fitness-certificate?purpose= ────
router.get(
  "/patients/:id/fitness-certificate",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purpose = (req.query.purpose as string) || "general employment";
      const html = await generateFitnessCertificateHTML(req.params.id, purpose);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Patient not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /patients/:id/death-certificate ──────────────
router.get(
  "/patients/:id/death-certificate",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cause = (req.query.cause as string) || "";
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const time = (req.query.time as string) || "";
      const manner = (req.query.manner as string) || "NATURAL";
      const antecedent = (req.query.antecedent as string) || "";
      const other = (req.query.other as string) || "";
      const html = await generateDeathCertificateHTML(
        req.params.id,
        cause,
        date,
        time,
        manner,
        antecedent,
        other
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Patient not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /patients/:id/ccda — medical record summary ──

router.get(
  "/patients/:id/ccda",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;

      const [
        patient,
        allergies,
        conditions,
        immunizations,
        recentVitals,
        recentLabResults,
        recentSurgeries,
        activePrescriptions,
      ] = await Promise.all([
        prisma.patient.findUnique({
          where: { id: patientId },
          include: {
            user: { select: { name: true, email: true, phone: true } },
          },
        }),
        prisma.patientAllergy.findMany({
          where: { patientId },
          orderBy: { notedAt: "desc" },
        }),
        prisma.chronicCondition.findMany({
          where: { patientId, status: "ACTIVE" },
          orderBy: { diagnosedDate: "desc" },
        }),
        prisma.immunization.findMany({
          where: { patientId },
          orderBy: { dateGiven: "desc" },
        }),
        prisma.vitals.findMany({
          where: { patientId },
          orderBy: { recordedAt: "desc" },
          take: 5,
        }),
        prisma.labResult.findMany({
          where: { orderItem: { order: { patientId } } },
          orderBy: { reportedAt: "desc" },
          take: 20,
          include: {
            orderItem: { include: { test: true, order: true } },
          },
        }),
        prisma.surgery.findMany({
          where: { patientId },
          orderBy: { scheduledAt: "desc" },
          take: 10,
          include: {
            surgeon: { include: { user: { select: { name: true } } } },
          },
        }),
        prisma.prescription.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { items: true },
        }),
      ]);

      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const doc = {
        generatedAt: new Date().toISOString(),
        documentType: "CCDA_SIMPLIFIED",
        patient: {
          id: patient.id,
          mrNumber: patient.mrNumber,
          name: patient.user.name,
          email: patient.user.email,
          phone: patient.user.phone,
          dateOfBirth: patient.dateOfBirth,
          age: patient.age,
          gender: patient.gender,
          bloodGroup: patient.bloodGroup,
          address: patient.address,
          maritalStatus: patient.maritalStatus,
          occupation: patient.occupation,
          preferredLanguage: patient.preferredLanguage,
          abhaId: patient.abhaId,
        },
        emergencyContacts: patient.emergencyContactName
          ? [
              {
                name: patient.emergencyContactName,
                phone: patient.emergencyContactPhone,
              },
            ]
          : [],
        activeProblems: conditions.map((c) => ({
          condition: c.condition,
          icd10Code: c.icd10Code,
          diagnosedDate: c.diagnosedDate,
          status: c.status,
          notes: c.notes,
        })),
        allergies: allergies.map((a) => ({
          allergen: a.allergen,
          severity: a.severity,
          reaction: a.reaction,
          notes: a.notes,
          notedAt: a.notedAt,
        })),
        currentMedications: activePrescriptions.flatMap((p) =>
          p.items.map((it) => ({
            prescriptionId: p.id,
            medicineName: it.medicineName,
            dosage: it.dosage,
            frequency: it.frequency,
            duration: it.duration,
            instructions: it.instructions,
            prescribedAt: p.createdAt,
          }))
        ),
        recentVitals: recentVitals.map((v) => ({
          recordedAt: v.recordedAt,
          bloodPressure:
            v.bloodPressureSystolic && v.bloodPressureDiastolic
              ? `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`
              : null,
          pulseRate: v.pulseRate,
          spO2: v.spO2,
          temperature: v.temperature,
          temperatureUnit: v.temperatureUnit,
          weight: v.weight,
          height: v.height,
          bmi: v.bmi,
          respiratoryRate: v.respiratoryRate,
          isAbnormal: v.isAbnormal,
          abnormalFlags: v.abnormalFlags,
        })),
        recentLabResults: recentLabResults.map((r) => ({
          test: r.orderItem.test.name,
          value: r.value,
          unit: r.unit,
          flag: r.flag,
          reportedAt: r.reportedAt,
          orderNumber: r.orderItem.order.orderNumber,
        })),
        recentProcedures: recentSurgeries.map((s: any) => ({
          procedureName: s.procedure,
          scheduledAt: s.scheduledAt,
          status: s.status,
          surgeon: s.surgeon?.user?.name,
          notes: s.notes ?? null,
        })),
        immunizations: immunizations.map((im) => ({
          vaccine: im.vaccine,
          doseNumber: im.doseNumber,
          dateGiven: im.dateGiven,
          nextDueDate: im.nextDueDate,
          batchNumber: im.batchNumber,
          manufacturer: im.manufacturer,
        })),
      };

      auditLog(req, "CCDA_EXPORT", "patient", patient.id).catch(console.error);

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ccda-${patient.mrNumber}.json"`
      );
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(doc, null, 2));
    } catch (err) {
      next(err);
    }
  }
);

// NOTE: All `/users/*` handlers (list, PATCH, reset-password,
// service-certificate, dashboard preferences) moved to
// `routes/users.ts` in TODO.md A6's discoverability refactor.

export { router as patientExtrasRouter };
