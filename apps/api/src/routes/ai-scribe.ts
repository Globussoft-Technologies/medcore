import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  startScribeSessionSchema,
  addTranscriptChunkSchema,
  scribeSignOffSchema,
  NotificationType,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import { requireFeature } from "../middleware/feature-flag";
import { generateSOAPNote, translateText } from "../services/ai/sarvam";
import { checkDrugSafety } from "../services/ai/drug-interactions";
import { auditLog } from "../middleware/audit";
import { sendNotification } from "../services/notification";
import { ingestConsultation, fireAndForgetIngest } from "../services/ai/rag-ingest";

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

/** Convert a stored soapFinal JSON blob to the plain-text notes string the
 *  previous-consultation UI panel expects. Mirrors soapToPlainText on the frontend. */
function soapFinalToNotes(soapFinal: unknown): string {
  if (!soapFinal || typeof soapFinal !== "object") return "";
  const soap = soapFinal as Record<string, any>;
  const parts: string[] = [];
  const s = soap.subjective;
  if (s) {
    if (s.chiefComplaint) parts.push(`Chief Complaint: ${s.chiefComplaint}`);
    if (s.hpi) parts.push(`HPI: ${s.hpi}`);
    if (s.pastMedicalHistory) parts.push(`PMH: ${s.pastMedicalHistory}`);
    if (s.medications?.length) parts.push(`Medications: ${(s.medications as string[]).join(", ")}`);
    if (s.allergies?.length) parts.push(`Allergies: ${(s.allergies as string[]).join(", ")}`);
  }
  const o = soap.objective;
  if (o) {
    if (o.vitals) parts.push(`Vitals: ${o.vitals}`);
    if (o.examinationFindings) parts.push(`Examination: ${o.examinationFindings}`);
  }
  const a = soap.assessment;
  if (a) {
    if (a.impression) parts.push(`Assessment: ${a.impression}`);
    if (a.icd10Codes?.length)
      parts.push(`ICD-10: ${(a.icd10Codes as any[]).map((c) => `${c.code} (${c.description})`).join(", ")}`);
  }
  const p = soap.plan;
  if (p) {
    if (p.medications?.length)
      parts.push(`Plan Meds: ${(p.medications as any[]).map((m) => `${m.name} ${m.dose} ${m.frequency} ${m.duration}`).join(", ")}`);
    if (p.investigations?.length) parts.push(`Investigations: ${(p.investigations as string[]).join(", ")}`);
    if (p.followUpTimeline) parts.push(`Follow-up: ${p.followUpTimeline}`);
    if (p.patientInstructions) parts.push(`Instructions: ${p.patientInstructions}`);
  }
  return parts.join("\n");
}

const router = Router();
router.use(authenticate);

// A SOAP draft is "empty" when the model returned the no-complaint placeholder
// (or nothing meaningful) — chief complaint blank/placeholder and no HPI,
// impression, ICD-10 codes or medications. Used to (a) avoid wiping a good
// draft with an empty regen, and (b) trigger a one-shot retry.
function isEmptySoapDraft(s: any): boolean {
  if (!s || typeof s !== "object") return true;
  const cc = String(s.subjective?.chiefComplaint ?? "").trim().toLowerCase();
  const ccEmpty = cc === "" || cc === "no clinical complaint stated yet";
  const hpi = String(s.subjective?.hpi ?? "").trim();
  const impression = String(s.assessment?.impression ?? "").trim();
  const icd = Array.isArray(s.assessment?.icd10Codes)
    ? s.assessment.icd10Codes.length
    : 0;
  const meds = Array.isArray(s.plan?.medications) ? s.plan.medications.length : 0;
  return ccEmpty && !hpi && !impression && icd === 0 && meds === 0;
}
// Pearl §6 + §18 (gap item #9 — audit fix-up #3, 2026-05-25): Voice-Rx
// (AI scribe + ASR + SOAP drafting) is a Stage-2 paid feature. Pearl-branded
// tenants set `voiceRx=false` and every scribe route 404s before authorize.
router.use(requireFeature("voiceRx"));
// #511 audit (file-level, 2026-05-09): every staff handler applies
// `authorize(Role.DOCTOR, Role.ADMIN)` (or DOCTOR-only for /finalize) — PATIENT
// excluded from list / start / transcript / soap / drafts / previous-consultation
// / speaker-tag / finalize. The DELETE /:sessionId consent-withdraw endpoint
// has no router-level role gate (intentional — patients must be able to
// withdraw consent on their own session) and instead loads the session row
// then runs `assertPatientOwnsResource` against `session.patientId` to scope
// PATIENT callers to their own session; staff pass through. Verified-safe.

