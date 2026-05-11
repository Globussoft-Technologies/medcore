// Unit tests for SNOMED-CT specialty mapping (PRD §3.5.4 / §3.7.1).
// Uses the pure `scoreSymptomsAgainstConcepts` function with a mocked
// concept list so nothing touches the DB or the filesystem.

import { describe, it, expect, vi } from "vitest";

// Mock @medcore/db BEFORE importing snomed-mapping so the import-time
// `prisma` symbol points to a noop client — these tests exercise only
// the pure scoring core.
vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: {} }));

import {
  scoreSymptomsAgainstConcepts,
  normaliseSpecialty,
  reconcileSpecialties,
  loadSnomedFromJson,
  _resetSnomedCache,
  type SnomedConcept,
} from "./snomed-mapping";

// ── Test fixture — compact synthetic SNOMED list ─────────────────────────────

const FIXTURE: SnomedConcept[] = [
  {
    conceptId: "25064002",
    term: "Headache",
    synonyms: ["Cephalgia", "सिरदर्द", "sar dard"],
    specialtyTags: ["GENERAL_MEDICINE", "NEUROLOGY"],
    redFlagTerms: ["thunderclap", "worst headache"],
    category: "neurological",
  },
  {
    conceptId: "29857009",
    term: "Chest pain",
    synonyms: ["Thoracic pain", "सीने में दर्द", "seene mein dard"],
    specialtyTags: ["CARDIOLOGY", "GENERAL_MEDICINE", "PULMONOLOGY"],
    redFlagTerms: ["crushing chest", "radiating to arm"],
    category: "cardiac",
  },
  {
    conceptId: "386661006",
    term: "Fever",
    synonyms: ["Pyrexia", "बुखार", "bukhar"],
    specialtyTags: ["GENERAL_MEDICINE", "INTERNAL_MEDICINE"],
    redFlagTerms: [],
    category: "constitutional",
  },
  {
    conceptId: "80313002",
    term: "Palpitations",
    synonyms: ["Racing heart", "धड़कन बढ़ना"],
    specialtyTags: ["CARDIOLOGY"],
    redFlagTerms: ["palpitations with syncope"],
    category: "cardiac",
  },
];

// ── Core scoring behaviour ───────────────────────────────────────────────────

describe("scoreSymptomsAgainstConcepts — basic token match", () => {
  it("maps an exact symptom to the expected specialty set", () => {
    const r = scoreSymptomsAgainstConcepts(["headache"], FIXTURE);
    const tags = r.specialties.map((s) => s.specialty);
    expect(tags).toContain("GENERAL_MEDICINE");
    expect(tags).toContain("NEUROLOGY");
    // Both specialties should score the full exact-match weight (1.0).
    expect(r.specialties.find((s) => s.specialty === "NEUROLOGY")!.score).toBe(1);
  });

  it("links the matched conceptId back to each specialty", () => {
    const r = scoreSymptomsAgainstConcepts(["chest pain"], FIXTURE);
    const cardiology = r.specialties.find((s) => s.specialty === "CARDIOLOGY");
    expect(cardiology).toBeDefined();
    expect(cardiology!.snomedMatches).toEqual(["29857009"]);
  });

  it("returns an empty specialty list for an unknown symptom", () => {
    const r = scoreSymptomsAgainstConcepts(["xyzzy gibberish"], FIXTURE);
    expect(r.specialties).toEqual([]);
    expect(r.matchedConceptIds).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    const r = scoreSymptomsAgainstConcepts([], FIXTURE);
    expect(r.specialties).toEqual([]);
  });

  it("is case-insensitive on the symptom", () => {
    const r = scoreSymptomsAgainstConcepts(["HEADACHE"], FIXTURE);
    expect(r.specialties.find((s) => s.specialty === "NEUROLOGY")).toBeDefined();
  });
});

// ── Hindi synonym matching ───────────────────────────────────────────────────

