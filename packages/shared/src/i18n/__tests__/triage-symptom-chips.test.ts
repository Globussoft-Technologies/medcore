// Coverage tests for the triage-symptom-chips i18n bundle.
// What: shape + integrity assertions for SYMPTOM_CHIPS, TRIAGE_UI_STRINGS,
//   LANGUAGE_DISPLAY, plus full-mapping + fallback tests for
//   toSarvamLanguageCode.
// Which modules: imports the constants and helper exclusively from
//   ../triage-symptom-chips and the language-code tuple from
//   ../../validation/ai (the canonical source of supported codes).
// Why: file shipped with 0% coverage and powers the AI-booking / triage
//   surfaces. Regressions in the per-language key set (missing locale,
//   missing chip, drifted complaint vocabulary, broken Sarvam BCP-47
//   mapping) would break the chip row or silently mis-language the ASR
//   call. These tests pin the shape so future translation edits cannot
//   ship a partial bundle.
import { describe, it, expect } from "vitest";
import {
  SYMPTOM_CHIPS,
  TRIAGE_UI_STRINGS,
  LANGUAGE_DISPLAY,
  toSarvamLanguageCode,
  type SymptomChip,
  type TriageUIStrings,
} from "../triage-symptom-chips";
import { TRIAGE_LANGUAGE_CODES, type TriageLanguageCode } from "../../validation/ai";

// Canonical English complaint vocabulary the LLM reasons over.
// Order matters — chips render left-to-right and every locale must mirror
// the English order so the same chip-index means the same complaint.
const CANONICAL_COMPLAINTS = [
  "Fever",
  "Cough",
  "Chest pain",
  "Headache",
  "Abdominal pain",
  "Breathlessness",
  "Vomiting",
  "Diarrhoea",
  "Back pain",
  "Fatigue",
] as const;

const SUPPORTED_LANGS = TRIAGE_LANGUAGE_CODES;

// ───────────────────────────────────────────────────────
// SYMPTOM_CHIPS
// ───────────────────────────────────────────────────────

