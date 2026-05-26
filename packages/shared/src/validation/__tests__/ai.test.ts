// Coverage tests for the AI feature validation schemas.
// What: happy + invalid + edge-case assertions for the 6 Zod schemas
//   plus the TRIAGE_LANGUAGE_CODES tuple exported from ../ai.
// Which modules: imports exclusively from ../ai (Sarvam-backed triage,
//   scribe-session, transcript-chunk, scribe-signoff, book-from-triage).
// Why: file shipped with 0% coverage and gates every AI route on the
//   API (POST /ai/triage/sessions, /ai/triage/sessions/:id/message,
//   /ai/triage/sessions/:id/book, /ai/scribe/sessions, scribe transcript
//   push, scribe sign-off). Regressions in the consent literals,
//   language enum, UUID requirements, or retention bounds would either
//   silently accept invalid payloads (consent bypass — PHI/regulatory
//   risk) or reject legitimate ones. These tests pin the contract so
//   schema edits surface in CI rather than at runtime.
import { describe, it, expect } from "vitest";
import {
  TRIAGE_LANGUAGE_CODES,
  startTriageSessionSchema,
  triageMessageSchema,
  bookFromTriageSchema,
  startScribeSessionSchema,
  addTranscriptChunkSchema,
  scribeSignOffSchema,
} from "../ai";

const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

describe("TRIAGE_LANGUAGE_CODES", () => {
  it("contains exactly the 8 PRD §3.5.1 Phase-1+Phase-2 codes in canonical order", () => {
    expect(TRIAGE_LANGUAGE_CODES).toEqual([
      "en",
      "hi",
      "ta",
      "te",
      "bn",
      "mr",
      "kn",
      "ml",
    ]);
  });
  it("is a readonly tuple (frozen at the type level via `as const`)", () => {
    // `as const` gives a readonly tuple; runtime value is a plain array.
    // Length pin guards against accidental additions that bypass the i18n
    // bundle sync convention.
    expect(TRIAGE_LANGUAGE_CODES.length).toBe(8);
  });
});

describe("startTriageSessionSchema", () => {
  it("accepts the minimum-valid body (only consentGiven supplied; defaults fill the rest)", () => {
    const parsed = startTriageSessionSchema.parse({ consentGiven: true });
    expect(parsed.language).toBe("en");
    expect(parsed.inputMode).toBe("text");
    expect(parsed.isForDependent).toBe(false);
  });
  it("accepts every supported language code", () => {
    for (const code of TRIAGE_LANGUAGE_CODES) {
      expect(
        startTriageSessionSchema.safeParse({ consentGiven: true, language: code }).success
      ).toBe(true);
    }
  });
  it("rejects an unsupported language code", () => {
    expect(
      startTriageSessionSchema.safeParse({ consentGiven: true, language: "fr" as any }).success
    ).toBe(false);
  });
  it("rejects consentGiven=false (literal(true) consent gate)", () => {
    expect(
      startTriageSessionSchema.safeParse({ consentGiven: false as any }).success
    ).toBe(false);
  });
  it("rejects missing consentGiven entirely", () => {
    expect(startTriageSessionSchema.safeParse({}).success).toBe(false);
  });
  it("rejects a non-UUID patientId", () => {
    expect(
      startTriageSessionSchema.safeParse({
        consentGiven: true,
        patientId: "not-a-uuid",
      }).success
    ).toBe(false);
  });
  it("accepts a valid UUID patientId", () => {
    expect(
      startTriageSessionSchema.safeParse({
        consentGiven: true,
        patientId: SAMPLE_UUID,
      }).success
    ).toBe(true);
  });
  it("rejects an invalid inputMode", () => {
    expect(
      startTriageSessionSchema.safeParse({
        consentGiven: true,
        inputMode: "video" as any,
      }).success
    ).toBe(false);
  });
  it("accepts both 'text' and 'voice' inputMode values", () => {
    expect(
      startTriageSessionSchema.safeParse({ consentGiven: true, inputMode: "text" }).success
    ).toBe(true);
    expect(
      startTriageSessionSchema.safeParse({ consentGiven: true, inputMode: "voice" }).success
    ).toBe(true);
  });
  it("accepts every bookingFor enum value", () => {
    for (const v of ["SELF", "CHILD", "PARENT", "SIBLING", "OTHER"] as const) {
      expect(
        startTriageSessionSchema.safeParse({ consentGiven: true, bookingFor: v }).success
      ).toBe(true);
    }
  });
  it("rejects an out-of-enum bookingFor value", () => {
    expect(
      startTriageSessionSchema.safeParse({
        consentGiven: true,
        bookingFor: "FRIEND" as any,
      }).success
    ).toBe(false);
  });
  it("accepts dependentPatientId as a non-UUID string (schema does not enforce UUID here)", () => {
    expect(
      startTriageSessionSchema.safeParse({
        consentGiven: true,
        dependentPatientId: "anything-string",
      }).success
    ).toBe(true);
  });
});

