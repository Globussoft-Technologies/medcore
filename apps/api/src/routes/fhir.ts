/**
 * FHIR R4 export endpoints.
 *
 * Responses use Content-Type: application/fhir+json per FHIR R4 §3.1.6.
 * Auth reuses the existing JWT middleware — only DOCTOR, NURSE, ADMIN, and
 * the patient themselves should be able to read FHIR resources. Audit is
 * written for every export so patient-data egress is traceable.
 *
 * This mirrors the pattern in ai-scribe.ts: authenticate → authorize → handler.
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  patientToFhir,
  doctorToFhir,
  appointmentToFhir,
  consultationToEncounter,
  consultationToComposition,
  prescriptionToMedicationRequests,
  labOrderToServiceRequest,
  labOrderToDiagnosticReport,
  labResultToObservation,
  allergyToFhir,
  type FhirResource,
} from "../services/fhir/resources";
import {
  toSearchsetBundle,
  toTransactionBundle,
  processTransactionBundle,
  type FhirBundle,
} from "../services/fhir/bundle";
import { validateResource, validateBundle } from "../services/fhir/validator";

const router = Router();
router.use(authenticate);

const FHIR_CONTENT_TYPE = "application/fhir+json";

/** Set the FHIR content type on the response. */
function sendFhir(res: Response, status: number, body: unknown) {
  res.status(status).type(FHIR_CONTENT_TYPE).send(JSON.stringify(body));
}

/**
 * Build a FHIR OperationOutcome (the FHIR-native error envelope).
 * We use this for 4xx/5xx responses instead of the MedCore envelope so
 * downstream FHIR clients can parse errors natively.
 */
function operationOutcome(severity: "error" | "warning", code: string, diagnostics: string) {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
}

/**
 * Guard: check the caller is allowed to read the given patient. Patients can
 * only access their own record; staff roles have broader access.
 */
async function canReadPatient(req: Request, patientId: string): Promise<boolean> {
  const role = req.user?.role;
  if (role === Role.ADMIN || role === Role.DOCTOR || role === Role.NURSE || role === Role.RECEPTION) {
    return true;
  }
  if (role === Role.PATIENT) {
    const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { userId: true } });
    return patient?.userId === req.user?.userId;
  }
  return false;
}

// ─── GET /api/v1/fhir/Patient/:id ───────────────────────────────────────────

router.get(
  "/Patient/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      if (!(await canReadPatient(req, id))) {
        sendFhir(res, 403, operationOutcome("error", "forbidden", "Not authorised to read this patient"));
        return;
      }

      const patient = await prisma.patient.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!patient) {
        sendFhir(res, 404, operationOutcome("error", "not-found", `Patient/${id} not found`));
        return;
      }

      const resource = patientToFhir(patient);
      const validation = validateResource(resource);
      if (!validation.valid) {
        sendFhir(res, 500, operationOutcome("error", "exception", "Generated resource failed validation"));
        return;
      }

      await auditLog(req, "FHIR_PATIENT_READ", "Patient", id, {});
      sendFhir(res, 200, resource);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/fhir/Patient/:id/$everything ───────────────────────────────

router.get(
  "/Patient/:id/\\$everything",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!(await canReadPatient(req, id))) {
        sendFhir(res, 403, operationOutcome("error", "forbidden", "Not authorised"));
        return;
      }

      const patient = await prisma.patient.findUnique({
        where: { id },
        include: {
          user: true,
          allergies: true,
          appointments: { include: { doctor: { include: { user: true } } } },
          prescriptions: { include: { items: true, doctor: { include: { user: true } } } },
          labOrders: { include: { items: { include: { test: true, results: true } }, doctor: { include: { user: true } } } },
        },
      });

      if (!patient) {
        sendFhir(res, 404, operationOutcome("error", "not-found", `Patient/${id} not found`));
        return;
      }

      const resources: FhirResource[] = [];
      resources.push(patientToFhir(patient));

      // De-duplicate doctors across appointments/prescriptions/labOrders
      const doctorMap = new Map<string, any>();
      for (const appt of patient.appointments as any[]) {
        if (appt.doctor && !doctorMap.has(appt.doctor.id)) doctorMap.set(appt.doctor.id, appt.doctor);
      }
      for (const rx of patient.prescriptions as any[]) {
        if (rx.doctor && !doctorMap.has(rx.doctor.id)) doctorMap.set(rx.doctor.id, rx.doctor);
      }
      for (const lo of patient.labOrders as any[]) {
        if (lo.doctor && !doctorMap.has(lo.doctor.id)) doctorMap.set(lo.doctor.id, lo.doctor);
      }
      for (const d of doctorMap.values()) resources.push(doctorToFhir(d));

      for (const appt of patient.appointments as any[]) resources.push(appointmentToFhir(appt));
      for (const allergy of patient.allergies as any[]) resources.push(allergyToFhir(allergy));
      for (const rx of patient.prescriptions as any[]) {
        resources.push(...prescriptionToMedicationRequests(rx));
      }

      // Consultations are keyed by appointmentId — fetch in one go
      const appointmentIds = (patient.appointments as any[]).map((a) => a.id);
      if (appointmentIds.length > 0) {
        const consultations = await prisma.consultation.findMany({
          where: { appointmentId: { in: appointmentIds } },
          include: { appointment: true },
        });
        for (const c of consultations as any[]) {
          resources.push(consultationToEncounter(c));
          try {
            resources.push(consultationToComposition(c));
          } catch {
            // Skip compositions when relation data is missing
          }
        }
      }

      for (const lo of patient.labOrders as any[]) {
        resources.push(labOrderToServiceRequest(lo));
        const resultIds: string[] = [];
        for (const item of (lo.items as any[]) ?? []) {
          for (const r of (item.results as any[]) ?? []) {
            resources.push(
              labResultToObservation(r, {
                patientId: id,
                orderId: lo.id,
                testCode: item.test?.code,
                testName: item.test?.name,
              })
            );
            resultIds.push(r.id);
          }
        }
        resources.push(labOrderToDiagnosticReport(lo, resultIds));
      }

      const bundle = toSearchsetBundle(resources, `patient-${id}-everything`);

      await auditLog(req, "FHIR_PATIENT_EVERYTHING", "Patient", id, { resourceCount: resources.length });
      sendFhir(res, 200, bundle);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/fhir/Encounter/:id ─────────────────────────────────────────

router.get(
  "/Encounter/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const consultation = await prisma.consultation.findUnique({
        where: { id },
        include: { appointment: true },
      });
      if (!consultation) {
        sendFhir(res, 404, operationOutcome("error", "not-found", `Encounter/${id} not found`));
        return;
      }

      const patientId = (consultation as any).appointment?.patientId;
      if (!(await canReadPatient(req, patientId))) {
        sendFhir(res, 403, operationOutcome("error", "forbidden", "Not authorised"));
        return;
      }

      const encounter = consultationToEncounter(consultation);
      await auditLog(req, "FHIR_ENCOUNTER_READ", "Encounter", id, {});
      sendFhir(res, 200, encounter);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/v1/fhir/Bundle ───────────────────────────────────────────────

router.post(
  "/Bundle",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bundle = req.body as FhirBundle;
      const validation = validateBundle(bundle);
      if (!validation.valid) {
        sendFhir(
          res,
          400,
          operationOutcome("error", "invalid", validation.issues.map((i) => `${i.path}: ${i.message}`).join("; "))
        );
        return;
      }

      if (bundle.type !== "transaction") {
        sendFhir(res, 400, operationOutcome("error", "invalid", "Bundle.type must be 'transaction'"));
        return;
      }

      // Stub: echo a transaction-response. Real ingestion (upserts per entry)
      // is out of scope for this initial FHIR slice — it requires per-resource
      // reverse-mappers and entity-conflict strategy.
      const response = processTransactionBundle(bundle);

      await auditLog(req, "FHIR_BUNDLE_RECEIVED", "Bundle", bundle.id, {
        entryCount: bundle.entry?.length ?? 0,
      });
      sendFhir(res, 200, response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── Utility: build a transaction bundle for export (ABDM push) ──────────────

/**
 * Helper route that packages a patient's data as a `transaction` bundle —
 * useful when pushing to external FHIR servers (ABDM Linking Token flow, etc.).
 */
router.get(
  "/Patient/:id/\\$export",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!(await canReadPatient(req, id))) {
        sendFhir(res, 403, operationOutcome("error", "forbidden", "Not authorised"));
        return;
      }

      const patient = await prisma.patient.findUnique({
        where: { id },
        include: { user: true, allergies: true },
      });
      if (!patient) {
        sendFhir(res, 404, operationOutcome("error", "not-found", `Patient/${id} not found`));
        return;
      }

      const resources: FhirResource[] = [patientToFhir(patient)];
      for (const a of patient.allergies as any[]) resources.push(allergyToFhir(a));

      const bundle = toTransactionBundle(resources, `export-${id}`);
      await auditLog(req, "FHIR_PATIENT_EXPORT", "Patient", id, { resourceCount: resources.length });
      sendFhir(res, 200, bundle);
    } catch (err) {
      next(err);
    }
  }
);

export { router as fhirRouter };
