// Pearl ERP Stage 1 §3.3 (gap item #3) — CRM lead pipeline.
//
// 6 endpoints. Every mutation writes an AuditLog row keyed by
// entity=lead so the conversion-attribution chain is greppable.
// Status transitions also write a LeadActivity row of type
// STATUS_CHANGE so the per-lead timeline tells the story.
//
//   POST   /api/v1/leads                       — create
//   GET    /api/v1/leads                       — list (filters: status, source, assignedToUserId, q)
//   GET    /api/v1/leads/:id                   — detail with activities
//   PATCH  /api/v1/leads/:id                   — update + auto-log STATUS_CHANGE
//   POST   /api/v1/leads/:id/activities        — log activity (CALL/MESSAGE/EMAIL/NOTE/etc.)
//   POST   /api/v1/leads/:id/convert           — convert to Patient (creates user + patient + activity + sets status=CONVERTED)

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { prisma as rawPrisma } from "@medcore/db";
import {
  Role,
  createLeadSchema,
  updateLeadSchema,
  createLeadActivitySchema,
  convertLeadSchema,
  LEAD_STATUS_VALUES,
  LEAD_SOURCE_VALUES,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import bcrypt from "bcryptjs";

const router = Router();
router.use(authenticate);

// All lead surfaces are staff-only (PATIENT role excluded).
const LEAD_ROLES = [Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE] as const;

// ─── POST /leads — create
router.post(
  "/",
  authorize(...LEAD_ROLES),
  validate(createLeadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // If promoting from a MarketingEnquiry, idempotency-check via the
      // @unique back-ref so a double-click doesn't duplicate the lead.
      if (req.body.marketingEnquiryId) {
        const existing = await prisma.lead.findFirst({
          where: { marketingEnquiryId: req.body.marketingEnquiryId },
          select: { id: true },
        });
        if (existing) {
          res.status(409).json({
            success: false,
            data: null,
            error: "This marketing enquiry has already been promoted to a lead.",
          });
          return;
        }
      }

      // Issue #1001 — exact-match dup detection within tenant. Block
      // when name + phone + email all match an existing lead exactly
      // (case-insensitive on name + email, exact on phone). Per
      // product decision the rule is intentionally strict so a typo
      // in any of the three fields lets the new lead through — false
      // negatives are acceptable; the goal is to stop the "same row
      // posted 20 times" reporter case.
      //
      // Only runs when BOTH phone and email are present in the
      // payload — if either is blank the operator hasn't supplied
      // enough to claim "identical lead" and we let the row through
      // (matches reception's intent when they record a half-known
      // walk-in).
      const nameIn = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const phoneIn =
        typeof req.body.phone === "string" ? req.body.phone.trim() : "";
      const emailIn =
        typeof req.body.email === "string" ? req.body.email.trim() : "";
      if (nameIn && phoneIn && emailIn) {
        const dup = await prisma.lead.findFirst({
          where: {
            tenantId: req.tenantId,
            phone: phoneIn,
            name: { equals: nameIn, mode: "insensitive" },
            email: { equals: emailIn, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (dup) {
          res.status(409).json({
            success: false,
            data: null,
            error:
              "A lead with this name, phone and email already exists. Open the existing lead or change one of the fields to proceed.",
          });
          return;
        }
      }

      const lead = await prisma.lead.create({
        data: {
          name: req.body.name,
          phone: req.body.phone ?? null,
          email: req.body.email ?? null,
          source: req.body.source ?? "WEB",
          preferredDoctorId: req.body.preferredDoctorId ?? null,
          assignedToUserId: req.body.assignedToUserId ?? null,
          notes: req.body.notes ?? null,
          marketingEnquiryId: req.body.marketingEnquiryId ?? null,
          tenantId: req.tenantId,
        },
        include: {
          assignedToUser: { select: { id: true, name: true, role: true } },
          preferredDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "LEAD_CREATE", "lead", lead.id, {
        source: lead.source,
        marketingEnquiryId: lead.marketingEnquiryId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: lead, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /leads — list with filters
router.get("/", authorize(...LEAD_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const assignedToUserId =
      typeof req.query.assignedToUserId === "string" ? req.query.assignedToUserId : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (status && !(LEAD_STATUS_VALUES as readonly string[]).includes(status)) {
      res.status(400).json({ success: false, data: null, error: "Invalid status filter" });
      return;
    }
    if (source && !(LEAD_SOURCE_VALUES as readonly string[]).includes(source)) {
      res.status(400).json({ success: false, data: null, error: "Invalid source filter" });
      return;
    }

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (source) where.source = source;
    if (assignedToUserId) where.assignedToUserId = assignedToUserId;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      include: {
        assignedToUser: { select: { id: true, name: true, role: true } },
        preferredDoctor: { include: { user: { select: { name: true } } } },
        _count: { select: { activities: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    res.json({ success: true, data: leads, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /leads/by-patient/:patientId — Pearl §7.1 (gap row 183)
// Doctor's patient-detail view ("CRM activity on a patient") needs the
// originating Lead + its activity timeline when a patient was converted
// from a lead. Returns 404 when no Lead links to the patient — the UI
// renders an empty-state in that case (most walk-in patients have none).
//
// IMPORTANT: registered BEFORE /:id so Express's static-before-dynamic
// matching doesn't swallow "by-patient" as a lead id (would 404 with the
// wrong error shape). See CLAUDE.md §14 (post-fix verification grep).
router.get(
  "/by-patient/:patientId",
  authorize(...LEAD_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lead = await prisma.lead.findFirst({
        where: { convertedPatientId: req.params.patientId },
        include: {
          assignedToUser: { select: { id: true, name: true, role: true } },
          preferredDoctor: { include: { user: { select: { name: true } } } },
          activities: {
            orderBy: { createdAt: "desc" },
            take: 10,
            include: { authorUser: { select: { id: true, name: true, role: true } } },
          },
        },
      });
      if (!lead) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No lead links to this patient",
        });
        return;
      }
      res.json({ success: true, data: lead, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /leads/:id — detail
router.get(
  "/:id",
  authorize(...LEAD_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: req.params.id },
        include: {
          assignedToUser: { select: { id: true, name: true, role: true } },
          preferredDoctor: { include: { user: { select: { name: true } } } },
          convertedPatient: {
            select: { id: true, mrNumber: true, user: { select: { name: true } } },
          },
          activities: {
            orderBy: { createdAt: "desc" },
            include: { authorUser: { select: { id: true, name: true, role: true } } },
          },
        },
      });
      if (!lead) {
        res.status(404).json({ success: false, data: null, error: "Lead not found" });
        return;
      }
      res.json({ success: true, data: lead, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /leads/:id — update + auto-log STATUS_CHANGE
router.patch(
  "/:id",
  authorize(...LEAD_ROLES),
  validate(updateLeadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.lead.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, assignedToUserId: true },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Lead not found" });
        return;
      }

      const updated = await prisma.lead.update({
        where: { id: existing.id },
        data: {
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.phone !== undefined ? { phone: req.body.phone } : {}),
          ...(req.body.email !== undefined ? { email: req.body.email } : {}),
          ...(req.body.source !== undefined ? { source: req.body.source } : {}),
          ...(req.body.status !== undefined ? { status: req.body.status } : {}),
          ...(req.body.preferredDoctorId !== undefined
            ? { preferredDoctorId: req.body.preferredDoctorId }
            : {}),
          ...(req.body.assignedToUserId !== undefined
            ? { assignedToUserId: req.body.assignedToUserId }
            : {}),
          ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
        },
        include: {
          assignedToUser: { select: { id: true, name: true, role: true } },
          preferredDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      // Auto-log STATUS_CHANGE activity for the timeline if status moved.
      if (req.body.status !== undefined && req.body.status !== existing.status) {
        await prisma.leadActivity.create({
          data: {
            leadId: existing.id,
            authorUserId: req.user!.userId,
            type: "STATUS_CHANGE",
            data: { fromStatus: existing.status, toStatus: req.body.status },
            body: `${existing.status} → ${req.body.status}`,
            tenantId: req.tenantId,
          },
        });
      }
      // Auto-log DOCTOR_ALLOCATION when assignedToUser changes.
      if (
        req.body.assignedToUserId !== undefined &&
        req.body.assignedToUserId !== existing.assignedToUserId
      ) {
        await prisma.leadActivity.create({
          data: {
            leadId: existing.id,
            authorUserId: req.user!.userId,
            type: "DOCTOR_ALLOCATION",
            data: {
              fromUserId: existing.assignedToUserId,
              toUserId: req.body.assignedToUserId,
            },
            body: req.body.assignedToUserId
              ? `Assigned to ${req.body.assignedToUserId}`
              : "Unassigned",
            tenantId: req.tenantId,
          },
        });
      }

      auditLog(req, "LEAD_UPDATE", "lead", updated.id, {
        changedKeys: Object.keys(req.body),
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /leads/:id/activities — log activity
router.post(
  "/:id/activities",
  authorize(...LEAD_ROLES),
  validate(createLeadActivitySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!lead) {
        res.status(404).json({ success: false, data: null, error: "Lead not found" });
        return;
      }

      const activity = await prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          authorUserId: req.user!.userId,
          type: req.body.type,
          body: req.body.body ?? null,
          data: req.body.data ?? null,
          tenantId: req.tenantId,
        },
        include: { authorUser: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "LEAD_ACTIVITY_CREATE", "lead_activity", activity.id, {
        leadId: lead.id,
        type: req.body.type,
      }).catch(console.error);

      res.status(201).json({ success: true, data: activity, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /leads/:id/convert — Lead → Patient
router.post(
  "/:id/convert",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(convertLeadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
          convertedPatientId: true,
        },
      });
      if (!lead) {
        res.status(404).json({ success: false, data: null, error: "Lead not found" });
        return;
      }
      if (lead.convertedPatientId) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Lead has already been converted",
        });
        return;
      }

      // Resolve patient fields from body OR lead row (body wins).
      const name = req.body.name ?? lead.name;
      const phone = req.body.phone ?? lead.phone;
      const email = req.body.email ?? lead.email;

      if (!phone) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Phone is required to convert a lead — neither the lead nor the request supplied one.",
        });
        return;
      }

      // Mint a deterministic placeholder email if none — same shape as
      // patients.ts uses (#891 nullable email kept the back-compat path
      // for legacy services that grep on the placeholder pattern).
      const mrCounter = await prisma.systemConfig.findUnique({
        where: { key: "next_mr_number" },
      });
      const mrSeq = mrCounter ? parseInt(mrCounter.value, 10) : 1;
      const mrNumber = `MR${String(mrSeq).padStart(6, "0")}`;
      const placeholderEmail = `noemail+${mrNumber}@medcore.invalid`;

      const result = await prisma.$transaction(async (tx) => {
        // User row first.
        const user = await tx.user.create({
          data: {
            name,
            email: email ?? placeholderEmail,
            phone,
            passwordHash: await bcrypt.hash(crypto.randomUUID(), 4),
            role: "PATIENT",
            tenantId: req.tenantId,
          },
        });
        const patient = await tx.patient.create({
          data: {
            userId: user.id,
            mrNumber,
            gender: req.body.gender,
            dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null,
            age: req.body.age ?? null,
            address: req.body.address ?? null,
            tenantId: req.tenantId,
          },
        });
        await tx.systemConfig.upsert({
          where: { key: "next_mr_number" },
          create: { key: "next_mr_number", value: String(mrSeq + 1) },
          update: { value: String(mrSeq + 1) },
        });

        const updatedLead = await tx.lead.update({
          where: { id: lead.id },
          data: {
            status: "CONVERTED",
            convertedAt: new Date(),
            convertedPatientId: patient.id,
          },
        });

        // Activity row pinning the conversion.
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            authorUserId: req.user!.userId,
            type: "CONVERSION",
            body: `Converted to patient ${mrNumber}`,
            data: { patientId: patient.id, mrNumber },
            tenantId: req.tenantId,
          },
        });

        return { lead: updatedLead, patient };
      });

      auditLog(req, "LEAD_CONVERT", "lead", lead.id, {
        patientId: result.patient.id,
        mrNumber: result.patient.mrNumber,
      }).catch(console.error);

      // Re-fetch lead with includes for the response shape consumers expect.
      const fresh = await prisma.lead.findUnique({
        where: { id: lead.id },
        include: {
          convertedPatient: {
            select: { id: true, mrNumber: true, user: { select: { name: true } } },
          },
          activities: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      });
      void rawPrisma; // imported for transactional escape-hatch parity; unused here
      res.status(201).json({ success: true, data: fresh, error: null });
    } catch (err) {
      next(err);
    }
  },
);

import crypto from "node:crypto";

export { router as leadRouter };