describe("triageMessageSchema", () => {
  it("accepts a minimal valid message", () => {
    expect(triageMessageSchema.safeParse({ message: "hi" }).success).toBe(true);
  });
  it("accepts a 2000-char message (upper boundary)", () => {
    expect(
      triageMessageSchema.safeParse({ message: "x".repeat(2000) }).success
    ).toBe(true);
  });
  it("rejects an empty-string message (min(1))", () => {
    expect(triageMessageSchema.safeParse({ message: "" }).success).toBe(false);
  });
  it("rejects a >2000-char message (max(2000))", () => {
    expect(
      triageMessageSchema.safeParse({ message: "x".repeat(2001) }).success
    ).toBe(false);
  });
  it("accepts an optional language code when in the enum", () => {
    expect(
      triageMessageSchema.safeParse({ message: "ok", language: "ta" }).success
    ).toBe(true);
  });
  it("rejects an out-of-enum language code", () => {
    expect(
      triageMessageSchema.safeParse({ message: "ok", language: "fr" as any }).success
    ).toBe(false);
  });
  it("rejects missing message", () => {
    expect(triageMessageSchema.safeParse({}).success).toBe(false);
  });
});

describe("bookFromTriageSchema", () => {
  const valid = {
    doctorId: SAMPLE_UUID,
    date: "2026-05-25",
    slotStart: "09:00",
    slotEnd: "09:30",
    patientId: OTHER_UUID,
  };
  it("accepts a valid booking payload", () => {
    expect(bookFromTriageSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a non-UUID doctorId", () => {
    expect(
      bookFromTriageSchema.safeParse({ ...valid, doctorId: "bad" }).success
    ).toBe(false);
  });
  it("rejects a non-UUID patientId", () => {
    expect(
      bookFromTriageSchema.safeParse({ ...valid, patientId: "bad" }).success
    ).toBe(false);
  });
  it("rejects a date NOT matching YYYY-MM-DD", () => {
    expect(
      bookFromTriageSchema.safeParse({ ...valid, date: "2026/05/25" }).success
    ).toBe(false);
    expect(
      bookFromTriageSchema.safeParse({ ...valid, date: "25-05-2026" }).success
    ).toBe(false);
    expect(
      bookFromTriageSchema.safeParse({ ...valid, date: "2026-5-25" }).success
    ).toBe(false);
  });
  it("rejects a slotStart NOT matching HH:MM", () => {
    expect(
      bookFromTriageSchema.safeParse({ ...valid, slotStart: "9:00" }).success
    ).toBe(false);
    expect(
      bookFromTriageSchema.safeParse({ ...valid, slotStart: "09:00:00" }).success
    ).toBe(false);
  });
  it("rejects a slotEnd NOT matching HH:MM", () => {
    expect(
      bookFromTriageSchema.safeParse({ ...valid, slotEnd: "9-30" }).success
    ).toBe(false);
  });
  it("rejects missing required fields", () => {
    const { doctorId, ...rest } = valid;
    expect(bookFromTriageSchema.safeParse(rest).success).toBe(false);
  });
  it("regex permits syntactically-valid-but-semantically-bogus values (no calendar/clock check)", () => {
    // Documents the contract: regex is shape-only, the route layer is
    // expected to do calendar validation. Avoids future surprise.
    expect(
      bookFromTriageSchema.safeParse({ ...valid, date: "9999-99-99", slotStart: "99:99", slotEnd: "99:99" }).success
    ).toBe(true);
  });
});

describe("startScribeSessionSchema", () => {
  const valid = { appointmentId: SAMPLE_UUID, consentObtained: true };
  it("accepts a minimal valid body (audioRetentionDays defaults to 30)", () => {
    const parsed = startScribeSessionSchema.parse(valid);
    expect(parsed.audioRetentionDays).toBe(30);
  });
  it("rejects a non-UUID appointmentId", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, appointmentId: "not-a-uuid" }).success
    ).toBe(false);
  });
  it("rejects consentObtained=false (literal(true) consent gate)", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, consentObtained: false as any }).success
    ).toBe(false);
  });
  it("rejects missing consentObtained", () => {
    expect(
      startScribeSessionSchema.safeParse({ appointmentId: SAMPLE_UUID }).success
    ).toBe(false);
  });
  it("accepts audioRetentionDays=0 (lower boundary)", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, audioRetentionDays: 0 }).success
    ).toBe(true);
  });
  it("accepts audioRetentionDays=365 (upper boundary)", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, audioRetentionDays: 365 }).success
    ).toBe(true);
  });
  it("rejects audioRetentionDays=-1 (below min)", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, audioRetentionDays: -1 }).success
    ).toBe(false);
  });
  it("rejects audioRetentionDays=366 (above max)", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, audioRetentionDays: 366 }).success
    ).toBe(false);
  });
  it("rejects a non-integer audioRetentionDays", () => {
    expect(
      startScribeSessionSchema.safeParse({ ...valid, audioRetentionDays: 30.5 }).success
    ).toBe(false);
  });
});

