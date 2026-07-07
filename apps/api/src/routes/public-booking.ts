/**
 * Public quick-appointment booking — mounted UNAUTHENTICATED at
 * /api/v1/public/booking in apps/api/src/app.ts.
 *
 * Drives the "Book appointment" flow on the marketing site. No login: a
 * prospective patient describes a symptom, picks a date, picks from the top
 * 2-3 AVAILABLE doctors + an open slot, and submits their name + WhatsApp
 * number. The booking endpoint:
 *   1. maps the symptom to a specialty (AI triage) — generic / low-confidence
 *      text falls back to a General Physician,
 *   2. auto-registers the caller as a PATIENT keyed by phone (idempotent — an
 *      existing phone is reused, never duplicated),
 *   3. books the appointment honouring the doctor's appointmentMode (TOKEN /
 *      SLOT / CALLING) and slot-collision rules,
 *   4. sends a WhatsApp confirmation to the entered number (non-fatal).
 *
 * The patient can later log in with the SAME phone via the patient OTP /
 * Firebase phone-auth flow (routes/patient-auth.ts) — the User row created
 * here is the handle.
 *
 * Security posture: this endpoint creates rows for an unauthenticated caller,
 * so it is (a) rate-limited per IP, (b) restricted to role PATIENT only (never
 * trusts a role from the body), (c) generates a random password the caller
 * never learns (login is phone-OTP only), and (d) validated by Zod before any
 * DB write. The symptom is the only free-text that reaches the LLM and is
 * length-capped in the schema.
 */

import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@medcore/db";
import {
  Role,
  suggestDoctorsSchema,
  publicBookSchema,
  canonicalisePhone,
  canonicaliseName,
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { istTodayDateStr, istNowMinutes } from "../utils/ist-time";
import { isDoctorOnConfirmedLeave } from "../utils/doctor-leave";
import { rateLimit } from "../middleware/rate-limit";
import { auditLog } from "../middleware/audit";
import { extractSymptomSummary, runTriageTurn } from "../services/ai/sarvam";
import { callWithASRFallback } from "../services/ai/asr-providers";
import { onAppointmentBooked } from "../services/notification-triggers";
// Use the Meta Cloud sender (same one prescriptions use) so booking
// confirmations actually go out with the configured WHATSAPP_ACCESS_TOKEN
// / WHATSAPP_PHONE_NUMBER_ID env. The older channels/whatsapp adapter
// needs different env vars (WHATSAPP_API_URL/_KEY) and otherwise stubs.
import { sendWhatsApp } from "../services/messaging/whatsapp";
import { patientPortalLink } from "../lib/site-link";
import {
  resolveMrPrefix,
  nextMrSeq,
  mrCounterKey,
  formatMrNumber,
} from "../services/mr-number";

export const publicBookingRouter = Router();

const DEFAULT_SLOT_DURATION_MINUTES = 15;

// Per-(doctor, date) counters — inlined copies of the helpers in
// routes/appointments.ts (module-private there). UTC day boundaries so a
// connection-timezone shift can't miss same-day rows.
async function getNextToken(doctorId: string, date: Date): Promise<number> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: dayStart, lt: dayEnd } },
    _max: { tokenNumber: true },
  });
  return (result._max.tokenNumber ?? 0) + 1;
}

async function getNextArrivalSeq(doctorId: string, date: Date): Promise<number> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: dayStart, lt: dayEnd } },
    _max: { arrivalSeq: true },
  });
  return (result._max.arrivalSeq ?? 0) + 1;
}
const GENERAL_SPECIALTY_FALLBACKS = [
  "General Physician",
  "General Medicine",
  "General Practitioner",
];

// Deterministic symptom-keyword → specialty map. The AI triage extractor is
// conservative and often defaults clear specialty cases (knee pain, pregnancy)
// to "General Physician". This map runs ALONGSIDE the LLM: when a keyword
// matches, its specialty is prepended so the patient is routed to the right
// doctor even if the LLM stayed generic. Specialty strings must be substrings
// of the stored Doctor.specialization values (matched case-insensitively with
// `contains`) — e.g. "Orthopedics" matches "Orthopedics & Sports Medicine",
// "Gynecolog" matches "Gynecologist".
const SYMPTOM_KEYWORD_SPECIALTIES: Array<{ keywords: string[]; specialty: string }> = [
  {
    specialty: "Orthopedics",
    keywords: ["knee", "joint", "bone", "fracture", "sprain", "back pain", "shoulder", "hip", "ankle", "ligament", "arthritis", "sports injury", "dislocat"],
  },
  {
    specialty: "Gynecolog",
    keywords: ["pregnan", "period", "menstru", "gynae", "gyno", "pcos", "pcod", "ovary", "ovarian", "uterus", "vaginal", "menopause", "obstetric", "antenatal", "morning sickness"],
  },
  {
    specialty: "Cardiolog",
    keywords: ["chest pain", "heart", "palpitation", "cardiac", "blood pressure", "hypertension"],
  },
  {
    specialty: "Dermatolog",
    keywords: ["skin", "rash", "acne", "itch", "eczema", "psoriasis", "hair fall", "pimple", "fungal"],
  },
  {
    specialty: "Pediatric",
    keywords: ["child", "baby", "infant", "toddler", "newborn", "vaccination"],
  },
  {
    specialty: "ENT",
    keywords: ["ear ", "nose", "throat", "sinus", "tonsil", "hearing"],
  },
  {
    specialty: "Neurolog",
    keywords: ["headache", "migraine", "seizure", "numbness", "dizziness", "vertigo", "stroke"],
  },
  {
    specialty: "Psychiatr",
    keywords: ["anxiety", "depress", "stress", "panic", "insomnia", "mental health", "mood"],
  },
  {
    specialty: "Gastroenterolog",
    keywords: ["stomach", "abdominal", "acidity", "ulcer", "constipation", "diarrhea", "diarrhoea", "liver", "vomit"],
  },
  {
    specialty: "Ophthalmolog",
    keywords: ["eye ", "vision", "blurred", "cataract"],
  },
];

