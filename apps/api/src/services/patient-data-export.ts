/**
 * Patient Data Export service — DPDP Act 2023 right-to-portability.
 *
 * Collects every row belonging to a single patient across the EHR and emits
 * one of three artifacts:
 *
 *   - JSON : one monolithic JSON document, keyed by entity
 *   - FHIR : R4 transaction bundle using existing forward mappers + bundle.ts
 *   - PDF  : human-readable summary via pdfkit (reuses pdf-generator patterns)
 *
 * Files land under `uploads/exports/` with a UUID filename. The route layer
 * hands out short-lived signed URLs; downloads go via the normal
 * `uploads/:filename?expires=&sig=` signed-URL flow (see `signed-url.ts`).
 *
 * Worker model: a lightweight in-process chain kicked off by
 * `startExportWorker(requestId)`. Uses `setImmediate` so the HTTP response to
 * POST /patient-data-export returns `QUEUED` immediately, and uses
 * `runWithTenant` to preserve tenant scoping across the async boundary.
 *
 * Backed by the `PatientDataExport` Prisma model — migration shipped in
 * `20260424000004_prd_closure_models`. Tenant-scoped via
 * `TENANT_SCOPED_MODELS`, so `prisma.patientDataExport.*` calls
 * automatically filter by `tenantId`.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { prisma as rawPrisma } from "@medcore/db";
import { tenantScopedPrisma as prisma } from "./tenant-prisma";
import { runWithTenant } from "./tenant-context";
import {
  patientToFhir,
  doctorToFhir,
  appointmentToFhir,
  consultationToEncounter,
  consultationToComposition,
  prescriptionToMedicationRequests,
  labOrderToServiceRequest,
  labResultToObservation,
  labOrderToDiagnosticReport,
  allergyToFhir,
  type FhirResource,
} from "./fhir/resources";
import { toTransactionBundle, type FhirBundle } from "./fhir/bundle";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PatientDataExportFormat = "json" | "fhir" | "pdf";
export type PatientDataExportStatus =
  | "QUEUED"
  | "PROCESSING"
  | "READY"
  | "FAILED";

export const EXPORT_FORMATS: PatientDataExportFormat[] = ["json", "fhir", "pdf"];

// Hard cap on how long a single export can run before being forced to FAILED.
export const EXPORT_MAX_MS = 10 * 60 * 1000; // 10 minutes

// Rate-limit window for the per-patient 3-per-24h cap.
export const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EXPORT_WINDOW_MAX = 3;

// Where finished export files live. Kept separate from `uploads/ehr/` (medical
// documents) so a stray purge of one never clobbers the other.
export const EXPORT_DIR = path.join(process.cwd(), "uploads", "exports");

function ensureExportDir(): void {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// ─── Rate-limit check ──────────────────────────────────────────────────────

/**
 * Count exports this patient has requested in the last 24 hours. Used by the
 * route to reject a 4th request with 429.
 */
export async function countRecentExports(
  patientId: string
): Promise<number> {
  const since = new Date(Date.now() - EXPORT_WINDOW_MS);
  const count = await prisma.patientDataExport.count({
    where: { patientId, requestedAt: { gte: since } },
  });
  return count;
}

// ─── Data collection ───────────────────────────────────────────────────────

/**
 * Raw bag of every record we export. The shapes are deliberately close to
 * Prisma's own so a consumer can round-trip back through Prisma if needed.
 */
export interface PatientDataBag {
  exportedAt: string;
  patient: any;
  appointments: any[];
  consultations: any[];
  prescriptions: any[];
  labOrders: any[];
  admissions: any[];
  allergies: any[];
  chronicConditions: any[];
  familyHistory: any[];
  immunizations: any[];
  medicationOrders: any[];
  documents: any[];
  invoices: any[];
  insuranceClaims: any[];
  aiTriageSessions: any[];
  aiScribeSessions: any[];
  symptomDiary: any[];
  adherenceSchedules: any[];
}

/**
 * Pull every row belonging to `patientId`. Each sub-query is defensive: it
 * `try`s on its own so a missing index or model change can't tank the whole
 * export.
 */
export async function collectPatientData(
  patientId: string
): Promise<PatientDataBag> {
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.warn(
        `[patient-data-export] sub-query failed:`,
        (err as Error)?.message ?? err
      );
      return fallback;
    }
  };

  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: { user: { select: { id: true, name: true, email: true, phone: true } } },
  });
  if (!patient) throw new Error(`Patient ${patientId} not found`);

  const [
    appointments,
    consultations,
    prescriptions,
    labOrders,
    admissions,
    allergies,
    chronicConditions,
    familyHistory,
    immunizations,
    medicationOrders,
    documents,
    invoices,
    insuranceClaims,
    aiTriageSessions,
    aiScribeSessions,
    symptomDiary,
    adherenceSchedules,
  ] = await Promise.all([
    safe(
      () =>
        prisma.appointment.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true, email: true, phone: true } } } },
          },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.consultation.findMany({
          where: { appointment: { patientId } },
          include: { appointment: true },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.prescription.findMany({
          where: { patientId },
          include: { items: true },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.labOrder.findMany({
          where: { patientId },
          include: { items: { include: { test: true, results: true } } },
          orderBy: { orderedAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.admission.findMany({
          where: { patientId },
          include: { bed: { include: { ward: true } } },
          orderBy: { admittedAt: "desc" },
        }),
      []
    ),
    safe(() => prisma.patientAllergy.findMany({ where: { patientId } }), []),
    safe(() => prisma.chronicCondition.findMany({ where: { patientId } }), []),
    safe(() => prisma.familyHistory.findMany({ where: { patientId } }), []),
    safe(() => prisma.immunization.findMany({ where: { patientId } }), []),
    safe(
      () =>
        prisma.medicationOrder.findMany({
          where: { admission: { patientId } },
        }),
      []
    ),
    safe(() => prisma.patientDocument.findMany({ where: { patientId } }), []),
    safe(
      () =>
        prisma.invoice.findMany({
          where: { patientId },
          include: { items: true, payments: true },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.insuranceClaim.findMany({
          where: { patientId },
          orderBy: { submittedAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.aITriageSession.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.aIScribeSession.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.symptomDiaryEntry.findMany({
          where: { patientId },
          orderBy: { symptomDate: "desc" },
        }),
      []
    ),
    safe(
      () =>
        prisma.adherenceSchedule.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
        }),
      []
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    patient,
    appointments,
    consultations,
    prescriptions,
    labOrders,
    admissions,
    allergies,
    chronicConditions,
    familyHistory,
    immunizations,
    medicationOrders,
    documents,
    invoices,
    insuranceClaims,
    aiTriageSessions,
    aiScribeSessions,
    symptomDiary,
    adherenceSchedules,
  };
}

// ─── Builders ──────────────────────────────────────────────────────────────

/**
 * Serialize the full data bag as a JSON buffer.
 */
export function buildJsonExport(bag: PatientDataBag): Buffer {
  return Buffer.from(JSON.stringify(bag, null, 2), "utf8");
}

/**
 * Map the collected bag into FHIR R4 resources, then wrap in a transaction
 * bundle so the receiver can replay it idempotently into their own store.
 */
export function buildFhirExport(bag: PatientDataBag): Buffer {
  const resources: FhirResource[] = [];

  // Patient (always first — everything else references it)
  try {
    resources.push(patientToFhir(bag.patient));
  } catch (err) {
    console.warn("[patient-data-export] patientToFhir failed:", err);
  }

  // Practitioners — de-dup by doctor id
  const seenDoctors = new Set<string>();
  for (const appt of bag.appointments) {
    const doc = appt?.doctor;
    if (doc?.id && !seenDoctors.has(doc.id)) {
      try {
        resources.push(doctorToFhir(doc));
        seenDoctors.add(doc.id);
      } catch {
        // skip
      }
    }
  }

  for (const appt of bag.appointments) {
    try {
      resources.push(appointmentToFhir(appt));
    } catch {
      // skip
    }
  }

  for (const consult of bag.consultations) {
    try {
      resources.push(consultationToEncounter(consult));
      resources.push(consultationToComposition(consult));
    } catch {
      // skip
    }
  }

  for (const rx of bag.prescriptions) {
    try {
      const reqs = prescriptionToMedicationRequests(rx);
      resources.push(...reqs);
    } catch {
      // skip
    }
  }

  for (const order of bag.labOrders) {
    try {
      resources.push(labOrderToServiceRequest(order));
      const resultIds: string[] = [];
      for (const item of order.items ?? []) {
        for (const r of item.results ?? []) {
          try {
            resources.push(
              labResultToObservation(r, {
                patientId: order.patientId,
                orderId: order.id,
                testCode: item.test?.code,
                testName: item.test?.name,
              })
            );
            if (r.id) resultIds.push(r.id);
          } catch {
            // skip
          }
        }
      }
      if (resultIds.length > 0) {
        try {
          resources.push(labOrderToDiagnosticReport(order, resultIds));
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  for (const allergy of bag.allergies) {
    try {
      resources.push(allergyToFhir(allergy));
    } catch {
      // skip
    }
  }

  const bundle: FhirBundle = toTransactionBundle(resources);
  return Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
}

/**
 * Produce a short summary PDF listing what's included. This is intentionally
 * a *summary*, not a clinical document — the full record lives in the JSON or
 * FHIR export. The disclaimer on page 1 spells that out so patients who only
 * download the PDF aren't misled.
 */
export function buildPdfExport(bag: PatientDataBag): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc
      .fillColor("#1e293b")
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("MedCore — Patient Data Export", { align: "center" });
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#64748b")
      .text(
        "DPDP Act 2023 — Right to Data Portability (summary)",
        { align: "center" }
      );
    doc.moveDown(0.8);

    // Disclaimer box
    const disclaimerY = doc.y;
    doc.rect(40, disclaimerY, 515, 70).fill("#fef3c7");
    doc
      .fillColor("#78350f")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Included:", 48, disclaimerY + 8, { width: 500 });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#78350f")
      .text(
        "This PDF is a high-level summary of your records held by this hospital: demographics, appointments, prescriptions, lab orders, admissions, allergies, immunizations, documents, bills, claims, and any AI-assisted sessions for you. " +
          "It is NOT a clinical document and does not replace your original prescriptions or reports. " +
          "For a machine-readable copy, download the JSON or FHIR bundle from the same page.",
        48,
        disclaimerY + 22,
        { width: 500 }
      );
    doc.y = disclaimerY + 78;
    doc.fillColor("#1e293b");

    // Patient block
    const p = bag.patient;
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(12).text("Patient");
    doc.font("Helvetica").fontSize(10).fillColor("#1e293b");
    doc.text(`Name: ${p?.user?.name ?? "-"}`);
    doc.text(`MR #: ${p?.mrNumber ?? "-"}`);
    doc.text(`Gender: ${p?.gender ?? "-"}`);
    if (p?.dateOfBirth)
      doc.text(`Date of birth: ${new Date(p.dateOfBirth).toISOString().slice(0, 10)}`);
    if (p?.user?.phone) doc.text(`Phone: ${p.user.phone}`);
    if (p?.user?.email) doc.text(`Email: ${p.user.email}`);
    if (p?.abhaId) doc.text(`ABHA ID: ${p.abhaId}`);
    doc.moveDown(0.6);

    // Counts table
    doc.font("Helvetica-Bold").fontSize(12).text("Summary of records");
    doc.moveDown(0.2);
    const rows: Array<[string, number]> = [
      ["Appointments", bag.appointments.length],
      ["Consultations", bag.consultations.length],
      ["Prescriptions", bag.prescriptions.length],
      ["Lab orders", bag.labOrders.length],
      ["Admissions", bag.admissions.length],
      ["Allergies", bag.allergies.length],
      ["Chronic conditions", bag.chronicConditions.length],
      ["Family history", bag.familyHistory.length],
      ["Immunizations", bag.immunizations.length],
      ["Medication orders (IPD)", bag.medicationOrders.length],
      ["Documents", bag.documents.length],
      ["Invoices", bag.invoices.length],
      ["Insurance claims", bag.insuranceClaims.length],
      ["AI triage sessions", bag.aiTriageSessions.length],
      ["AI scribe sessions (as subject)", bag.aiScribeSessions.length],
      ["Symptom diary entries", bag.symptomDiary.length],
      ["Adherence schedules", bag.adherenceSchedules.length],
    ];
    doc.font("Helvetica").fontSize(10);
    for (const [label, n] of rows) {
      doc.text(`  • ${label}: ${n}`);
    }

    // Appointments preview (first 10)
    if (bag.appointments.length > 0) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).text("Recent appointments");
      doc.font("Helvetica").fontSize(9).fillColor("#1e293b");
      for (const a of bag.appointments.slice(0, 10)) {
        const dt = a?.date
          ? new Date(a.date).toISOString().slice(0, 10)
          : "-";
        const docName = a?.doctor?.user?.name
          ? `Dr. ${a.doctor.user.name}`
          : "-";
        doc.text(
          `  • ${dt} — ${docName} — ${a?.status ?? "-"}`
        );
      }
    }

    // Prescriptions preview (first 10)
    if (bag.prescriptions.length > 0) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).text("Recent prescriptions");
      doc.font("Helvetica").fontSize(9).fillColor("#1e293b");
      for (const rx of bag.prescriptions.slice(0, 10)) {
        const dt = rx?.createdAt
          ? new Date(rx.createdAt).toISOString().slice(0, 10)
          : "-";
        const meds = (rx?.items ?? [])
          .map((i: any) => i.medicineName)
          .slice(0, 3)
          .join(", ");
        doc.text(`  • ${dt} — ${rx?.diagnosis ?? "-"} — ${meds || "-"}`);
      }
    }

    // Footer on final page
    doc.moveDown(1.2);
    doc.font("Helvetica").fontSize(8).fillColor("#94a3b8");
    doc.text(
      `Generated at ${bag.exportedAt} — full machine-readable copy available in JSON/FHIR.`,
      { align: "center" }
    );

    doc.end();
  });
}

/**
 * Dispatch to the format builder. Extracted so the worker + tests share
 * exactly one switch.
 */
export async function buildExport(
  patientId: string,
  format: PatientDataExportFormat
): Promise<{ buffer: Buffer; extension: string; mime: string }> {
  const bag = await collectPatientData(patientId);

  switch (format) {
    case "json":
      return {
        buffer: buildJsonExport(bag),
        extension: "json",
        mime: "application/json",
      };
    case "fhir":
      return {
        buffer: buildFhirExport(bag),
        extension: "fhir.json",
        mime: "application/fhir+json",
      };
    case "pdf": {
      const buffer = await buildPdfExport(bag);
      return { buffer, extension: "pdf", mime: "application/pdf" };
    }
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown export format: ${String(_exhaustive)}`);
    }
  }
}

// ─── Worker ────────────────────────────────────────────────────────────────

/**
 * Filename for a finished export. Kept UUID-based so the signed URL can't be
 * guessed even if the expires + sig were leaked (the filename itself
 * contributes entropy to the signed path).
 */
export function exportFilename(requestId: string, extension: string): string {
  const suffix = crypto.randomBytes(6).toString("hex");
  return `export-${requestId}-${suffix}.${extension}`;
}

/**
 * Run the export for `requestId` end-to-end and update the row through
 * QUEUED → PROCESSING → READY|FAILED. Safe to call twice: the second call
 * will notice a non-QUEUED status and return without work.
 *
 * This function is normally kicked off by `scheduleExportWorker` via
 * `setImmediate`, but tests invoke it synchronously for determinism.
 */
export async function runExportWorker(requestId: string): Promise<void> {
  // Use the raw (non-tenant-scoped) prisma here because the worker runs
  // outside the request-local tenant context. The row was created tenant-
  // scoped; this update is an admin-style housekeeping write keyed by id.
  const row = await rawPrisma.patientDataExport.findUnique({
    where: { id: requestId },
  });
  if (!row) return;
  if (row.status !== "QUEUED") return;

  const started = Date.now();
  const markFailed = async (msg: string) => {
    try {
      await rawPrisma.patientDataExport.update({
        where: { id: requestId },
        data: { status: "FAILED", errorMessage: msg.slice(0, 1000) },
      });
    } catch (err) {
      console.error("[patient-data-export] failed to mark FAILED:", err);
    }
  };

  try {
    await rawPrisma.patientDataExport.update({
      where: { id: requestId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });

    // Watchdog: if the build takes longer than EXPORT_MAX_MS, mark FAILED.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      void markFailed(`Export exceeded ${EXPORT_MAX_MS}ms deadline`);
    }, EXPORT_MAX_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();

    const run = async () => {
      const { buffer, extension } = await buildExport(
        row.patientId,
        row.format.toLowerCase() as PatientDataExportFormat
      );
      ensureExportDir();
      const filename = exportFilename(requestId, extension);
      const fullPath = path.join(EXPORT_DIR, filename);
      await fs.promises.writeFile(fullPath, buffer);
      return { filename, size: buffer.length };
    };

    // Run inside the row's tenant context so any tenantScopedPrisma call in
    // collectPatientData sees the right scope even though the HTTP request
    // that created the row is long gone.
    const { filename, size } = row.tenantId
      ? await runWithTenant(row.tenantId, run)
      : await run();

    clearTimeout(watchdog);
    if (watchdogFired) return; // already marked FAILED by watchdog

    await rawPrisma.patientDataExport.update({
      where: { id: requestId },
      data: {
        status: "READY",
        readyAt: new Date(),
        filePath: filename,
        fileSize: size,
      },
    });

    const duration = Date.now() - started;
    console.info(
      `[patient-data-export] ${requestId} READY in ${duration}ms (${size} bytes)`
    );
  } catch (err) {
    console.error(`[patient-data-export] ${requestId} FAILED:`, err);
    await markFailed((err as Error)?.message ?? "Unknown error");
  }
}

/**
 * Fire-and-forget: schedule `runExportWorker` via `setImmediate` so the
 * caller's HTTP handler can return right away.
 */
export function scheduleExportWorker(requestId: string): void {
  setImmediate(() => {
    void runExportWorker(requestId);
  });
}