describe("SYMPTOM_CHIPS map", () => {
  it("covers every supported triage language code", () => {
    for (const code of SUPPORTED_LANGS) {
      expect(SYMPTOM_CHIPS).toHaveProperty(code);
      expect(Array.isArray(SYMPTOM_CHIPS[code])).toBe(true);
    }
  });

  it("does not contain any extra language keys beyond TRIAGE_LANGUAGE_CODES", () => {
    const declaredKeys = Object.keys(SYMPTOM_CHIPS).sort();
    const expectedKeys = [...SUPPORTED_LANGS].sort();
    expect(declaredKeys).toEqual(expectedKeys);
  });

  it("ships exactly 10 chips per locale (the Phase-2 chief-complaint set)", () => {
    for (const code of SUPPORTED_LANGS) {
      expect(SYMPTOM_CHIPS[code]).toHaveLength(10);
    }
  });

  it("uses the canonical English complaint vocabulary in every locale", () => {
    for (const code of SUPPORTED_LANGS) {
      const complaints = SYMPTOM_CHIPS[code].map((c) => c.complaint);
      expect(complaints).toEqual(CANONICAL_COMPLAINTS);
    }
  });

  it("uses the chip-as-label = complaint identity rule only for English", () => {
    for (const chip of SYMPTOM_CHIPS.en) {
      expect(chip.label).toBe(chip.complaint);
    }
  });

  it("non-English locales translate the label (label !== complaint for every chip)", () => {
    for (const code of SUPPORTED_LANGS) {
      if (code === "en") continue;
      for (const chip of SYMPTOM_CHIPS[code]) {
        expect(chip.label).not.toBe(chip.complaint);
      }
    }
  });

  it("every chip has a non-empty label and complaint string", () => {
    for (const code of SUPPORTED_LANGS) {
      for (const chip of SYMPTOM_CHIPS[code]) {
        expect(typeof chip.label).toBe("string");
        expect(chip.label.trim().length).toBeGreaterThan(0);
        expect(typeof chip.complaint).toBe("string");
        expect(chip.complaint.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("labels within a single locale are unique (no duplicate chip text)", () => {
    for (const code of SUPPORTED_LANGS) {
      const labels = SYMPTOM_CHIPS[code].map((c) => c.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("complaints within a single locale are unique (no duplicate chief complaint)", () => {
    for (const code of SUPPORTED_LANGS) {
      const complaints = SYMPTOM_CHIPS[code].map((c) => c.complaint);
      expect(new Set(complaints).size).toBe(complaints.length);
    }
  });

  it("chip objects expose only the SymptomChip contract (label + complaint, no extras)", () => {
    for (const code of SUPPORTED_LANGS) {
      for (const chip of SYMPTOM_CHIPS[code]) {
        const keys = Object.keys(chip).sort();
        expect(keys).toEqual(["complaint", "label"]);
      }
    }
  });

  it("English labels exactly match the canonical complaint vocabulary", () => {
    const labels = SYMPTOM_CHIPS.en.map((c) => c.label);
    expect(labels).toEqual(CANONICAL_COMPLAINTS);
  });
});

// ───────────────────────────────────────────────────────
// TRIAGE_UI_STRINGS
// ───────────────────────────────────────────────────────

describe("TRIAGE_UI_STRINGS map", () => {
  const REQUIRED_KEYS: (keyof TriageUIStrings)[] = [
    "inputPlaceholder",
    "languageLabel",
    "languagePickerAria",
    "symptomChipsLabel",
  ];

  it("covers every supported triage language code", () => {
    for (const code of SUPPORTED_LANGS) {
      expect(TRIAGE_UI_STRINGS).toHaveProperty(code);
    }
  });

  it("does not contain any extra language keys beyond TRIAGE_LANGUAGE_CODES", () => {
    const declaredKeys = Object.keys(TRIAGE_UI_STRINGS).sort();
    const expectedKeys = [...SUPPORTED_LANGS].sort();
    expect(declaredKeys).toEqual(expectedKeys);
  });

  it("exposes the full TriageUIStrings contract in every locale", () => {
    for (const code of SUPPORTED_LANGS) {
      const entry = TRIAGE_UI_STRINGS[code];
      for (const key of REQUIRED_KEYS) {
        expect(entry).toHaveProperty(key);
        expect(typeof entry[key]).toBe("string");
        expect(entry[key].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("does not expose any extra keys per locale beyond the contract", () => {
    const expected = [...REQUIRED_KEYS].sort();
    for (const code of SUPPORTED_LANGS) {
      const keys = Object.keys(TRIAGE_UI_STRINGS[code]).sort();
      expect(keys).toEqual(expected);
    }
  });

  it("English inputPlaceholder is the documented prompt", () => {
    expect(TRIAGE_UI_STRINGS.en.inputPlaceholder).toBe("Describe your symptoms...");
  });
});

// ───────────────────────────────────────────────────────
// LANGUAGE_DISPLAY
// ───────────────────────────────────────────────────────

describe("LANGUAGE_DISPLAY map", () => {
  it("covers every supported triage language code", () => {
    for (const code of SUPPORTED_LANGS) {
      expect(LANGUAGE_DISPLAY).toHaveProperty(code);
    }
  });

  it("does not contain any extra language keys beyond TRIAGE_LANGUAGE_CODES", () => {
    const declaredKeys = Object.keys(LANGUAGE_DISPLAY).sort();
    const expectedKeys = [...SUPPORTED_LANGS].sort();
    expect(declaredKeys).toEqual(expectedKeys);
  });

  it("each entry has non-empty englishName and nativeName strings", () => {
    for (const code of SUPPORTED_LANGS) {
      const entry = LANGUAGE_DISPLAY[code];
      expect(typeof entry.englishName).toBe("string");
      expect(entry.englishName.trim().length).toBeGreaterThan(0);
      expect(typeof entry.nativeName).toBe("string");
      expect(entry.nativeName.trim().length).toBeGreaterThan(0);
    }
  });

  it("English is the only locale where englishName === nativeName", () => {
    for (const code of SUPPORTED_LANGS) {
      const { englishName, nativeName } = LANGUAGE_DISPLAY[code];
      if (code === "en") {
        expect(englishName).toBe(nativeName);
      } else {
        expect(englishName).not.toBe(nativeName);
      }
    }
  });

  it("englishName values are unique across locales (no two languages share a name)", () => {
    const names = SUPPORTED_LANGS.map((c) => LANGUAGE_DISPLAY[c].englishName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("nativeName values are unique across locales", () => {
    const names = SUPPORTED_LANGS.map((c) => LANGUAGE_DISPLAY[c].nativeName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins the documented englishName for each locale", () => {
    expect(LANGUAGE_DISPLAY.en.englishName).toBe("English");
    expect(LANGUAGE_DISPLAY.hi.englishName).toBe("Hindi");
    expect(LANGUAGE_DISPLAY.ta.englishName).toBe("Tamil");
    expect(LANGUAGE_DISPLAY.te.englishName).toBe("Telugu");
    expect(LANGUAGE_DISPLAY.bn.englishName).toBe("Bengali");
    expect(LANGUAGE_DISPLAY.mr.englishName).toBe("Marathi");
    expect(LANGUAGE_DISPLAY.kn.englishName).toBe("Kannada");
    expect(LANGUAGE_DISPLAY.ml.englishName).toBe("Malayalam");
  });
});

// ───────────────────────────────────────────────────────
// Cross-map consistency
// ───────────────────────────────────────────────────────

describe("cross-map consistency", () => {
  it("SYMPTOM_CHIPS, TRIAGE_UI_STRINGS, and LANGUAGE_DISPLAY share the same language key set", () => {
    const chipKeys = Object.keys(SYMPTOM_CHIPS).sort();
    const uiKeys = Object.keys(TRIAGE_UI_STRINGS).sort();
    const displayKeys = Object.keys(LANGUAGE_DISPLAY).sort();
    expect(uiKeys).toEqual(chipKeys);
    expect(displayKeys).toEqual(chipKeys);
  });
});

// ───────────────────────────────────────────────────────
// toSarvamLanguageCode
// ───────────────────────────────────────────────────────

describe("toSarvamLanguageCode", () => {
  // Documented mapping per the JSDoc on the helper.
  const EXPECTED_MAPPING: Record<TriageLanguageCode, string> = {
    en: "en-IN",
    hi: "hi-IN",
    ta: "ta-IN",
    te: "te-IN",
    bn: "bn-IN",
    mr: "mr-IN",
    kn: "kn-IN",
    ml: "ml-IN",
  };

  for (const code of SUPPORTED_LANGS) {
    it(`maps ${code} -> ${EXPECTED_MAPPING[code]} (BCP-47 Indian variant)`, () => {
      expect(toSarvamLanguageCode(code)).toBe(EXPECTED_MAPPING[code]);
    });
  }

  it("falls back to en-IN for an unknown string code", () => {
    expect(toSarvamLanguageCode("xx")).toBe("en-IN");
    expect(toSarvamLanguageCode("fr")).toBe("en-IN");
    expect(toSarvamLanguageCode("zh-CN")).toBe("en-IN");
  });

  it("falls back to en-IN for the empty string", () => {
    expect(toSarvamLanguageCode("")).toBe("en-IN");
  });

  it("does NOT echo the input — return value is always a BCP-47 *-IN tag", () => {
    for (const code of SUPPORTED_LANGS) {
      const out = toSarvamLanguageCode(code);
      expect(out).toMatch(/^[a-z]{2}-IN$/);
    }
  });

  it("returns a string of the expected shape even for the fallback path", () => {
    const out = toSarvamLanguageCode("definitely-not-a-language-code");
    expect(out).toMatch(/^[a-z]{2}-IN$/);
  });

  it("is case-sensitive — uppercase codes hit the fallback (matches sarvam.ts resolveLanguageSuffix)", () => {
    // The switch uses string-literal matching, so "EN" is NOT recognised
    // and must fall through to the en-IN default. This pins the current
    // behaviour so a future refactor that adds case-folding is a
    // deliberate, reviewed change.
    expect(toSarvamLanguageCode("EN")).toBe("en-IN");
    expect(toSarvamLanguageCode("HI")).toBe("en-IN");
  });
});

// ───────────────────────────────────────────────────────
// SymptomChip type-shape smoke test
// ───────────────────────────────────────────────────────

describe("SymptomChip type", () => {
  it("structural assignment from a SYMPTOM_CHIPS entry satisfies the SymptomChip contract", () => {
    const chip: SymptomChip = SYMPTOM_CHIPS.en[0];
    expect(chip.label).toBeDefined();
    expect(chip.complaint).toBeDefined();
  });
});
