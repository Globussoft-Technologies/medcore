import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  startTriageSessionSchema,
  triageMessageSchema,
  bookFromTriageSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { checkRedFlags, buildEmergencyResponse } from "../services/ai/red-flag";
import { runTriageTurn, extractSymptomSummary } from "../services/ai/sarvam";
import { auditLog } from "../middleware/audit";

const router = Router();

// POST /api/v1/ai/triage/start — create a new triage session (auth optional for patients)
router.post(
  "/start",
  authenticate,
  validate(startTriageSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { language, inputMode, patientId, isForDependent, dependentRelationship, consentGiven, bookingFor, dependentPatientId } = req.body;

      // Resolve patientId from JWT if patient role and not explicitly provided
      let resolvedPatientId = patientId;
      if (!resolvedPatientId && req.user?.role === Role.PATIENT) {
        const patient = await prisma.patient.findFirst({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        resolvedPatientId = patient?.id;
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

        await auditLog(req, "AI_TRIAGE_EMERGENCY_DETECTED", "AITriageSession", sessionId, { redFlagReason: redFlag.reason });

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

      // 3. Run Claude turn
      const lang = langOverride || session.language;
      const { reply, isEmergency, emergencyReason } = await runTriageTurn(claudeMessages, lang);

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
          if (summary.confidence < 0.5) {
            const gpEntry = {
              specialty: "General Physician",
              subSpecialty: null,
              confidence: 0.9,
              reasoning: "Confidence in specialty match is low — a General Physician can assess and refer appropriately.",
              isGPFallback: true,
            };
            suggestedSpecialties = [gpEntry, ...(summary.specialties || [])] as any;
          } else {
            suggestedSpecialties = summary.specialties as any;
          }
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

      // Fetch doctor suggestions if specialties are available
      let doctorSuggestions: any[] = [];
      if (session.suggestedSpecialties) {
        const specialties = (session.suggestedSpecialties as any[]).map((s: any) => s.specialty);
        const doctors = await prisma.doctor.findMany({
          where: {
            specialization: { in: specialties },
            user: { isActive: true },
          },
          include: {
            user: { select: { id: true, name: true, photoUrl: true, preferredLanguage: true } },
            schedules: true,
          },
          take: 6,
        });

        doctorSuggestions = doctors.map((d) => {
          const specialty = (session.suggestedSpecialties as any[]).find(
            (s: any) => s.specialty === d.specialization
          );
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
            reasoning: specialty?.reasoning || `Specialist in ${d.specialization}`,
            confidence: specialty?.confidence || 0.7,
          };
        });
      }

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

      // Build pre-visit summary from session data
      const symptoms = session.symptoms as any;
      const preVisitSummary = {
        chiefComplaint: session.chiefComplaint || symptoms?.chiefComplaint || "Not specified",
        hpi: symptoms?.associatedSymptoms?.join(", ") || "",
        redFlagsNoted: session.redFlagDetected ? [session.redFlagReason!] : [],
        confidence: session.confidence,
        language: session.language,
        transcriptSummary: `AI-assisted triage session. ${(session.messages as any[]).filter((m: any) => m.role === "user").length} patient turns.`,
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
          notes: [
            `[AI Triage Booking]`,
            `Chief Complaint: ${preVisitSummary.chiefComplaint}`,
            preVisitSummary.hpi ? `HPI: ${preVisitSummary.hpi}` : null,
            preVisitSummary.redFlagsNoted.length ? `Red Flags: ${preVisitSummary.redFlagsNoted.join(", ")}` : `Red Flags: None`,
            `Confidence: ${preVisitSummary.confidence != null ? Math.round((preVisitSummary.confidence as number) * 100) + "%" : "N/A"}`,
            `Language: ${preVisitSummary.language}`,
            preVisitSummary.transcriptSummary,
          ].filter(Boolean).join("\n"),
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

      await auditLog(req, "AI_TRIAGE_APPOINTMENT_BOOKED", "Appointment", appointment.id, { sessionId, triageConfidence: session.confidence });

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
router.delete(
  "/:sessionId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
