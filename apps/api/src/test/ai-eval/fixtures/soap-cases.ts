export interface SoapCase {
  id: string;
  description: string;
  transcript: { speaker: "DOCTOR" | "PATIENT"; text: string; timestamp: string }[];
  patientContext: {
    allergies: string[];
    currentMedications: string[];
    chronicConditions: string[];
    age?: number;
    gender?: string;
  };
  requiredFields: string[]; // dot-notation paths that must be non-empty, e.g. "subjective.chiefComplaint"
  forbiddenContent?: string[]; // strings that MUST NOT appear in the output (hallucination check)
}

export const SOAP_CASES: SoapCase[] = [
  {
    id: "hypertension-followup",
    description: "BP follow-up — must capture chief complaint and plan",
    transcript: [
      { speaker: "DOCTOR", text: "Good morning, how are you feeling today?", timestamp: "2026-04-22T09:00:00Z" },
      {
        speaker: "PATIENT",
        text: "My blood pressure has been high, 160 over 100 yesterday",
        timestamp: "2026-04-22T09:00:10Z",
      },
      { speaker: "DOCTOR", text: "Any headache or chest tightness?", timestamp: "2026-04-22T09:00:20Z" },
      { speaker: "PATIENT", text: "Yes mild headache in the morning", timestamp: "2026-04-22T09:00:30Z" },
      {
        speaker: "DOCTOR",
        text: "I am going to continue amlodipine 5mg and add telmisartan 40mg once daily",
        timestamp: "2026-04-22T09:01:00Z",
      },
    ],
    patientContext: {
      allergies: [],
      currentMedications: ["Amlodipine 5mg"],
      chronicConditions: ["Hypertension"],
      age: 55,
      gender: "M",
    },
    requiredFields: ["subjective.chiefComplaint", "subjective.hpi", "assessment.impression", "plan"],
    forbiddenContent: ["insulin", "metformin"], // not mentioned — if these appear it's a hallucination
  },
  {
    id: "fever-acute",
    description: "Acute fever — must not hallucinate medications not mentioned",
    transcript: [
      {
        speaker: "PATIENT",
        text: "I have fever since 2 days, temperature 101 F, and body ache",
        timestamp: "2026-04-22T10:00:00Z",
      },
      { speaker: "DOCTOR", text: "Any cough or throat pain?", timestamp: "2026-04-22T10:00:10Z" },
      { speaker: "PATIENT", text: "Yes sore throat as well", timestamp: "2026-04-22T10:00:20Z" },
      {
        speaker: "DOCTOR",
        text: "This looks like viral fever, I will prescribe paracetamol and rest",
        timestamp: "2026-04-22T10:01:00Z",
      },
    ],
    patientContext: {
      allergies: [],
      currentMedications: [],
      chronicConditions: [],
      age: 28,
      gender: "F",
    },
    requiredFields: ["subjective.chiefComplaint", "plan"],
    forbiddenContent: ["amoxicillin", "azithromycin", "warfarin"],
  },
];
