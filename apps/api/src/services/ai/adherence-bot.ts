import OpenAI from "openai";

const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

const MODEL = "sarvam-105b";

/**
 * Generate a personalized reminder message for a patient via Sarvam AI.
 */
export async function generateReminderMessage(opts: {
  patientName: string;
  medications: { name: string; dosage: string; frequency: string }[];
  language: "en" | "hi";
  reminderType: "morning" | "afternoon" | "evening" | "night";
}): Promise<string> {
  const { patientName, medications, language, reminderType } = opts;

  const medList = medications
    .map((m) => `${m.name} (${m.dosage}, ${m.frequency})`)
    .join(", ");

  const userMessage =
    language === "hi"
      ? `Patient name: ${patientName}\nReminder time: ${reminderType}\nMedications: ${medList}\nLanguage: Hindi`
      : `Patient name: ${patientName}\nReminder time: ${reminderType}\nMedications: ${medList}\nLanguage: English`;

  try {
    const response = await sarvam.chat.completions.create({
      model: MODEL,
      max_tokens: 256,
      messages: [
        {
          role: "system",
          content:
            "You are MedCore's medication reminder assistant. Generate a short, warm, personalized reminder message (2-3 sentences max) for a patient to take their medication. Be empathetic. Use the patient's language.",
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? fallbackMessage(opts);
  } catch {
    return fallbackMessage(opts);
  }
}

function fallbackMessage(opts: {
  medications: { name: string; dosage: string; frequency: string }[];
}): string {
  return `Reminder: Time to take your medication — ${opts.medications.map((m) => m.name).join(", ")}. Please take it as prescribed.`;
}

/**
 * Determine which medications are due NOW based on reminderTimes (HH:MM strings).
 * Returns medications whose reminderTime is within ±15 minutes of current time.
 */
export function getMedicationsDueNow(
  medications: {
    name: string;
    dosage: string;
    frequency: string;
    reminderTimes: string[];
  }[]
): { name: string; dosage: string; frequency: string }[] {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const WINDOW = 15;

  return medications.filter((med) =>
    med.reminderTimes.some((t) => {
      const [hStr, mStr] = t.split(":");
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      if (isNaN(h) || isNaN(m)) return false;
      const medMinutes = h * 60 + m;
      return Math.abs(nowMinutes - medMinutes) <= WINDOW;
    })
  );
}
