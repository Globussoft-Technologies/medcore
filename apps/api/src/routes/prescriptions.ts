import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site in the authenticated router keeps
// working without edits. The `publicPrescriptionRouter` at the bottom of the
// file is unauthenticated (signed-URL verification for printed Rx QR codes),
// so it uses the raw, un-scoped `prisma` via `rawPrisma`.
import { prisma as rawPrisma } from "@medcore/db";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createPrescriptionSchema,
  updatePrescriptionSchema,
  copyPrescriptionSchema,
  sharePrescriptionSchema,
  prescriptionTemplateSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import {
  generatePrescriptionPDF,
  generatePrescriptionVerifyHTML,
} from "../services/pdf";
import { generatePrescriptionPDFBuffer } from "../services/pdf-generator";
import { onPrescriptionReady } from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { ingestPrescription, fireAndForgetIngest } from "../services/ai/rag-ingest";
import { sendEmail } from "../services/messaging/email";
import { sendWhatsApp } from "../services/messaging/whatsapp";
import { formatDoctorName } from "../lib/format-doctor-name";

const router = Router();
router.use(authenticate);

// Helper: check drug interactions across a set of medicine names
// Returns warnings grouped by severity
async function checkDrugInteractions(
  newMedicineNames: string[],
  patientId: string
): Promise<{
  warnings: Array<{
    drugA: string;
    drugB: string;
    severity: string;
    description: string;
    source: "NEW_VS_NEW" | "NEW_VS_EXISTING";
  }>;
  hasBlocking: boolean;
}> {
  // Fetch medicines for the new prescription
  const newMedicines = await prisma.medicine.findMany({
    where: {
      OR: newMedicineNames.flatMap((n) => [
        { name: { equals: n, mode: "insensitive" as const } },
        { genericName: { equals: n, mode: "insensitive" as const } },
      ]),
    },
  });

  // Fetch patient's active medicines from prescriptions in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentPrescriptions = await prisma.prescription.findMany({
    where: {
      patientId,
      createdAt: { gte: thirtyDaysAgo },
    },
    include: { items: true },
  });
  const existingNames = Array.from(
    new Set(
      recentPrescriptions.flatMap((p) =>
        p.items.map((i) => i.medicineName)
      )
    )
  );
  const existingMedicines = existingNames.length
    ? await prisma.medicine.findMany({
        where: {
          OR: existingNames.flatMap((n) => [
            { name: { equals: n, mode: "insensitive" as const } },
            { genericName: { equals: n, mode: "insensitive" as const } },
          ]),
        },
      })
    : [];

  const allIds = Array.from(
    new Set([...newMedicines.map((m) => m.id), ...existingMedicines.map((m) => m.id)])
  );
  if (allIds.length < 2) return { warnings: [], hasBlocking: false };

  const interactions = await prisma.drugInteraction.findMany({
    where: {
      AND: [{ drugAId: { in: allIds } }, { drugBId: { in: allIds } }],
    },
    include: { drugA: true, drugB: true },
  });

  const newIds = new Set(newMedicines.map((m) => m.id));
  const warnings = interactions
    .filter((i) => newIds.has(i.drugAId) || newIds.has(i.drugBId))
    .map((i) => {
      const source: "NEW_VS_NEW" | "NEW_VS_EXISTING" =
        newIds.has(i.drugAId) && newIds.has(i.drugBId)
          ? "NEW_VS_NEW"
          : "NEW_VS_EXISTING";
      return {
        drugA: i.drugA.name,
        drugB: i.drugB.name,
        severity: i.severity,
        description: i.description,
        source,
      };
    });
  const hasBlocking = warnings.some(
    (w) => w.severity === "SEVERE" || w.severity === "CONTRAINDICATED"
  );
  return { warnings, hasBlocking };
}

