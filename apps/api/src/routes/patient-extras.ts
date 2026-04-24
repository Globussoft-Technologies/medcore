import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, dashboardPreferenceSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { computePatientBaseline } from "../services/vitals-baseline";
import {
  generatePatientIdCardHTML,
  generateVitalsHistoryHTML,
  generateFitnessCertificateHTML,
  generateDeathCertificateHTML,
  generateServiceCertificateHTML,
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

// ─── GET /users/:id/service-certificate ───────────────
router.get(
  "/users/:id/service-certificate",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conduct = (req.query.conduct as string) || "satisfactory";
      const html = await generateServiceCertificateHTML(req.params.id, conduct);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "User not found") {
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

// ─── GET /users — list staff users for /dashboard/users (Issue #4) ────
//
// Returns a flat list of staff users with the fields the User Management
// table reads directly: name, email, phone, role, isActive, createdAt.
//
// Why this lives in patient-extras.ts: strict rules forbid touching app.ts,
// and the `/api/v1` mount for this router means we can add a top-level
// `/users` route here without a new `app.use(...)` call.
//
// The existing `/shifts/staff` endpoint omits `phone` and `createdAt`, which
// is why the UsersPage rendered empty "Joined" / "Phone" cells — and the
// page was falling back to `/doctors`, whose payload is shaped as
// `{ user: { name, email, phone } }` (nested), so `u.name` etc. were all
// undefined. This endpoint returns the exact shape the `StaffUser`
// interface in apps/web/src/app/dashboard/users/page.tsx expects.
router.get(
  "/users",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          role: { in: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });
      res.json({ success: true, data: users, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── User dashboard preferences ───────────────────────

router.get(
  "/users/me/dashboard-preferences",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const pref = await prisma.userDashboardPreference.findUnique({
        where: { userId },
      });
      res.json({
        success: true,
        data: pref ?? { userId, layout: { widgets: [] } },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/users/me/dashboard-preferences",
  validate(dashboardPreferenceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const layout = req.body.layout;
      const saved = await prisma.userDashboardPreference.upsert({
        where: { userId },
        update: { layout: layout as any },
        create: { userId, layout: layout as any },
      });
      res.json({ success: true, data: saved, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as patientExtrasRouter };
