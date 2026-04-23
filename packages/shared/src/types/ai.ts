/** Lifecycle state of an AI triage session. */
export type AITriageStatus = "ACTIVE" | "COMPLETED" | "ABANDONED" | "EMERGENCY_DETECTED";
/** Lifecycle state of an AI scribe session. */
export type AIScribeStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CONSENT_WITHDRAWN";

/** A single message in the triage conversation history, with an ISO timestamp. */
export interface TriageMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/**
 * Structured symptom data extracted from a triage conversation.
 * All fields except `chiefComplaint` are optional since the patient may not
 * have provided them.
 */
export interface SymptomCapture {
  chiefComplaint: string;
  onset?: string;
  duration?: string;
  severity?: number; // 1-10
  location?: string;
  aggravatingFactors?: string[];
  relievingFactors?: string[];
  associatedSymptoms?: string[];
  relevantHistory?: string;
  currentMedications?: string[];
  knownAllergies?: string[];
  age?: number;
  gender?: string;
  isForDependent?: boolean;
  dependentRelationship?: string;
}

/** A recommended medical specialty and confidence score produced by AI triage. */
export interface SpecialtySuggestion {
  specialty: string;
  subSpecialty?: string;
  confidence: number; // 0-1
  reasoning: string;
}

/** A doctor recommendation returned to the patient at the end of a triage session. */
export interface DoctorSuggestion {
  doctorId: string;
  name: string;
  specialty: string;
  qualification?: string;
  photoUrl?: string;
  yearsOfExperience?: number;
  languages?: string[];
  rating?: number;
  nextSlots: { date: string; startTime: string; endTime: string }[];
  consultationFee?: number;
  consultationMode: "IN_PERSON" | "VIDEO" | "BOTH";
  reasoning: string;
}

/** Compact patient-facing summary generated at the end of a triage session, forwarded to the treating doctor. */
export interface PreVisitSummary {
  chiefComplaint: string;
  hpi: string;
  redFlagsNoted: string[];
  confidence: number;
  language: string;
  transcriptSummary: string;
  capturedAt: string;
}

/**
 * Structured SOAP note produced by the AI scribe from a consultation transcript.
 * Each section carries an optional `confidence` (0–1) and `evidenceSpan` (verbatim
 * transcript quote) to support clinician review and hallucination detection.
 */
export interface SOAPNote {
  subjective: {
    chiefComplaint: string;
    hpi: string;
    pastMedicalHistory?: string;
    medications?: string[];
    allergies?: string[];
    socialHistory?: string;
    familyHistory?: string;
    confidence?: number;       // 0-1, how well-supported this section is from the transcript
    evidenceSpan?: string;     // verbatim transcript excerpt that most strongly supports this section
  };
  objective: {
    vitals?: string;
    examinationFindings?: string;
    confidence?: number;       // 0-1, how well-supported this section is from the transcript
    evidenceSpan?: string;     // verbatim transcript excerpt that most strongly supports this section
  };
  assessment: {
    impression: string;
    icd10Codes?: { code: string; description: string; confidence: number; evidenceSpan?: string }[];
    confidence?: number;       // 0-1, how well-supported this section is from the transcript
    evidenceSpan?: string;     // verbatim transcript excerpt that most strongly supports this section
  };
  plan: {
    medications?: { name: string; dose: string; frequency: string; duration: string; notes?: string }[];
    investigations?: string[];
    procedures?: string[];
    referrals?: string[];
    followUpTimeline?: string;
    patientInstructions?: string;
    cptCodes?: { code: string; description: string; justification: string }[];
    confidence?: number;       // 0-1, how well-supported this section is from the transcript
    evidenceSpan?: string;     // verbatim transcript excerpt that most strongly supports this section
  };
}

/** One time-stamped speech segment from a consultation recording. */
export interface TranscriptEntry {
  speaker: "DOCTOR" | "PATIENT" | "ATTENDANT" | "UNKNOWN";
  text: string;
  timestamp: string;
  confidence?: number;
}

/** A single drug safety alert raised by the deterministic rules or the LLM checker. */
export interface DrugInteractionAlert {
  drug1: string;
  drug2: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | "CONTRAINDICATED";
  description: string;
}