// Pearl ERP Stage 1 §2.1.4 — drug-allergy block. Reads the patient's
// PatientAllergy rows and cross-references each medicine being
// prescribed against them. Match strategy: case-insensitive bidirectional
// substring against the medicine's brand name + generic name. False
// positives are preferable to misses (a missed allergy is a patient
// safety event; a false positive is an override-with-reason). The
// override is gated at the route handler — this helper just surfaces
// the conflicts.
async function checkPatientAllergies(
  medicineNames: string[],
  patientId: string,
): Promise<{
  conflicts: Array<{
    medicineName: string;
    allergen: string;
    severity: string;
    reaction: string | null;
  }>;
}> {
  if (medicineNames.length === 0) return { conflicts: [] };

  const allergies = await prisma.patientAllergy.findMany({
    where: { patientId },
    select: { allergen: true, severity: true, reaction: true },
  });
  if (allergies.length === 0) return { conflicts: [] };

  // Resolve each medicine name to (brand, generic) tokens. Unknown names
  // (free-text prescriptions outside the master) fall back to the name
  // itself.
  const medicines = await prisma.medicine.findMany({
    where: {
      OR: medicineNames.flatMap((n) => [
        { name: { equals: n, mode: "insensitive" as const } },
        { genericName: { equals: n, mode: "insensitive" as const } },
      ]),
    },
    select: { name: true, genericName: true },
  });

  const tokensByName = new Map<string, string[]>();
  for (const n of medicineNames) {
    const key = n.toLowerCase();
    const matched = medicines.find(
      (m) =>
        m.name.toLowerCase() === key ||
        (m.genericName && m.genericName.toLowerCase() === key),
    );
    const tokens = matched
      ? [matched.name, matched.genericName].filter((s): s is string => !!s).map((s) => s.toLowerCase())
      : [key];
    tokensByName.set(n, tokens);
  }

  const conflicts: Array<{
    medicineName: string;
    allergen: string;
    severity: string;
    reaction: string | null;
  }> = [];
  for (const medName of medicineNames) {
    const tokens = tokensByName.get(medName) ?? [medName.toLowerCase()];
    for (const a of allergies) {
      const allergen = a.allergen.toLowerCase().trim();
      if (!allergen) continue;
      const hit = tokens.some((t) => t.includes(allergen) || allergen.includes(t));
      if (hit) {
        conflicts.push({
          medicineName: medName,
          allergen: a.allergen,
          severity: a.severity,
          reaction: a.reaction,
        });
      }
    }
  }
  return { conflicts };
}