describe("scoreSymptomsAgainstConcepts — Hindi synonyms", () => {
  it("matches Devanagari Hindi synonym", () => {
    const r = scoreSymptomsAgainstConcepts(["सिरदर्द"], FIXTURE);
    expect(r.specialties.find((s) => s.specialty === "NEUROLOGY")).toBeDefined();
    // Synonym weight is 0.9, so the NEUROLOGY score should reflect that.
    expect(r.specialties.find((s) => s.specialty === "NEUROLOGY")!.score).toBeCloseTo(0.9, 3);
  });

  it("matches Romanised Hindi synonym", () => {
    const r = scoreSymptomsAgainstConcepts(["seene mein dard"], FIXTURE);
    expect(r.specialties.find((s) => s.specialty === "CARDIOLOGY")).toBeDefined();
  });

  it("matches Hindi synonym embedded in longer free-text", () => {
    const r = scoreSymptomsAgainstConcepts(["bahut tez bukhar aa raha hai"], FIXTURE);
    // Substring hit on "bukhar" → fever → GENERAL_MEDICINE + INTERNAL_MEDICINE
    expect(r.specialties.find((s) => s.specialty === "GENERAL_MEDICINE")).toBeDefined();
  });
});

// ── Multi-symptom aggregation ────────────────────────────────────────────────

describe("scoreSymptomsAgainstConcepts — aggregation", () => {
  it("accumulates scores across multiple symptoms", () => {
    const r = scoreSymptomsAgainstConcepts(["chest pain", "palpitations"], FIXTURE);
    const cardio = r.specialties.find((s) => s.specialty === "CARDIOLOGY");
    expect(cardio).toBeDefined();
    // Chest pain (1.0) + Palpitations (1.0) = 2.0 for CARDIOLOGY.
    expect(cardio!.score).toBe(2);
    // And the snomedMatches list should carry BOTH conceptIds.
    expect(cardio!.snomedMatches).toEqual(["29857009", "80313002"]);
  });

  it("sorts specialties by score descending", () => {
    const r = scoreSymptomsAgainstConcepts(["chest pain", "palpitations"], FIXTURE);
    const scores = r.specialties.map((s) => s.score);
    const sortedDesc = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sortedDesc);
    // Cardiology should dominate when both symptoms are cardiac.
    expect(r.specialties[0].specialty).toBe("CARDIOLOGY");
  });

  it("dedupes concept ids per specialty when the same concept matches twice", () => {
    const r = scoreSymptomsAgainstConcepts(["chest pain", "Chest pain"], FIXTURE);
    const cardio = r.specialties.find((s) => s.specialty === "CARDIOLOGY")!;
    expect(cardio.snomedMatches).toEqual(["29857009"]);
  });
});

// ── Red-flag surfacing ───────────────────────────────────────────────────────

describe("scoreSymptomsAgainstConcepts — red-flag surfacing", () => {
  it("returns red-flag terms separately from specialty scoring", () => {
    const r = scoreSymptomsAgainstConcepts(["headache", "chest pain"], FIXTURE);
    // Both concepts contribute red-flag terms, collected into a separate field.
    expect(r.redFlagTerms).toContain("thunderclap");
    expect(r.redFlagTerms).toContain("worst headache");
    expect(r.redFlagTerms).toContain("crushing chest");
    expect(r.redFlagTerms).toContain("radiating to arm");
  });

  it("does not conflate red-flag terms with specialty scores", () => {
    // The palpitations concept has a red-flag term with the word
    // "palpitations" in it, but that term must NOT double-count into the
    // specialty score — the specialty contribution is ONLY from specialtyTags.
    const r = scoreSymptomsAgainstConcepts(["palpitations"], FIXTURE);
    expect(r.specialties.find((s) => s.specialty === "CARDIOLOGY")!.score).toBe(1);
    expect(r.redFlagTerms).toContain("palpitations with syncope");
  });

  it("returns empty redFlagTerms when no matched concept has any", () => {
    const r = scoreSymptomsAgainstConcepts(["fever"], FIXTURE);
    expect(r.redFlagTerms).toEqual([]);
  });
});

// ── Normalisation guarantees ─────────────────────────────────────────────────