describe("addTranscriptChunkSchema", () => {
  const validEntry = {
    speaker: "DOCTOR" as const,
    text: "Patient reports persistent headache.",
    timestamp: "2026-05-25T09:00:00Z",
  };
  it("accepts a single valid entry", () => {
    expect(
      addTranscriptChunkSchema.safeParse({ entries: [validEntry] }).success
    ).toBe(true);
  });
  it("accepts an empty entries array (min(0))", () => {
    expect(addTranscriptChunkSchema.safeParse({ entries: [] }).success).toBe(true);
  });
  it("accepts all four speaker enum values", () => {
    for (const speaker of ["DOCTOR", "PATIENT", "ATTENDANT", "UNKNOWN"] as const) {
      expect(
        addTranscriptChunkSchema.safeParse({ entries: [{ ...validEntry, speaker }] }).success
      ).toBe(true);
    }
  });
  it("rejects an out-of-enum speaker", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, speaker: "NURSE" as any }],
      }).success
    ).toBe(false);
  });
  it("rejects an empty-string text (min(1))", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, text: "" }],
      }).success
    ).toBe(false);
  });
  it("accepts confidence at boundaries 0 and 1", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, confidence: 0 }],
      }).success
    ).toBe(true);
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, confidence: 1 }],
      }).success
    ).toBe(true);
  });
  it("rejects confidence < 0", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, confidence: -0.01 }],
      }).success
    ).toBe(false);
  });
  it("rejects confidence > 1", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ ...validEntry, confidence: 1.01 }],
      }).success
    ).toBe(false);
  });
  it("accepts optional forceRegen flag", () => {
    expect(
      addTranscriptChunkSchema.safeParse({ entries: [], forceRegen: true }).success
    ).toBe(true);
    expect(
      addTranscriptChunkSchema.safeParse({ entries: [], forceRegen: false }).success
    ).toBe(true);
  });
  it("rejects a missing entries array", () => {
    expect(addTranscriptChunkSchema.safeParse({}).success).toBe(false);
  });
  it("rejects an entry with missing required fields", () => {
    expect(
      addTranscriptChunkSchema.safeParse({
        entries: [{ speaker: "DOCTOR", text: "hi" }],
      }).success
    ).toBe(false);
  });
});

describe("scribeSignOffSchema", () => {
  const validSoap = {
    subjective: "S",
    objective: "O",
    assessment: "A",
    plan: "P",
  };
  it("accepts a minimal valid sign-off (defaults fill rxApproved + doctorEdits)", () => {
    const parsed = scribeSignOffSchema.parse({ soapFinal: validSoap });
    expect(parsed.rxApproved).toBe(false);
    expect(parsed.doctorEdits).toEqual([]);
  });
  it("accepts arbitrary value types for each SOAP section (z.any())", () => {
    expect(
      scribeSignOffSchema.safeParse({
        soapFinal: {
          subjective: { complaint: "headache", duration: "2d" },
          objective: [{ bp: "120/80" }],
          assessment: null,
          plan: 42,
        },
      }).success
    ).toBe(true);
  });
  it("rejects a soapFinal missing a required SOAP key", () => {
    expect(
      scribeSignOffSchema.safeParse({
        soapFinal: { subjective: "s", objective: "o", assessment: "a" },
      }).success
    ).toBe(false);
  });
  it("rejects missing soapFinal entirely", () => {
    expect(scribeSignOffSchema.safeParse({}).success).toBe(false);
  });
  it("accepts optional icd10Codes array", () => {
    expect(
      scribeSignOffSchema.safeParse({
        soapFinal: validSoap,
        icd10Codes: ["R51", { code: "J06.9", display: "URI" }],
      }).success
    ).toBe(true);
  });
  it("accepts an explicit rxApproved=true", () => {
    const parsed = scribeSignOffSchema.parse({
      soapFinal: validSoap,
      rxApproved: true,
    });
    expect(parsed.rxApproved).toBe(true);
  });
  it("rejects a non-boolean rxApproved", () => {
    expect(
      scribeSignOffSchema.safeParse({
        soapFinal: validSoap,
        rxApproved: "yes" as any,
      }).success
    ).toBe(false);
  });
  it("accepts arbitrary structures inside doctorEdits", () => {
    expect(
      scribeSignOffSchema.safeParse({
        soapFinal: validSoap,
        doctorEdits: [
          { field: "plan", before: "x", after: "y" },
          "raw-string-edit",
          { nested: { again: true } },
        ],
      }).success
    ).toBe(true);
  });
});
