// Drug safety eval fixtures.
//
// 15 cases covering DDI, allergy, condition contraindication, paediatric,
// renal, hepatic. All claims drawn from Goodman & Gilman's, Stockley's
// Drug Interactions, IAP guidelines, and BNF. Cases I was unsure about
// are dropped rather than guessed.
//
// expectedAlerts is a list of substring keywords; the runner does
// case-insensitive containment over generated alert descriptions/drug
// pairs. We don't insist on every keyword — see runDrugSafetyEval for
// the per-case hit-rate.

export type SafetyCategory =
  | "DDI"
  | "ALLERGY"
  | "CONDITION"
  | "PAEDIATRIC"
  | "RENAL"
  | "HEPATIC";

export interface DrugSafetyCase {
  id: string;
  description: string;
  category: SafetyCategory;
  patientContext: {
    age?: number;
    gender?: string;
    weightKg?: number;
    eGFR?: number;
    hepaticImpairment?: "mild" | "moderate" | "severe" | null;
    pregnancyWeeks?: number;
    allergies: string[];
    currentMedications: string[];
    chronicConditions: string[];
  };
  prescription: { name: string; dose: string; frequency: string; duration: string }[];
  /** Substring keywords expected to appear somewhere in the alert output (case-insensitive). */
  expectedAlerts: string[];
  /** When true, the runner expects at least one CONTRAINDICATED-severity alert. */
  expectContraindicated?: boolean;
  /** When true, the runner expects at least one SEVERE-severity alert. */
  expectSevere?: boolean;
  clinicalRationale: string;
}

