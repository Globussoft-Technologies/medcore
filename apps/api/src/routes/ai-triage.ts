import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  startTriageSessionSchema,
  triageMessageSchema,
  bookFromTriageSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import { checkRedFlags, buildEmergencyResponse } from "../services/ai/red-flag";
import { runTriageTurn, extractSymptomSummary } from "../services/ai/sarvam";
import { auditLog } from "../middleware/audit";

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

// Specialty synonym normalisation. The triage LLM emits canonical specialty
// names (e.g. "General Physician", "Orthopedic") but a hospital's Doctor rows
// may be tagged with a clinically-equivalent variant ("General Medicine",
// "Orthopedics"). An exact `specialization IN (...)` match silently drops these,
// producing a "No doctors available" card even when a suitable doctor exists in
// the tenant. We expand each suggested specialty to its known synonyms before
// querying, and match case-insensitively.
const SPECIALTY_SYNONYMS: Record<string, string[]> = {
  "general physician": ["general physician", "general medicine", "family physician", "family medicine", "gp", "general practitioner", "internal medicine", "physician"],
  "general practitioner": ["general practitioner", "general physician", "general medicine", "family physician", "gp"],
  "cardiologist": ["cardiologist", "cardiology"],
  "pulmonologist": ["pulmonologist", "pulmonology", "chest physician", "respiratory medicine"],
  "gastroenterologist": ["gastroenterologist", "gastroenterology"],
  "neurologist": ["neurologist", "neurology"],
  "orthopedic": ["orthopedic", "orthopaedic", "orthopedics", "orthopaedics", "orthopedic surgeon"],
  "dermatologist": ["dermatologist", "dermatology", "skin specialist"],
  "ent": ["ent", "otolaryngologist", "otolaryngology", "ear nose throat"],
  "ophthalmologist": ["ophthalmologist", "ophthalmology", "eye specialist"],
  "gynecologist": ["gynecologist", "gynaecologist", "gynecology", "gynaecology", "obstetrician", "obg", "obstetrics & gynaecology"],
  "pediatrician": ["pediatrician", "paediatrician", "pediatrics", "paediatrics", "child specialist"],
  "urologist": ["urologist", "urology"],
  "endocrinologist": ["endocrinologist", "endocrinology", "diabetologist"],
  "psychiatrist": ["psychiatrist", "psychiatry"],
  "oncologist": ["oncologist", "oncology", "medical oncologist"],
  "nephrologist": ["nephrologist", "nephrology"],
  "rheumatologist": ["rheumatologist", "rheumatology"],
  "dentist": ["dentist", "dental", "dentistry"],
  "physiotherapist": ["physiotherapist", "physiotherapy", "physical therapist"],
};

/**
 * Expand a list of LLM-suggested specialty names into the full set of
 * clinically-equivalent variants (lower-cased) used for tenant-scoped doctor
 * lookup. Unknown specialties pass through as their own single-element set so
 * matching never gets narrower than the exact name.
 */
function expandSpecialties(specialties: string[]): string[] {
  const out = new Set<string>();
  for (const raw of specialties) {
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const variants = SPECIALTY_SYNONYMS[key] ?? [key];
    for (const v of variants) out.add(v);
  }
  return [...out];
}

// Lower-cased synonym set for any GP-equivalent specialty — used by the
// last-resort fallback when nothing else in the tenant matches.
const GP_SYNONYMS = SPECIALTY_SYNONYMS["general physician"];

const router = Router();
// #511 audit (file-level, 2026-05-09): no router-level `router.use(authenticate)`
// — each handler applies `authenticate` individually (and `authorize` where the
// surface is staff-restricted). Every PATIENT-reachable `:sessionId`-keyed
// handler (POST /:sessionId/message, GET /:sessionId, POST /:sessionId/book,
// POST /:sessionId/handoff, DELETE /:sessionId) loads the session row and
// runs `assertPatientOwnsResource` against `session.patientId` so a PATIENT
// cannot reach another patient's triage session. /start has no row to scope.
// BOLA gaps on /:sessionId/message and /:sessionId/handoff were closed in
// commit 2684b6d on this same audit pass. Verified-safe.

