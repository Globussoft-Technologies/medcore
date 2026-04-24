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
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { validateUuidParams } from "../middleware/validate-params";
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
  type FhirBundle,
} from "../services/fhir/bundle";
import { validateResource, validateBundle } from "../services/fhir/validator";
import { processBundle } from "../services/fhir/ingest";
import {
  searchPatient,
  searchEncounter,
  searchMedicationRequest,
  searchAllergyIntolerance,
  FhirSearchError,
  type PatientSearchParams,
  type EncounterSearchParams,
  type MedicationRequestSearchParams,
  type AllergyIntoleranceSearchParams,
  type SearchParams,
  type SearchContext,
} from "../services/fhir/search";

const router = Router();

// security(2026-04-23-low): PHI responses must not be cached by intermediate
// proxies or browsers, and FHIR clients must not MIME-sniff JSON payloads.
// Apply headers at the router layer so every endpoint inherits them without
// touching app.ts.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

router.use(authenticate);

// security(2026-04-23-med): F-FHIR-2 — Bundle ingest is a heavy, multi-write
// path. Cap to 10/min/IP so a compromised admin token can't flood the DB.
const bundleRateLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(10, 60_000);

// security(2026-04-24): F-FHIR-2 — cap per-bundle entry count. Even with the
// rate limiter above, a single 50 000-entry transaction bundle can starve the
// DB for several seconds inside prisma.$transaction. 100 entries covers all
// realistic ABDM-side bundle shapes we've round-tripped (round-trip.test max
// observed ~60 entries for a heavy Patient/$everything export).
const MAX_BUNDLE_ENTRIES = 100;

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
  // security(2026-04-23-med): F-FHIR-1 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
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
  // security(2026-04-23-med): F-FHIR-1 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
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
  // security(2026-04-23-med): F-FHIR-1 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
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
  // Ingesting a FHIR bundle rewrites clinical state across multiple tables and
  // bypasses the normal per-endpoint business rules — restricted to ADMIN.
  authorize(Role.ADMIN),
  bundleRateLimit,
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
        sendFhir(
          res,
          400,
          operationOutcome(
            "error",
            "invalid",
            `Bundle.type must be 'transaction' (got '${bundle.type}'). batch/history/document bundles are not accepted.`
          )
        );
        return;
      }

      // security(2026-04-24): F-FHIR-2 — reject oversized bundles up front so
      // the DB transaction below never sees a pathological payload. 413 is the
      // closest HTTP semantics ("payload too large"); FHIR wraps it in an
      // OperationOutcome with code=too-costly per §3.1.8.
      const entryCount = bundle.entry?.length ?? 0;
      if (entryCount > MAX_BUNDLE_ENTRIES) {
        sendFhir(
          res,
          413,
          operationOutcome(
            "error",
            "too-costly",
            `Bundle.entry has ${entryCount} entries; maximum is ${MAX_BUNDLE_ENTRIES}. Split into smaller bundles.`
          )
        );
        return;
      }

      const { bundle: response, success, errorMessage } = await processBundle(bundle, {
        recordedBy: req.user?.userId ?? "system",
      });

      await auditLog(req, "FHIR_BUNDLE_RECEIVED", "Bundle", bundle.id, {
        entryCount: bundle.entry?.length ?? 0,
        success,
      });

      if (!success) {
        // Whole-bundle failure — rollback already happened in processBundle.
        sendFhir(
          res,
          400,
          operationOutcome("error", "processing", errorMessage ?? "Bundle ingestion failed")
        );
        return;
      }

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
  // security(2026-04-23-med): F-FHIR-1 — reject non-UUID :id up front.
  validateUuidParams(["id"]),
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

// ─── Search endpoints (FHIR R4 §3.1.3 — type=searchset) ────────────────────
//
// These provide the third-party query entrypoint used by ABDM HIU pulls and
// other FHIR clients. Unlike the read endpoints they accept only ADMIN/DOCTOR
// (patient-self role would need per-patient authorisation we can't express
// via a simple filter). Bad parameters produce a FHIR OperationOutcome with
// severity=error rather than being silently ignored.

/** Extract the SearchContext used to build self/next/prev links. */
function searchContext(req: Request): SearchContext {
  // Prefer the FHIR canonical base when the reverse proxy sets it; fall back
  // to the request host. URLs are assembled with the same `req.path` so link
  // URLs round-trip back to this handler.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = `${proto}://${host}${req.baseUrl}${req.path}`;
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) v.forEach((vv) => searchParams.append(k, String(vv)));
    else if (v !== undefined) searchParams.set(k, String(v));
  }
  const selfUrl = `${baseUrl}?${searchParams.toString()}`;
  return { baseUrl, searchParams, selfUrl };
}

/** Coerce Express's ParsedQs into string-only params for our search layer. */
function flatQuery(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) {
      if (v.length) out[k] = String(v[0]);
    } else if (v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

async function handleSearchError(
  res: Response,
  err: unknown,
  next: NextFunction
): Promise<void> {
  if (err instanceof FhirSearchError) {
    sendFhir(res, 400, operationOutcome("error", "invalid", err.diagnostics));
    return;
  }
  next(err as any);
}

/**
 * Build an audit-safe summary of FHIR search params. Logs ONLY the param
 * names + a boolean indicating whether a value was supplied. Never emits
 * the raw identifier, name, family-name, or other value — those can
 * themselves be PHI (ABHA IDs, MRNs, etc.) and must not land in audit_logs.
 */
function redactedSearchParams(
  q: SearchParams
): Record<string, { hasValue: boolean }> {
  const out: Record<string, { hasValue: boolean }> = {};
  for (const [k, v] of Object.entries(q)) {
    out[k] = { hasValue: typeof v === "string" && v.length > 0 };
  }
  return out;
}

// GET /api/v1/fhir/Patient?name=...&family=...&identifier=...&_count=...
router.get(
  "/Patient",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    const q = flatQuery(req.query) as PatientSearchParams;
    try {
      const bundle = await searchPatient(q, searchContext(req));
      await auditLog(req, "FHIR_SEARCH_PATIENT", "Patient", undefined, {
        params: redactedSearchParams(q),
        resultCount: bundle.total,
      });
      sendFhir(res, 200, bundle);
    } catch (err) {
      await handleSearchError(res, err, next);
    }
  }
);

// GET /api/v1/fhir/Encounter?patient=...&date=ge2024-01-01&status=finished
router.get(
  "/Encounter",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    const q = flatQuery(req.query) as EncounterSearchParams;
    try {
      const bundle = await searchEncounter(q, searchContext(req));
      await auditLog(req, "FHIR_SEARCH_ENCOUNTER", "Encounter", undefined, {
        params: redactedSearchParams(q),
        resultCount: bundle.total,
      });
      sendFhir(res, 200, bundle);
    } catch (err) {
      await handleSearchError(res, err, next);
    }
  }
);

// GET /api/v1/fhir/MedicationRequest?patient=...&authoredon=ge2025-01-01
router.get(
  "/MedicationRequest",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    const q = flatQuery(req.query) as MedicationRequestSearchParams;
    try {
      const bundle = await searchMedicationRequest(q, searchContext(req));
      await auditLog(req, "FHIR_SEARCH_MEDICATIONREQUEST", "MedicationRequest", undefined, {
        params: redactedSearchParams(q),
        resultCount: bundle.total,
      });
      sendFhir(res, 200, bundle);
    } catch (err) {
      await handleSearchError(res, err, next);
    }
  }
);

// GET /api/v1/fhir/AllergyIntolerance?patient=...
router.get(
  "/AllergyIntolerance",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    const q = flatQuery(req.query) as AllergyIntoleranceSearchParams;
    try {
      const bundle = await searchAllergyIntolerance(q, searchContext(req));
      await auditLog(req, "FHIR_SEARCH_ALLERGYINTOLERANCE", "AllergyIntolerance", undefined, {
        params: redactedSearchParams(q),
        resultCount: bundle.total,
      });
      sendFhir(res, 200, bundle);
    } catch (err) {
      await handleSearchError(res, err, next);
    }
  }
);

export { router as fhirRouter };
