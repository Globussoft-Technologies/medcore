import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createAllergySchema,
  createConditionSchema,
  updateConditionSchema,
  createFamilyHistorySchema,
  createImmunizationSchema,
  updateImmunizationSchema,
  createDocumentSchema,
  advanceDirectiveSchema,
  updateAdvanceDirectiveSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
// #511: replaced this file's hand-rolled `assertPatientAccess` helper
// (functionally identical signature) with the canonical
// `assertPatientOwnsResource` to prevent drift. See
// `apps/api/src/middleware/patient-self-only.ts`.
import { assertPatientOwnsResource } from "../middleware/patient-self-only";

const router = Router();
router.use(authenticate);

// Resolve patientId from an existing record of a given entity, so we
// can apply the same access check on non-list routes.
async function resolvePatientIdForEntity(
  entity:
    | "allergy"
    | "condition"
    | "familyHistory"
    | "immunization"
    | "document",
  id: string
): Promise<string | null> {
  switch (entity) {
    case "allergy": {
      const r = await prisma.patientAllergy.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "condition": {
      const r = await prisma.chronicCondition.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "familyHistory": {
      const r = await prisma.familyHistory.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "immunization": {
      const r = await prisma.immunization.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "document": {
      const r = await prisma.patientDocument.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
  }
}

// ───────────────────────────────────────────────────────
// ALLERGIES
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/allergies",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const allergies = await prisma.patientAllergy.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { notedAt: "desc" },
      });
      res.json({ success: true, data: allergies, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/allergies",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(createAllergySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, allergen, severity, reaction, notes } = req.body;
      const allergy = await prisma.patientAllergy.create({
        data: {
          patientId,
          allergen,
          severity,
          reaction,
          notes,
          notedBy: req.user!.userId,
        },
      });
      auditLog(req, "ALLERGY_CREATE", "patient_allergy", allergy.id, {
        patientId,
        allergen,
        severity,
      }).catch(console.error);
      res.status(201).json({ success: true, data: allergy, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/allergies/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allergy = await prisma.patientAllergy.findUnique({
        where: { id: req.params.id },
      });
      if (!allergy) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Allergy not found" });
        return;
      }
      await prisma.patientAllergy.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "ALLERGY_DELETE",
        "patient_allergy",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// CHRONIC CONDITIONS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/conditions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const conditions = await prisma.chronicCondition.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: conditions, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/conditions",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createConditionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, condition, icd10Code, diagnosedDate, status, notes } =
        req.body;
      const created = await prisma.chronicCondition.create({
        data: {
          patientId,
          condition,
          icd10Code,
          diagnosedDate: diagnosedDate ? new Date(diagnosedDate) : null,
          status,
          notes,
        },
      });
      auditLog(req, "CONDITION_CREATE", "chronic_condition", created.id, {
        patientId,
        condition,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/conditions/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(updateConditionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.diagnosedDate)
        data.diagnosedDate = new Date(data.diagnosedDate as string);
      const updated = await prisma.chronicCondition.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "CONDITION_UPDATE",
        "chronic_condition",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/conditions/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.chronicCondition.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "CONDITION_DELETE",
        "chronic_condition",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Common family-history templates (clients use these to autocomplete the UI)
const FAMILY_HISTORY_TEMPLATES = [
  { relation: "Father", condition: "Hypertension" },
  { relation: "Father", condition: "Diabetes Mellitus Type 2" },
  { relation: "Father", condition: "Coronary Artery Disease" },
  { relation: "Father", condition: "Stroke" },
  { relation: "Mother", condition: "Hypertension" },
  { relation: "Mother", condition: "Diabetes Mellitus Type 2" },
  { relation: "Mother", condition: "Breast Cancer" },
  { relation: "Mother", condition: "Thyroid Disorder" },
  { relation: "Sibling", condition: "Asthma" },
  { relation: "Sibling", condition: "Epilepsy" },
  { relation: "Grandparent", condition: "Alzheimer's Disease" },
  { relation: "Grandparent", condition: "Osteoporosis" },
];

router.get(
  "/family-history/templates",
  (_req: Request, res: Response) => {
    res.json({ success: true, data: FAMILY_HISTORY_TEMPLATES, error: null });
  }
);

// ───────────────────────────────────────────────────────
// FAMILY HISTORY
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/family-history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const rows = await prisma.familyHistory.findMany({
        where: { patientId: req.params.patientId },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/family-history",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(createFamilyHistorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await prisma.familyHistory.create({ data: req.body });
      auditLog(
        req,
        "FAMILY_HISTORY_CREATE",
        "family_history",
        created.id,
        req.body
      ).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/family-history/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.familyHistory.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "FAMILY_HISTORY_DELETE",
        "family_history",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// IMMUNIZATIONS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/immunizations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const rows = await prisma.immunization.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { dateGiven: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/patients/:patientId/immunizations/due",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const now = new Date();
      const rows = await prisma.immunization.findMany({
        where: {
          patientId: req.params.patientId,
          nextDueDate: { gte: now },
        },
        orderBy: { nextDueDate: "asc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Helper to build the nextDueDate clause for a given filter.
function buildScheduleDateClause(
  filter: string | undefined
): Record<string, unknown> | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (filter === "week") {
    const end = new Date(today);
    end.setDate(end.getDate() + 7);
    return { gte: today, lte: end };
  }
  if (filter === "month") {
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    return { gte: today, lte: end };
  }
  if (filter === "overdue") {
    return { lt: today };
  }
  return { not: null };
}

// Cross-patient schedule endpoint used by the Immunization Schedule page.
// Also supports an optional ?patientId= query for per-patient filtering so
// widgets on the patient detail page don't accidentally show hospital-wide
// counts (fix for Issue #38).
router.get(
  "/immunizations/schedule",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filter = "month", patientId } = req.query as Record<string, string>;

      const where: Record<string, unknown> = {
        nextDueDate: buildScheduleDateClause(filter),
      };
      if (patientId) {
        where.patientId = patientId;
      }

      const rows = await prisma.immunization.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
        orderBy: { nextDueDate: "asc" },
        take: 200,
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Per-patient schedule endpoint. Same filter semantics as the global route
// but scoped to a single patientId (fix for Issue #38: the patient 360 view
// was showing the tenant-wide overdue count).
router.get(
  "/patients/:patientId/immunizations/schedule",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const { filter = "month" } = req.query as Record<string, string>;

      const rows = await prisma.immunization.findMany({
        where: {
          patientId: req.params.patientId,
          nextDueDate: buildScheduleDateClause(filter),
        },
        orderBy: { nextDueDate: "asc" },
        take: 200,
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Pediatric immunization schedule (simplified Indian IAP schedule)
// Returns recommended vaccines with due-by-date based on patient DOB
const PEDIATRIC_SCHEDULE: Array<{
  vaccine: string;
  ageLabel: string;
  ageDays: number; // days from DOB
}> = [
  { vaccine: "BCG", ageLabel: "At Birth", ageDays: 0 },
  { vaccine: "OPV 0", ageLabel: "At Birth", ageDays: 0 },
  { vaccine: "Hepatitis B 1", ageLabel: "At Birth", ageDays: 0 },
  { vaccine: "DPT 1", ageLabel: "6 weeks", ageDays: 42 },
  { vaccine: "OPV 1", ageLabel: "6 weeks", ageDays: 42 },
  { vaccine: "Hepatitis B 2", ageLabel: "6 weeks", ageDays: 42 },
  { vaccine: "Rotavirus 1", ageLabel: "6 weeks", ageDays: 42 },
  { vaccine: "Hib 1", ageLabel: "6 weeks", ageDays: 42 },
  { vaccine: "DPT 2", ageLabel: "10 weeks", ageDays: 70 },
  { vaccine: "OPV 2", ageLabel: "10 weeks", ageDays: 70 },
  { vaccine: "Rotavirus 2", ageLabel: "10 weeks", ageDays: 70 },
  { vaccine: "Hib 2", ageLabel: "10 weeks", ageDays: 70 },
  { vaccine: "DPT 3", ageLabel: "14 weeks", ageDays: 98 },
  { vaccine: "OPV 3", ageLabel: "14 weeks", ageDays: 98 },
  { vaccine: "Hib 3", ageLabel: "14 weeks", ageDays: 98 },
  { vaccine: "Measles 1 / MMR 1", ageLabel: "9 months", ageDays: 270 },
  { vaccine: "Hepatitis A 1", ageLabel: "12 months", ageDays: 365 },
  { vaccine: "MMR 2", ageLabel: "15 months", ageDays: 456 },
  { vaccine: "DPT Booster 1", ageLabel: "18 months", ageDays: 540 },
  { vaccine: "Typhoid", ageLabel: "2 years", ageDays: 730 },
  { vaccine: "DPT Booster 2", ageLabel: "5 years", ageDays: 1825 },
  { vaccine: "Tdap", ageLabel: "10 years", ageDays: 3650 },
  { vaccine: "HPV 1", ageLabel: "10 years (girls)", ageDays: 3650 },
];

router.get(
  "/patients/:patientId/immunizations/recommended",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.patientId },
        select: { dateOfBirth: true, gender: true },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      if (!patient.dateOfBirth) {
        res.json({
          success: true,
          data: { items: [], note: "Date of birth required" },
          error: null,
        });
        return;
      }

      const given = await prisma.immunization.findMany({
        where: { patientId: req.params.patientId },
        select: { vaccine: true },
      });
      const givenSet = new Set(given.map((g) => g.vaccine.toLowerCase()));

      const dob = new Date(patient.dateOfBirth);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const items = PEDIATRIC_SCHEDULE.map((s) => {
        const dueDate = new Date(dob);
        dueDate.setDate(dueDate.getDate() + s.ageDays);
        const received =
          givenSet.has(s.vaccine.toLowerCase()) ||
          Array.from(givenSet).some((g) =>
            s.vaccine.toLowerCase().includes(g)
          );
        const status = received
          ? "GIVEN"
          : dueDate < today
            ? "OVERDUE"
            : dueDate.getTime() - today.getTime() <= 30 * 24 * 60 * 60 * 1000
              ? "DUE_SOON"
              : "UPCOMING";
        return {
          vaccine: s.vaccine,
          ageLabel: s.ageLabel,
          dueDate: dueDate.toISOString().split("T")[0],
          status,
          received,
        };
      });

      res.json({
        success: true,
        data: {
          dob: dob.toISOString().split("T")[0],
          items,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/immunizations",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(createImmunizationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const created = await prisma.immunization.create({
        data: {
          patientId: body.patientId,
          vaccine: body.vaccine,
          doseNumber: body.doseNumber,
          dateGiven: new Date(body.dateGiven),
          administeredBy: body.administeredBy ?? req.user!.userId,
          batchNumber: body.batchNumber,
          manufacturer: body.manufacturer,
          site: body.site,
          nextDueDate: body.nextDueDate ? new Date(body.nextDueDate) : null,
          notes: body.notes,
        },
      });
      auditLog(req, "IMMUNIZATION_CREATE", "immunization", created.id, {
        patientId: body.patientId,
        vaccine: body.vaccine,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/immunizations/:id",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(updateImmunizationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.dateGiven) data.dateGiven = new Date(data.dateGiven as string);
      if (data.nextDueDate)
        data.nextDueDate = new Date(data.nextDueDate as string);
      const updated = await prisma.immunization.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "IMMUNIZATION_UPDATE",
        "immunization",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/immunizations/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.immunization.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "IMMUNIZATION_DELETE",
        "immunization",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DOCUMENTS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/documents",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const docs = await prisma.patientDocument.findMany({
        where: { patientId: req.params.patientId },
        select: {
          id: true,
          patientId: true,
          type: true,
          title: true,
          fileSize: true,
          mimeType: true,
          uploadedBy: true,
          notes: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: docs, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/documents",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN, Role.RECEPTION),
  validate(createDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, type, title, notes, filePath, fileSize, mimeType } =
        req.body;

      // If the client hasn't uploaded a file yet (filePath not provided),
      // stamp a placeholder path so we can store metadata up-front.
      const sanitizedTitle = title
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(0, 64);
      const uuid = randomUUID();
      const resolvedPath =
        filePath || `uploads/ehr/${uuid}-${sanitizedTitle}`;

      const doc = await prisma.patientDocument.create({
        data: {
          patientId,
          type,
          title,
          filePath: resolvedPath,
          fileSize: fileSize ?? null,
          mimeType: mimeType ?? null,
          uploadedBy: req.user!.userId,
          notes,
        },
      });
      auditLog(req, "DOCUMENT_CREATE", "patient_document", doc.id, {
        patientId,
        type,
        title,
      }).catch(console.error);
      res.status(201).json({ success: true, data: doc, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/documents/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await prisma.patientDocument.findUnique({
        where: { id: req.params.id },
      });
      if (!doc) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Document not found" });
        return;
      }
      // #511 audit: PATCHED A1 — /documents/:id is doc-keyed; resolved patientId via Document.patientId then gated through canonical helper.
      if (!(await assertPatientOwnsResource(req, res, doc.patientId))) return;

      const filename = doc.filePath.split(/[\\/]/).pop() || "";
      const downloadUrl = `/api/v1/uploads/${encodeURIComponent(filename)}`;

      res.json({
        success: true,
        data: { ...doc, downloadUrl },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/documents/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = await resolvePatientIdForEntity(
        "document",
        req.params.id
      );
      if (!patientId) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Document not found" });
        return;
      }
      await prisma.patientDocument.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DOCUMENT_DELETE",
        "patient_document",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// PATIENT SUMMARY (dashboard)
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.patientId;
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const in90 = new Date(today);
      in90.setDate(in90.getDate() + 90);

      const [
        allergyCount,
        conditionCount,
        familyCount,
        immunizationCount,
        documentCount,
        severeAllergies,
        activeConditions,
        upcomingImmunizations,
      ] = await Promise.all([
        prisma.patientAllergy.count({ where: { patientId } }),
        prisma.chronicCondition.count({ where: { patientId } }),
        prisma.familyHistory.count({ where: { patientId } }),
        prisma.immunization.count({ where: { patientId } }),
        prisma.patientDocument.count({ where: { patientId } }),
        prisma.patientAllergy.findMany({
          where: {
            patientId,
            severity: { in: ["SEVERE", "LIFE_THREATENING"] },
          },
          orderBy: { notedAt: "desc" },
        }),
        prisma.chronicCondition.findMany({
          where: { patientId, status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        }),
        prisma.immunization.findMany({
          where: {
            patientId,
            nextDueDate: { gte: today, lte: in90 },
          },
          orderBy: { nextDueDate: "asc" },
        }),
      ]);

      res.json({
        success: true,
        data: {
          counts: {
            allergies: allergyCount,
            conditions: conditionCount,
            familyHistory: familyCount,
            immunizations: immunizationCount,
            documents: documentCount,
          },
          severeAllergies,
          activeConditions,
          upcomingImmunizations,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ADVANCE DIRECTIVES
// ═══════════════════════════════════════════════════════

router.get(
  "/patients/:patientId/advance-directives",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, req.params.patientId))) return;
      const includeInactive = req.query.includeInactive === "true";
      const rows = await prisma.advanceDirective.findMany({
        where: {
          patientId: req.params.patientId,
          ...(includeInactive ? {} : { active: true }),
        },
        orderBy: { effectiveDate: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/patients/:patientId/advance-directives",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(advanceDirectiveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.patientId;
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;
      const body = req.body;
      const created = await prisma.advanceDirective.create({
        data: {
          patientId,
          type: body.type,
          effectiveDate: new Date(body.effectiveDate),
          expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          documentPath: body.documentPath ?? null,
          witnessedBy: body.witnessedBy ?? null,
          notes: body.notes,
          createdBy: req.user!.userId,
        },
      });
      auditLog(req, "ADVANCE_DIRECTIVE_CREATE", "advance_directive", created.id, {
        patientId,
        type: body.type,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/advance-directives/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(updateAdvanceDirectiveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.effectiveDate) data.effectiveDate = new Date(data.effectiveDate as string);
      if (data.expiryDate) data.expiryDate = new Date(data.expiryDate as string);
      const updated = await prisma.advanceDirective.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "ADVANCE_DIRECTIVE_UPDATE",
        "advance_directive",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/advance-directives/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.advanceDirective.update({
        where: { id: req.params.id },
        data: { active: false },
      });
      auditLog(
        req,
        "ADVANCE_DIRECTIVE_DELETE",
        "advance_directive",
        updated.id
      ).catch(console.error);
      res.json({ success: true, data: { id: updated.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// PROBLEM LIST (consolidated)
// ═══════════════════════════════════════════════════════

// Severity ranking helper
function severityRank(s: string | null | undefined): number {
  switch (s) {
    case "LIFE_THREATENING":
      return 5;
    case "SEVERE":
      return 4;
    case "ACTIVE":
    case "RELAPSED":
      return 3;
    case "MODERATE":
    case "CONTROLLED":
      return 2;
    case "MILD":
      return 1;
    default:
      return 0;
  }
}

router.get(
  "/patients/:patientId/problem-list",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.patientId;
      // #511 audit: VERIFIED-SAFE — canonical helper (was hand-rolled assertPatientAccess pre-refactor)
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;

      const activeOnly = req.query.activeOnly !== "false";
      const typeFilter = req.query.type as string | undefined;

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const [conditions, allergies, recentPrescriptions, activeAdmission] =
        await Promise.all([
          prisma.chronicCondition.findMany({
            where: {
              patientId,
              ...(activeOnly
                ? { status: { in: ["ACTIVE", "CONTROLLED", "RELAPSED"] } }
                : {}),
            },
            orderBy: { updatedAt: "desc" },
          }),
          prisma.patientAllergy.findMany({
            where: {
              patientId,
              ...(activeOnly
                ? { severity: { in: ["SEVERE", "LIFE_THREATENING"] } }
                : {}),
            },
            orderBy: { notedAt: "desc" },
          }),
          prisma.prescription.findMany({
            where: {
              patientId,
              createdAt: { gte: ninetyDaysAgo },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, diagnosis: true, createdAt: true, doctorId: true },
          }),
          prisma.admission.findFirst({
            where: { patientId, status: "ADMITTED" },
            orderBy: { admittedAt: "desc" },
            include: { bed: { include: { ward: true } } },
          }),
        ]);

      const items: Array<{
        id: string;
        type: "condition" | "allergy" | "diagnosis" | "admission";
        title: string;
        severity: string;
        status: string;
        lastUpdated: string;
        source: string;
        icd10Code?: string | null;
      }> = [];

      if (!typeFilter || typeFilter === "condition") {
        for (const c of conditions) {
          items.push({
            id: c.id,
            type: "condition",
            title: c.condition,
            severity: c.status,
            status: c.status,
            lastUpdated: c.updatedAt.toISOString(),
            source: "Chronic Condition",
            icd10Code: c.icd10Code,
          });
        }
      }

      if (!typeFilter || typeFilter === "allergy") {
        for (const a of allergies) {
          items.push({
            id: a.id,
            type: "allergy",
            title: `Allergy: ${a.allergen}${a.reaction ? ` (${a.reaction})` : ""}`,
            severity: a.severity,
            status: "ACTIVE",
            lastUpdated: a.notedAt.toISOString(),
            source: "Allergy",
          });
        }
      }

      if (!typeFilter || typeFilter === "diagnosis") {
        // Deduplicate by diagnosis text (case-insensitive)
        const seen = new Set<string>();
        for (const p of recentPrescriptions) {
          const key = (p.diagnosis || "").trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push({
            id: p.id,
            type: "diagnosis",
            title: p.diagnosis,
            severity: "ACTIVE",
            status: "ACTIVE",
            lastUpdated: p.createdAt.toISOString(),
            source: "Recent Prescription",
          });
        }
      }

      if ((!typeFilter || typeFilter === "admission") && activeAdmission) {
        items.push({
          id: activeAdmission.id,
          type: "admission",
          title:
            activeAdmission.diagnosis ||
            activeAdmission.reason ||
            `Admitted (${activeAdmission.admissionNumber})`,
          severity: "ACTIVE",
          status: "ADMITTED",
          lastUpdated: activeAdmission.admittedAt.toISOString(),
          source: `Currently Admitted — ${activeAdmission.bed.ward.name} / ${activeAdmission.bed.bedNumber}`,
        });
      }

      items.sort((a, b) => {
        const sd = severityRank(b.severity) - severityRank(a.severity);
        if (sd !== 0) return sd;
        return b.lastUpdated.localeCompare(a.lastUpdated);
      });

      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as ehrRouter };
