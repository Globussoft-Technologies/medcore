import OpenAI from "openai";

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
  const medicationList =
    opts.currentMedications.length > 0
      ? opts.currentMedications.map((m) => `  - ${m}`).join("\n")
      : "  - None";

  const toDoctorLine = opts.toDoctorName
    ? `Dr. ${opts.toDoctorName} / ${opts.toSpecialty}`
    : `${opts.toSpecialty} Specialist`;

  const userPrompt = `Generate a referral letter with the following information:

DATE: ${opts.date}
FROM: Dr. ${opts.fromDoctorName}, ${opts.fromHospital}
TO: ${toDoctorLine}
PATIENT: ${opts.patientName}${opts.patientAge ? `, Age ${opts.patientAge}` : ""}${opts.patientGender ? `, ${opts.patientGender}` : ""}
CLINICAL SUMMARY: ${opts.clinicalSummary}
RELEVANT HISTORY: ${opts.relevantHistory}
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
  const procedureList =
    opts.proceduresPerformed.length > 0
      ? opts.proceduresPerformed.map((p) => `  - ${p}`).join("\n")
      : "  - None";

  const medicationList =
    opts.medicationsOnDischarge.length > 0
      ? opts.medicationsOnDischarge.map((m) => `  - ${m}`).join("\n")
      : "  - None";

  const userPrompt = `Generate a discharge summary with the following information:

HOSPITAL: ${opts.hospital}
ATTENDING PHYSICIAN: Dr. ${opts.doctorName}
PATIENT: ${opts.patientName}${opts.patientAge ? `, Age ${opts.patientAge}` : ""}
ADMISSION DATE: ${opts.admissionDate}
DISCHARGE DATE: ${opts.dischargeDate}
ADMITTING DIAGNOSIS: ${opts.admittingDiagnosis}
DISCHARGE DIAGNOSIS: ${opts.dischargeDiagnosis}
PROCEDURES PERFORMED:
${procedureList}
DISCHARGE MEDICATIONS:
${medicationList}
FOLLOW-UP INSTRUCTIONS: ${opts.followUpInstructions}

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