// GET /api/v1/ai/scribe — list scribe sessions for the EntityPicker
//
// Issue #100: the AI Letters page picks a scribe session via
// `<EntityPicker endpoint="/ai/scribe" />`. There was no list endpoint
// — the picker hit a 404 and the page was permanently stuck on
// "Searching…" / "No matches", so no letter could ever be generated.
//
// Returns finalised sessions (soapFinal != null) preferentially, since
// only those can drive a referral letter, but accepts any status when
// the client asks for `?status=`. Response envelope matches the rest
// of the API: `{ success, data, error }`.
router.get(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const search = (req.query.search as string | undefined)?.trim();
      const limitRaw = parseInt((req.query.limit as string) ?? "20", 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(limitRaw, 100))
        : 20;
      const status = req.query.status as string | undefined;

      const where: Record<string, unknown> = {};
      if (status) {
        where.status = status.includes(",")
          ? { in: status.split(",").map((s) => s.trim()).filter(Boolean) }
          : status;
      } else {
        // Letters need a finalised SOAP, so default to COMPLETED.
        where.status = "COMPLETED";
      }
      if (search) {
        // Search by id prefix or by patient name through the appointment.
        where.OR = [
          { id: { startsWith: search } },
          {
            appointment: {
              patient: { user: { name: { contains: search, mode: "insensitive" } } },
            },
          },
        ];
      }

      const sessions = await prisma.aIScribeSession.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          appointment: {
            include: {
              patient: { include: { user: { select: { name: true } } } },
            },
          },
        },
      });

      // Lift the patient summary onto the row so the EntityPicker's
      // `labelField="patient.user.name"` resolves without an extra hop.
      const data = sessions.map((s: any) => ({
        id: s.id,
        status: s.status,
        appointmentId: s.appointmentId,
        createdAt: s.createdAt,
        patient: s.appointment?.patient
          ? {
              id: s.appointment.patient.id,
              user: { name: s.appointment.patient.user?.name ?? null },
            }
          : null,
      }));

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/scribe/start — start a scribe session (doctor only)
router.post(
  "/start",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(startScribeSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId, audioRetentionDays } = req.body;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          patient: {
            include: {
              allergies: { select: { allergen: true } },
              chronicConditions: { select: { condition: true } },
            },
          },
          doctor: true,
        },
      });

      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      // Ensure caller is the attending doctor (or admin)
      if (req.user?.role === Role.DOCTOR) {
        const doctor = await prisma.doctor.findFirst({ where: { userId: req.user.userId } });
        if (doctor?.id !== appointment.doctorId) {
          res.status(403).json({ success: false, data: null, error: "Not the attending doctor" });
          return;
        }
      }

      // Prevent duplicate sessions
      const existing = await prisma.aIScribeSession.findUnique({ where: { appointmentId } });

     if (existing) {
        if (existing.status === "ACTIVE" || existing.status === "PAUSED") {
          res.json({ success: true, data: { sessionId: existing.id, resumed: true }, error: null });
          return;
        }
        if (existing.status === "COMPLETED") {
          res.json({ success: true, data: { sessionId: existing.id, completed: true }, error: null });
          return;
        }
        // CONSENT_WITHDRAWN — patient re-consenting; delete stale session and start fresh
        await prisma.aIScribeSession.delete({ where: { appointmentId } });
      }

      const retainUntil = audioRetentionDays > 0
        ? new Date(Date.now() + audioRetentionDays * 86400000)
        : null;

      const session = await prisma.aIScribeSession.create({
        data: {
          appointmentId,
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          consentObtained: req.body.consentObtained,
          consentAt: new Date(),
          audioRetainUntil: retainUntil,
          modelVersion: "claude-sonnet-4-6",
        },
      });

      await auditLog(req, "AI_SCRIBE_SESSION_START", "AIScribeSession", session.id, { appointmentId, audioRetentionDays });

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          patientContext: {
            allergies: appointment.patient.allergies.map((a: any) => a.allergen),
            chronicConditions: appointment.patient.chronicConditions.map((c: any) => c.condition),
            // PRD §4.5.5: surface the patient's preferred language so the web
            // UI can show a "Sending summary in: <language>" badge before the
            // doctor signs off.
            preferredLanguage: appointment.patient.preferredLanguage ?? null,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/scribe/:sessionId/transcript — add transcript chunks
router.post(
  "/:sessionId/transcript",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(addTranscriptChunkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { entries, forceRegen, asrEngine } = req.body;
      // The ASR engine the doctor picked selects the LLM provider for the SOAP
      // draft: Browser STT → OpenAI, Sarvam ASR → Sarvam. Undefined leaves the
      // server's AI_PROVIDER default in force.
      const llmProvider: "openai" | "sarvam" | undefined =
        asrEngine === "browser" ? "openai" : asrEngine === "sarvam" ? "sarvam" : undefined;
      // eslint-disable-next-line no-console
      console.log(
        `[SCRIBE-DBG] /transcript recv session=${sessionId} newEntries=${Array.isArray(entries) ? entries.length : "n/a"} asrEngine=${asrEngine ?? "(none)"} llmProvider=${llmProvider ?? "(default)"} forceRegen=${!!forceRegen}`,
      );

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (session.status === "CONSENT_WITHDRAWN") {
        res.status(400).json({ success: false, data: null, error: "Session consent has been withdrawn" });
        return;
      }

      // Doctor continued recording on a paused or completed session — reactivate it.
      if (session.status !== "ACTIVE") {
        await prisma.aIScribeSession.update({ where: { id: sessionId }, data: { status: "ACTIVE" } });
      }

      const existingTranscript = (session.transcript as any[]) || [];
      const updatedTranscript = [...existingTranscript, ...entries];

      // Regenerate SOAP draft every time transcript is updated
      // Fetch patient context for drug interaction checks
      const appointment = await prisma.appointment.findUnique({
        where: { id: session.appointmentId },
        include: {
          patient: {
            include: {
              allergies: { select: { allergen: true } },
              chronicConditions: { select: { condition: true } },
              prescriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { items: { select: { medicineName: true } } },
              },
            },
          },
        },
      });

      const patientContext = {
        allergies: appointment?.patient.allergies.map((a: any) => a.allergen) || [],
        currentMedications:
          appointment?.patient.prescriptions[0]?.items.map((i: any) => i.medicineName) || [],
        chronicConditions: appointment?.patient.chronicConditions.map((c: any) => c.condition) || [],
        age: appointment?.patient.age ?? undefined,
        gender: appointment?.patient.gender ?? undefined,
      };

      let soapDraft: any = session.soapDraft;
      let rxSafetyReport = (session.rxDraft as any) || null;
      // Surface a generation failure to the client (otherwise it's only in the
      // server log and the doctor just sees a blank, never-updating draft).
      let soapError: string | null = null;
      // [SCRIBE-DBG] time the SOAP generation so the browser can see it.
      let soapGenMs: number | null = null;

      // GAP-S8: Time-based SOAP flush. PRD §4.8 wants 30–60s freshness, not
      // per-utterance regeneration. Keep the updatedTranscript.length >= 3
      // minimum gate so very short sessions don't burn tokens, but otherwise
      // regenerate only when either:
      //   (a) 5+ new entries have arrived since the last regen, or
      //   (b) 30s+ has elapsed since the last regen.
      // First regen (no prior `_meta.lastRegenAt`) always fires so the initial
      // draft is produced immediately after 3+ entries — this matches the
      // existing integration-test expectation.
      // NOTE: we can't persist `lastRegenAt` on AIScribeSession without a
      // schema change (see .prisma-models-triage-scribe.md), so we stash it
      // inside soapDraft._meta until the dedicated column lands.
      const prevMeta = (soapDraft && typeof soapDraft === "object" && (soapDraft as any)._meta) || null;
      const lastRegenAtStr: string | null = prevMeta?.lastRegenAt ?? null;
      const lastRegenAt = lastRegenAtStr ? new Date(lastRegenAtStr).getTime() : null;
      const entriesAtLastRegen: number = typeof prevMeta?.entriesAtLastRegen === "number"
        ? prevMeta.entriesAtLastRegen
        : 0;
      const now = Date.now();
      const newEntriesSinceLastRegen = updatedTranscript.length - entriesAtLastRegen;
      const timeSinceLastRegenMs = lastRegenAt != null ? now - lastRegenAt : Number.POSITIVE_INFINITY;

      // Generate from the very first entry (was 3) so the draft appears within
      // seconds of the first spoken sentence, and refresh on every new entry so
      // a quickly-spoken second utterance/condition isn't stuck behind a timer.
      const minEntries = 1;
      const shouldRegen = updatedTranscript.length >= minEntries && (
        forceRegen === true
          || lastRegenAt == null
          || newEntriesSinceLastRegen >= 1
          || timeSinceLastRegenMs >= 10_000
      );

      if (shouldRegen) {
        const _genStart = Date.now();
        try {
          // Medication stability: pass the medicines already in the current
          // draft so the model PRESERVES them and only APPENDS new ones for
          // newly-mentioned symptoms — existing prescriptions must stay stable
          // as the transcript grows. verifyHallucinations:false keeps the live
          // draft to a single fast model call (the prompt already grounds it,
          // and the doctor still reviews + signs off before any EHR commit).
          const existingMedications = Array.isArray((soapDraft as any)?.plan?.medications)
            ? (soapDraft as any).plan.medications
            : [];
          // NOTE: we deliberately do NOT anchor the complaints. The full
          // transcript is sent every regen and SCRIBE_SYSTEM already says
          // "capture EVERY complaint", so the note re-derives all complaints
          // freely and the draft UPDATES as new exchanges arrive. (An earlier
          // "keep these complaints unchanged" instruction froze the draft on
          // the first complaint and stopped the UI updating.)
          // Provider stays tied to the chosen ASR engine — Browser STT → OpenAI,
          // Sarvam ASR → Sarvam. No cross-engine fallback: the two are kept
          // separate. If the chosen provider fails, soapError surfaces why.
          let fresh: any = await generateSOAPNote(updatedTranscript, patientContext, {
            provider: llmProvider,
            verifyHallucinations: false,
            existingMedications,
          });
          // Retry-on-empty: the model intermittently returns the no-complaint
          // placeholder for a transcript that clearly has content (e.g. a
          // truncated reasoning chain). When we got nothing useful, resend the
          // SAME transcript once more before giving up so a missed exchange
          // still produces a draft.
          if (isEmptySoapDraft(fresh)) {
            try {
              const retry: any = await generateSOAPNote(
                updatedTranscript,
                patientContext,
                {
                  provider: llmProvider,
                  verifyHallucinations: false,
                  existingMedications,
                },
              );
              if (!isEmptySoapDraft(retry)) fresh = retry;
            } catch (retryErr) {
              console.error(
                "[ai-scribe] SOAP retry failed:",
                retryErr instanceof Error ? retryErr.message : retryErr,
              );
            }
          }
          if (fresh && typeof fresh === "object") {
            // Guard against a regen that comes back EMPTY (the model
            // intermittently returns the "No clinical complaint stated yet"
            // placeholder for a transcript that clearly has complaints). When
            // that happens but we already have a non-empty draft, KEEP the
            // good draft instead of wiping it back to "Not captured" — only
            // bump the regen metadata. Otherwise adopt the fresh draft.
            const keepPrior = isEmptySoapDraft(fresh) && !isEmptySoapDraft(soapDraft);
            soapDraft = {
              ...(keepPrior ? (soapDraft as any) : fresh),
              _meta: {
                ...(prevMeta ?? {}),
                lastRegenAt: new Date(now).toISOString(),
                entriesAtLastRegen: updatedTranscript.length,
              },
            };
          } else {
            soapDraft = fresh;
          }
        }catch (soapErr) {
          soapError = soapErr instanceof Error ? soapErr.message : String(soapErr);
          console.error("[ai-scribe] generateSOAPNote failed:", soapError);
        }
        soapGenMs = Date.now() - _genStart;

        // Run drug safety checks whenever we have a fresh SOAP draft with medications
        const proposedMeds = (soapDraft as any)?.plan?.medications ?? [];
        if (proposedMeds.length > 0) {
          try {
            // Perf: deterministic-only on live drafts (skip the Layer-2 LLM
            // interaction pass) so the SOAP response isn't gated on a second
            // model round-trip. Allergy / known-interaction / contraindication
            // / dosing checks still run instantly.
            rxSafetyReport = await checkDrugSafety(
              proposedMeds,
              patientContext.currentMedications,
              patientContext.allergies,
              patientContext.chronicConditions,
              { age: patientContext.age, gender: patientContext.gender },
              { skipLLM: true }
            );
          } catch {
            // Non-fatal — continue without safety report
          }
        } else {
          // The fresh draft has no medications — clear any stale safety report
          // from a previous regen so we never show an alert for a drug that is
          // no longer in the plan.
          rxSafetyReport = null;
        }
      }

      await prisma.aIScribeSession.update({
        where: { id: sessionId },
        data: {
          transcript: updatedTranscript as any,
          soapDraft: soapDraft as any,
          rxDraft: rxSafetyReport as any,
        },
      });

      res.json({
        success: true,
        data: {
          transcriptLength: updatedTranscript.length,
          soapDraftUpdated: !!soapDraft,
          soapDraft,
          rxSafetyReport,
          soapError,
          // [SCRIBE-DBG] pipeline diagnostics surfaced to the BROWSER console
          // (the frontend logs `_debug`). Metadata only — no PHI. This is how
          // "all logs show in browser" without SSHing for pm2 logs.
          _debug: {
            sessionId,
            newEntries: Array.isArray(entries) ? entries.length : 0,
            totalTranscript: updatedTranscript.length,
            asrEngine: asrEngine ?? null,
            llmProvider: llmProvider ?? "(server-default)",
            shouldRegen,
            regenReason: !shouldRegen
              ? "throttled"
              : forceRegen
                ? "forceRegen"
                : lastRegenAt == null
                  ? "first-draft"
                  : newEntriesSinceLastRegen >= 1
                    ? "new-entries"
                    : "time-elapsed",
            soapGenMs,
            soapParsed: !!soapDraft && !soapError,
            soapError,
            rxAlerts: rxSafetyReport?.alerts?.length ?? 0,
            serverAt: new Date(now).toISOString(),
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/scribe/:sessionId/soap — get current SOAP draft
router.get(
  "/:sessionId/soap",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.aIScribeSession.findUnique({
        where: { id: req.params.sessionId },
        select: {
          id: true,
          status: true,
          soapDraft: true,
          soapFinal: true,
          icd10Codes: true,
          rxDraft: true,
          transcript: true,
          signedOffAt: true,
          signedOffBy: true,
        },
      });

      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      safeAudit(req, "AI_SCRIBE_READ", "AIScribeSession", session.id, {
        status: session.status,
        hasSoapFinal: !!session.soapFinal,
      });

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/scribe/:sessionId/finalize — doctor signs off
router.post(
  "/:sessionId/finalize",
  authorize(Role.DOCTOR),
  validate(scribeSignOffSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { soapFinal, icd10Codes, rxApproved, doctorEdits } = req.body;

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const doctor = await prisma.doctor.findFirst({ where: { userId: req.user!.userId } });
      if (doctor?.id !== session.doctorId) {
        res.status(403).json({ success: false, data: null, error: "Not the attending doctor" });
        return;
      }

      // Compute diff between AI draft and doctor's final version
      let computedEdits: { section: string; field: string; from: unknown; to: unknown }[] = [];
      if (session.soapDraft && soapFinal) {
        const draft = session.soapDraft as Record<string, any>;
        const final = soapFinal as Record<string, any>;
        for (const section of ["subjective", "objective", "assessment", "plan"] as const) {
          if (!draft[section] || !final[section]) continue;
          for (const field of Object.keys(final[section])) {
            const fromVal = draft[section]?.[field];
            const toVal = final[section]?.[field];
            if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
              computedEdits.push({ section, field, from: fromVal ?? null, to: toVal });
            }
          }
        }
      }

      const finalSession = await prisma.aIScribeSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          soapFinal: soapFinal as any,
          icd10Codes: icd10Codes as any,
          doctorEdits: computedEdits as any,
          signedOffAt: new Date(),
          signedOffBy: req.user!.userId,
        },
      });

      // Write SOAP note to EHR (consultation record)
      let consultationIdForIngest: string | null = null;
      if (soapFinal) {
        const existingConsultation = await prisma.consultation.findUnique({
          where: { appointmentId: session.appointmentId },
        });

        const notes = `[AI Scribe — Doctor Approved]\n\nSubjective: ${JSON.stringify(soapFinal.subjective)}\n\nObjective: ${JSON.stringify(soapFinal.objective)}\n\nAssessment: ${soapFinal.assessment?.impression}\n\nPlan: ${JSON.stringify(soapFinal.plan)}`;

        if (existingConsultation) {
          const updated = await prisma.consultation.update({
            where: { appointmentId: session.appointmentId },
            data: { notes },
          });
          consultationIdForIngest = updated.id;
        } else {
          const created = await prisma.consultation.create({
            data: {
              appointmentId: session.appointmentId,
              doctorId: session.doctorId,
              notes,
              findings: soapFinal.objective?.examinationFindings || "",
            },
          });
          consultationIdForIngest = created.id;
        }
      }

      // Fire-and-forget: index this consultation into the RAG knowledge base
      // so the chart-search endpoint can find it later. Non-blocking.
      if (consultationIdForIngest) {
        fireAndForgetIngest("ingestConsultation", () =>
          ingestConsultation(consultationIdForIngest as string)
        );
      }

      // Auto-create draft lab orders from SOAP plan.investigations
      const investigations: string[] = (soapFinal as any)?.plan?.investigations ?? [];
      let draftLabOrdersCount = 0;
      if (investigations.length > 0) {
        for (const testName of investigations) {
          try {
            // Check if a draft order for this test already exists for this patient/doctor
            const existingOrder = await prisma.labOrder.findFirst({
              where: {
                patientId: session.patientId,
                doctorId: session.doctorId,
                notes: `[AI Scribe Draft] ${testName}`,
                status: "ORDERED",
              },
            });
            if (!existingOrder) {
              const orderNumber = `SCRIBE-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
              await prisma.labOrder.create({
                data: {
                  orderNumber,
                  patientId: session.patientId,
                  doctorId: session.doctorId,
                  status: "ORDERED",
                  notes: `[AI Scribe Draft] ${testName}`,
                  orderedAt: new Date(),
                },
              });
              draftLabOrdersCount++;
            }
          } catch {
            // Non-fatal — continue
          }
        }
      }

      // Auto-create draft referrals from SOAP plan.referrals
      const referrals: string[] = (soapFinal as any)?.plan?.referrals ?? [];
      let draftReferralsCount = 0;
      if (referrals.length > 0) {
        for (const referralText of referrals) {
          try {
            // Parse specialty from referral text, e.g. "Refer to Cardiologist" → "Cardiologist"
            const specialty = referralText.replace(/refer\s+(to|for)\s+/i, "").trim();
            const referralNumber = `SCRIBE-REF-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
            await prisma.referral.create({
              data: {
                referralNumber,
                patientId: session.patientId,
                fromDoctorId: session.doctorId,
                specialty,
                reason: `[AI Scribe Draft] ${referralText}`,
                status: "PENDING",
              },
            });
            draftReferralsCount++;
          } catch {
            // Non-fatal — continue
          }
        }
      }

      // Notify patient with a plain-language visit summary (non-fatal).
      // PRD §4.5.5: deliver the summary in Patient.preferredLanguage when set
      // to a non-English BCP-47 code (hi, ta, te, bn, mr, kn, ml). English /
      // null / missing keeps the legacy behaviour. Translation failures fall
      // back to the English body via translateText() so patients still get
      // the notification.
      try {
        const patientRecord = await prisma.patient.findUnique({
          where: { id: session.patientId },
          select: { userId: true, preferredLanguage: true },
        });
        if (patientRecord?.userId && soapFinal) {
          const impression = (soapFinal as any)?.assessment?.impression || "your consultation";
          const followUp = (soapFinal as any)?.plan?.followUpTimeline || "";
          const instructions = (soapFinal as any)?.plan?.patientInstructions || "";
          const englishSummary = [
            `Your consultation has been completed.`,
            impression ? `Diagnosis: ${impression}.` : "",
            followUp ? `Follow-up: ${followUp}.` : "",
            instructions ? `Instructions: ${instructions}` : "",
          ].filter(Boolean).join(" ");

          const targetLang = (patientRecord.preferredLanguage || "en").trim();
          const summaryMsg =
            targetLang && targetLang !== "en"
              ? await translateText(englishSummary, targetLang)
              : englishSummary;

          await sendNotification({
            userId: patientRecord.userId,
            type: NotificationType.PRESCRIPTION_READY,
            title: "Your Visit Summary is Ready",
            message: summaryMsg,
            data: { scribeSessionId: sessionId, language: targetLang || "en" },
          });
        }
      } catch (notifyErr) {
        console.error("[AI Scribe] Patient notification failed (non-fatal):", notifyErr);
      }

      await auditLog(req, "AI_SCRIBE_SIGN_OFF", "AIScribeSession", sessionId, { rxApproved, editCount: doctorEdits?.length || 0 });

      res.json({
        success: true,
        data: {
          session: finalSession,
          draftLabOrders: draftLabOrdersCount,
          draftReferrals: draftReferralsCount,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GAP-S6: GET /api/v1/ai/scribe/:sessionId/previous-consultation
// Returns the patient's most recent completed consultation (excluding the
// current session's appointment). The web review UI uses this to render a
// side-by-side diff so the doctor can spot changes vs the last visit without
// leaving the scribe screen.
router.get(
  "/:sessionId/previous-consultation",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const session = await prisma.aIScribeSession.findUnique({
        where: { id: sessionId },
        select: { id: true, patientId: true, appointmentId: true },
      });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

     // Query both sources in parallel: signed-off scribe sessions (soapFinal)
     // and legacy manual Consultation records. Return whichever is more recent.
      const [prevScribe, prevConsultation] = await Promise.all([
        prisma.aIScribeSession.findFirst({
          where: {
            patientId: session.patientId,
            appointmentId: { not: session.appointmentId },
            status: "COMPLETED",
            NOT: [{ soapFinal: { equals: Prisma.DbNull } }],
          },

          orderBy: { signedOffAt: "desc" },
          select: {
            id: true,
            soapFinal: true,
            signedOffAt: true,
            createdAt: true,
            appointment: { select: { id: true, date: true, slotStart: true, slotEnd: true } },
          },
        }),
        prisma.consultation.findFirst({
          where: {
            appointment: { patientId: session.patientId },
            appointmentId: { not: session.appointmentId },
          },
          orderBy: { createdAt: "desc" },
          include: {
            appointment: { select: { id: true, date: true, slotStart: true, slotEnd: true } },
          },
        }),
      ]);

      // Prefer the more recent record; normalise to a common shape the UI expects.
      let previous: { id: string; notes: string | null; findings: string | null; createdAt: string; appointment?: any } | null = null;

      const scribeDate = prevScribe?.signedOffAt ?? prevScribe?.createdAt ?? null;
      const consultDate = prevConsultation?.createdAt ?? null;

      if (prevScribe && (!consultDate || (scribeDate && scribeDate >= consultDate))) {
        previous = {
          id: prevScribe.id,
          notes: soapFinalToNotes(prevScribe.soapFinal),
          findings: null,
          createdAt: (scribeDate ?? prevScribe.createdAt).toISOString(),
          appointment: prevScribe.appointment,
        };
      } else if (prevConsultation) {
        previous = {
          id: prevConsultation.id,
          notes: prevConsultation.notes,
          findings: prevConsultation.findings,
          createdAt: prevConsultation.createdAt.toISOString(),
          appointment: prevConsultation.appointment,
        };
      }
      safeAudit(req, "AI_SCRIBE_PREV_CONSULT_READ", "AIScribeSession", session.id, {
        hasPrevious: !!previous,
      });

      res.json({
        success: true,
        data: { previous },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GAP-S4: PATCH /api/v1/ai/scribe/:sessionId/transcript/:index/speaker
// Let the doctor re-assign a transcript entry to DOCTOR | PATIENT | ATTENDANT
// after the fact (our live heuristic assumes alternating speakers, which is
// often wrong in practice). Acoustic diarization is tracked as a separate
// future gap — this endpoint is the minimum useful piece to power the
// client-side dropdown tagging.
router.patch(
  "/:sessionId/transcript/:index/speaker",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId, index } = req.params;
      const { speaker } = req.body as { speaker?: string };
      if (speaker !== "DOCTOR" && speaker !== "PATIENT" && speaker !== "ATTENDANT") {
        res.status(400).json({
          success: false,
          data: null,
          error: "speaker must be DOCTOR | PATIENT | ATTENDANT",
        });
        return;
      }
      const idx = Number.parseInt(index, 10);
      if (!Number.isFinite(idx) || idx < 0) {
        res.status(400).json({ success: false, data: null, error: "invalid index" });
        return;
      }

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (session.status !== "ACTIVE") {
        res.status(400).json({ success: false, data: null, error: `Session is ${session.status}` });
        return;
      }
      const transcript = (session.transcript as any[]) || [];
      if (idx >= transcript.length) {
        res.status(404).json({ success: false, data: null, error: "transcript entry not found" });
        return;
      }
      transcript[idx] = { ...transcript[idx], speaker };

      await prisma.aIScribeSession.update({
        where: { id: sessionId },
        data: { transcript: transcript as any },
      });

      res.json({
        success: true,
        data: { transcript, updatedIndex: idx, speaker },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/scribe/:sessionId/drafts — get draft lab orders and referrals for this session
router.get(
  "/:sessionId/drafts",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const [labOrders, referrals] = await Promise.all([
        prisma.labOrder.findMany({
          where: {
            patientId: session.patientId,
            doctorId: session.doctorId,
            notes: { startsWith: "[AI Scribe Draft]" },
          },
        }),
        prisma.referral.findMany({
          where: {
            patientId: session.patientId,
            fromDoctorId: session.doctorId,
            reason: { startsWith: "[AI Scribe Draft]" },
          },
        }),
      ]);

      safeAudit(req, "AI_SCRIBE_DRAFTS_READ", "AIScribeSession", session.id, {
        labOrderCount: labOrders.length,
        referralCount: referrals.length,
      });

      res.json({ success: true, data: { labOrders, referrals }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/ai/scribe/:sessionId — withdraw consent, purge transcript
//
// security(2026-05-04, issue #511): the consent-withdraw endpoint had no
// router-level role gate AND no per-row ownership check. Any authenticated
// user (including PATIENT) could DELETE another patient's scribe session by
// guessing the UUID, wiping transcript + soapDraft and flipping status to
// CONSENT_WITHDRAWN. This is OWASP API1:2023 BOLA / CWE-285. Load the
// session first, then run `assertPatientOwnsResource` so PATIENT callers
// can only withdraw consent on their own session; staff (DOCTOR/ADMIN)
// pass through unconditionally.
router.delete(
  "/:sessionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.aIScribeSession.findUnique({
        where: { id: req.params.sessionId },
        select: { id: true, patientId: true },
      });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, session.patientId))) return;

      await prisma.aIScribeSession.update({
        where: { id: req.params.sessionId },
        data: {
          status: "CONSENT_WITHDRAWN",
          transcript: [] as any,
          // Prisma footgun: `undefined` means "skip this field"; only DbNull
          // actually writes SQL NULL on a nullable JSON column.
          soapDraft: Prisma.DbNull,
        },
      });

      await auditLog(req, "AI_SCRIBE_CONSENT_WITHDRAW", "AIScribeSession", req.params.sessionId, {});

      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiScribeRouter };
