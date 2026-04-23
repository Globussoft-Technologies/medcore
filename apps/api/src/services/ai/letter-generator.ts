import OpenAI from "openai";
import { sanitizeUserInput } from "./prompt-safety";

// Sarvam AI client
const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

const MODEL = "sarvam-105b";

const SYSTEM_PROMPT =
  "You are a medical letter writer. Generate professional, concise clinical correspondence. Use formal medical language. Format with proper sections. Output plain text suitable for printing.";

// ── generateReferralLetter ────────────────────────────────────────────────────

/**
 * Generate a formatted clinical referral letter as plain text, ready for
 * printing. Includes a structured nine-section layout (date, from/to,
 * clinical summary, medications, urgency, and request).
 */
export async function generateReferralLetter(opts: {
  patientName: string;
  patientAge?: number;
  patientGender?: string;
  fromDoctorName: string;
  fromHospital: string;
  toSpecialty: string;
  toDoctorName?: string;
  clinicalSummary: string;
  relevantHistory: string;
  currentMedications: string[];
  urgency: "ROUTINE" | "URGENT" | "EMERGENCY";
  date: string;
}): Promise<string> {
  // security(2026-04-23-low): F-INJ-1 — referral letter free-text fields
  // (clinical summary, history, medications, names) are sanitized before
  // concatenation. Letters are clinician-facing but still benefit from
  // hardening because a malicious earlier note could steer the letter text.
  const safeFromDoctor = sanitizeUserInput(opts.fromDoctorName, { maxLen: 100 });
  const safeFromHospital = sanitizeUserInput(opts.fromHospital, { maxLen: 150 });
  const safeToSpecialty = sanitizeUserInput(opts.toSpecialty, { maxLen: 100 });
  const safeToDoctorName = opts.toDoctorName
    ? sanitizeUserInput(opts.toDoctorName, { maxLen: 100 })
    : undefined;
  const safePatientName = sanitizeUserInput(opts.patientName, { maxLen: 100 });
  const safePatientGender = opts.patientGender
    ? sanitizeUserInput(opts.patientGender, { maxLen: 20 })
    : "";
  const safeClinicalSummary = sanitizeUserInput(opts.clinicalSummary, { maxLen: 3000 });
  const safeRelevantHistory = sanitizeUserInput(opts.relevantHistory, { maxLen: 3000 });
  const safeDate = sanitizeUserInput(opts.date, { maxLen: 40 });

  const medicationList =
    opts.currentMedications.length > 0
      ? opts.currentMedications
          .map((m) => `  - ${sanitizeUserInput(m, { maxLen: 200 })}`)
          .join("\n")
      : "  - None";

  const toDoctorLine = safeToDoctorName
    ? `Dr. ${safeToDoctorName} / ${safeToSpecialty}`
    : `${safeToSpecialty} Specialist`;

  const userPrompt = `Generate a referral letter with the following information:

DATE: ${safeDate}
FROM: Dr. ${safeFromDoctor}, ${safeFromHospital}
TO: ${toDoctorLine}
PATIENT: ${safePatientName}${opts.patientAge ? `, Age ${opts.patientAge}` : ""}${safePatientGender ? `, ${safePatientGender}` : ""}
CLINICAL SUMMARY: ${safeClinicalSummary}
RELEVANT HISTORY: ${safeRelevantHistory}
CURRENT MEDICATIONS:
${medicationList}
URGENCY: ${opts.urgency}

Structure the letter with these sections:
1. Date
2. From (doctor/hospital)
3. To (specialty/doctor)
4. Re: Patient
5. Clinical Summary
6. Reason for Referral
7. Current Medications
8. Urgency
9. Request

Write a formal referral letter using the above data.`;

  const response = await sarvam.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

// ── generateDischargeSummary ──────────────────────────────────────────────────

/**
 * Generate a formal inpatient discharge summary as plain text, ready for
 * printing. Covers admission/discharge dates, diagnoses, procedures,
 * discharge medications, follow-up instructions, and a signature block.
 */
export async function generateDischargeSummary(opts: {
  patientName: string;
  patientAge?: number;
  admissionDate: string;
  dischargeDate: string;
  admittingDiagnosis: string;
  dischargeDiagnosis: string;
  proceduresPerformed: string[];
  medicationsOnDischarge: string[];
  followUpInstructions: string;
  doctorName: string;
  hospital: string;
}): Promise<string> {
  // security(2026-04-23-low): F-INJ-1 — sanitize every free-text field before
  // concatenating into the discharge-summary prompt.
  const safeHospital = sanitizeUserInput(opts.hospital, { maxLen: 150 });
  const safeDoctorName = sanitizeUserInput(opts.doctorName, { maxLen: 100 });
  const safePatientName = sanitizeUserInput(opts.patientName, { maxLen: 100 });
  const safeAdmissionDate = sanitizeUserInput(opts.admissionDate, { maxLen: 40 });
  const safeDischargeDate = sanitizeUserInput(opts.dischargeDate, { maxLen: 40 });
  const safeAdmittingDx = sanitizeUserInput(opts.admittingDiagnosis, { maxLen: 1000 });
  const safeDischargeDx = sanitizeUserInput(opts.dischargeDiagnosis, { maxLen: 1000 });
  const safeFollowUp = sanitizeUserInput(opts.followUpInstructions, { maxLen: 3000 });

  const procedureList =
    opts.proceduresPerformed.length > 0
      ? opts.proceduresPerformed
          .map((p) => `  - ${sanitizeUserInput(p, { maxLen: 300 })}`)
          .join("\n")
      : "  - None";

  const medicationList =
    opts.medicationsOnDischarge.length > 0
      ? opts.medicationsOnDischarge
          .map((m) => `  - ${sanitizeUserInput(m, { maxLen: 200 })}`)
          .join("\n")
      : "  - None";

  const userPrompt = `Generate a discharge summary with the following information:

HOSPITAL: ${safeHospital}
ATTENDING PHYSICIAN: Dr. ${safeDoctorName}
PATIENT: ${safePatientName}${opts.patientAge ? `, Age ${opts.patientAge}` : ""}
ADMISSION DATE: ${safeAdmissionDate}
DISCHARGE DATE: ${safeDischargeDate}
ADMITTING DIAGNOSIS: ${safeAdmittingDx}
DISCHARGE DIAGNOSIS: ${safeDischargeDx}
PROCEDURES PERFORMED:
${procedureList}
DISCHARGE MEDICATIONS:
${medicationList}
FOLLOW-UP INSTRUCTIONS: ${safeFollowUp}

Structure the summary with these sections:
1. Admission Date
2. Discharge Date
3. Diagnosis (admitting and discharge)
4. Procedures Performed
5. Hospital Course (brief narrative)
6. Discharge Medications
7. Follow-up Instructions
8. Signature line

Write a formal discharge summary using the above data.`;

  const response = await sarvam.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}