function keywordSpecialties(symptom: string): string[] {
  const lower = ` ${symptom.toLowerCase()} `;
  const hits: string[] = [];
  for (const { keywords, specialty } of SYMPTOM_KEYWORD_SPECIALTIES) {
    if (keywords.some((k) => lower.includes(k))) hits.push(specialty);
  }
  return hits;
}

// ── Tenant resolution (mirrors auth.ts resolveRegistrationTenant) ──────────
// Unauthenticated caller → header override, then subdomain, then the seeded
// `default` tenant. Kept local so we don't cross into auth.ts internals.
async function resolveTenant(req: Request): Promise<string | null> {
  const headerTenant = req.header("X-Tenant-Id");
  if (headerTenant && headerTenant.trim().length > 0) {
    const t = await prisma.tenant.findUnique({
      where: { id: headerTenant.trim() },
      select: { id: true, active: true },
    });
    if (t?.active) return t.id;
  }
  const host = (req.headers.host || "").toLowerCase().split(":")[0];
  if (host.endsWith(".medcore.globusdemos.com")) {
    const subdomain = host.slice(0, host.length - ".medcore.globusdemos.com".length);
    if (subdomain && subdomain !== "www") {
      const t = await prisma.tenant.findUnique({
        where: { subdomain },
        select: { id: true, active: true },
      });
      if (t?.active) return t.id;
    }
  }
  const fallback = await prisma.tenant.findUnique({
    where: { subdomain: "default" },
    select: { id: true, active: true },
  });
  return fallback?.active ? fallback.id : null;
}

