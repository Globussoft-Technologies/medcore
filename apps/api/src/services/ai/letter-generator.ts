import { sanitizeUserInput } from "./prompt-safety";
import { getChatClient } from "./model-router";

const sarvam = getChatClient("sarvam");
const MODEL = process.env.SARVAM_MODEL ?? "sarvam-m";

function cleanResponse(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^---+$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SYSTEM_PROMPT =
  "You are a medical letter writer. Generate professional, concise clinical correspondence. Use formal medical language. Format with proper sections. Output plain text suitable for printing. Do not use any markdown formatting — no asterisks, no bold, no italics, no hyphens for bullets, no horizontal rules. Never add notes, warnings, disclaimers, or editorial comments about the quality or completeness of the data provided. Use the data exactly as given.";

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

    return cleanResponse(response.choices[0]?.message?.content ?? "");
}

// ── generateDischargeSummary ──────────────────────────────────────────────────

/**
 * Generate a formal inpatient discharge summary as plain text, ready for
 * printing. Covers admission/discharge dates, diagnoses, procedures,
 * discharge medications, follow-up instructions, and a signature block.
 */
function salutation(gender?: string): string {
  const g = (gender ?? "").toUpperCase();
  if (g === "MALE" || g === "M") return "Mr.";
  if (g === "FEMALE" || g === "F") return "Ms.";
  return "";
}
export async function generateDischargeSummary(opts: {
  patientName: string;
  patientAge?: number;
  patientGender?: string;
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
  const rawDoctorName = sanitizeUserInput(opts.doctorName, { maxLen: 100 });
  const safeDoctorName = rawDoctorName.replace(/^Dr\.\s*/i, "").trim();
  const safePatientName = sanitizeUserInput(opts.patientName, { maxLen: 100 });
  const safeAdmissionDate = sanitizeUserInput(opts.admissionDate, { maxLen: 40 });
  const safeDischargeDate = sanitizeUserInput(opts.dischargeDate, { maxLen: 40 });
  const safeAdmittingDx = sanitizeUserInput(opts.admittingDiagnosis, { maxLen: 1000 });
  const safeDischargeDx = sanitizeUserInput(opts.dischargeDiagnosis, { maxLen: 1000 });
  const safeFollowUp = sanitizeUserInput(opts.followUpInstructions, { maxLen: 3000 });

  const sal = salutation(opts.patientGender);
  const patientLabel = sal ? `${sal} ${safePatientName}` : safePatientName;
  const g = (opts.patientGender ?? "").toUpperCase();
  const displayGender = (g === "MALE" || g === "M" || g === "FEMALE" || g === "F") ? opts.patientGender : "";
  const ageGender = [
    opts.patientAge ? `Age ${opts.patientAge}` : "",
    displayGender ?? "",
  ].filter(Boolean).join(", ");


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

   const userPrompt = `Generate a formal inpatient discharge summary using ONLY the data provided below. Output every section exactly as labelled. Do not skip any section.

HOSPITAL: ${safeHospital}
ATTENDING PHYSICIAN: Dr. ${safeDoctorName}
PATIENT NAME: ${patientLabel}${ageGender ? ` (${ageGender})` : ""}
ADMISSION DATE: ${safeAdmissionDate}
DISCHARGE DATE: ${safeDischargeDate}
ADMITTING DIAGNOSIS: ${safeAdmittingDx}
DISCHARGE DIAGNOSIS: ${safeDischargeDx}
PROCEDURES PERFORMED:
${procedureList}
DISCHARGE MEDICATIONS:
${medicationList}
FOLLOW-UP INSTRUCTIONS: ${safeFollowUp}

Output the summary in this exact structure — include all 8 sections, no section may be omitted:

Discharge Summary
Hospital: <value>
Attending Physician: <value>
Patient: <value>

1. Admission Date: <value>
2. Discharge Date: <value>
3. Diagnosis:
   Admitting: <value>
   Discharge: <value>
4. Procedures Performed: <value>
5. Hospital Course: <2-3 sentence narrative; refer to the patient as "${patientLabel}" and mention attending physician "Dr. ${safeDoctorName}" — do not use any other names>
6. Discharge Medications: <value>
7. Follow-up Instructions: <value>
8. Signature:
   Dr. ${safeDoctorName}
   Attending Physician
   ${safeHospital}`;


  const response = await sarvam.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  return cleanResponse(response.choices[0]?.message?.content ?? "");
}