describe("normaliseSpecialty", () => {
  it("upper-cases and snake-cases free-text specialty strings", () => {
    expect(normaliseSpecialty("General Physician")).toBe("GENERAL_PHYSICIAN");
    expect(normaliseSpecialty("cardiology")).toBe("CARDIOLOGY");
    expect(normaliseSpecialty("ENT / Otolaryngology")).toBe("ENT_OTOLARYNGOLOGY");
    expect(normaliseSpecialty("  Internal Medicine  ")).toBe("INTERNAL_MEDICINE");
  });

  it("fixture specialty tags are already normalised", () => {
    for (const c of FIXTURE) {
      for (const t of c.specialtyTags) {
        expect(t).toBe(normaliseSpecialty(t));
        expect(t).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  it("scored output specialties are normalised", () => {
    const r = scoreSymptomsAgainstConcepts(["fever"], FIXTURE);
    for (const s of r.specialties) {
      expect(s.specialty).toMatch(/^[A-Z0-9_]+$/);
    }
  });
});

// ── Dataset integrity (loads the real JSON) ──────────────────────────────────

describe("loadSnomedFromJson — dataset integrity", () => {
  it("loads the curated dataset with no duplicate conceptIds", () => {
    _resetSnomedCache();
    const concepts = loadSnomedFromJson();
    expect(concepts.length).toBeGreaterThanOrEqual(80);
    const ids = new Set<string>();
    for (const c of concepts) {
      expect(ids.has(c.conceptId)).toBe(false);
      ids.add(c.conceptId);
    }
  });

  it("every dataset specialty tag is already normalised (SCREAMING_SNAKE)", () => {
    _resetSnomedCache();
    const concepts = loadSnomedFromJson();
    for (const c of concepts) {
      for (const tag of c.specialtyTags) {
        expect(tag).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(tag).toBe(normaliseSpecialty(tag));
      }
    }
  });

  it("every concept has at least one specialty tag", () => {
    _resetSnomedCache();
    const concepts = loadSnomedFromJson();
    for (const c of concepts) {
      expect(c.specialtyTags.length).toBeGreaterThan(0);
    }
  });

  it("covers the core PRD-listed categories", () => {
    _resetSnomedCache();
    const concepts = loadSnomedFromJson();
    const cats = new Set(concepts.map((c) => c.category));
    // Coverage smoke-test — the exhaustive list is in the JSON file.
    for (const required of [
      "cardiac",
      "respiratory",
      "gastrointestinal",
      "neurological",
      "musculoskeletal",
      "dermatological",
      "obstetric",
      "paediatric",
    ]) {
      expect(cats.has(required)).toBe(true);
    }
  });
});

// ── Reconciliation with LLM ──────────────────────────────────────────────────

describe("reconcileSpecialties", () => {
  it("finds the agreed set when LLM and SNOMED overlap", () => {
    const snomed = scoreSymptomsAgainstConcepts(["chest pain"], FIXTURE).specialties;
    const r = reconcileSpecialties(["Cardiology", "General Medicine"], snomed);
    expect(r.agreed).toContain("CARDIOLOGY");
    expect(r.agreed).toContain("GENERAL_MEDICINE");
    // Pulmonology came only from SNOMED, so it's in snomedOnly.
    expect(r.snomedOnly).toContain("PULMONOLOGY");
    // LLM and SNOMED differ → disagreement flag is true (even though there
    // IS overlap on Cardiology and General Medicine).
    expect(r.disagreement).toBe(true);
  });

  it("flags no disagreement when the two sets match exactly", () => {
    const snomed = scoreSymptomsAgainstConcepts(["fever"], FIXTURE).specialties;
    const r = reconcileSpecialties(["General Medicine", "Internal Medicine"], snomed);
    expect(r.disagreement).toBe(false);
    expect(r.llmOnly).toEqual([]);
    expect(r.snomedOnly).toEqual([]);
  });

  it("handles empty SNOMED matches (LLM-only)", () => {
    const r = reconcileSpecialties(["Dermatology"], []);
    expect(r.agreed).toEqual([]);
    expect(r.llmOnly).toEqual(["DERMATOLOGY"]);
    expect(r.snomedOnly).toEqual([]);
    expect(r.disagreement).toBe(true);
  });
});

// ── Purity guarantee (no DB access in tests) ─────────────────────────────────

describe("scoreSymptomsAgainstConcepts — purity", () => {
  it("produces identical output across repeated calls with the same inputs", () => {
    const a = scoreSymptomsAgainstConcepts(["chest pain", "fever"], FIXTURE);
    const b = scoreSymptomsAgainstConcepts(["chest pain", "fever"], FIXTURE);
    expect(a).toEqual(b);
  });

  it("does not mutate the input concept list", () => {
    const snapshot = JSON.parse(JSON.stringify(FIXTURE));
    scoreSymptomsAgainstConcepts(["headache"], FIXTURE);
    expect(FIXTURE).toEqual(snapshot);
  });

  it("does not mutate the input symptoms list", () => {
    const inputs = ["headache", "fever"];
    const snapshot = [...inputs];
    scoreSymptomsAgainstConcepts(inputs, FIXTURE);
    expect(inputs).toEqual(snapshot);
  });
});
