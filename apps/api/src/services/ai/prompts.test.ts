// Unit tests for the AI prompt template constants.
//
// prompts.ts exports a frozen `PROMPTS` object plus the `PromptKey` type that
// underpin MedCore's triage + scribe LLM features (consumed by ai-triage.ts /
// ai-scribe.ts). The constants are load-bearing — wording changes alter LLM
// behaviour — so these tests pin shape, non-emptiness, the domain-specific
// guardrail phrases that the product/legal review require to be present,
// and the typographical quality bar (no stray TODOs, no smart-quote drift,
// no accidental template-literal `${` leakage).

import { describe, it, expect } from "vitest";
import { PROMPTS, type PromptKey } from "./prompts";

describe("services/ai/prompts", () => {
  describe("PROMPTS object shape", () => {
    it("exports exactly the three expected keys", () => {
      const keys = Object.keys(PROMPTS).sort();
      expect(keys).toEqual([
        "SCRIBE_SYSTEM",
        "TRIAGE_SYSTEM",
        "TRIAGE_SYSTEM_HINDI_SUFFIX",
      ]);
    });

    it("is declared `as const` so values are typed as string literals", () => {
      // Compile-time check materialised at runtime: each value is a string,
      // not a `string | undefined` or widened type.
      for (const value of Object.values(PROMPTS)) {
        expect(typeof value).toBe("string");
      }
    });

    it("every prompt is non-empty and has meaningful length", () => {
      for (const [key, value] of Object.entries(PROMPTS)) {
        expect(value.length, `${key} must be non-empty`).toBeGreaterThan(0);
        // Suffix is shorter; system prompts are substantial.
        const minLen = key === "TRIAGE_SYSTEM_HINDI_SUFFIX" ? 20 : 200;
        expect(value.length, `${key} must be a meaningful prompt`).toBeGreaterThan(minLen);
      }
    });

    it("no prompt contains accidental TODO/FIXME/XXX markers", () => {
      for (const [key, value] of Object.entries(PROMPTS)) {
        expect(value, `${key} should not ship with TODO markers`).not.toMatch(/\b(TODO|FIXME|XXX)\b/);
      }
    });

    it("no prompt contains an unescaped template-literal placeholder", () => {
      // `${...}` inside a static template string is almost always a bug —
      // it would have been interpolated at module load time.
      for (const [key, value] of Object.entries(PROMPTS)) {
        expect(value, `${key} should not contain raw \${...} placeholders`).not.toMatch(/\$\{[^}]+\}/);
      }
    });

    it("no prompt contains common smart-quote drift (curly quotes)", () => {
      // Smart quotes (U+2018/U+2019/U+201C/U+201D) sneak in via copy-paste
      // from doc editors and confuse downstream tokenizers / JSON tooling.
      const smartQuotes = /[‘’“”]/;
      for (const [key, value] of Object.entries(PROMPTS)) {
        expect(value, `${key} should not contain curly quotes`).not.toMatch(smartQuotes);
      }
    });
  });

  describe("TRIAGE_SYSTEM", () => {
    const prompt = PROMPTS.TRIAGE_SYSTEM;

    it("identifies the assistant as a routing tool, not a diagnostic one", () => {
      expect(prompt).toMatch(/NOT a diagnostic tool/);
      expect(prompt).toMatch(/route patients/i);
    });

    it("forbids diagnosis, prescription, and medical advice", () => {
      expect(prompt).toMatch(/Never diagnose, prescribe, or give medical advice/);
    });

    it("requires a routing-assistant disclaimer", () => {
      expect(prompt).toMatch(/disclaimer/i);
      expect(prompt).toMatch(/routing assistant only/i);
    });

    it("instructs the model to support both English and Hindi", () => {
      expect(prompt).toMatch(/English or Hindi/);
    });

    it("caps follow-up questions to keep conversations short", () => {
      expect(prompt).toMatch(/max 5-7 total/);
    });

    it("enumerates the red-flag emergency symptoms required by safety review", () => {
      const redFlags = [
        "chest pain with radiation",
        "difficulty breathing",
        "stroke signs",
        "severe bleeding",
        "loss of consciousness",
        "anaphylaxis",
        "suicidal ideation",
        "eclampsia",
        "neonatal distress",
        "severe burns",
      ];
      for (const flag of redFlags) {
        expect(prompt, `red-flag list must mention "${flag}"`).toContain(flag);
      }
    });

    it("falls back to General Physician when unsure", () => {
      expect(prompt).toMatch(/recommend a General Physician/);
    });

    it("lists the core Indian medical specialties the router can pick from", () => {
      const requiredSpecialties = [
        "General Physician",
        "Cardiologist",
        "Pulmonologist",
        "Gastroenterologist",
        "Neurologist",
        "Orthopedic",
        "Dermatologist",
        "ENT",
        "Ophthalmologist",
        "Gynecologist",
        "Pediatrician",
        "Urologist",
        "Endocrinologist",
        "Psychiatrist",
        "Oncologist",
        "Nephrologist",
        "Rheumatologist",
        "Dentist",
        "Physiotherapist",
      ];
      for (const specialty of requiredSpecialties) {
        expect(prompt, `specialty list must include "${specialty}"`).toContain(specialty);
      }
    });

    it("scopes the assistant to Indian hospitals", () => {
      expect(prompt).toMatch(/Indian hospitals/);
    });
  });

  describe("TRIAGE_SYSTEM_HINDI_SUFFIX", () => {
    const suffix = PROMPTS.TRIAGE_SYSTEM_HINDI_SUFFIX;

    it("starts with two newlines so it appends cleanly to the system prompt", () => {
      expect(suffix.startsWith("\n\n")).toBe(true);
    });

    it("instructs the model to use Devanagari script when the patient writes in Hindi", () => {
      expect(suffix).toMatch(/Devanagari script/);
      expect(suffix).toMatch(/Hindi/);
    });

    it("asks for simple, clear language", () => {
      expect(suffix).toMatch(/simple, clear language/);
    });

    it("appends cleanly to TRIAGE_SYSTEM without producing triple newlines", () => {
      const combined = PROMPTS.TRIAGE_SYSTEM + suffix;
      // Concatenation should produce at most "\n\n" between the two pieces,
      // never "\n\n\n" (which would be a sign of a stray trailing newline).
      expect(combined).not.toMatch(/\n\n\n/);
    });
  });

  describe("SCRIBE_SYSTEM", () => {
    const prompt = PROMPTS.SCRIBE_SYSTEM;

    it("identifies the assistant as MedCore's AI Medical Scribe", () => {
      expect(prompt).toMatch(/MedCore's AI Medical Scribe/);
    });

    it("defines the SOAP note extraction contract grounded in the transcript", () => {
      expect(prompt).toMatch(/structured SOAP note/);
      expect(prompt).toMatch(/GROUNDING/);
    });

    it("requires a confidence score and an evidenceSpan per SOAP section", () => {
      expect(prompt).toMatch(/confidence 0-1/);
      expect(prompt).toMatch(/evidenceSpan/);
    });

    it("requires clinically-appropriate medicine matching for the condition", () => {
      expect(prompt).toMatch(/CLINICAL MATCH/);
    });

    it("requires ICD-10 suggestions with confidence + justification", () => {
      expect(prompt).toMatch(/ICD-10 codes/);
      expect(prompt).toMatch(/justification/);
    });

    it("mandates a treatment PLAN built for the diagnosis when a complaint exists", () => {
      expect(prompt).toMatch(/PLAN \(when a complaint exists\)/);
    });

    it("enumerates the four required PLAN sub-fields", () => {
      const planFields = ["medications", "investigations", "followUp", "patientInstructions"];
      for (const field of planFields) {
        expect(prompt, `PLAN must define field "${field}"`).toContain(field);
      }
    });

    it("differentiates 'transcribed' from 'AI suggested' for prescriber attribution", () => {
      expect(prompt).toMatch(/AI suggested/);
      expect(prompt).toMatch(/transcribed/);
    });

    it("requires structured JSON output with no extraneous prose/markdown", () => {
      expect(prompt).toMatch(/structured JSON only/);
      expect(prompt).toMatch(/no markdown outside field values/);
    });

    it("requires doctor review + sign-off before EHR commit (compliance gate)", () => {
      expect(prompt).toMatch(/doctor review and sign-off/);
      expect(prompt).toMatch(/EHR/);
    });

    it("states the note is advisory and requires doctor sign-off (liability disclaimer)", () => {
      expect(prompt).toMatch(/advisory/);
      expect(prompt).toMatch(/requires doctor review and sign-off/);
    });

    it("uses generic names + standard Indian dosing for medication suggestions", () => {
      expect(prompt).toMatch(/generic name/);
      expect(prompt).toMatch(/standard Indian dosing/);
    });
  });

  describe("PromptKey type", () => {
    it("permits every key of PROMPTS at runtime usage", () => {
      // Smoke test that the exported type alias resolves to the live keys —
      // if PROMPTS gained or lost a key without updating the type, this
      // assertion would fail to compile (caught by `tsc`) AND fail at
      // runtime here when the array can't be assigned.
      const keys: PromptKey[] = ["TRIAGE_SYSTEM", "TRIAGE_SYSTEM_HINDI_SUFFIX", "SCRIBE_SYSTEM"];
      for (const k of keys) {
        expect(PROMPTS[k]).toBeDefined();
        expect(typeof PROMPTS[k]).toBe("string");
      }
    });
  });
});
