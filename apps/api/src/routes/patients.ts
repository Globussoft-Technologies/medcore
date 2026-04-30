import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  createPatientSchema,
  updatePatientSchema,
  recordVitalsSchema,
  mergePatientSchema,
  Role,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();

// All patient routes require authentication
router.use(authenticate);

// GET /api/v1/patients — search/list patients
router.get(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { search, page = "1", limit = "20" } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: any = search
        ? {
            AND: [
              { mergedIntoId: null },
              {
                OR: [
                  { mrNumber: { contains: search as string, mode: "insensitive" } },
                  { user: { name: { contains: search as string, mode: "insensitive" } } },
                  { user: { phone: { contains: search as string } } },
                  { user: { email: { contains: search as string, mode: "insensitive" } } },
                  { address: { contains: search as string, mode: "insensitive" } },
                  { abhaId: { contains: search as string } },
                ],
              },
            ],
          }
        : { mergedIntoId: null };

      const [patients, total] = await Promise.all([
        prisma.patient.findMany({
          where,
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true },
            },
          },
          skip,
          take,
          orderBy: { user: { name: "asc" } },
        }),
        prisma.patient.count({ where }),
      ]);

      res.json({
        success: true,
        data: patients,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Issue #331 (Apr 2026): the synthetic walk-in email placeholder must
// never reach the frontend or notification stack. We strip it on the
// way out — the schema requires a non-null value at write time, but
// the API contract says "no email" should be observable as `null` so
// the reception edit form, the CRM export, and the email channel all
// see consistency. Matches both the new `noemail+...@medcore.invalid`
// pattern and any pre-fix `patient_<n>@medcore.local` rows that were
// already in the DB before this change shipped.
const PLACEHOLDER_EMAIL_RE =
  /^(?:noemail\+[^@]+@medcore\.invalid|patient_\d+@medcore\.local)$/i;
function maskPlaceholderEmail<T extends { email?: string | null } | null | undefined>(
  user: T,
): T {
  if (!user || typeof user.email !== "string") return user;
  if (PLACEHOLDER_EMAIL_RE.test(user.email)) {
    return { ...user, email: null } as T;
  }
  return user;
}

// GET /api/v1/patients/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #170 (Apr 2026): previously a single `findUnique` with a
      // wide `include` block. If ANY one relation (vitals, prescriptions,
      // appointments) hit a transient error or timed out, the whole route
      // 503'd — and pediatric patients with sparse but valid relations
      // tripped this most often. Split the relations into independent
      // queries with `.catch(() => [])` per-call so a missing/empty/slow
      // relation can't tank the chart-load. Empty arrays are guaranteed,
      // never `undefined` — that's what the frontend defends against in
      // the matching iteration sites.
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true },
          },
        },
      });

      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const [appointments, vitals, prescriptions] = await Promise.all([
        prisma.appointment
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { date: "desc" },
            take: 20,
            include: {
              doctor: { include: { user: { select: { name: true } } } },
            },
          })
          .catch(() => []),
        prisma.vitals
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { recordedAt: "desc" },
            take: 10,
          })
          .catch(() => []),
        prisma.prescription
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { createdAt: "desc" },
            take: 10,
            include: { items: true },
          })
          .catch(() => []),
      ]);

      res.json({
        success: true,
        data: {
          ...patient,
          user: maskPlaceholderEmail(patient.user),
          appointments,
          vitals,
          prescriptions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients — register new patient (reception)
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createPatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req.body;

      // Issue #103 (Apr 2026): pre-check for an existing patient with the
      // same phone before creating a duplicate MR record. We surface the
      // matching MR number so reception can pull up the existing chart
      // instead of creating a "Sharma 2" / "Sharma 3" sprawl. We DO NOT
      // rely solely on a unique constraint at the DB layer because (a) it
      // would 500 the request with a Prisma error and (b) the user would
      // get no actionable hint about which record already exists.
      if (typeof data.phone === "string" && data.phone.trim().length > 0) {
        const existing = await prisma.patient.findFirst({
          where: {
            mergedIntoId: null,
            user: { phone: data.phone.trim() },
          },
          select: { id: true, mrNumber: true, user: { select: { name: true } } },
        });
        if (existing) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A patient with this phone is already registered (MR: ${existing.mrNumber}).`,
            details: [
              {
                field: "phone",
                message: `Already registered as ${existing.user?.name ?? "patient"} (MR: ${existing.mrNumber}).`,
              },
            ],
            existingPatient: {
              id: existing.id,
              mrNumber: existing.mrNumber,
              name: existing.user?.name ?? null,
            },
          });
          return;
        }
      }

      // Auto-generate MR number
      const config = await prisma.systemConfig.findUnique({
        where: { key: "next_mr_number" },
      });
      const mrSeq = config ? parseInt(config.value) : 1;
      const mrNumber = `MR${String(mrSeq).padStart(6, "0")}`;

      // Issue #331 (Apr 2026): the placeholder email
      // `patient_<MR>@medcore.local` was leaking into appointment
      // reminders and CRM exports — reception would open the chart,
      // see a real-looking address, and assume it was something the
      // patient supplied. We can't store NULL because the schema's
      // `User.email` is non-null + `@unique`, so we keep the
      // placeholder but switch to the `.invalid` reserved TLD (RFC
      // 6761): every notification provider drops `.invalid` addresses
      // immediately, and the format is unambiguously "not real" to any
      // human reading the chart. The frontend hides anything matching
      // this pattern from the email field on the patient detail page,
      // so reception sees an empty field instead of a fabricated one.
      // For phone we just pass through what reception typed — never
      // invent one.
      const trimmedEmail =
        typeof data.email === "string" ? data.email.trim() : "";
      const placeholderEmail = `noemail+${mrNumber}@medcore.invalid`;
      // Create user + patient in transaction
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: data.name,
            email: trimmedEmail || placeholderEmail,
            phone: data.phone,
            passwordHash: "", // walk-in patients may not need login
            role: "PATIENT",
          },
        });

        const patient = await tx.patient.create({
          data: {
            userId: user.id,
            mrNumber,
            dateOfBirth: data.dateOfBirth
              ? new Date(data.dateOfBirth)
              : undefined,
            age: data.age,
            gender: data.gender,
            address: data.address,
            bloodGroup: data.bloodGroup,
            emergencyContactName: data.emergencyContactName,
            emergencyContactPhone: data.emergencyContactPhone,
            insuranceProvider: data.insuranceProvider,
            insurancePolicyNumber: data.insurancePolicyNumber,
          },
        });

        await tx.systemConfig.upsert({
          where: { key: "next_mr_number" },
          update: { value: String(mrSeq + 1) },
          create: { key: "next_mr_number", value: String(mrSeq + 1) },
        });

        return { ...patient, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } };
      });

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/patients/:id — update demographics. Open to most staff so
// typos in phone/address/name can be corrected without escalation. MR number
// is immutable and is never touched here.
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  validate(updatePatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        name?: string;
        phone?: string;
        email?: string;
        dateOfBirth?: string | null;
        [key: string]: unknown;
      };
      const { name, phone, email, dateOfBirth, ...rest } = body;

      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Defence-in-depth: MR number is never editable via PATCH. The Zod
      // schema doesn't include it, but strip any stray value just in case.
      const patientData: Record<string, unknown> = { ...rest };
      delete patientData.mrNumber;
      if (dateOfBirth !== undefined) {
        patientData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth as string) : null;
      }

      await prisma.$transaction(async (tx) => {
        if (name || phone || email) {
          await tx.user.update({
            where: { id: patient.userId },
            data: {
              ...(name && { name }),
              ...(phone && { phone }),
              ...(email && { email }),
            },
          });
        }

        if (Object.keys(patientData).length > 0) {
          await tx.patient.update({
            where: { id: req.params.id },
            data: patientData,
          });
        }
      });

      auditLog(req, "PATIENT_UPDATE", "patient", req.params.id, {
        fields: [
          ...(name ? ["name"] : []),
          ...(phone ? ["phone"] : []),
          ...(email ? ["email"] : []),
          ...Object.keys(patientData),
        ],
      }).catch(console.error);

      const updated = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/vitals — record vitals (nurse)
router.post(
  "/:id/vitals",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(recordVitalsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Compute baseline + analysis (considering patient baseline)
      const { computePatientBaseline, detectSuddenChanges } = await import(
        "../services/vitals-baseline"
      );
      const { computeVitalsFlagsWithBaseline } = await import(
        "../services/vitals-analysis"
      );
      const baseline = await computePatientBaseline(req.params.id);
      const analysis = computeVitalsFlagsWithBaseline(req.body, {
        bpSystolic: baseline.bpSystolic,
        bpDiastolic: baseline.bpDiastolic,
        pulse: baseline.pulse,
        spO2: baseline.spO2,
      });

      // Detect sudden changes vs last 24h
      const suddenChanges = await detectSuddenChanges(req.params.id, req.body);

      const vitals = await prisma.vitals.create({
        data: {
          ...req.body,
          patientId: req.params.id,
          nurseId: req.user!.userId,
          bmi: analysis.bmi,
          isAbnormal: analysis.isAbnormal,
          abnormalFlags:
            analysis.flags.length > 0 ? analysis.flags.join(",") : null,
        },
      });

      // If critical, push a notification to the doctor for the appointment
      if (analysis.isCritical && req.body.appointmentId) {
        (async () => {
          try {
            const apt = await prisma.appointment.findUnique({
              where: { id: req.body.appointmentId },
              select: {
                doctorId: true,
                patient: { select: { user: { select: { name: true, phone: true } } } },
              },
            });
            if (apt?.doctorId) {
              const doc = await prisma.doctor.findUnique({
                where: { id: apt.doctorId },
                select: { userId: true },
              });
              if (doc?.userId) {
                await prisma.notification.create({
                  data: {
                    userId: doc.userId,
                    type: "APPOINTMENT_REMINDER" as any,
                    channel: "PUSH" as any,
                    title: "Critical Vitals Alert",
                    message: `${apt.patient?.user?.name || "Patient"}: ${analysis.flags.join(", ")}`,
                    data: {
                      vitalsId: vitals.id,
                      flags: analysis.flags,
                    } as any,
                    sentAt: new Date(),
                  },
                });
              }
            }

            // If vitals are critical (e.g. LOW_SPO2), also send an SMS to
            // the patient per configured template.
            const patientUser = apt?.patient?.user;
            if (patientUser?.phone) {
              const cfg = await prisma.systemConfig.findUnique({
                where: { key: "vitals_alert_sms_template" },
              });
              const tpl =
                cfg?.value ||
                "Your recent vitals reading shows {{flags}}. Please contact the clinic for follow-up.";
              const msg = tpl.replace(
                "{{flags}}",
                analysis.critical.join(", ")
              );
              const { sendSMS, sendWhatsApp } = await import(
                "../services/notification"
              );
              sendSMS(patientUser.phone, msg).catch(() => undefined);
              sendWhatsApp(patientUser.phone, msg).catch(() => undefined);
            }
          } catch (e) {
            console.error("vitals-critical-notify", e);
          }
        })().catch(console.error);
      }

      // Fire notification to doctor when sudden changes are detected
      if (suddenChanges.hasSignificantChange && req.body.appointmentId) {
        (async () => {
          try {
            const apt = await prisma.appointment.findUnique({
              where: { id: req.body.appointmentId },
              select: {
                doctorId: true,
                patient: { select: { user: { select: { name: true } } } },
              },
            });
            if (apt?.doctorId) {
              const doc = await prisma.doctor.findUnique({
                where: { id: apt.doctorId },
                select: { userId: true },
              });
              if (doc?.userId) {
                const sigs = suddenChanges.changes
                  .filter((c) => c.significant)
                  .map((c) => `${c.field}: Δ${c.delta}`)
                  .join(", ");
                await prisma.notification.create({
                  data: {
                    userId: doc.userId,
                    type: "APPOINTMENT_REMINDER" as any,
                    channel: "PUSH" as any,
                    title: "Sudden Vitals Change",
                    message: `${apt.patient?.user?.name || "Patient"}: ${sigs}`,
                    data: {
                      vitalsId: vitals.id,
                      changes: suddenChanges.changes,
                    } as any,
                    sentAt: new Date(),
                  },
                });
              }
            }
          } catch (e) {
            console.error("vitals-sudden-notify", e);
          }
        })().catch(console.error);
      }

      res.status(201).json({
        success: true,
        data: {
          ...vitals,
          analysis,
          changes: suddenChanges.changes,
          previousRecordedAt: suddenChanges.previousRecordedAt,
          baseline,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/merge — merge another patient record into this one
router.post(
  "/:id/merge",
  authorize(Role.ADMIN),
  validate(mergePatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keepId = req.params.id;
      const { otherPatientId } = req.body as { otherPatientId: string };
      if (keepId === otherPatientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot merge a patient into itself",
        });
        return;
      }

      const [keep, other] = await Promise.all([
        prisma.patient.findUnique({ where: { id: keepId } }),
        prisma.patient.findUnique({ where: { id: otherPatientId } }),
      ]);

      if (!keep || !other) {
        res.status(404).json({
          success: false,
          data: null,
          error: "One or both patients not found",
        });
        return;
      }
      if (other.mergedIntoId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Source patient is already merged",
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        // Repoint all dependent child records to the keep patient
        await tx.appointment.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.vitals.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.prescription.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.invoice.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.patientAllergy.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.chronicCondition.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.familyHistory.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.immunization.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.patientDocument.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.labOrder.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });

        // Mark the source as merged (keep for audit trail)
        const marked = await tx.patient.update({
          where: { id: otherPatientId },
          data: { mergedIntoId: keepId },
        });
        return marked;
      });

      auditLog(req, "PATIENT_MERGE", "patient", keepId, {
        mergedFrom: otherPatientId,
      }).catch(console.error);

      res.json({
        success: true,
        data: { keptId: keepId, mergedId: result.id },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/history — visit history
router.get(
  "/:id/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appointments = await prisma.appointment.findMany({
        where: { patientId: req.params.id },
        orderBy: { date: "desc" },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          vitals: true,
          consultation: true,
          prescription: { include: { items: true } },
          invoice: { include: { payments: true } },
        },
      });

      res.json({ success: true, data: appointments, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/timeline — unified chronological timeline
router.get(
  "/:id/timeline",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const [
        appointments,
        consultations,
        prescriptions,
        vitals,
        admissions,
        labOrders,
        surgeries,
        invoices,
        emergencies,
      ] = await Promise.all([
        prisma.appointment.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { date: "desc" },
          take: 200,
        }),
        prisma.consultation.findMany({
          where: { appointment: { patientId } },
          include: {
            appointment: true,
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.prescription.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
            items: true,
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.vitals.findMany({
          where: { patientId },
          orderBy: { recordedAt: "desc" },
          take: 200,
        }),
        prisma.admission.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
          orderBy: { admittedAt: "desc" },
          take: 200,
        }),
        prisma.labOrder.findMany({
          where: { patientId },
          include: {
            items: { include: { test: true, results: true } },
          },
          orderBy: { orderedAt: "desc" },
          take: 200,
        }),
        prisma.surgery.findMany({
          where: { patientId },
          include: {
            surgeon: { include: { user: { select: { name: true } } } },
          },
          orderBy: { scheduledAt: "desc" },
          take: 200,
        }),
        prisma.invoice.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.emergencyCase.findMany({
          where: { patientId },
          orderBy: { arrivedAt: "desc" },
          take: 200,
        }),
      ]);

      type Entry = {
        id: string;
        type: string;
        title: string;
        description: string;
        timestamp: string;
        icon: string;
        color: string;
        link: string | null;
      };
      const entries: Entry[] = [];

      for (const a of appointments) {
        entries.push({
          id: `appt-${a.id}`,
          type: "appointment",
          title: `Appointment with Dr. ${a.doctor?.user?.name || "—"}`,
          description: `${a.type} · ${a.status.replace(/_/g, " ")}${
            a.notes ? ` · ${a.notes}` : ""
          }`,
          timestamp: new Date(a.date).toISOString(),
          icon: "Calendar",
          color: "blue",
          link: `/dashboard/appointments`,
        });
      }

      for (const c of consultations) {
        entries.push({
          id: `cons-${c.id}`,
          type: "consultation",
          title: `Consultation with Dr. ${c.doctor?.user?.name || "—"}`,
          description:
            (c.findings ? `Findings: ${c.findings}` : "") +
            (c.notes ? (c.findings ? " · " : "") + `Notes: ${c.notes}` : ""),
          timestamp: c.createdAt.toISOString(),
          icon: "Stethoscope",
          color: "indigo",
          link: null,
        });
      }

      for (const p of prescriptions) {
        entries.push({
          id: `rx-${p.id}`,
          type: "prescription",
          title: `Prescription — ${p.diagnosis}`,
          description: `${p.items.length} medication(s)${
            p.followUpDate
              ? ` · Follow up: ${new Date(p.followUpDate).toLocaleDateString()}`
              : ""
          }`,
          timestamp: p.createdAt.toISOString(),
          icon: "FileText",
          color: "green",
          link: null,
        });
      }

      for (const v of vitals) {
        const parts: string[] = [];
        if (v.bloodPressureSystolic && v.bloodPressureDiastolic) {
          parts.push(`BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`);
        }
        if (v.pulseRate) parts.push(`HR ${v.pulseRate}`);
        if (v.temperature) parts.push(`Temp ${v.temperature}`);
        if (v.spO2) parts.push(`SpO2 ${v.spO2}%`);
        if (v.weight) parts.push(`Wt ${v.weight}kg`);
        entries.push({
          id: `vit-${v.id}`,
          type: "vitals",
          title: "Vitals Recorded",
          description: parts.join(" · ") || "—",
          timestamp: v.recordedAt.toISOString(),
          icon: "Activity",
          color: "cyan",
          link: null,
        });
      }

      for (const a of admissions) {
        entries.push({
          id: `adm-in-${a.id}`,
          type: "admission",
          title: `Admitted — ${a.admissionNumber}`,
          description: `${a.reason} · Dr. ${a.doctor?.user?.name || "—"} · Ward ${
            a.bed?.ward?.name || ""
          } Bed ${a.bed?.bedNumber || ""}`.trim(),
          timestamp: a.admittedAt.toISOString(),
          icon: "BedDouble",
          color: "purple",
          link: `/dashboard/ipd/${a.id}`,
        });
        if (a.dischargedAt) {
          entries.push({
            id: `adm-out-${a.id}`,
            type: "admission",
            title: `Discharged — ${a.admissionNumber}`,
            description: a.dischargeSummary || a.dischargeNotes || "Discharged",
            timestamp: a.dischargedAt.toISOString(),
            icon: "BedDouble",
            color: "gray",
            link: `/dashboard/ipd/${a.id}`,
          });
        }
      }

      for (const lo of labOrders) {
        const testNames = lo.items.map((i) => i.test.name).join(", ");
        entries.push({
          id: `lab-${lo.id}`,
          type: "lab",
          title: `Lab Order ${lo.orderNumber}`,
          description: `${testNames || "—"} · ${lo.status.replace(/_/g, " ")}`,
          timestamp: lo.orderedAt.toISOString(),
          icon: "FlaskConical",
          color: "amber",
          link: null,
        });
        if (lo.completedAt) {
          const totalResults = lo.items.reduce(
            (s, i) => s + i.results.length,
            0
          );
          const abnormal = lo.items.reduce(
            (s, i) =>
              s + i.results.filter((r) => r.flag !== "NORMAL").length,
            0
          );
          entries.push({
            id: `lab-result-${lo.id}`,
            type: "lab",
            title: `Lab Results — ${lo.orderNumber}`,
            description: `${totalResults} result(s)${
              abnormal > 0 ? ` · ${abnormal} abnormal` : ""
            }`,
            timestamp: lo.completedAt.toISOString(),
            icon: "FlaskConical",
            color: abnormal > 0 ? "red" : "green",
            link: null,
          });
        }
      }

      for (const s of surgeries) {
        entries.push({
          id: `surg-${s.id}`,
          type: "surgery",
          title: `Surgery — ${s.procedure}`,
          description: `${s.caseNumber} · Dr. ${s.surgeon?.user?.name || "—"} · ${s.status.replace(
            /_/g,
            " "
          )}`,
          timestamp: s.scheduledAt.toISOString(),
          icon: "Scissors",
          color: "rose",
          link: null,
        });
      }

      for (const inv of invoices) {
        entries.push({
          id: `inv-${inv.id}`,
          type: "invoice",
          title: `Invoice ${inv.invoiceNumber}`,
          description: `Rs. ${inv.totalAmount.toFixed(2)} · ${inv.paymentStatus}`,
          timestamp: inv.createdAt.toISOString(),
          icon: "CreditCard",
          color: inv.paymentStatus === "PAID" ? "green" : "orange",
          link: null,
        });
      }

      for (const ec of emergencies) {
        entries.push({
          id: `er-${ec.id}`,
          type: "emergency",
          title: `ER Visit — ${ec.caseNumber}`,
          description: `${ec.chiefComplaint} · ${ec.status.replace(/_/g, " ")}${
            ec.triageLevel ? ` · Triage ${ec.triageLevel}` : ""
          }`,
          timestamp: ec.arrivedAt.toISOString(),
          icon: "Siren",
          color: "red",
          link: null,
        });
      }

      entries.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/vitals-trend?from=&to=
router.get(
  "/:id/vitals-trend",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query;
      const where: any = { patientId: req.params.id };
      if (from || to) {
        where.recordedAt = {};
        if (from) where.recordedAt.gte = new Date(from as string);
        if (to) where.recordedAt.lte = new Date(to as string);
      }

      const [opdVitals, ipdVitals] = await Promise.all([
        prisma.vitals.findMany({
          where,
          orderBy: { recordedAt: "asc" },
          select: {
            recordedAt: true,
            bloodPressureSystolic: true,
            bloodPressureDiastolic: true,
            temperature: true,
            temperatureUnit: true,
            pulseRate: true,
            spO2: true,
            weight: true,
            height: true,
            bmi: true,
            isAbnormal: true,
            abnormalFlags: true,
            respiratoryRate: true,
            painScale: true,
          },
        }),
        prisma.ipdVitals.findMany({
          where: {
            admission: { patientId: req.params.id },
            ...(from || to
              ? {
                  recordedAt: {
                    ...(from ? { gte: new Date(from as string) } : {}),
                    ...(to ? { lte: new Date(to as string) } : {}),
                  },
                }
              : {}),
          },
          orderBy: { recordedAt: "asc" },
          select: {
            recordedAt: true,
            bloodPressureSystolic: true,
            bloodPressureDiastolic: true,
            temperature: true,
            pulseRate: true,
            spO2: true,
          },
        }),
      ]);

      const combined = [
        ...opdVitals.map((v) => ({ ...v, weight: v.weight ?? null })),
        ...ipdVitals.map((v) => ({ ...v, weight: null })),
      ].sort(
        (a, b) =>
          new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
      );

      res.json({ success: true, data: combined, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/stats
router.get(
  "/:id/stats",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];

      // Issue #330: previously totalVisits only counted COMPLETED +
      // IN_CONSULTATION, so a freshly-registered walk-in (status BOOKED)
      // showed Total Visits = 0 in the header KPI strip even though the
      // "Last 90 Days" panel and the Recent Activity / Timeline both
      // surfaced the same row as a visit. The two displays disagreed on
      // the same screen.
      //
      // Align the count with what users (and the timeline) consider a
      // visit: any real appointment, excluding only CANCELLED and
      // NO_SHOW. The Last 90 Days panel derives from the same /history
      // feed, so the two now agree by construction (Last 90 Days = a
      // trailing-90-day subset of the same denominator).
      const VISIT_STATUSES = [
        "BOOKED",
        "CHECKED_IN",
        "IN_CONSULTATION",
        "COMPLETED",
      ] as const;
      const [
        totalVisits,
        lastVisit,
        paidInvoices,
        activeConditions,
        activeAllergies,
        upcomingAppointments,
        pendingBills,
        currentAdmission,
      ] = await Promise.all([
        prisma.appointment.count({
          where: { patientId, status: { in: [...VISIT_STATUSES] } },
        }),
        prisma.appointment.findFirst({
          where: { patientId, status: { in: [...VISIT_STATUSES] } },
          orderBy: { date: "desc" },
          select: { date: true },
        }),
        prisma.invoice.aggregate({
          where: { patientId, paymentStatus: "PAID" },
          _sum: { totalAmount: true },
        }),
        // Issue #85: previously this only counted chronic conditions with
        // status ACTIVE/RELAPSED. The Patient 360 "Problem List" card,
        // backed by GET /ehr/patients/:id/problem-list, treats CONTROLLED
        // as active too — so the KPI tile read 0 while the card showed 7.
        // Aligning the include set fixes the mismatch.
        prisma.chronicCondition.count({
          where: {
            patientId,
            status: { in: ["ACTIVE", "RELAPSED", "CONTROLLED"] },
          },
        }),
        prisma.patientAllergy.count({
          where: { patientId },
        }),
        prisma.appointment.count({
          where: {
            patientId,
            status: { in: ["BOOKED", "CHECKED_IN"] },
            date: { gte: new Date(todayStr) },
          },
        }),
        prisma.invoice.count({
          where: {
            patientId,
            paymentStatus: { in: ["PENDING", "PARTIAL"] },
          },
        }),
        prisma.admission.findFirst({
          where: { patientId, status: "ADMITTED" },
          select: { id: true, admissionNumber: true },
        }),
      ]);

      res.json({
        success: true,
        data: {
          totalVisits,
          lastVisitDate: lastVisit?.date || null,
          totalSpent: paidInvoices._sum.totalAmount || 0,
          activeConditionsCount: activeConditions,
          activeAllergiesCount: activeAllergies,
          upcomingAppointments,
          pendingBills,
          currentAdmissionId: currentAdmission?.id || null,
          currentAdmissionNumber: currentAdmission?.admissionNumber || null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/invoices
router.get(
  "/:id/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoices = await prisma.invoice.findMany({
        where: { patientId: req.params.id },
        include: {
          items: true,
          payments: true,
          appointment: {
            include: {
              doctor: { include: { user: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: invoices, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/lab-orders
router.get(
  "/:id/lab-orders",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orders = await prisma.labOrder.findMany({
        where: { patientId: req.params.id },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          items: {
            include: {
              test: true,
              results: true,
            },
          },
        },
        orderBy: { orderedAt: "desc" },
      });

      res.json({ success: true, data: orders, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── FAMILY LINKING (Apr 2026) ──────────────────────────

// GET /api/v1/patients/:id/family
router.get(
  "/:id/family",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: { id: true, guardianPatientId: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const [guardian, dependents, familyLinks] = await Promise.all([
        patient.guardianPatientId
          ? prisma.patient.findUnique({
              where: { id: patient.guardianPatientId },
              include: { user: { select: { name: true, phone: true } } },
            })
          : Promise.resolve(null),
        prisma.patient.findMany({
          where: { guardianPatientId: patient.id },
          include: { user: { select: { name: true, phone: true } } },
        }),
        prisma.patientFamilyLink.findMany({
          where: { patientId: patient.id },
          include: {
            relatedPatient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
        }),
      ]);

      res.json({
        success: true,
        data: { guardian, dependents, familyLinks },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/link-family
router.post(
  "/:id/link-family",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const { relatedPatientId, relationship } = req.body as {
        relatedPatientId: string;
        relationship: "PARENT" | "CHILD" | "SPOUSE" | "SIBLING" | "GUARDIAN";
      };
      if (!relatedPatientId || !relationship) {
        res.status(400).json({
          success: false,
          data: null,
          error: "relatedPatientId and relationship required",
        });
        return;
      }
      if (relatedPatientId === patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot link a patient to themselves",
        });
        return;
      }
      const [patient, related] = await Promise.all([
        prisma.patient.findUnique({ where: { id: patientId } }),
        prisma.patient.findUnique({ where: { id: relatedPatientId } }),
      ]);
      if (!patient || !related) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Create bidirectional link (simplified — inverse relation is PARENT<->CHILD, otherwise same)
      const inverse: Record<string, string> = {
        PARENT: "CHILD",
        CHILD: "PARENT",
        SPOUSE: "SPOUSE",
        SIBLING: "SIBLING",
        GUARDIAN: "CHILD",
      };

      const [a, b] = await prisma.$transaction([
        prisma.patientFamilyLink.upsert({
          where: {
            patientId_relatedPatientId: { patientId, relatedPatientId },
          },
          create: { patientId, relatedPatientId, relationship },
          update: { relationship },
        }),
        prisma.patientFamilyLink.upsert({
          where: {
            patientId_relatedPatientId: {
              patientId: relatedPatientId,
              relatedPatientId: patientId,
            },
          },
          create: {
            patientId: relatedPatientId,
            relatedPatientId: patientId,
            relationship: inverse[relationship] || relationship,
          },
          update: { relationship: inverse[relationship] || relationship },
        }),
      ]);

      // If PARENT/GUARDIAN, set guardianPatientId on this patient
      if (relationship === "PARENT" || relationship === "GUARDIAN") {
        await prisma.patient.update({
          where: { id: patientId },
          data: { guardianPatientId: relatedPatientId },
        });
      }
      if (relationship === "CHILD") {
        await prisma.patient.update({
          where: { id: relatedPatientId },
          data: { guardianPatientId: patientId },
        });
      }

      auditLog(req, "FAMILY_LINK", "patient", patientId, {
        relatedPatientId,
        relationship,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { primaryLink: a, inverseLink: b },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/patients/:id/link-family/:relatedId
router.delete(
  "/:id/link-family/:relatedId",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, relatedId } = req.params;
      await prisma.$transaction([
        prisma.patientFamilyLink.deleteMany({
          where: { patientId: id, relatedPatientId: relatedId },
        }),
        prisma.patientFamilyLink.deleteMany({
          where: { patientId: relatedId, relatedPatientId: id },
        }),
      ]);
      auditLog(req, "FAMILY_UNLINK", "patient", id, { relatedId }).catch(
        console.error
      );
      res.json({ success: true, data: { unlinked: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/renal-function
// Latest creatinine + Cockcroft-Gault eGFR estimate
router.get(
  "/:id/renal-function",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: { id: true, dateOfBirth: true, age: true, gender: true },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Find latest creatinine lab result (parameter includes 'creatinine', case-insensitive)
      const recentResults = await prisma.labResult.findMany({
        where: {
          parameter: { contains: "reatinine", mode: "insensitive" },
          orderItem: { order: { patientId: patient.id } },
        },
        orderBy: { reportedAt: "desc" },
        take: 1,
        include: {
          orderItem: {
            select: {
              order: {
                select: { orderedAt: true, orderNumber: true },
              },
            },
          },
        },
      });

      const latest = recentResults[0] ?? null;
      const creatinineMgDl = latest ? parseFloat(latest.value) : null;

      // Get latest weight from vitals for CrCl calc
      const latestVitals = await prisma.vitals.findFirst({
        where: { patientId: patient.id, weight: { not: null } },
        orderBy: { recordedAt: "desc" },
        select: { weight: true, recordedAt: true },
      });

      const ageYears =
        patient.age ??
        (patient.dateOfBirth
          ? Math.floor(
              (Date.now() - patient.dateOfBirth.getTime()) /
                (365.25 * 24 * 3600 * 1000)
            )
          : null);
      const genderMale = patient.gender === "MALE";
      const weightKg = latestVitals?.weight ?? null;

      let crcl: number | null = null;
      if (creatinineMgDl && creatinineMgDl > 0 && ageYears && weightKg) {
        let v = ((140 - ageYears) * weightKg) / (72 * creatinineMgDl);
        if (!genderMale) v *= 0.85;
        crcl = Math.round(v * 10) / 10;
      }

      let stage: string | null = null;
      if (crcl !== null) {
        if (crcl < 15) stage = "KIDNEY_FAILURE";
        else if (crcl < 30) stage = "SEVERE";
        else if (crcl < 60) stage = "MODERATE";
        else if (crcl < 90) stage = "MILD";
        else stage = "NORMAL";
      }

      res.json({
        success: true,
        data: {
          patientId: patient.id,
          ageYears,
          genderMale,
          weightKg,
          latestCreatinine: latest
            ? {
                value: creatinineMgDl,
                unit: latest.unit,
                reportedAt: latest.reportedAt,
                orderNumber: latest.orderItem.order.orderNumber,
              }
            : null,
          crClMlPerMin: crcl,
          ckdStage: stage,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as patientRouter };
