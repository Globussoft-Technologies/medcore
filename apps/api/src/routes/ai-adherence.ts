import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";

/**
 * Best-effort audit wrapper: PHI audit writes must never take a GET response
 * down with them. If prisma is unavailable (e.g. transient DB blip), log a
 * warning and allow the request to complete.
 */
function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

const router = Router();
router.use(authenticate);

// ── Ownership helper ────────────────────────────────────────────────────────

/**
 * Enforces that the caller is allowed to act on dose logs for a given
 * schedule. Patients may only touch their own; ADMIN and DOCTOR may touch any.
 *
 * Returns `{ schedule }` on success, or `{ ok: false, ... }` with the
 * HTTP status + message that the handler should return verbatim. The
 * actual ownership comparison is delegated to `assertPatientOwnsResource`
 * (issue #511 BOLA sweep) so all per-row checks use the canonical helper.
 */
type AuthorizeResult =
  | { ok: true; schedule: NonNullable<Awaited<ReturnType<typeof prisma.adherenceSchedule.findUnique>>> }
  | { ok: false; status: number; message: string; handled?: boolean };

async function authorizeScheduleAccess(
  req: Request,
  res: Response,
  scheduleId: string
): Promise<AuthorizeResult> {
  const schedule = await prisma.adherenceSchedule.findUnique({
    where: { id: scheduleId },
  });
  if (!schedule) {
    return { ok: false, status: 404, message: "Schedule not found" };
  }

  // security(2026-05-04-med): issue #511 — delegate per-row ownership to the
  // canonical helper. On failure the helper writes a 403 envelope to `res`
  // and returns false; the caller MUST early-return without further
  // response writes (signalled here by `handled: true`).
  if (!(await assertPatientOwnsResource(req, res, schedule.patientId))) {
    return { ok: false, status: 403, message: "Forbidden", handled: true };
  }

  return { ok: true, schedule };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a duration string like "7 days", "2 weeks", "1 month" into days.
 * Falls back to 7 if unparseable.
 */
function parseDurationDays(duration: string): number {
  const lower = duration.toLowerCase();
  const num = parseInt(lower, 10);
  if (isNaN(num)) return 7;
  if (lower.includes("month")) return num * 30;
  if (lower.includes("week")) return num * 7;
  return num; // days
}

/**
 * Derive default reminder times from a frequency string. Handles plain
 * English ("twice daily") and the standard medical abbreviations
 * (OD/BD/BID/TID/QID/QDS — these are what doctors actually type into
 * prescriptions in India).
 */
function derivedFromFrequency(frequency: string): string[] {
  const lower = frequency.toLowerCase().trim();
  const tokens = new Set(lower.split(/[\s,/.-]+/));

  if (lower.includes("four times") || tokens.has("qid") || tokens.has("qds")) {
    return ["07:00", "12:00", "17:00", "21:00"];
  }
  if (lower.includes("three times") || tokens.has("tid") || tokens.has("tds")) {
    return ["08:00", "14:00", "20:00"];
  }
  if (lower.includes("twice") || tokens.has("bid") || tokens.has("bd")) {
    return ["08:00", "20:00"];
  }
  if (lower.includes("once") || tokens.has("od") || tokens.has("qd")) {
    return ["08:00"];
  }
  return ["08:00"];
}

// ── POST /api/v1/ai/adherence/enroll ────────────────────────────────────────

router.post(
  "/enroll",
  // security(2026-04-23-med): F-ADH-1 — enroll writes an adherence schedule
  // row linking a prescription to a patient. Restricted to clinical staff who
  // already have prescribe / dispense privileges.
  // Issue #241 (2026-04-30): PATIENT may also self-enroll their OWN
  // prescription (the /dashboard/adherence "+ Enroll Prescription" flow). The
  // owner check is enforced inline below — a patient cannot enrol someone
  // else's prescriptionId.
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE, Role.PHARMACIST, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    // security(2026-05-04-med): F-ADH-3 — stamp an AI-inference audit row for
    // every /enroll call so the security team can reconstruct who triggered
    // the adherence-bot pipeline (Sarvam reminder generation runs out-of-band
    // from this schedule). NEVER log prompt content; metadata only.
    const startedAt = Date.now();
    try {
      const { prescriptionId, reminderTimes } = req.body as {
        prescriptionId: string;
        reminderTimes?: string[];
      };

      if (!prescriptionId) {
        res.status(400).json({ success: false, data: null, error: "prescriptionId is required" });
        return;
      }

      // Fetch prescription with items and patient
      const prescription = await prisma.prescription.findUnique({
        where: { id: prescriptionId },
        include: {
          items: true,
          patient: { include: { user: { select: { id: true } } } },
        },
      });

      if (!prescription) {
        res.status(404).json({ success: false, data: null, error: "Prescription not found" });
        return;
      }

      // Issue #241: per-row ownership check for PATIENT callers. Staff roles
      // already passed the authorize() gate above and may enrol on behalf of
      // any patient.
      const user = req.user!;
      if (
        user.role === Role.PATIENT &&
        prescription.patient?.user?.id !== user.userId
      ) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Forbidden: you can only enrol your own prescription",
        });
        return;
      }

      // Build medications array
      const medications = prescription.items.map((item) => ({
        name: item.medicineName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        reminderTimes: reminderTimes ?? derivedFromFrequency(item.frequency),
      }));

      // Calculate endDate from max duration among items
      const maxDays = Math.max(
        ...prescription.items.map((item) => parseDurationDays(item.duration)),
        7
      );
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + maxDays);

      // Upsert AdherenceSchedule keyed on prescriptionId
      const schedule = await prisma.adherenceSchedule.upsert({
        where: { prescriptionId },
        create: {
          patientId: prescription.patientId,
          prescriptionId,
          medications: medications as any,
          startDate: today,
          endDate,
          active: true,
          remindersSent: 0,
        },
        update: {
          medications: medications as any,
          startDate: today,
          endDate,
          active: true,
        },
      });

      safeAudit(req, "AI_ADHERENCE_INFERENCE", "AdherenceSchedule", schedule.id, {
        prescriptionId,
        medicationCount: medications.length,
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: true,
      });

      res.status(200).json({ success: true, data: schedule, error: null });
    } catch (err) {
      safeAudit(req, "AI_ADHERENCE_INFERENCE", "AdherenceSchedule", undefined, {
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: false,
        failure: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  }
);

// ── GET /api/v1/ai/adherence/mine ───────────────────────────────────────────
//
// Issue #24: patients don't know (and shouldn't need to know) their internal
// patientId. Resolve it server-side from the authenticated user's Patient
// record, then return the same payload as `/:patientId`. Non-patient roles
// receive 403 — staff have the `/:patientId` endpoint for lookup by id.
//
// MUST be declared BEFORE the `/:patientId` route so Express doesn't treat
// the literal "mine" as a UUID param and fail uuid validation.
router.get(
  "/mine",
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const patient = await prisma.patient.findFirst({
        where: { userId: user.userId },
        select: { id: true },
      });
      if (!patient) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No patient profile linked to this account",
        });
        return;
      }

      const schedules = await prisma.adherenceSchedule.findMany({
        where: { patientId: patient.id, active: true },
        orderBy: { createdAt: "desc" },
      });

      safeAudit(req, "AI_ADHERENCE_READ", "AdherenceSchedule", undefined, {
        patientId: patient.id,
        resultCount: schedules.length,
        via: "mine",
      });

      res.json({ success: true, data: schedules, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/adherence/:patientId ─────────────────────────────────────

router.get(
  "/:patientId",
  // security(2026-04-23-med): F-ADH-4 — reject non-UUID :patientId up front
  // so a malformed path doesn't reach prisma.findUnique (which returns P2023).
  validateUuidParams(["patientId"]),
  // security(2026-05-04-med): issue #511 BOLA sweep — restrict non-staff to
  // ADMIN / DOCTOR only at the role gate. PATIENT callers fall through to
  // the per-row `assertPatientOwnsResource` check below; everyone else is
  // 403'd here. NURSE / PHARMACIST / RECEPTIONIST / LAB_TECH / etc are not
  // expected callers for this endpoint (they use staff-side workflows).
  authorize(Role.ADMIN, Role.DOCTOR, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      // security(2026-05-04-med): issue #511 — use the canonical
      // `assertPatientOwnsResource` helper so the ownership check is uniform
      // across the codebase. ADMIN/DOCTOR pass through (already gated above);
      // PATIENT must own the patient row keyed by `:patientId`.
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;

      // 404 for staff-callers when the patient row doesn't exist (PATIENT
      // would have already 403'd inside the helper).
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const schedules = await prisma.adherenceSchedule.findMany({
        where: { patientId, active: true },
        orderBy: { createdAt: "desc" },
      });

      safeAudit(req, "AI_ADHERENCE_READ", "AdherenceSchedule", undefined, {
        patientId,
        resultCount: schedules.length,
      });

      res.json({ success: true, data: schedules, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/v1/ai/adherence/:scheduleId ─────────────────────────────────

router.delete(
  "/:scheduleId",
  // security(2026-04-23-med): F-ADH-4 — reject non-UUID :scheduleId up front.
  validateUuidParams(["scheduleId"]),
  // security(2026-05-04-med): issue #511 BOLA sweep — pre-gate role at the
  // mount; per-row ownership is enforced inline once we've resolved the
  // schedule's owning patient.
  authorize(Role.ADMIN, Role.DOCTOR, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scheduleId } = req.params;

      const schedule = await prisma.adherenceSchedule.findUnique({
        where: { id: scheduleId },
      });

      if (!schedule) {
        res.status(404).json({ success: false, data: null, error: "Schedule not found" });
        return;
      }

      // security(2026-05-04-med): issue #511 — use the canonical
      // `assertPatientOwnsResource` helper. Schedule keys to a patientId; the
      // helper looks up patient.userId and matches against req.user.userId
      // for PATIENT callers (staff pass through unconditionally).
      if (!(await assertPatientOwnsResource(req, res, schedule.patientId))) return;

      const updated = await prisma.adherenceSchedule.update({
        where: { id: scheduleId },
        data: { active: false },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/v1/ai/adherence/:scheduleId/doses ─────────────────────────────
//
// Body: { medicationName, scheduledAt, takenAt?, skipped?, note? }
// Writes a single dose-log row. The patient who owns the schedule (or an
// ADMIN / DOCTOR) may call this. Emits an audit event on success.

router.post(
  "/:scheduleId/doses",
  // security(2026-04-23-med): F-ADH-4 — reject non-UUID :scheduleId up front.
  validateUuidParams(["scheduleId"]),
  // security(2026-05-04-med): issue #511 — pre-gate role at the mount; the
  // schedule's owning patient is verified inline via authorizeScheduleAccess.
  authorize(Role.ADMIN, Role.DOCTOR, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scheduleId } = req.params;
      const { medicationName, scheduledAt, takenAt, skipped, note } =
        (req.body ?? {}) as {
          medicationName?: string;
          scheduledAt?: string;
          takenAt?: string | null;
          skipped?: boolean;
          note?: string;
        };

      if (!medicationName || typeof medicationName !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "medicationName is required",
        });
        return;
      }

      if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
        res.status(400).json({
          success: false,
          data: null,
          error: "scheduledAt must be a valid ISO date-time",
        });
        return;
      }

      if (takenAt && Number.isNaN(Date.parse(takenAt))) {
        res.status(400).json({
          success: false,
          data: null,
          error: "takenAt must be a valid ISO date-time",
        });
        return;
      }

      const authResult = await authorizeScheduleAccess(req, res, scheduleId);
      if (!authResult.ok) {
        if (!authResult.handled) {
          res.status(authResult.status).json({
            success: false,
            data: null,
            error: authResult.message,
          });
        }
        return;
      }
      const { schedule } = authResult;

      const isSkipped = !!skipped;
      const takenAtDate = takenAt ? new Date(takenAt) : isSkipped ? null : new Date();

      const created = await prisma.adherenceDoseLog.create({
        data: {
          scheduleId: schedule.id,
          patientId: schedule.patientId,
          medicationName,
          scheduledAt: new Date(scheduledAt),
          takenAt: takenAtDate,
          skipped: isSkipped,
          note: typeof note === "string" && note.length > 0 ? note : null,
        },
      });

      await auditLog(
        req,
        isSkipped ? "ADHERENCE_DOSE_SKIPPED" : "ADHERENCE_DOSE_TAKEN",
        "AdherenceDoseLog",
        created.id,
        {
          scheduleId: schedule.id,
          patientId: schedule.patientId,
          medicationName,
          scheduledAt,
        }
      );

      const status = isSkipped ? "SKIPPED" : "TAKEN";
      res.status(201).json({
        success: true,
        data: {
          id: created.id,
          scheduledAt: created.scheduledAt,
          takenAt: created.takenAt,
          status,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/adherence/:scheduleId/doses ──────────────────────────────
//
// Query: ?from=ISO&to=ISO
// Defaults to the last 30 days ending now. Sorted scheduledAt DESC.

router.get(
  "/:scheduleId/doses",
  // security(2026-04-23-med): F-ADH-4 — reject non-UUID :scheduleId up front.
  validateUuidParams(["scheduleId"]),
  // security(2026-05-04-med): issue #511 — pre-gate role at the mount; the
  // schedule's owning patient is verified inline via authorizeScheduleAccess.
  authorize(Role.ADMIN, Role.DOCTOR, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scheduleId } = req.params;
      const { from, to } = req.query as { from?: string; to?: string };

      const authResult = await authorizeScheduleAccess(req, res, scheduleId);
      if (!authResult.ok) {
        if (!authResult.handled) {
          res.status(authResult.status).json({
            success: false,
            data: null,
            error: authResult.message,
          });
        }
        return;
      }

      const now = new Date();
      const defaultFrom = new Date(now);
      defaultFrom.setDate(defaultFrom.getDate() - 30);

      const fromDate =
        from && !Number.isNaN(Date.parse(from)) ? new Date(from) : defaultFrom;
      const toDate =
        to && !Number.isNaN(Date.parse(to)) ? new Date(to) : now;

      const logs = await prisma.adherenceDoseLog.findMany({
        where: {
          scheduleId,
          scheduledAt: { gte: fromDate, lte: toDate },
        },
        orderBy: { scheduledAt: "desc" },
      });

      safeAudit(req, "AI_ADHERENCE_DOSE_LOG_READ", "AdherenceDoseLog", undefined, {
        scheduleId,
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
        resultCount: logs.length,
      });

      res.json({ success: true, data: logs, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export const aiAdherenceRouter = router;