// ── Slot computation (mirrors GET /doctors/:id/slots) ──────────────────────
// Returns the open HH:MM slots for one doctor on one date, dropping booked
// slots, past dates, and (for today) elapsed times. Honours ScheduleOverride.
async function computeOpenSlots(
  doctorId: string,
  date: string,
): Promise<string[]> {
  const dateObj = new Date(date);
  const dayOfWeek = dateObj.getDay();

  const override = await prisma.scheduleOverride.findUnique({
    where: { doctorId_date: { doctorId, date: dateObj } },
  });
  if (override?.isBlocked) return [];

  // Confirmed (APPROVED) doctor leave → no slots for the day.
  if (await isDoctorOnConfirmedLeave(doctorId, dateObj)) return [];

  const schedules = await prisma.doctorSchedule.findMany({
    where: { doctorId, dayOfWeek },
  });
  if (schedules.length === 0) return [];

  // IST-anchored "now" — slot strings are clinic-local IST clock times,
  // so the cutoff MUST be IST too. Using server-local time leaks elapsed
  // slots on a UTC host (see istNowMinutes docs / the slot-leak bug).
  const todayStr = istTodayDateStr();
  if (date < todayStr) return [];
  const isToday = date === todayStr;
  const nowMin = istNowMinutes();

  const existing = await prisma.appointment.findMany({
    where: {
      doctorId,
      date: dateObj,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    select: { slotStart: true },
  });
  const booked = new Set(existing.map((a) => a.slotStart));

  const slots: string[] = [];
  for (const schedule of schedules) {
    const startTime = override?.startTime || schedule.startTime;
    const endTime = override?.endTime || schedule.endTime;
    const duration = schedule.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
    const step = duration + (schedule.bufferMinutes || 0);
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    for (let m = startMinutes; m + duration <= endMinutes; m += step) {
      if (isToday && m < nowMin) continue;
      const slotStart = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      if (!booked.has(slotStart)) slots.push(slotStart);
    }
  }
  // De-dupe (overlapping shifts) + sort.
  return Array.from(new Set(slots)).sort();
}

// ── Working-day availability (TOKEN / CALLING modes) ───────────────────────
// TOKEN and CALLING doctors do NOT run a time grid — a patient gets the next
// token / arrival number, not a picked slot. So their availability is simply
// "is the doctor working that day?" — a schedule exists for the weekday, the
// day isn't blocked by an override, the doctor isn't on confirmed leave, and
// the date isn't in the past. Using computeOpenSlots() for these modes was a
// bug: a busy TOKEN doctor whose every notional slot is already booked/elapsed
// returned [] and vanished from the picker, even though they can still take
// more token patients (June 2026 — "I added a doctor but No doctors available").
async function isDoctorWorkingOn(
  doctorId: string,
  date: string,
): Promise<boolean> {
  const dateObj = new Date(date);
  const dayOfWeek = dateObj.getDay();

  // Past date → not bookable.
  if (date < istTodayDateStr()) return false;

  const override = await prisma.scheduleOverride.findUnique({
    where: { doctorId_date: { doctorId, date: dateObj } },
  });
  if (override?.isBlocked) return false;

  if (await isDoctorOnConfirmedLeave(doctorId, dateObj)) return false;

  const scheduleCount = await prisma.doctorSchedule.count({
    where: { doctorId, dayOfWeek },
  });
  return scheduleCount > 0;
}

// Map a free-text symptom to candidate specialties via the AI triage
// extractor. A single user turn is enough for a coarse mapping; we always
// append the General-Physician fallbacks so a generic input ("general
// doctor") or a low-confidence extraction still yields a bookable doctor.
async function symptomToSpecialties(symptom: string): Promise<string[]> {
  const specialties: string[] = [];
  // 1. Deterministic keyword routing FIRST (highest priority) — guarantees
  //    e.g. "knee pain" → Orthopedics and "pregnancy" → Gynecology even when
  //    the LLM conservatively returns General Physician.
  specialties.push(...keywordSpecialties(symptom));
  // 2. LLM extraction — adds specialties the keyword map didn't catch.
  try {
    const summary = await extractSymptomSummary([
      { role: "user", content: symptom },
    ]);
    for (const s of summary.specialties ?? []) {
      if (s?.specialty && typeof s.specialty === "string") {
        if (!specialties.includes(s.specialty)) specialties.push(s.specialty);
      }
    }
  } catch {
    // LLM unavailable / errored — fall through to the GP fallback below so the
    // patient can still book. The whole point is "suggest a doctor immediately".
  }
  // Always include the generic fallbacks at the tail so there is a bookable
  // doctor even when the symptom is vague or the extractor returns nothing.
  for (const g of GENERAL_SPECIALTY_FALLBACKS) {
    if (!specialties.includes(g)) specialties.push(g);
  }
  return specialties;
}

// ════════════════════════════════════════════════════════
// POST /api/v1/public/booking/chat
// Body: { messages: {role:"user"|"assistant", content:string}[], language?, name? }
// → Multi-turn AI triage chat for the public booking flow. The caller describes
//   their symptoms conversationally; the assistant asks follow-ups and (when the
//   caller taps "Find a doctor") the whole conversation is sent to
//   /suggest-doctors as the symptom text. STATELESS — the full history is passed
//   in the body each turn; runTriageTurn writes nothing to the DB.
//
// Security: unauthenticated + spends LLM quota, so it is rate-limited per IP and
// the message array is length/turn-capped. Emergency detection (isEmergency)
// lets the client block booking and show a "call 112" banner.
// ════════════════════════════════════════════════════════
const MAX_CHAT_TURNS = 20;
const MAX_CHAT_MSG_CHARS = 1000;
publicBookingRouter.post(
  "/chat",
  rateLimit(15, 60_000), // 15/min/IP — bounds LLM cost on an unauth surface
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { messages, language, name } = req.body as {
        messages?: Array<{ role?: string; content?: string }>;
        language?: string;
        name?: string;
      };
      void name; // accepted for parity with the client; greeting is client-seeded

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "messages must be a non-empty array",
        });
        return;
      }
      if (messages.length > MAX_CHAT_TURNS) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Conversation is too long (max ${MAX_CHAT_TURNS} turns).`,
        });
        return;
      }
      // Normalise + validate each turn. Reject unknown roles / oversized text.
      const clean: { role: "user" | "assistant"; content: string }[] = [];
      for (const m of messages) {
        const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
        const content = typeof m?.content === "string" ? m.content.trim() : "";
        if (!role || !content) continue;
        if (content.length > MAX_CHAT_MSG_CHARS) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Each message must be at most ${MAX_CHAT_MSG_CHARS} characters.`,
          });
          return;
        }
        clean.push({ role, content });
      }
      if (clean.length === 0 || !clean.some((m) => m.role === "user")) {
        res.status(400).json({
          success: false,
          data: null,
          error: "At least one user message is required.",
        });
        return;
      }

      try {
        // Public-booking guardrails: MedCore has its OWN in-house doctor
        // roster, so the assistant must NEVER ask for the patient's city /
        // location and must NEVER name external hospitals or clinics. It only
        // asks about the symptoms themselves, then we match a doctor from the
        // database by specialty.
        // Map a Sarvam/BCP-47 language code (e.g. "bn-IN") to a name so we can
        // instruct the model to reply in the patient's OWN language.
        const LANG_NAMES: Record<string, string> = {
          en: "English", hi: "Hindi", bn: "Bengali", ta: "Tamil",
          te: "Telugu", mr: "Marathi", kn: "Kannada", ml: "Malayalam",
          gu: "Gujarati", pa: "Punjabi", or: "Odia", ur: "Urdu",
        };
        const langCode = (language ?? "").split("-")[0].toLowerCase();
        const langName = LANG_NAMES[langCode];
        const LANGUAGE_SUFFIX =
          langName && langName !== "English"
            ? ` IMPORTANT: The patient is communicating in ${langName}. Reply ONLY in ${langName} (use ${langName} script), matching their language exactly. Do not switch to English.`
            : "";
        const PUBLIC_BOOKING_SUFFIX =
          "IMPORTANT BOOKING CONTEXT: You are booking inside ONE specific MedCore hospital that has its own panel of doctors. Do NOT ask for the patient's city, area, or location — it is already known. Do NOT name, list, or recommend any external hospitals, clinics, or other organisations. Only ask follow-up questions about the SYMPTOMS (duration, severity, related symptoms, history). Once you understand the problem, simply tell the patient you'll suggest a suitable doctor from our panel — the system will pick the matching in-house doctor automatically. Never output a list of hospitals." +
          LANGUAGE_SUFFIX;
        const turn = await runTriageTurn(
          clean,
          language ?? "en-IN",
          PUBLIC_BOOKING_SUFFIX,
        );
        // "Ready for a doctor" mirrors ai-triage.ts: only after the patient has
        // had a proper back-and-forth (≥4 user turns) do we surface doctors —
        // before that the assistant keeps asking normal follow-up questions
        // (duration, severity, related symptoms, etc).
        const userTurns = clean.filter((m) => m.role === "user").length;
        res.json({
          success: true,
          data: {
            reply: turn.reply,
            isEmergency: turn.isEmergency,
            emergencyReason: turn.emergencyReason ?? null,
            readyForDoctors: userTurns >= 4,
          },
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /is not configured/i.test(message) ? 500 : 502;
        res.status(status).json({
          success: false,
          data: null,
          error:
            status === 500
              ? "The assistant is not available right now."
              : "The assistant is busy. Please try again or tap 'Find a doctor'.",
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ════════════════════════════════════════════════════════
// POST /api/v1/public/booking/transcribe
// Body: { audioBase64: string }
// → Sarvam saaras speech-to-text-translate: the caller speaks their symptom
//   in ANY supported language and we return ENGLISH text to drop into the
//   symptom field, which then drives the normal suggest-doctors flow.
//
// Security: this is an UNAUTHENTICATED surface that spends paid Sarvam ASR
// quota, so it is locked down hard — tight per-IP rate limit + a small audio
// cap (≈30s of speech). NEVER log audio bytes or transcript content.
// ════════════════════════════════════════════════════════
const MAX_VOICE_AUDIO_BYTES = 1 * 1024 * 1024; // ~30s webm @ 96 kbps
publicBookingRouter.post(
  "/transcribe",
  rateLimit(5, 60_000), // 5/min/IP — a symptom sentence, not a transcription service
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { audioBase64 } = req.body as { audioBase64?: string };
      if (!audioBase64 || typeof audioBase64 !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "audioBase64 field is required",
        });
        return;
      }
      const audioBuffer = Buffer.from(audioBase64, "base64");
      if (
        audioBuffer.length === 0 ||
        audioBuffer.length > MAX_VOICE_AUDIO_BYTES
      ) {
        res.status(413).json({
          success: false,
          data: null,
          error: `audio must be between 1 byte and ${MAX_VOICE_AUDIO_BYTES} bytes (~30 seconds)`,
        });
        return;
      }

      try {
        // translate:false keeps the SPOKEN language (Bengali stays Bengali,
        // etc.) and Sarvam auto-detects which language it was — we return that
        // so the chat can reply in the same language.
        const result = await callWithASRFallback(
          audioBuffer,
          { diarize: false, translate: false },
          { providers: ["sarvam"], feature: "asr-sarvam" },
        );
        res.json({
          success: true,
          data: {
            transcript: (result.transcript ?? "").trim(),
            language: result.language ?? null,
          },
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /is not configured/i.test(message) ? 500 : 502;
        res.status(status).json({
          success: false,
          data: null,
          error:
            status === 500
              ? "Voice input is not available right now."
              : "Couldn't understand the audio. Please try again or type instead.",
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ════════════════════════════════════════════════════════
// POST /api/v1/public/booking/suggest-doctors
// Body: { symptom, date } → up to 3 available doctors with open slots.
// ════════════════════════════════════════════════════════
publicBookingRouter.post(
  "/suggest-doctors",
  rateLimit(20, 60_000), // 20/min/IP — generous for a multi-try picker
  validate(suggestDoctorsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { symptom, date, tenantId: bodyTenantId } = req.body as {
        symptom: string;
        date: string;
        tenantId?: string;
      };
      // The public booking chat asks the patient which HOSPITAL they want,
      // and sends the chosen tenantId. We scope the suggested doctors to that
      // hospital's panel so the AI only ever recommends in-house doctors.
      // Priority: body tenantId (the patient's pick) → header → subdomain →
      // default. Validated active inside resolveTenant when from header/sub;
      // the body id is validated here so a stale/forged id can't scope to a
      // suspended hospital.
      let tenantId: string | null = null;
      if (bodyTenantId && bodyTenantId.trim()) {
        const t = await prisma.tenant.findUnique({
          where: { id: bodyTenantId.trim() },
          select: { id: true, active: true },
        });
        if (t?.active) tenantId = t.id;
      }
      if (!tenantId) tenantId = await resolveTenant(req);

      const specialties = await symptomToSpecialties(symptom);

      // Pull active doctors in the matched specialties, SCOPED to the chosen
      // hospital. Specialty match is case-insensitive contains so "General
      // Medicine" matches a doctor stored as "General Medicine / Diabetology".
      const doctors = await prisma.doctor.findMany({
        where: {
          ...(tenantId ? { tenantId } : {}),
          user: { isActive: true },
          OR: specialties.map((s) => ({
            specialization: { contains: s, mode: "insensitive" as const },
          })),
        },
        select: {
          id: true,
          specialization: true,
          experienceYears: true,
          averageRating: true,
          consultationFee: true,
          appointmentMode: true,
          tokenPrefix: true,
          user: { select: { name: true } },
        },
        take: 12,
      });

      // Rank by the specialty order returned from the extractor (best match
      // first), then by rating. Compute open slots and keep only doctors who
      // actually have availability on the chosen date. Surface the top 3.
      const specialtyRank = (spec: string | null): number => {
        if (!spec) return specialties.length;
        const idx = specialties.findIndex((s) =>
          spec.toLowerCase().includes(s.toLowerCase()),
        );
        return idx === -1 ? specialties.length : idx;
      };
      const sorted = [...doctors].sort((a, b) => {
        const r = specialtyRank(a.specialization) - specialtyRank(b.specialization);
        if (r !== 0) return r;
        // averageRating is a Prisma Decimal — coerce to Number for the compare.
        return Number(b.averageRating ?? 0) - Number(a.averageRating ?? 0);
      });

      const suggestions: Array<{
        doctorId: string;
        name: string;
        specialization: string | null;
        experienceYears: number | null;
        averageRating: number | null;
        consultationFee: number | null;
        // Booking shape varies by the doctor's appointmentMode:
        //   SLOT    → `slots` holds the open HH:MM times; patient picks one.
        //   TOKEN   → no time grid; `nextToken` is the number they'll get.
        //   CALLING → no time, no token; book by arrival on the chosen date.
        appointmentMode: "SLOT" | "TOKEN" | "CALLING";
        slots: string[];
        nextToken: number | null;
      }> = [];
      for (const d of sorted) {
        if (suggestions.length >= 3) break;
        const mode = d.appointmentMode as "SLOT" | "TOKEN" | "CALLING";

        // Availability differs by mode:
        //   SLOT    → needs at least one OPEN time slot (booked/elapsed times
        //             are removed; an empty grid means genuinely full).
        //   TOKEN /
        //   CALLING → no time grid; available as long as the doctor is WORKING
        //             that day. A busy TOKEN doctor (every notional slot taken)
        //             can still issue the next token, so we must NOT gate them
        //             on the slot grid being non-empty.
        let slots: string[] = [];
        if (mode === "SLOT") {
          slots = await computeOpenSlots(d.id, date);
          if (slots.length === 0) continue; // genuinely full / not working
        } else {
          const working = await isDoctorWorkingOn(d.id, date);
          if (!working) continue; // not working that day / on leave / past date
        }

        let nextToken: number | null = null;
        if (mode === "TOKEN") {
          const n = await getNextToken(d.id, new Date(date));
          nextToken = n;
        }

        suggestions.push({
          doctorId: d.id,
          name: d.user.name,
          specialization: d.specialization,
          experienceYears: d.experienceYears ?? null,
          // averageRating / consultationFee are Prisma Decimal — serialise as
          // plain numbers so the JSON client gets a number, not a Decimal blob.
          averageRating: d.averageRating != null ? Number(d.averageRating) : null,
          consultationFee: d.consultationFee != null ? Number(d.consultationFee) : null,
          appointmentMode: mode,
          // Only SLOT mode exposes a pickable time grid; TOKEN/CALLING book
          // against the date itself.
          slots: mode === "SLOT" ? slots.slice(0, 24) : [],
          nextToken,
        });
      }

      res.json({
        success: true,
        data: {
          date,
          matchedSpecialties: specialties,
          doctors: suggestions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ════════════════════════════════════════════════════════
// POST /api/v1/public/booking/book
// Body: { name, phone, doctorId, date, slotId, symptom? }
// → auto-register patient (by phone) + book + WhatsApp confirm.
// ════════════════════════════════════════════════════════
// POST /public/booking/check-appointment — pre-submit duplicate check.
// Given (name + phone + doctorId + date) resolved to the doctor's hospital,
// tell the kiosk whether that patient ALREADY has an open appointment with
// this doctor on this date — so the UI can show the existing booking instead
// of creating a second one. Read-only, rate-limited, no rows written.
publicBookingRouter.post(
  "/check-appointment",
  rateLimit(20, 60_000),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const rawPhone = typeof req.body?.phone === "string" ? req.body.phone : "";
      const doctorId = typeof req.body?.doctorId === "string" ? req.body.doctorId : "";
      const date = typeof req.body?.date === "string" ? req.body.date : "";
      if (!name.trim() || !rawPhone.trim() || !doctorId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "name, phone, doctorId and date (YYYY-MM-DD) are required",
        });
        return;
      }
      const phone = canonicalisePhone(rawPhone);
      const cleanName = canonicaliseName(name);

      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: {
          tenantId: true,
          specialization: true,
          tokenPrefix: true,
          user: { select: { name: true } },
        },
      });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }
      const tenantId = doctor.tenantId ?? (await resolveTenant(req));

      // Same (phone + name + tenant) match rule as /book's patient resolution.
      const user = await prisma.user.findFirst({
        where: {
          phone,
          role: Role.PATIENT,
          name: { equals: cleanName, mode: "insensitive" },
          ...(tenantId ? { tenantId } : {}),
          patient: { is: {} },
        },
        select: { patient: { select: { id: true } } },
      });
      if (!user?.patient) {
        // No matching patient → definitely not a duplicate → normal flow.
        res.json({ success: true, data: { exists: false }, error: null });
        return;
      }

      const dayStart = new Date(date);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      const existing = await prisma.appointment.findFirst({
        where: {
          patientId: user.patient.id,
          doctorId,
          date: { gte: dayStart, lt: dayEnd },
          status: { in: ["BOOKED", "CHECKED_IN", "IN_CONSULTATION"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!existing) {
        res.json({ success: true, data: { exists: false }, error: null });
        return;
      }
      const displayToken =
        existing.tokenNumber != null
          ? `${doctor.tokenPrefix ?? ""}${existing.tokenNumber}`
          : null;
      res.json({
        success: true,
        data: {
          exists: true,
          appointment: {
            appointmentId: existing.id,
            date: existing.date.toISOString().slice(0, 10),
            slotStart: existing.slotStart,
            tokenNumber: existing.tokenNumber,
            arrivalSeq: existing.arrivalSeq,
            displayToken,
            status: existing.status,
            doctorName: doctor.user.name,
            department: doctor.specialization,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

publicBookingRouter.post(
  "/book",
  rateLimit(10, 60_000), // 10/min/IP — tighter; this writes rows
  validate(publicBookSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, doctorId, date, slotId, symptom, gender, dateOfBirth, email, tenantId: bodyTenantId } = req.body as {
        name: string;
        phone: string;
        doctorId: string;
        date: string;
        slotId: string;
        symptom?: string;
        gender: "MALE" | "FEMALE" | "OTHER";
        dateOfBirth: string;
        email?: string;
        // The hospital the patient chose in the booking chat.
        tenantId?: string;
      };
      const phone = canonicalisePhone(req.body.phone);
      // Canonical name: trim + collapse inner whitespace so "Sourav  Adak"
      // (double space) matches and stores identically to "Sourav Adak".
      const cleanName = canonicaliseName(name);
      const dateObj = new Date(date);

      // Same-day past-slot guard (mirrors /appointments/book). IST-anchored
      // so a UTC-host server rejects the correct elapsed slots. Only applies
      // when a time slot was supplied (SLOT mode); TOKEN/CALLING book against
      // the date with no specific time, so there's no elapsed-time to reject.
      const todayStr = istTodayDateStr();
      if (date === todayStr && slotId) {
        const [sh, sm] = slotId.split(":").map(Number);
        if (sh * 60 + sm < istNowMinutes()) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Cannot book a slot in the past",
          });
          return;
        }
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: {
          id: true,
          appointmentMode: true,
          tokenPrefix: true,
          tenantId: true,
          user: { select: { name: true } },
        },
      });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }

      // Confirmed (APPROVED) doctor leave blocks public booking on that
      // date — mirrors the slot grid, which returns no slots for leave days.
      if (await isDoctorOnConfirmedLeave(doctorId, dateObj)) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Doctor is on leave on the selected date",
        });
        return;
      }

      // Resolve the hospital this booking belongs to. The patient picked it in
      // the chat (bodyTenantId); we trust the DOCTOR'S tenant as the source of
      // truth (the doctor was already suggested from the chosen hospital), and
      // only fall back to the body/header/default when the doctor has no
      // tenant. This keeps the appointment + new patient in the same hospital
      // as the doctor — never split across tenants.
      const tenantId =
        doctor.tenantId ??
        (bodyTenantId?.trim()
          ? (await prisma.tenant.findUnique({
              where: { id: bodyTenantId.trim() },
              select: { id: true, active: true },
            }))?.id ?? null
          : null) ??
        (await resolveTenant(req));

      // SLOT mode requires a specific time slot; TOKEN/CALLING do not (they
      // book against the date — next token / arrival order). Enforce here now
      // that slotId is schema-optional.
      if (doctor.appointmentMode === "SLOT" && !slotId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Please pick a time slot for this doctor.",
        });
        return;
      }

      // ── Slot-collision pre-check (SLOT mode only — it's the only mode that
      // books a specific slotStart time). ──
      if (doctor.appointmentMode === "SLOT" && slotId) {
        const taken = await prisma.appointment.findFirst({
          where: {
            doctorId,
            date: dateObj,
            slotStart: slotId,
            status: { notIn: ["CANCELLED", "NO_SHOW"] },
          },
          select: { id: true },
        });
        if (taken) {
          res.status(409).json({
            success: false,
            data: null,
            error: "This slot was just booked. Please pick another.",
          });
          return;
        }
      }

      // ── Find-or-create the patient by (phone + name + HOSPITAL) ──
      // Identity for a public booking is keyed on phone AND name AND the
      // selected hospital (tenant). Only when ALL THREE match an existing
      // patient IN THIS HOSPITAL do we book against that existing chart. If
      // ANY of them differs — different name, different phone, or a different
      // hospital — we create a NEW patient in the selected hospital. (Duplicate
      // phones across hospitals/people are allowed; a patient at Hospital A is
      // a separate record from the same person at Hospital B.)
      let user = await prisma.user.findFirst({
        where: {
          phone,
          role: Role.PATIENT,
          name: { equals: cleanName, mode: "insensitive" },
          // Scope to the chosen hospital — the crux of the per-tenant rule.
          ...(tenantId ? { tenantId } : {}),
          // Must already have a Patient row in this tenant to be reusable.
          patient: { is: {} },
        },
        select: { id: true, tenantId: true, patient: { select: { id: true } } },
      });

      let patientId: string;
      if (user?.patient) {
        patientId = user.patient.id;
      } else {
        // Create User (if missing) + Patient in one go. Random password — the
        // patient logs in via phone OTP, never with a password.
        const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
        // Only attach the email if it's provided AND not already taken
        // (User.email is unique — a collision would throw). When omitted or
        // taken, store null; staff can reconcile later.
        let emailToStore: string | null = null;
        const trimmedEmail = (email ?? "").trim();
        if (trimmedEmail) {
          const emailTaken = await prisma.user.findUnique({
            where: { email: trimmedEmail },
            select: { id: true },
          });
          if (!emailTaken) emailToStore = trimmedEmail;
        }
        if (!user) {
          user = await prisma.user.create({
            data: {
              name: cleanName,
              phone,
              email: emailToStore,
              passwordHash,
              role: Role.PATIENT,
              isActive: true,
              tenantId,
            },
            select: { id: true, tenantId: true, patient: { select: { id: true } } },
          });
        }
        // MR number — per-tenant scheme (<tenant code><sequence>, e.g.
        // PG01000001) shared with staff + self-registration via
        // services/mr-number.ts. The patient email goes on Patient.contactEmail
        // too (per-tenant), mirroring the registration write.
        const mrPrefix = await resolveMrPrefix(prisma, tenantId);
        const counterKey = mrCounterKey(tenantId);
        let mrSeq = await nextMrSeq(prisma, counterKey, mrPrefix);
        let patient: { id: string } | undefined;
        const MAX_MR_ATTEMPTS = 5;
        for (let attempt = 0; attempt < MAX_MR_ATTEMPTS; attempt++) {
          try {
            patient = await prisma.patient.create({
              data: {
                userId: user.id,
                mrNumber: formatMrNumber(mrPrefix, mrSeq),
                contactEmail: emailToStore ? emailToStore.toLowerCase() : null,
                // Demographics from the booking form (gender + DOB required).
                gender,
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                tenantId,
                source: "WEB",
              },
              select: { id: true },
            });
            await prisma.systemConfig.upsert({
              where: { key: counterKey },
              update: { value: String(mrSeq + 1) },
              create: { key: counterKey, value: String(mrSeq + 1) },
            });
            break;
          } catch (err) {
            const code = (err as { code?: string })?.code;
            const target = (err as { meta?: { target?: string[] | string } })?.meta
              ?.target;
            const fields = Array.isArray(target) ? target : target ? [String(target)] : [];
            const isMrClash = code === "P2002" && fields.includes("mrNumber");
            if (!isMrClash || attempt === MAX_MR_ATTEMPTS - 1) throw err;
            mrSeq = Math.max(await nextMrSeq(prisma, counterKey, mrPrefix), mrSeq + 1);
          }
        }
        patientId = patient!.id;
      }

      // ── Mode-specific token / arrival / slot assignment + create ──
      //   SLOT    → slotStart = the picked time.
      //   TOKEN   → next token number, no slotStart (date + token only).
      //   CALLING → next arrival seq, no slotStart/token (date + arrival).
      const mode = doctor.appointmentMode;
      let tokenNumber: number | null = null;
      let arrivalSeq: number | null = null;
      let slotStartToUse: string | null = null;
      if (mode === "TOKEN") {
        tokenNumber = await getNextToken(doctorId, dateObj);
      } else if (mode === "SLOT") {
        slotStartToUse = slotId ?? null;
      } else {
        arrivalSeq = await getNextArrivalSeq(doctorId, dateObj);
      }

      let appointment: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          appointment = await prisma.appointment.create({
            data: {
              patientId,
              doctorId,
              date: dateObj,
              slotStart: slotStartToUse,
              tokenNumber,
              arrivalSeq,
              type: "SCHEDULED",
              status: "BOOKED",
              // Stamp the appointment with the booking's hospital. This route
              // uses the UNSCOPED global `prisma` (no req.tenantId on an
              // unauthenticated caller), so the row's tenantId must be set
              // explicitly — otherwise it lands NULL and the patient's
              // tenant-scoped appointment list (which filters tenantId = their
              // hospital) never returns it, making the booking invisible.
              tenantId,
              notes: symptom ? `Self-booked (web). Reason: ${symptom}` : "Self-booked (web)",
            },
            include: {
              patient: { include: { user: { select: { name: true, phone: true } } } },
              doctor: { include: { user: { select: { name: true } } } },
            },
          });
          break;
        } catch (err: any) {
          if (err?.code === "P2002" && attempt < 4) {
            if (mode === "TOKEN" && tokenNumber !== null) { tokenNumber++; continue; }
            if (mode === "CALLING" && arrivalSeq !== null) { arrivalSeq++; continue; }
            res.status(409).json({
              success: false,
              data: null,
              error: "This slot was just booked. Please pick another.",
            });
            return;
          }
          throw err;
        }
      }

      // Queue socket update + in-app notifications (fire-and-forget).
      const io = req.app.get("io");
      if (io) io.to(`queue:${doctorId}`).emit("queue-updated", { doctorId, date });
      onAppointmentBooked(appointment as any, patientPortalLink(req)).catch(console.error);
      auditLog(req, "PUBLIC_APPOINTMENT_BOOK", "appointment", appointment.id, {
        patientId,
        doctorId,
        date,
        autoRegistered: !user?.patient,
      }).catch(console.error);

      const displayToken =
        appointment.tokenNumber !== null && appointment.tokenNumber !== undefined
          ? `${doctor.tokenPrefix ?? ""}${appointment.tokenNumber}`
          : null;

      // ── WhatsApp confirmation to the entered number (non-fatal) ──
      const dateStr = dateObj.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const timeLine = slotStartToUse ? ` at ${slotStartToUse}` : "";
      const tokenLine = displayToken ? `\nYour token: ${displayToken}` : "";
      const waMessage =
        `Hi ${cleanName}, your appointment with ${doctor.user.name} is confirmed for ` +
        `${dateStr}${timeLine}.${tokenLine}\n\n` +
        `View your appointments and reports anytime: ${patientPortalLink(req)}\n` +
        `Just sign in with this phone number. — MedCore`;
      // Fire-and-forget — a WhatsApp failure must never block the 201.
      // The sender normalises the phone to E.164 itself.
      sendWhatsApp({ to: phone, body: waMessage }).catch((e) =>
        console.error("[public-booking] WhatsApp confirm failed (non-fatal)", e),
      );

      res.status(201).json({
        success: true,
        data: {
          appointmentId: appointment.id,
          doctorName: doctor.user.name,
          date,
          slotStart: slotStartToUse,
          // Raw mode outputs so the confirmation UI can show the right thing
          // per mode (SLOT → time, TOKEN → token #, CALLING → arrival #).
          tokenNumber,
          arrivalSeq,
          displayToken,
          // So the client can nudge "sign in with this number to track it".
          patientPhone: phone,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);