// POST /api/v1/prescriptions/check-interactions — preview-only (no save)
router.post(
  "/check-interactions",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, items } = req.body as {
        patientId: string;
        items: Array<{ medicineName: string }>;
      };
      if (!patientId || !Array.isArray(items)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId and items are required",
        });
        return;
      }
      const names = items.map((i) => i.medicineName).filter(Boolean);
      const result = await checkDrugInteractions(names, patientId);
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/prescriptions — create prescription (doctor)
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createPrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        appointmentId,
        patientId,
        diagnosis,
        items,
        advice,
        followUpDate,
        overrideWarnings,
        overrideAllergies,
        allergyOverrideReason,
      } = req.body as {
          appointmentId: string;
          patientId: string;
          diagnosis: string;
          items: Array<{ medicineId?: string; medicineName: string; dosage: string; frequency: string; duration: string; instructions?: string; refills?: number }>;
          advice?: string;
          followUpDate?: string;
          overrideWarnings?: boolean;
          overrideAllergies?: boolean;
          allergyOverrideReason?: string;
        };

      // ─── Issue #898 ───────────────────────────────────────────────────
      // When the caller supplies a structured `medicineId`, verify it
      // resolves to a real Medicine and pin `medicineName` from the master
      // (so the snapshot is canonical, not whatever the FE typed). Any bad
      // id is a 400 — the whole batch is rejected rather than silently
      // dropped, because a wrong-drug Rx is a patient-safety bug, not a
      // user-input nuisance. `medicineId` stays optional for back-compat
      // with mobile + voice-entry flows that still POST name-only.
      const providedMedicineIds = Array.from(
        new Set(items.map((i) => i.medicineId).filter((v): v is string => !!v))
      );
      const resolvedMedicines = providedMedicineIds.length
        ? await prisma.medicine.findMany({
            where: { id: { in: providedMedicineIds } },
            select: { id: true, name: true },
          })
        : [];
      const resolvedMedicineMap = new Map(
        resolvedMedicines.map((m) => [m.id, m.name])
      );
      const missingIds = providedMedicineIds.filter(
        (id) => !resolvedMedicineMap.has(id)
      );
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unknown medicineId(s): ${missingIds.join(", ")}`,
        });
        return;
      }
      const normalizedItems = items.map((i) => ({
        ...i,
        medicineName: i.medicineId
          ? resolvedMedicineMap.get(i.medicineId) || i.medicineName
          : i.medicineName,
      }));

      // Drug interaction check before save — use the post-normalization
      // names so a caller that supplied medicineId benefits from the
      // canonical master spelling (the engine joins on Medicine.name).
      const names = normalizedItems.map((i) => i.medicineName).filter(Boolean);
      const { warnings, hasBlocking } = await checkDrugInteractions(names, patientId);

      if (hasBlocking && !overrideWarnings) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Blocking drug interactions detected",
          warnings,
        });
        return;
      }

      // Pearl ERP Stage 1 §2.1.4 — drug-allergy block. Cross-references
      // the patient's PatientAllergy rows against the medicines being
      // prescribed; any conflict aborts unless the prescriber supplies
      // `overrideAllergies=true` AND a `allergyOverrideReason` (the Zod
      // schema enforces the reason; we audit the override below).
      const { conflicts: allergyConflicts } = await checkPatientAllergies(
        names,
        patientId,
      );
      if (allergyConflicts.length > 0 && !overrideAllergies) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Patient allergy conflict — Rx blocked",
          allergyConflicts,
        });
        return;
      }
      if (allergyConflicts.length > 0 && overrideAllergies) {
        auditLog(
          req,
          "PRESCRIPTION_ALLERGY_OVERRIDE",
          "patient",
          patientId,
          {
            conflicts: allergyConflicts,
            reason: allergyOverrideReason,
            medicineNames: names,
          },
        ).catch(console.error);
      }

      // Get doctor record from user
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });

      if (!doctor && req.user!.role !== "ADMIN") {
        res.status(403).json({
          success: false,
          data: null,
          error: "Doctor profile not found",
        });
        return;
      }

      const doctorId = doctor?.id || req.user!.userId;

      // One prescription per appointment — Prescription.appointmentId is
      // @unique in the schema, so a duplicate create raises a P2002 that
      // would otherwise surface as a confusing 500. Detect it up front and
      // return a clean 409 telling the doctor to edit the existing Rx.
      const existing = await prisma.prescription.findUnique({
        where: { appointmentId },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: { existingPrescriptionId: existing.id },
          error:
            "A prescription already exists for this appointment. Edit the existing one instead of creating a new one.",
        });
        return;
      }

      const prescription = await prisma.prescription.create({
        data: {
          appointmentId,
          patientId,
          doctorId,
          diagnosis,
          advice,
          followUpDate: followUpDate ? new Date(followUpDate) : undefined,
          signatureUrl: doctor?.signatureUrl,
          items: {
            create: normalizedItems,
          },
        },
        include: {
          items: true,
          doctor: { include: { user: { select: { name: true } } } },
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      // Fire-and-forget notification
      onPrescriptionReady(prescription as any).catch(console.error);
      auditLog(req, "PRESCRIPTION_CREATE", "prescription", prescription.id, {
        appointmentId,
        patientId,
        diagnosis,
        warningCount: warnings.length,
        overrideWarnings: Boolean(overrideWarnings),
      }).catch(console.error);

      // Index the prescription into the RAG knowledge base so cohort/chart
      // searches ("which of my patients are on metformin?") can find it.
      fireAndForgetIngest("ingestPrescription", () => ingestPrescription(prescription.id));

      res.status(201).json({
        success: true,
        data: prescription,
        warnings: warnings.length ? warnings : undefined,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/prescriptions/:id — edit an existing prescription
//
// Updates the clinical content of an existing Rx without changing its
// identity (appointmentId / patientId / doctorId stay fixed). Items are
// fully replaced (delete + recreate inside a transaction) so the caller
// MUST send the FULL desired set, not a partial diff. Re-runs the same
// drug-interaction check as the create handler so an edited Rx can't bypass
// a SEVERE/CONTRAINDICATED interaction by going through the edit path.
router.patch(
  "/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(updatePrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { diagnosis, items, advice, followUpDate, overrideWarnings } =
        req.body as {
          diagnosis: string;
          items: Array<{
            medicineId?: string;
            medicineName: string;
            dosage: string;
            frequency: string;
            duration: string;
            instructions?: string;
            refills?: number;
          }>;
          advice?: string;
          followUpDate?: string;
          overrideWarnings?: boolean;
        };

      // ─── Issue #898 (PATCH parity with POST) ────────────────────────
      // Same medicineId-resolution contract as the create handler. Bad id
      // → 400 (whole batch rejected); good id → name pinned from master.
      const providedMedicineIds = Array.from(
        new Set(items.map((i) => i.medicineId).filter((v): v is string => !!v))
      );
      const resolvedMedicines = providedMedicineIds.length
        ? await prisma.medicine.findMany({
            where: { id: { in: providedMedicineIds } },
            select: { id: true, name: true },
          })
        : [];
      const resolvedMedicineMap = new Map(
        resolvedMedicines.map((m) => [m.id, m.name])
      );
      const missingIds = providedMedicineIds.filter(
        (id) => !resolvedMedicineMap.has(id)
      );
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unknown medicineId(s): ${missingIds.join(", ")}`,
        });
        return;
      }
      const normalizedItems = items.map((i) => ({
        ...i,
        medicineName: i.medicineId
          ? resolvedMedicineMap.get(i.medicineId) || i.medicineName
          : i.medicineName,
      }));

      // Load the row first — gives a clean 404 and lets us scope downstream
      // checks (drug interactions need the patientId).
      const existing = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        select: { id: true, patientId: true, doctorId: true, appointmentId: true },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }

      // DOCTOR may only edit prescriptions they themselves authored. ADMIN
      // bypass is by design (cross-clinic correction). Per CLAUDE.md gotcha
      // #14 — authorize() alone isn't enough when DOCTOR is in the allowlist.
      if (req.user?.role === Role.DOCTOR) {
        const doctorRecord = await prisma.doctor.findFirst({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        if (!doctorRecord || doctorRecord.id !== existing.doctorId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "You can only edit prescriptions you authored.",
          });
          return;
        }
      }

      // Re-run interaction check on the new item set (post-#898 normalize).
      const names = normalizedItems.map((i) => i.medicineName).filter(Boolean);
      const { warnings, hasBlocking } = await checkDrugInteractions(
        names,
        existing.patientId,
      );
      if (hasBlocking && !overrideWarnings) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Blocking drug interactions detected",
          warnings,
        });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.prescriptionItem.deleteMany({
          where: { prescriptionId: existing.id },
        });
        return tx.prescription.update({
          where: { id: existing.id },
          data: {
            diagnosis,
            advice,
            followUpDate: followUpDate ? new Date(followUpDate) : null,
            items: { create: normalizedItems },
          },
          include: {
            items: true,
            doctor: { include: { user: { select: { name: true } } } },
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
        });
      });

      auditLog(req, "PRESCRIPTION_UPDATE", "prescription", updated.id, {
        appointmentId: existing.appointmentId,
        patientId: existing.patientId,
        diagnosis,
        itemCount: items.length,
        warningCount: warnings.length,
        overrideWarnings: Boolean(overrideWarnings),
      }).catch(console.error);

      // Re-index for RAG so cohort/chart searches see the latest content.
      fireAndForgetIngest("ingestPrescription", () =>
        ingestPrescription(updated.id),
      );

      res.json({
        success: true,
        data: updated,
        warnings: warnings.length ? warnings : undefined,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/prescriptions — list prescriptions
// RBAC (issue #90): RECEPTION must NOT see prescriptions / clinical
// diagnoses. PATIENT path is enforced inline below.
// #511 audit: VERIFIED-SAFE — PATIENT branch force-overwrites
// `where.patientId` with the caller's own Patient.id at L267-272 before the
// findMany executes, so no per-row helper is needed for the list surface.
router.get("/", authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.PATIENT), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { patientId, doctorId, page = "1", limit = "20", search, from, to } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    // Issue #588 (May 2026): mirror the audit-log inverted-range guard
    // (#690 / commit abae2f0). The patient prescriptions list page accepts
    // From > To pickers and quietly returned `0 of 14 shown` with no
    // explanation. Reject the inverted range at the API layer so the form
    // can render an inline error rather than swallowing the inversion.
    if (from && to) {
      const fromDate = new Date(from as string);
      const toDate = new Date(to as string);
      if (
        !isNaN(fromDate.getTime()) &&
        !isNaN(toDate.getTime()) &&
        fromDate.getTime() > toDate.getTime()
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "from must be on or before to",
          details: [{ field: "to", message: "from must be on or before to" }],
        });
        return;
      }
    }

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;

    // Issue #588: when both pickers are populated, also wire them into the
    // Prisma `createdAt` filter so the API actually narrows the result set
    // (the FE used to filter purely in-memory after fetching). Single-sided
    // ranges are also supported.
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) {
        const f = new Date(from as string);
        if (!isNaN(f.getTime())) range.gte = f;
      }
      if (to) {
        const t = new Date(to as string);
        if (!isNaN(t.getTime())) range.lte = t;
      }
      if (Object.keys(range).length > 0) where.createdAt = range;
    }

    // Issue #243: the adherence enrollment picker (and any other consumer
    // using the shared EntityPicker) sends `?search=<text>` to filter the
    // dropdown by diagnosis. The endpoint previously ignored the param so
    // results were never narrowed. Filter case-insensitively on
    // `diagnosis`; this is purely additive so existing callers without the
    // param see the same response as before.
    const searchStr = typeof search === "string" ? search.trim() : "";
    if (searchStr.length > 0) {
      where.diagnosis = { contains: searchStr, mode: "insensitive" as const };
    }

    // Patients see only their own
    if (req.user!.role === "PATIENT") {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
    }

    // Doctors see only their own
    if (req.user!.role === "DOCTOR") {
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });
      if (doctor) where.doctorId = doctor.id;
    }

    const [prescriptions, total] = await Promise.all([
      prisma.prescription.findMany({
        where,
        include: {
          items: true,
          doctor: { include: { user: { select: { name: true } } } },
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.prescription.count({ where }),
    ]);

    res.json({
      success: true,
      data: prescriptions,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/prescriptions/:id
// RBAC (issue #90): RECEPTION excluded — clinical prescription detail.
router.get(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prescription = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        include: {
          items: true,
          doctor: {
            include: { user: { select: { name: true, email: true } } },
          },
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          appointment: true,
        },
      });

      if (!prescription) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }

      // Issue #474 (BOLA): PATIENT must only see own prescriptions.
      if (!(await assertPatientOwnsResource(req, res, prescription.patientId))) return;

      res.json({ success: true, data: prescription, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions/:id/pdf — render prescription as printable HTML
// RBAC (issue #90): RECEPTION excluded.
// Issue #511 (BOLA, expanded criterion): PATIENT is in the authorize() list
// AND the handler operates on a row keyed by `:id`. Without a per-row owner
// check PATIENT-A could download PATIENT-B's prescription PDF / HTML — same
// shape of bug as the original GET /:id (#474). Load the prescription's
// patientId first, gate via assertPatientOwnsResource, THEN render.
router.get(
  "/:id/pdf",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: per-row ownership check before delegating to the PDF
      // service (which fetches by id with no owner gate of its own).
      const owner = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        select: { patientId: true },
      });
      if (!owner) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, owner.patientId))) return;

      // ?format=pdf -> real server-rendered PDF buffer (application/pdf).
      // Default behavior remains HTML (used by the existing in-browser
      // print-view flow) so this is a backward-compatible addition.
      if (req.query.format === "pdf") {
        const buffer = await generatePrescriptionPDFBuffer(req.params.id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=prescription-${req.params.id}.pdf`
        );
        res.setHeader("Content-Length", String(buffer.length));
        res.end(buffer);
        return;
      }
      const html = await generatePrescriptionPDF(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // The global helmet CSP is `default-src 'none'`, which would suppress
      // the inline <style>, embedded QR data: image, signature URL, and the
      // auto-print <script> in this self-contained printable view. Override
      // only for this HTML render so the document is usable; the API's
      // restrictive default still applies to every other endpoint.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
      );
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Prescription not found") {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      next(err);
    }
  }
);

// POST /api/v1/prescriptions/:id/print — mark as printed
// RBAC (issue #90): RECEPTION removed (was DOCTOR/ADMIN/RECEPTION).
router.post(
  "/:id/print",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.prescription.update({
        where: { id: req.params.id },
        data: { printed: true, printedAt: new Date() },
      });
      auditLog(req, "PRESCRIPTION_PRINT", "prescription", updated.id).catch(
        console.error
      );
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/prescriptions/:id/share — record sharing via WhatsApp/Email/SMS
// RBAC (issue #90): RECEPTION removed.
// Issue #242 (2026-04-30): PATIENT can also share their OWN prescription
// (the /dashboard/prescriptions "Share via WhatsApp/Email" buttons). Staff
// (DOCTOR/ADMIN) may share any; PATIENT is constrained inline below to their
// own row.
router.post(
  "/:id/share",
  authorize(Role.DOCTOR, Role.ADMIN, Role.PATIENT),
  validate(sharePrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel } = req.body as { channel: string };
      const existing = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, email: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }

      // Issue #242 + #511 audit: PATIENT may only share their own
      // prescription; staff already cleared the authorize() gate above.
      if (!(await assertPatientOwnsResource(req, res, existing.patientId))) return;

      // Issue #897: never share an unsigned or invalidated prescription.
      // A REJECTED/CANCELLED prescription is not a valid medical document,
      // and one with no doctor `signatureUrl` is still a draft — emailing
      // either to the patient sends an unverifiable artefact (the /verify
      // page shows "unsigned"). The prescribing doctor must sign first.
      if (existing.status === "REJECTED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot share a ${existing.status.toLowerCase()} prescription.`,
        });
        return;
      }
      if (!existing.signatureUrl) {
        res.status(409).json({
          success: false,
          data: null,
          error:
            "Cannot share an unsigned prescription — the prescribing doctor must sign it first.",
        });
        return;
      }

      // Same fallback as the QR-generation sites in pdf.ts / pdf-generator.ts
      // — keep them in lockstep so that on a live host where PUBLIC_APP_URL
      // is unset, the QR, the email link, AND the WhatsApp link all point at
      // the prod domain rather than diverging.
      const verifyBase = (process.env.PUBLIC_APP_URL || "https://medcore.globusdemos.com").replace(/\/$/, "");
      const verifyUrl = `${verifyBase}/verify/rx/${existing.id}`;
      const patientName = existing.patient.user.name;
      const doctorName = existing.doctor.user.name;

      // Per-channel delivery. EMAIL and WHATSAPP are wired (SendGrid + Meta
      // Cloud API). SMS still returns 501 until a gateway is integrated —
      // recording a stub-success would be a clinical-truth bug.
      let deliveryError: string | null = null;
      if (channel === "EMAIL") {
        const recipient = existing.patient.user.email;
        if (!recipient) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Patient has no email on file. Add one to the patient record before sharing.",
          });
          return;
        }
        const result = await sendEmail({
          to: recipient,
          subject: `Your prescription from ${formatDoctorName(doctorName)}`,
          html: `
            <div style="font-family:Segoe UI,Tahoma,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
              <h2 style="color:#4f46e5;margin:0 0 12px;">Your Prescription is Ready</h2>
              <p>Hi ${escapeText(patientName)},</p>
              <p>${escapeText(formatDoctorName(doctorName))} has issued your prescription. You can view, download, and verify it via the secure link below.</p>
              <p style="margin:24px 0;">
                <a href="${verifyUrl}" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">View Prescription</a>
              </p>
              <p style="font-size:12px;color:#64748b;margin-top:24px;">
                This is an authentic prescription. The link includes a verifiable signature and is unique to you.
              </p>
              <p style="font-size:12px;color:#94a3b8;word-break:break-all;">
                If the button does not work, copy this URL: ${escapeText(verifyUrl)}
              </p>
            </div>
          `,
        });
        if (!result.ok) deliveryError = `Email delivery failed: ${result.error}`;
      } else if (channel === "WHATSAPP") {
        const recipient = existing.patient.user.phone;
        console.log(`[share-rx] WHATSAPP request: rxId=${existing.id} patientId=${existing.patientId} patientName="${patientName}" rawPhoneFromDB="${recipient}"`);
        if (!recipient) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Patient has no phone on file. Add one to the patient record before sharing via WhatsApp.",
          });
          return;
        }
        // Plain text body — Meta auto-linkifies the verify URL on the
        // recipient's WhatsApp client. For prod outside the 24h customer
        // service window this MUST switch to a pre-approved Utility template
        // (see TODO(template) in services/messaging/whatsapp.ts).
        const result = await sendWhatsApp({
          to: recipient,
          body: `Hi ${patientName}, ${formatDoctorName(doctorName)} has issued your prescription. View it here: ${verifyUrl}`,
        });
        if (!result.ok) deliveryError = `WhatsApp delivery failed: ${result.error}`;
      } else {
        // SMS still pending a gateway integration (Twilio / MSG91 / Karix).
        res.status(501).json({
          success: false,
          data: null,
          error: `${channel} delivery is not yet available. Use EMAIL or WHATSAPP.`,
        });
        return;
      }

      if (deliveryError) {
        // Compliance: failed share attempts must still be auditable. Without
        // this row a reviewer / regulator cannot tell whether a prescription
        // was attempted-and-failed or never attempted at all.
        auditLog(req, "PRESCRIPTION_SHARE_FAILED", "prescription", existing.id, {
          channel,
          error: deliveryError,
        }).catch(console.error);
        res.status(502).json({
          success: false,
          data: null,
          error: deliveryError,
        });
        return;
      }

      // Record the MOST RECENT channel as the single source of truth — the
      // UI badge shows "Shared via X" and accumulating "WHATSAPP,EMAIL"
      // confused reception about what was actually used last. Audit log
      // below preserves the full per-attempt history for compliance, so
      // overwriting `sharedVia` doesn't lose information.
      const updated = await prisma.prescription.update({
        where: { id: req.params.id },
        data: {
          sharedVia: channel,
          sharedAt: new Date(),
        },
      });
      auditLog(req, "PRESCRIPTION_SHARE", "prescription", updated.id, {
        channel,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Local helper: escape user-controlled strings before interpolating into
// HTML email body (defense-in-depth — patient name is already validated
// against PATIENT_NAME_REGEX upstream, but we render this in a third-party
// inbox and CSP doesn't apply, so don't trust upstream alone).
function escapeText(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /api/v1/prescriptions/copy-from-previous — copy items from a previous prescription
router.post(
  "/copy-from-previous",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(copyPrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { previousPrescriptionId, appointmentId } = req.body as {
        previousPrescriptionId: string;
        appointmentId: string;
      };

      const prev = await prisma.prescription.findUnique({
        where: { id: previousPrescriptionId },
        include: { items: true },
      });
      if (!prev) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Previous prescription not found",
        });
        return;
      }

      const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { patientId: true, doctorId: true },
      });
      if (!appt) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Appointment not found",
        });
        return;
      }

      // Get doctor record from user for this call
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });
      const doctorId = doctor?.id || appt.doctorId;

      const created = await prisma.prescription.create({
        data: {
          appointmentId,
          patientId: appt.patientId,
          doctorId,
          diagnosis: prev.diagnosis,
          advice: prev.advice,
          copiedFromId: prev.id,
          items: {
            // Issue #898: carry the medicineId FK across so copied Rx
            // remain linked to the same master SKU for allergy/inventory.
            create: prev.items.map((i) => ({
              medicineId: i.medicineId,
              medicineName: i.medicineName,
              dosage: i.dosage,
              frequency: i.frequency,
              duration: i.duration,
              instructions: i.instructions,
              refills: i.refills,
            })),
          },
        },
        include: { items: true },
      });

      // Index copied prescription into RAG
      fireAndForgetIngest("ingestPrescription(copy)", () => ingestPrescription(created.id));

      auditLog(req, "PRESCRIPTION_COPY", "prescription", created.id, {
        copiedFrom: previousPrescriptionId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/prescriptions/items/:itemId/refill — refill a prescription item
router.post(
  "/items/:itemId/refill",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.prescriptionItem.findUnique({
        where: { id: req.params.itemId },
      });
      if (!item) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription item not found",
        });
        return;
      }
      if (item.refillsUsed >= item.refills) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No refills remaining",
        });
        return;
      }
      const updated = await prisma.prescriptionItem.update({
        where: { id: req.params.itemId },
        data: { refillsUsed: { increment: 1 } },
      });
      auditLog(req, "PRESCRIPTION_ITEM_REFILL", "prescription_item", updated.id, {
        refillsUsed: updated.refillsUsed,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PRESCRIPTION TEMPLATES ────────────────────────────

// GET /api/v1/prescriptions/templates
router.get(
  "/templates/list",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { specialty, q } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = { isActive: true };
      if (specialty) where.specialty = specialty;
      if (q) {
        where.OR = [
          { name: { contains: q, mode: "insensitive" } },
          { diagnosis: { contains: q, mode: "insensitive" } },
        ];
      }
      const templates = await prisma.prescriptionTemplate.findMany({
        where,
        orderBy: { name: "asc" },
        take: 200,
      });
      res.json({ success: true, data: templates, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/prescriptions/templates
router.post(
  "/templates",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(prescriptionTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const created = await prisma.prescriptionTemplate.create({
        data: {
          name: body.name,
          diagnosis: body.diagnosis,
          advice: body.advice ?? null,
          specialty: body.specialty ?? null,
          items: body.items as any,
          createdBy: req.user!.userId,
        },
      });
      auditLog(req, "RX_TEMPLATE_CREATE", "prescription_template", created.id, {
        name: body.name,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/prescriptions/templates/:id
router.delete(
  "/templates/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.prescriptionTemplate.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      auditLog(req, "RX_TEMPLATE_DELETE", "prescription_template", req.params.id).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions/:id/leaflets — leaflets for all medicines in prescription
// RBAC (issue #90): RECEPTION excluded — leaflet payload exposes diagnosis.
// Issue #511 (BOLA, expanded criterion): PATIENT in authorize() list +
// row-keyed `:id` and no owner check → PATIENT-A could read PATIENT-B's
// diagnosis + medicine list. Add per-row ownership gate.
router.get(
  "/:id/leaflets",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rx = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        include: {
          items: true,
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });
      if (!rx) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Prescription not found" });
        return;
      }

      // #511 audit: PATIENT must only see their own leaflet payload (the
      // payload exposes diagnosis + every medicine, dosage, and instruction).
      if (!(await assertPatientOwnsResource(req, res, rx.patientId))) return;
      const names = rx.items.map((i) => i.medicineName);
      const meds = await prisma.medicine.findMany({
        where: {
          OR: names.map((n) => ({
            OR: [
              { name: { equals: n, mode: "insensitive" } },
              { genericName: { equals: n, mode: "insensitive" } },
            ],
          })),
        },
        select: {
          id: true,
          name: true,
          genericName: true,
          brand: true,
          strength: true,
          form: true,
          patientInstructions: true,
          sideEffects: true,
          contraindications: true,
          pregnancyCategory: true,
        },
      });

      // Map Rx items to leaflets (retain instruction from Rx item)
      const leaflets = rx.items.map((it) => {
        const match =
          meds.find(
            (m) =>
              m.name.toLowerCase() === it.medicineName.toLowerCase() ||
              (m.genericName ?? "").toLowerCase() ===
                it.medicineName.toLowerCase()
          ) ?? null;
        return {
          medicineName: it.medicineName,
          dosage: it.dosage,
          frequency: it.frequency,
          duration: it.duration,
          instructions: it.instructions,
          leaflet: match,
        };
      });

      res.json({
        success: true,
        data: {
          prescriptionId: rx.id,
          patientName: rx.patient.user.name,
          doctorName: rx.doctor.user.name,
          diagnosis: rx.diagnosis,
          createdAt: rx.createdAt,
          leaflets,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as prescriptionRouter };

// ─── PUBLIC (no-auth) ROUTER for prescription verification ─
export const publicPrescriptionRouter = Router();

publicPrescriptionRouter.get(
  "/verify/rx/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Content negotiation: JSON for the Next.js verify page,
      // HTML (legacy) for direct browser hits / the QR fallback.
      const accept = String(req.headers.accept || "");
      const wantsJson =
        req.query.format === "json" ||
        (accept.includes("application/json") && !accept.includes("text/html"));

      if (wantsJson) {
        const rx = await rawPrisma.prescription.findUnique({
          where: { id: req.params.id },
          include: {
            patient: { include: { user: { select: { name: true } } } },
            doctor: { include: { user: { select: { name: true } } } },
          },
        });
        if (!rx) {
          res.status(404).json({ ok: false, error: "Prescription not found" });
          return;
        }
        const cfg = await rawPrisma.systemConfig.findMany({
          where: {
            key: {
              in: [
                "hospital_name",
                "hospital_address",
                "hospital_phone",
                "hospital_email",
                "hospital_logo_url",
                "hospital_tagline",
              ],
            },
          },
        });
        const map: Record<string, string> = {};
        cfg.forEach((r) => (map[r.key] = r.value));
        res.json({
          ok: true,
          prescriptionId: rx.id,
          patientInitial: rx.patient.user.name.charAt(0).toUpperCase() + ".",
          doctorName: rx.doctor.user.name,
          dateIssued: new Date(rx.createdAt).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }),
          status: rx.printed ? "Issued & Printed" : "Issued",
          hospital: {
            name: map.hospital_name || "Hospital",
            address: map.hospital_address || "",
            phone: map.hospital_phone || "",
            email: map.hospital_email || "",
            logoUrl: map.hospital_logo_url || "",
            tagline: map.hospital_tagline || "",
          },
        });
        return;
      }

      const html = await generatePrescriptionVerifyHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      next(err);
    }
  }
);