// POST /api/v1/ai/triage/start — create a new triage session (auth optional for patients)
router.post(
  "/start",
  authenticate,
  validate(startTriageSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { language, inputMode, patientId, isForDependent, dependentRelationship, consentGiven, bookingFor, dependentPatientId } = req.body;

      // Resolve patientId from JWT if patient role and not explicitly provided.
      // If the logged-in PATIENT user has no linked Patient row (e.g. their
      // profile was never completed), return a clear 400 rather than letting
      // the session proceed with a null patientId — the patient would hit a
      // confusing failure at the /book step (issue #22).
      let resolvedPatientId = patientId;
      if (!resolvedPatientId && req.user?.role === Role.PATIENT) {
        const patient = await prisma.patient.findFirst({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        if (!patient) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Please complete your patient profile before using AI-assisted booking.",
          });
          return;
        }
        resolvedPatientId = patient.id;
      }

      const greeting =
        language === "hi"
          ? "नमस्ते! मैं आपकी सही डॉक्टर तक पहुँचने में मदद करूँगा। कृपया अपनी तकलीफ बताएँ — आप कैसा महसूस कर रहे हैं?"
          : "Hello! I'm here to help you find the right doctor. Please describe what's bothering you — how are you feeling?";

      const initialMessages = [{ role: "assistant", content: greeting, timestamp: new Date().toISOString() }];

      const session = await prisma.aITriageSession.create({
        data: {
          patientId: resolvedPatientId,
          language,
          inputMode,
          messages: initialMessages as any,
          modelVersion: "claude-sonnet-4-6",
          symptoms: isForDependent ? { isForDependent, dependentRelationship } : undefined,
          bookingFor: bookingFor ?? "SELF",
          dependentPatientId: dependentPatientId ?? null,
        },
      });

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          message: greeting,
          language,
          disclaimer:
            language === "hi"
              ? "यह एक अपॉइंटमेंट बुकिंग सहायक है, न कि डायग्नोसिस टूल।"
              : "This is an appointment routing assistant, not a diagnostic tool.",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/triage/:sessionId/message — send a user message
//
// security(2026-05-09, issue #511): only `authenticate` was applied — any
// signed-in PATIENT could send messages into another patient's in-flight
// triage session, mutating its state and potentially driving its red-flag
// + suggestedSpecialties output. OWASP API1:2023 BOLA / CWE-285. Same fix
// shape as GET /:sessionId and DELETE /:sessionId in this file: load the
// session row, then run `assertPatientOwnsResource` so PATIENT callers are
// scoped to their own session; staff (DOCTOR/ADMIN) pass through.
router.post(
  "/:sessionId/message",
  authenticate,
  validate(triageMessageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { message, language: langOverride } = req.body;

      const session = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, session.patientId))) return;
      if (session.status !== "ACTIVE") {
        res.status(400).json({ success: false, data: null, error: `Session is ${session.status}` });
        return;
      }

      // 1. Deterministic red-flag check first (fast, no LLM cost)
      const redFlag = checkRedFlags(message);
      if (redFlag.detected) {
        const emergencyReply = buildEmergencyResponse(redFlag.reason!);
        await prisma.aITriageSession.update({
          where: { id: sessionId },
          data: {
            status: "EMERGENCY_DETECTED",
            redFlagDetected: true,
            redFlagReason: redFlag.reason,
            messages: [
              ...(session.messages as any[]),
              { role: "user", content: message, timestamp: new Date().toISOString() },
              { role: "assistant", content: emergencyReply, timestamp: new Date().toISOString() },
            ] as any,
          },
        });

        await auditLog(req, "AI_TRIAGE_EMERGENCY_DETECT", "AITriageSession", sessionId, { redFlagReason: redFlag.reason });

        res.json({
          success: true,
          data: {
            message: emergencyReply,
            isEmergency: true,
            emergencyReason: redFlag.reason,
            sessionStatus: "EMERGENCY_DETECTED",
          },
          error: null,
        });
        return;
      }

      // 2. Build conversation history for Claude
      const existingMessages = session.messages as { role: string; content: string }[];
      const claudeMessages: { role: "user" | "assistant"; content: string }[] = [
        ...existingMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: message },
      ];

      // 3. Run Claude turn.
      // Issue #240: any unexpected LLM error (not just the
      // AIServiceUnavailableError that `runTriageTurn` already swallows
      // — e.g. a JSON-parse failure on a malformed tool-call response)
      // would bubble up and 500 the request, breaking *every* user
      // message. Catch defensively and return a graceful fallback so
      // the chat keeps working; we still log the original error.
      const lang = langOverride || session.language;
      // In-hospital routing constraint: the patient is already inside their
      // hospital's portal, so the assistant must NEVER ask for the patient's
      // city/location, and must NEVER name external hospitals or third-party
      // booking sites (Practo, Lybrate, Apollo, AMRI, Google Maps, etc). It
      // routes only to doctors available within this hospital — the suggestion
      // cards are populated from the tenant's own (already tenant-scoped)
      // doctor roster. See issue: AI booking asking for location.
      const IN_HOSPITAL_SUFFIX =
        lang === "hi"
          ? "महत्वपूर्ण: मरीज़ पहले से ही अपने अस्पताल के पोर्टल में लॉग-इन है। उनसे उनका शहर, क्षेत्र या स्थान कभी न पूछें। किसी बाहरी अस्पताल, क्लिनिक या वेबसाइट (जैसे Practo, Lybrate, Apollo, AMRI, Google) का नाम न लें। केवल लक्षणों के आधार पर सही विशेषज्ञता (specialty) सुझाएँ — डॉक्टर की सूची इसी अस्पताल से अपने आप दिखाई जाएगी।"
          : "IMPORTANT: The patient is ALREADY logged in to their own hospital's portal. NEVER ask the patient for their city, area, or location. NEVER name or suggest any external hospital, clinic, or third-party booking website (e.g. Practo, Lybrate, Apollo, AMRI, Fortis, Google Maps) — you route ONLY to doctors within this hospital. Based on the symptoms, just recommend the right medical specialty; the matching in-hospital doctors are surfaced automatically as suggestion cards. Do not tell the patient to search elsewhere.";
      let reply = "";
      let isEmergency = false;
      let emergencyReason: string | undefined;
      try {
        const turn = await runTriageTurn(claudeMessages, lang, IN_HOSPITAL_SUFFIX);
        reply = turn.reply;
        isEmergency = turn.isEmergency;
        emergencyReason = turn.emergencyReason;
      } catch (turnErr) {
        console.error(
          "[ai-triage] runTriageTurn failed — returning graceful fallback:",
          (turnErr as Error)?.message ?? turnErr
        );
        reply =
          lang === "hi"
            ? "क्षमा करें, मैं अभी जवाब नहीं दे पा रहा। कृपया कुछ देर बाद पुनः प्रयास करें या रिसेप्शन से बात करें।"
            : "I'm sorry, I couldn't process that just now. Please try again in a moment or tap 'Talk to a person' to continue with reception.";
      }

      if (isEmergency) {
        const emergencyReply = buildEmergencyResponse(emergencyReason!);
        await prisma.aITriageSession.update({
          where: { id: sessionId },
          data: {
            status: "EMERGENCY_DETECTED",
            redFlagDetected: true,
            redFlagReason: emergencyReason,
            messages: [
              ...(session.messages as any[]),
              { role: "user", content: message, timestamp: new Date().toISOString() },
              { role: "assistant", content: emergencyReply, timestamp: new Date().toISOString() },
            ] as any,
          },
        });

        res.json({
          success: true,
          data: {
            message: emergencyReply,
            isEmergency: true,
            emergencyReason,
            sessionStatus: "EMERGENCY_DETECTED",
          },
          error: null,
        });
        return;
      }

      // 4. Count user turns — if 5+ turns, extract summary and suggest doctors
      const userTurnCount = existingMessages.filter((m) => m.role === "user").length + 1;
      const skipCount = existingMessages.filter((m) => m.role === "user" && m.content === "[SKIPPED]").length
        + (message === "[SKIPPED]" ? 1 : 0);
      const updatedMessages = [
        ...(session.messages as any[]),
        {
          role: "user",
          content: message,
          timestamp: new Date().toISOString(),
          ...(message === "[SKIPPED]" ? { displayAs: "Skipped" } : {}),
        },
        { role: "assistant", content: reply, timestamp: new Date().toISOString() },
      ];

      let suggestedSpecialties = null;
      let confidence = null;
      let symptoms = session.symptoms;

      if (userTurnCount >= 4) {
        try {
          const summary = await extractSymptomSummary(
            claudeMessages.concat([{ role: "assistant", content: reply }])
          );
          // Reduce confidence by 0.1 per skip, floor at 0.1
          if (skipCount > 0) {
            summary.confidence = Math.max(0.1, summary.confidence - 0.1 * skipCount);
          }

          // GAP-T8: GP fallback on low confidence OR thin specialty pool.
          // extractSymptomSummary may already prepend GP on low confidence;
          // dedup and additionally check the live doctor pool so the patient
          // starts with a GP when the suggested specialty is sparsely staffed.
          const specialtiesFromSummary = summary.specialties || [];
          const hasGP = (list: any[]) =>
            list.some(
              (s) => typeof s?.specialty === "string"
                && (s.specialty.toLowerCase().includes("general physician")
                  || s.specialty.toLowerCase().includes("general practitioner")),
            );
          const gpEntry = {
            specialty: "General Physician",
            subSpecialty: null,
            confidence: 0.9,
            reasoning:
              "Starting with a General Physician given the complexity/uncertainty of your symptoms.",
            isGPFallback: true,
          };

          let candidateSpecialties: any[] = [...specialtiesFromSummary];
          if (summary.confidence < 0.5 && !hasGP(candidateSpecialties)) {
            candidateSpecialties = [gpEntry, ...candidateSpecialties];
          }

          // "Fewer than 2 matching doctors" check — even with high confidence
          // if the suggested specialty is thinly staffed the patient should
          // start with a GP who can triage and refer onward.
          const topSpecialty = candidateSpecialties.find(
            (s) => !s.isGPFallback,
          )?.specialty;
          if (topSpecialty && !hasGP(candidateSpecialties)) {
            try {
              // Count via the same synonym-expanded, case-insensitive match the
              // GET handler uses, so "General Medicine" counts toward a suggested
              // "General Physician" instead of reading 0 and over-triggering the
              // GP prepend.
              const wantedTop = new Set(expandSpecialties([topSpecialty]));
              const activeForCount = await prisma.doctor.findMany({
                where: { user: { isActive: true } },
                select: { specialization: true },
              });
              const matchingCount = activeForCount.filter(
                (d) => !!d.specialization && wantedTop.has(d.specialization.trim().toLowerCase()),
              ).length;
              if (matchingCount < 2) {
                candidateSpecialties = [gpEntry, ...candidateSpecialties];
              }
            } catch {
              // Non-fatal — skip the doctor-count fallback if DB lookup fails.
            }
          }

          suggestedSpecialties = candidateSpecialties as any;
          confidence = summary.confidence;
          symptoms = summary as any;
        } catch {
          // Non-fatal — triage continues without summary
        }
      }

      await prisma.aITriageSession.update({
        where: { id: sessionId },
        data: {
          messages: updatedMessages as any,
          symptoms: symptoms as any,
          suggestedSpecialties: suggestedSpecialties as any,
          confidence,
          chiefComplaint: (symptoms as any)?.chiefComplaint || session.chiefComplaint,
        },
      });

      res.json({
        success: true,
        data: {
          message: reply,
          isEmergency: false,
          turnCount: userTurnCount,
          readyForDoctorSuggestion: userTurnCount >= 4 && !!suggestedSpecialties,
          suggestedSpecialties,
          confidence,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/triage/:sessionId — get session state + doctor suggestions
//
// security(2026-05-04, issue #511): only `authenticate` was applied — any
// signed-in user could fetch another patient's triage session (chief
// complaint, symptom JSON, suggested specialties) by UUID. OWASP API1:2023
// BOLA / CWE-285. After loading the row we now run
// `assertPatientOwnsResource` so PATIENT callers can only see their own
// session; staff roles pass through.
router.get(
  "/:sessionId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.aITriageSession.findUnique({
        where: { id: req.params.sessionId },
      });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, session.patientId))) return;

      // Fetch doctor suggestions if specialties are available
      let doctorSuggestions: any[] = [];
      if (session.suggestedSpecialties) {
        const specialties = (session.suggestedSpecialties as any[]).map((s: any) => s.specialty);
        // Expand the suggested specialties to their clinical synonyms and match
        // case-insensitively. Prisma's `in` is case-sensitive and would miss
        // "General Medicine" for a suggested "General Physician", so we pull the
        // tenant's active doctors (the client is already tenant-scoped) and
        // filter in JS against the expanded synonym set.
        const wanted = new Set(expandSpecialties(specialties));
        const activeDoctors = await prisma.doctor.findMany({
          where: { user: { isActive: true } },
          include: {
            user: { select: { id: true, name: true, photoUrl: true, preferredLanguage: true } },
            schedules: true,
          },
        });
        const matches = (spec: string | null | undefined) =>
          !!spec && wanted.has(spec.trim().toLowerCase());

        let doctors = activeDoctors.filter((d) => matches(d.specialization)).slice(0, 6);

        // GP fallback: if no doctor in this hospital matches the suggested
        // specialty, surface any General-Physician-equivalent doctor in the
        // tenant so the patient still gets a starting point instead of an empty
        // list. Tagged isGPFallback below so the UI can badge it.
        let isFallbackPool = false;
        if (doctors.length === 0) {
          const gpSet = new Set(GP_SYNONYMS);
          const gpDoctors = activeDoctors.filter(
            (d) => !!d.specialization && gpSet.has(d.specialization.trim().toLowerCase()),
          );
          if (gpDoctors.length > 0) {
            doctors = gpDoctors.slice(0, 6);
            isFallbackPool = true;
          }
        }

        doctorSuggestions = doctors.map((d) => {
          // Match the suggestion metadata case-insensitively too, so the
          // reasoning/confidence from the LLM still attaches to a doctor whose
          // specialization is a synonym (not a byte-for-byte match).
          const specialty = (session.suggestedSpecialties as any[]).find(
            (s: any) => typeof s?.specialty === "string"
              && s.specialty.trim().toLowerCase() === (d.specialization ?? "").trim().toLowerCase()
          ) ?? (session.suggestedSpecialties as any[])[0];
          return {
            doctorId: d.id,
            name: d.user.name,
            specialty: d.specialization,
            subSpecialty: d.subSpecialty || null,
            qualification: d.qualification,
            photoUrl: d.user.photoUrl,
            experienceYears: d.experienceYears ?? null,
            languages: d.languages ?? [],
            rating: d.averageRating ? Number(d.averageRating) : null,
            consultationFee: d.consultationFee ? Number(d.consultationFee) : null,
            consultationMode: "in-person",          // default; extend later
            // Surface the doctor's booking mode (TOKEN / SLOT / CALLING) so the
            // AI-booking cards can badge it and the booking step picks the right
            // shape. All three modes are suggested — no mode is filtered out.
            appointmentMode: d.appointmentMode,
            reasoning: specialty?.reasoning || `Specialist in ${d.specialization}`,
            confidence: specialty?.confidence || 0.7,
            // GAP-T8: flag GP cards so the UI can surface a "GP recommended
            // first" badge when Claude's confidence was low or the suggested
            // specialty pool is thin. Also flagged when this card came from the
            // tenant-wide GP fallback pool (no exact-specialty doctor existed).
            isGPFallback: !!specialty?.isGPFallback || isFallbackPool,
          };
        });
        // Ensure GP-fallback cards appear first so patients see them prominently.
        doctorSuggestions.sort((a, b) =>
          (b.isGPFallback ? 1 : 0) - (a.isGPFallback ? 1 : 0)
        );
      }

      safeAudit(req, "AI_TRIAGE_SESSION_READ", "AITriageSession", session.id, {
        status: session.status,
        suggestionCount: doctorSuggestions.length,
      });

      res.json({
        success: true,
        data: {
          session: {
            id: session.id,
            status: session.status,
            language: session.language,
            messages: session.messages,
            redFlagDetected: session.redFlagDetected,
            redFlagReason: session.redFlagReason,
            confidence: session.confidence,
          },
          doctorSuggestions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/triage/:sessionId/book — book appointment from triage
router.post(
  "/:sessionId/book",
  authenticate,
  authorize(Role.PATIENT, Role.RECEPTION, Role.ADMIN),
  validate(bookFromTriageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { doctorId, date, slotStart, slotEnd, patientId } = req.body;

      const session = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (session.status === "EMERGENCY_DETECTED") {
        res.status(400).json({ success: false, data: null, error: "Cannot book — emergency was detected" });
        return;
      }

      // GAP-T2: Build structured pre-visit summary blob from session data.
      // This includes the symptom summary, full conversation transcript, confidence
      // and language so the attending doctor can see exactly what was captured
      // pre-visit. The blob is also prepended to appointment.notes as JSON so it's
      // machine-parseable (see the `aiSummary Json?` proposal in
      // services/.prisma-models-triage-scribe.md for the future dedicated column).
      const symptoms = session.symptoms as any;
      const rawMessages = (session.messages as any[]) ?? [];
      const transcript = rawMessages
        .filter((m: any) => m.role === "user" || m.role === "assistant")
        .map((m: any) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp ?? null,
        }));
      const preVisitSummary = {
        version: 1,
        sessionId,
        chiefComplaint: session.chiefComplaint || symptoms?.chiefComplaint || "Not specified",
        onset: symptoms?.onset ?? null,
        duration: symptoms?.duration ?? null,
        severity: typeof symptoms?.severity === "number" ? symptoms.severity : null,
        location: symptoms?.location ?? null,
        associatedSymptoms: Array.isArray(symptoms?.associatedSymptoms) ? symptoms.associatedSymptoms : [],
        relevantHistory: symptoms?.relevantHistory ?? null,
        hpi: symptoms?.associatedSymptoms?.join(", ") || "",
        redFlagsNoted: session.redFlagDetected ? [session.redFlagReason!] : [],
        confidence: session.confidence,
        language: session.language,
        transcript,
        transcriptSummary: `AI-assisted triage session. ${rawMessages.filter((m: any) => m.role === "user").length} patient turns.`,
        capturedAt: new Date().toISOString(),
      };

      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay();

      // Get next token number
      const lastAppt = await prisma.appointment.findFirst({
        where: { doctorId, date: dateObj },
        orderBy: { tokenNumber: "desc" },
      });
      const tokenNumber = (lastAppt?.tokenNumber ?? 0) + 1;

      // Verify slot is still available
      const conflict = await prisma.appointment.findFirst({
        where: { doctorId, date: dateObj, slotStart, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      });
      if (conflict) {
        res.status(409).json({ success: false, data: null, error: "Slot no longer available" });
        return;
      }

      // GAP-T2: prepend a structured JSON blob wrapped in a fenced marker so
      // the full summary (symptom fields + transcript + confidence + language)
      // is recoverable from notes until the dedicated aiSummary Json? column
      // in packages/db/prisma/schema.prisma lands.
      const humanSummary = [
        `[AI Triage Booking]`,
        `Chief Complaint: ${preVisitSummary.chiefComplaint}`,
        preVisitSummary.hpi ? `HPI: ${preVisitSummary.hpi}` : null,
        preVisitSummary.redFlagsNoted.length ? `Red Flags: ${preVisitSummary.redFlagsNoted.join(", ")}` : `Red Flags: None`,
        `Confidence: ${preVisitSummary.confidence != null ? Math.round((preVisitSummary.confidence as number) * 100) + "%" : "N/A"}`,
        `Language: ${preVisitSummary.language}`,
        preVisitSummary.transcriptSummary,
      ].filter(Boolean).join("\n");
      const jsonBlob =
        `<!-- AI_TRIAGE_SUMMARY_JSON\n` +
        JSON.stringify(preVisitSummary) +
        `\nAI_TRIAGE_SUMMARY_JSON -->`;

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          date: dateObj,
          slotStart,
          slotEnd,
          tokenNumber,
          type: "SCHEDULED",
          status: "BOOKED",
          notes: `${humanSummary}\n\n${jsonBlob}`,
        },
      });

      // Link session to appointment and mark completed
      await prisma.aITriageSession.update({
        where: { id: sessionId },
        data: {
          appointmentId: appointment.id,
          status: "COMPLETED",
          preVisitSummary: preVisitSummary as any,
        },
      });

      await auditLog(req, "AI_TRIAGE_APPOINTMENT_BOOK", "Appointment", appointment.id, { sessionId, triageConfidence: session.confidence });

      res.status(201).json({
        success: true,
        data: { appointment, preVisitSummary },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/triage/:sessionId/handoff — human handoff to receptionist
//
// security(2026-05-09, issue #511): only `authenticate` was applied — any
// signed-in PATIENT could trigger another patient's handoff, creating a
// ChatRoom with the receptionist and flipping the session to COMPLETED.
// OWASP API1:2023 BOLA / CWE-285. Load the session, then enforce per-row
// ownership via `assertPatientOwnsResource`.
router.post(
  "/:sessionId/handoff",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // 1. Find the triage session
      const session = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, session.patientId))) return;

      // 2. Find an available RECEPTION or ADMIN user
      const receptionist = await prisma.user.findFirst({
        where: {
          role: { in: [Role.RECEPTION, Role.ADMIN] },
          isActive: true,
        },
        select: { id: true, name: true },
      });
      if (!receptionist) {
        res.status(503).json({ success: false, data: null, error: "No receptionists available at this time" });
        return;
      }

      // 3. Create a ChatRoom directly via Prisma
      const patientUserId = req.user?.userId;
      const roomParticipants: { userId: string }[] = [{ userId: receptionist.id }];
      if (patientUserId) roomParticipants.push({ userId: patientUserId });

      const chatRoom = await prisma.chatRoom.create({
        data: {
          name: `AI Triage Handoff — Session ${sessionId.slice(0, 8)}`,
          isGroup: false,
          isChannel: false,
          createdBy: receptionist.id,
          participants: {
            create: roomParticipants.map((p) => ({ userId: p.userId })),
          },
        },
      });

      // 4. Create the initial handoff message
      const transcriptSummary = [
        "[AI Triage Handoff]",
        `Patient: ${session.chiefComplaint || "Not specified"}`,
        `Confidence: ${session.confidence != null ? Math.round((session.confidence as number) * 100) + "%" : "N/A"}`,
        `Session: ${sessionId}`,
        "",
        "Please assist this patient directly.",
      ].join("\n");

      await prisma.chatMessage.create({
        data: {
          roomId: chatRoom.id,
          senderId: receptionist.id,
          content: transcriptSummary,
          type: "TEXT",
        },
      });

      // 5. Update session status and store handoff room id
      await prisma.aITriageSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          handoffChatRoomId: chatRoom.id,
        },
      });

      await auditLog(req, "AI_TRIAGE_HANDOFF", "AITriageSession", sessionId, { chatRoomId: chatRoom.id, receptionistId: receptionist.id });

      // 6. Return chatRoomId and receptionist info
      res.json({
        success: true,
        data: {
          chatRoomId: chatRoom.id,
          receptionist: { id: receptionist.id, name: receptionist.name },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/ai/triage/:sessionId — abandon session
//
// security(2026-05-04, issue #511): same BOLA gap as GET /:sessionId — a
// patient could abandon another patient's in-flight triage session by
// guessing the UUID. Load the row first, then enforce per-row ownership.
router.delete(
  "/:sessionId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.aITriageSession.findUnique({
        where: { id: req.params.sessionId },
        select: { id: true, patientId: true },
      });
      if (!session) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (!(await assertPatientOwnsResource(req, res, session.patientId))) return;

      await prisma.aITriageSession.update({
        where: { id: req.params.sessionId },
        data: { status: "ABANDONED" },
      });
      res.json({ success: true, data: null, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiTriageRouter };
