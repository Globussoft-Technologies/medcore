import { z } from "zod";
import { PATIENT_NAME_REGEX, PHONE_REGEX } from "./patient";

// Public quick-appointment booking (June 2026).
//
// Drives the unauthenticated "Book appointment" flow on the marketing site:
//   1. /public/booking/suggest-doctors — patient types a symptom + picks a
//      date; the API maps the symptom to a specialty (AI triage) and returns
//      the top 2-3 AVAILABLE doctors for that date with their open slots.
//   2. /public/booking/book — patient picks a doctor + slot and submits their
//      name + WhatsApp number; the API auto-registers them as a PATIENT (by
//      phone), books the appointment, and sends a WhatsApp confirmation.
//
// No auth — these are public endpoints. Inputs are deliberately minimal:
// just the symptom + date to suggest, and name + phone + doctor + date + slot
// to book. Everything else (MR number, password, gender default) is derived
// server-side.

// A symptom free-text line. Short and rejects nothing clinical — but capped so
// the LLM prompt can't be stuffed. "general doctor", "fever", "skin rash" all
// pass; the server maps it to a specialty (General Physician fallback when the
// text is generic / low-confidence).
const symptomField = z
  .string()
  .trim()
  .min(2, "Please describe your symptom or who you'd like to see")
  .max(500, "Please keep this under 500 characters");

const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const suggestDoctorsSchema = z.object({
  symptom: symptomField,
  date: isoDateField,
});
export type SuggestDoctorsInput = z.infer<typeof suggestDoctorsSchema>;

export const publicBookSchema = z.object({
  // Patient identity — minimal. Name follows the same Latin+Devanagari rule
  // the rest of the app enforces; phone is the WhatsApp number and becomes the
  // login handle later.
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters")
    .regex(
      PATIENT_NAME_REGEX,
      "Name may contain letters, spaces, '.', '-' and apostrophes only",
    ),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Enter a valid 10–15 digit phone number"),
  doctorId: z.string().uuid("Invalid doctor"),
  date: isoDateField,
  // Slot is HH:MM. Required only for SLOT-mode doctors (the UI picks a time);
  // TOKEN and CALLING mode doctors book against the date itself with no time
  // grid, so slotId is optional. The /book handler enforces "SLOT mode needs
  // a slotId" server-side after it loads the doctor's appointmentMode.
  slotId: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Pick a time slot")
    .optional(),
  // Carry the symptom through so it lands on the appointment notes + the
  // patient's first triage context. Optional — the booking still works without.
  symptom: symptomField.optional(),
  // Demographics collected on the final booking step. gender + dateOfBirth
  // are required (useful clinically); email is optional. All persist onto
  // the Patient/User row created for a brand-new booking.
  gender: z.enum(["MALE", "FEMALE", "OTHER"], {
    message: "Please select a gender",
  }),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD"),
  email: z
    .string()
    .email("Enter a valid email address")
    .optional()
    .or(z.literal("")),
});
export type PublicBookInput = z.infer<typeof publicBookSchema>;
