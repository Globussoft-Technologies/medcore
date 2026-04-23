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
  copyPrescriptionSchema,
  sharePrescriptionSchema,
  prescriptionTemplateSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  generatePrescriptionPDF,
  generatePrescriptionVerifyHTML,
} from "../services/pdf";
import { generatePrescriptionPDFBuffer } from "../services/pdf-generator";
import { onPrescriptionReady } from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { ingestPrescription, fireAndForgetIngest } from "../services/ai/rag-ingest";

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
      const { appointmentId, patientId, diagnosis, items, advice, followUpDate, overrideWarnings } =
        req.body as {
          appointmentId: string;
          patientId: string;
          diagnosis: string;
          items: Array<{ medicineName: string; dosage: string; frequency: string; duration: string; instructions?: string; refills?: number }>;
          advice?: string;
          followUpDate?: string;
          overrideWarnings?: boolean;
        };

      // Drug interaction check before save
      const names = items.map((i) => i.medicineName).filter(Boolean);
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
            create: items,
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

// GET /api/v1/prescriptions — list prescriptions
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { patientId, doctorId, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;

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
router.get(
  "/:id",
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

      res.json({ success: true, data: prescription, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions/:id/pdf — render prescription as printable HTML
router.get(
  "/:id/pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
router.post(
  "/:id/print",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.prescription.update({
        where: { id: req.params.id },
        data: { printed: true, printedAt: new Date() },
      });
      auditLog(req, "PRINT_PRESCRIPTION", "prescription", updated.id).catch(
        console.error
      );
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/prescriptions/:id/share — record sharing via WhatsApp/Email/SMS
router.post(
  "/:id/share",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  validate(sharePrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel } = req.body as { channel: string };
      const existing = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        select: { sharedVia: true },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      const channels = new Set(
        (existing.sharedVia ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      channels.add(channel);
      const updated = await prisma.prescription.update({
        where: { id: req.params.id },
        data: {
          sharedVia: Array.from(channels).join(","),
          sharedAt: new Date(),
        },
      });
      // fire-and-forget: log to console (stub)
      console.log(`[share-rx] Prescription ${updated.id} shared via ${channel}`);
      auditLog(req, "SHARE_PRESCRIPTION", "prescription", updated.id, {
        channel,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

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
            create: prev.items.map((i) => ({
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

      auditLog(req, "COPY_PRESCRIPTION", "prescription", created.id, {
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
      auditLog(req, "REFILL_PRESCRIPTION_ITEM", "prescription_item", updated.id, {
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
      auditLog(req, "CREATE_RX_TEMPLATE", "prescription_template", created.id, {
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
      auditLog(req, "DELETE_RX_TEMPLATE", "prescription_template", req.params.id).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/prescriptions/:id/leaflets — leaflets for all medicines in prescription
router.get(
  "/:id/leaflets",
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
