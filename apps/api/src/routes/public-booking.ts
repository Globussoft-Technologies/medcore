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
} from "@medcore/shared";
import { validate } from "../middleware/validate";
import { istTodayDateStr, istNowMinutes } from "../utils/ist-time";
import { isDoctorOnConfirmedLeave } from "../utils/doctor-leave";
import { rateLimit } from "../middleware/rate-limit";
import { auditLog } from "../middleware/audit";
import { extractSymptomSummary } from "../services/ai/sarvam";
import { onAppointmentBooked } from "../services/notification-triggers";
import { sendWhatsApp } from "../services/channels/whatsapp";

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
// POST /api/v1/public/booking/suggest-doctors
// Body: { symptom, date } → up to 3 available doctors with open slots.
// ════════════════════════════════════════════════════════
publicBookingRouter.post(
  "/suggest-doctors",
  rateLimit(20, 60_000), // 20/min/IP — generous for a multi-try picker
  validate(suggestDoctorsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { symptom, date } = req.body as { symptom: string; date: string };
      // TEMP (2026-06-03): tenant resolution disabled here so the doctor
      // list isn't scoped — see the findMany comment below. Restore with
      // `const tenantId = await resolveTenant(req);` when re-enabling.
      // const tenantId = await resolveTenant(req);

      const specialties = await symptomToSpecialties(symptom);

      // Pull active doctors in the matched specialties.
      // Specialty match is case-insensitive contains so "General Medicine"
      // matches a doctor stored as "General Medicine / Diabetology".
      // TEMP (2026-06-03): tenant scoping commented out so the public
      // booking page surfaces ALL doctors in production while the demo
      // data lives across multiple tenants. Re-enable the
      // `...(tenantId ? { tenantId } : {})` line below to restore
      // per-tenant scoping once each tenant has its own doctor roster.
      const doctors = await prisma.doctor.findMany({
        where: {
          // ...(tenantId ? { tenantId } : {}),
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
        slots: string[];
      }> = [];
      for (const d of sorted) {
        if (suggestions.length >= 3) break;
        const slots = await computeOpenSlots(d.id, date);
        if (slots.length === 0) continue; // "always suggest on availability"
        suggestions.push({
          doctorId: d.id,
          name: d.user.name,
          specialization: d.specialization,
          experienceYears: d.experienceYears ?? null,
          // averageRating / consultationFee are Prisma Decimal — serialise as
          // plain numbers so the JSON client gets a number, not a Decimal blob.
          averageRating: d.averageRating != null ? Number(d.averageRating) : null,
          consultationFee: d.consultationFee != null ? Number(d.consultationFee) : null,
          slots: slots.slice(0, 24), // cap the grid
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
publicBookingRouter.post(
  "/book",
  rateLimit(10, 60_000), // 10/min/IP — tighter; this writes rows
  validate(publicBookSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, doctorId, date, slotId, symptom } = req.body as {
        name: string;
        phone: string;
        doctorId: string;
        date: string;
        slotId: string;
        symptom?: string;
      };
      const phone = canonicalisePhone(req.body.phone);
      const dateObj = new Date(date);

      // Same-day past-slot guard (mirrors /appointments/book). IST-anchored
      // so a UTC-host server rejects the correct elapsed slots.
      const todayStr = istTodayDateStr();
      if (date === todayStr) {
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

      const tenantId = doctor.tenantId ?? (await resolveTenant(req));

      // ── Slot-collision pre-check (TOKEN w/ slot + SLOT modes) ──
      if (doctor.appointmentMode !== "CALLING") {
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

      // ── Auto-register the patient by phone (idempotent) ──
      // An existing User with this phone is reused — we never create a second
      // account for the same number. If the existing user has no Patient row
      // (e.g. a staff phone collision is impossible here since we only match
      // role PATIENT), we create one.
      let user = await prisma.user.findFirst({
        where: { phone, role: Role.PATIENT },
        select: { id: true, tenantId: true, patient: { select: { id: true } } },
      });

      let patientId: string;
      if (user?.patient) {
        patientId = user.patient.id;
      } else {
        // Create User (if missing) + Patient in one go. Random password — the
        // patient logs in via phone OTP, never with a password.
        const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
        if (!user) {
          user = await prisma.user.create({
            data: {
              name,
              phone,
              email: null,
              passwordHash,
              role: Role.PATIENT,
              isActive: true,
              tenantId,
            },
            select: { id: true, tenantId: true, patient: { select: { id: true } } },
          });
        }
        // MR number — mirrors auth.ts registration (next_mr_number counter).
        const cfg = await prisma.systemConfig.findUnique({
          where: { key: "next_mr_number" },
        });
        const mrSeq = cfg ? parseInt(cfg.value, 10) : 1;
        const mrNumber = `MR${String(mrSeq).padStart(6, "0")}`;
        const patient = await prisma.patient.create({
          data: {
            userId: user.id,
            mrNumber,
            gender: "OTHER", // not collected in the quick flow; staff can edit
            tenantId,
            source: "WEB",
          },
          select: { id: true },
        });
        patientId = patient.id;
        await prisma.systemConfig.upsert({
          where: { key: "next_mr_number" },
          update: { value: String(mrSeq + 1) },
          create: { key: "next_mr_number", value: String(mrSeq + 1) },
        });
      }

      // ── Mode-specific token / arrival / slot assignment + create ──
      const mode = doctor.appointmentMode;
      let tokenNumber: number | null = null;
      let arrivalSeq: number | null = null;
      let slotStartToUse: string | null = null;
      if (mode === "TOKEN") {
        tokenNumber = await getNextToken(doctorId, dateObj);
        slotStartToUse = slotId;
      } else if (mode === "SLOT") {
        slotStartToUse = slotId;
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
      onAppointmentBooked(appointment as any).catch(console.error);
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
        `Hi ${name}, your appointment with ${doctor.user.name} is confirmed for ` +
        `${dateStr}${timeLine}.${tokenLine}\n\n` +
        `You can view your appointments and reports anytime — just sign in with this ` +
        `phone number. — MedCore`;
      sendWhatsApp(phone, waMessage, tenantId).catch((e) =>
        console.error("[public-booking] WhatsApp confirm failed (non-fatal)", e),
      );

      res.status(201).json({
        success: true,
        data: {
          appointmentId: appointment.id,
          doctorName: doctor.user.name,
          date,
          slotStart: slotStartToUse,
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