export const DRUG_SAFETY_CASES: DrugSafetyCase[] = [
  // ── DDI ─────────────────────────────────────────────────────────────────────
  {
    id: "ds-warfarin-aspirin",
    description: "Warfarin + Aspirin — bleeding risk",
    category: "DDI",
    patientContext: {
      age: 68,
      allergies: [],
      currentMedications: ["Warfarin 3mg"],
      chronicConditions: ["Atrial Fibrillation"],
    },
    prescription: [{ name: "Aspirin 75mg", dose: "75mg", frequency: "OD", duration: "30 days" }],
    expectedAlerts: ["warfarin", "aspirin", "bleeding"],
    expectSevere: true,
    clinicalRationale: "Anticoagulant + NSAID/antiplatelet — significantly increased GI/intracranial bleed risk.",
  },
  {
    id: "ds-ssri-tramadol",
    description: "SSRI + Tramadol — serotonin syndrome",
    category: "DDI",
    patientContext: {
      age: 42,
      allergies: [],
      currentMedications: ["Sertraline 50mg"],
      chronicConditions: ["Depression"],
    },
    prescription: [{ name: "Tramadol 50mg", dose: "50mg", frequency: "BD", duration: "5 days" }],
    expectedAlerts: ["tramadol", "serotonin"],
    expectSevere: true,
    clinicalRationale: "SSRI + tramadol — risk of serotonin syndrome.",
  },
  {
    id: "ds-sildenafil-nitrate",
    description: "Sildenafil + Nitrate — fatal hypotension (CONTRAINDICATED)",
    category: "DDI",
    patientContext: {
      age: 60,
      allergies: [],
      currentMedications: ["Isosorbide mononitrate 20mg"],
      chronicConditions: ["Angina"],
    },
    prescription: [{ name: "Sildenafil 50mg", dose: "50mg", frequency: "PRN", duration: "as needed" }],
    expectedAlerts: ["sildenafil", "nitrate", "hypotension"],
    expectContraindicated: true,
    clinicalRationale: "PDE5 + nitrate — severe potentially fatal hypotension; absolute contraindication.",
  },
  {
    id: "ds-clopidogrel-omeprazole",
    description: "Clopidogrel + Omeprazole — reduced antiplatelet activity",
    category: "DDI",
    patientContext: {
      age: 65,
      allergies: [],
      currentMedications: ["Clopidogrel 75mg"],
      chronicConditions: ["Coronary Artery Disease"],
    },
    prescription: [{ name: "Omeprazole 20mg", dose: "20mg", frequency: "OD", duration: "30 days" }],
    expectedAlerts: ["clopidogrel", "omeprazole"],
    clinicalRationale: "Omeprazole inhibits CYP2C19 needed for clopidogrel activation; pantoprazole preferred.",
  },

  // ── Allergy ─────────────────────────────────────────────────────────────────
  {
    id: "ds-penicillin-allergy-amoxicillin",
    description: "Penicillin allergy + Amoxicillin",
    category: "ALLERGY",
    patientContext: {
      age: 35,
      allergies: ["Penicillin"],
      currentMedications: [],
      chronicConditions: [],
    },
    prescription: [{ name: "Amoxicillin 500mg", dose: "500mg", frequency: "TDS", duration: "5 days" }],
    expectedAlerts: ["penicillin", "amoxicillin"],
    expectSevere: true,
    clinicalRationale: "Amoxicillin is a penicillin — direct contraindication.",
  },
  {
    id: "ds-sulfa-allergy-cotrimoxazole",
    description: "Sulfa allergy + Co-trimoxazole",
    category: "ALLERGY",
    patientContext: {
      age: 40,
      allergies: ["Sulfa"],
      currentMedications: [],
      chronicConditions: [],
    },
    prescription: [
      { name: "Co-trimoxazole 800/160mg", dose: "1 tab", frequency: "BD", duration: "7 days" },
    ],
    expectedAlerts: ["sulfa", "co-trimoxazole"],
    clinicalRationale: "Co-trimoxazole contains sulfamethoxazole — sulfa cross-reactivity.",
  },
  {
    id: "ds-aspirin-allergy-ibuprofen",
    description: "Aspirin allergy + Ibuprofen — NSAID cross-reactivity",
    category: "ALLERGY",
    patientContext: {
      age: 50,
      allergies: ["Aspirin"],
      currentMedications: [],
      chronicConditions: [],
    },
    prescription: [{ name: "Ibuprofen 400mg", dose: "400mg", frequency: "TDS", duration: "5 days" }],
    expectedAlerts: ["nsaid", "aspirin"],
    clinicalRationale: "Aspirin-exacerbated respiratory disease — NSAID cross-reactivity.",
  },

  // ── Condition contraindication ──────────────────────────────────────────────
  {
    id: "ds-asthma-propranolol",
    description: "Asthma + Propranolol — bronchospasm",
    category: "CONDITION",
    patientContext: {
      age: 45,
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Asthma"],
    },
    prescription: [{ name: "Propranolol 40mg", dose: "40mg", frequency: "BD", duration: "30 days" }],
    expectedAlerts: ["asthma", "propranolol", "bronchospasm"],
    expectSevere: true,
    clinicalRationale: "Non-cardioselective beta-blocker can precipitate severe bronchospasm in asthma.",
  },
  {
    id: "ds-pregnancy-warfarin",
    description: "Pregnancy + Warfarin — teratogenic",
    category: "CONDITION",
    patientContext: {
      age: 30,
      gender: "F",
      pregnancyWeeks: 12,
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Pregnancy"],
    },
    prescription: [{ name: "Warfarin 5mg", dose: "5mg", frequency: "OD", duration: "long-term" }],
    expectedAlerts: ["warfarin", "pregnancy"],
    expectContraindicated: true,
    clinicalRationale: "Warfarin is teratogenic and fetotoxic — contraindicated; use LMWH.",
  },
  {
    id: "ds-pud-nsaid",
    description: "Active peptic ulcer + Diclofenac",
    category: "CONDITION",
    patientContext: {
      age: 55,
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Peptic Ulcer Disease"],
    },
    prescription: [{ name: "Diclofenac 50mg", dose: "50mg", frequency: "TDS", duration: "5 days" }],
    expectedAlerts: ["nsaid", "peptic ulcer"],
    expectSevere: true,
    clinicalRationale: "NSAIDs in PUD — high risk of GI haemorrhage.",
  },

  // ── Paediatric ──────────────────────────────────────────────────────────────
  {
    id: "ds-paed-aspirin",
    description: "8-year-old + Aspirin — Reye's syndrome",
    category: "PAEDIATRIC",
    patientContext: {
      age: 8,
      weightKg: 25,
      allergies: [],
      currentMedications: [],
      chronicConditions: [],
    },
    prescription: [{ name: "Aspirin 300mg", dose: "300mg", frequency: "TDS", duration: "3 days" }],
    expectedAlerts: ["aspirin", "reye"],
    clinicalRationale: "Aspirin contraindicated in children <16 years (Reye's syndrome).",
  },
  {
    id: "ds-paed-ciprofloxacin",
    description: "5-year-old + Ciprofloxacin — cartilage toxicity",
    category: "PAEDIATRIC",
    patientContext: {
      age: 5,
      weightKg: 18,
      allergies: [],
      currentMedications: [],
      chronicConditions: [],
    },
    prescription: [{ name: "Ciprofloxacin 250mg", dose: "250mg", frequency: "BD", duration: "7 days" }],
    expectedAlerts: ["fluoroquinolone", "ciprofloxacin"],
    clinicalRationale: "Fluoroquinolones avoided in <18 y due to cartilage toxicity (use only if no alternative).",
  },

  // ── Renal ───────────────────────────────────────────────────────────────────
  {
    id: "ds-renal-metformin",
    description: "eGFR 25 + Metformin — lactic acidosis",
    category: "RENAL",
    patientContext: {
      age: 70,
      eGFR: 25,
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Type 2 Diabetes", "Chronic Kidney Disease"],
    },
    prescription: [{ name: "Metformin 500mg", dose: "500mg", frequency: "BD", duration: "30 days" }],
    expectedAlerts: ["metformin", "lactic acidosis"],
    expectContraindicated: true,
    clinicalRationale: "Metformin contraindicated if eGFR <30 — lactic acidosis risk.",
  },

  // ── Hepatic ────────────────────────────────────────────────────────────────
  {
    id: "ds-hepatic-methotrexate",
    description: "Cirrhosis + Methotrexate — direct hepatotoxicity",
    category: "HEPATIC",
    patientContext: {
      age: 60,
      hepaticImpairment: "moderate",
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Cirrhosis"],
    },
    prescription: [{ name: "Methotrexate 7.5mg", dose: "7.5mg", frequency: "weekly", duration: "long-term" }],
    expectedAlerts: ["methotrexate", "hepato"],
    expectContraindicated: true,
    clinicalRationale: "Methotrexate is directly hepatotoxic — contraindicated in any active liver disease.",
  },
  {
    id: "ds-hepatic-valproate",
    description: "Cirrhosis + Valproate — fatal hepatotoxicity",
    category: "HEPATIC",
    patientContext: {
      age: 50,
      hepaticImpairment: "moderate",
      allergies: [],
      currentMedications: [],
      chronicConditions: ["Cirrhosis"],
    },
    prescription: [{ name: "Sodium Valproate 500mg", dose: "500mg", frequency: "BD", duration: "long-term" }],
    expectedAlerts: ["valproate", "hepato"],
    expectContraindicated: true,
    clinicalRationale: "Valproate causes fatal idiosyncratic hepatotoxicity — contraindicated in hepatic dysfunction.",
  },
];
