export interface TriageCase {
  id: string;
  description: string;
  messages: { role: "user" | "assistant"; content: string }[];
  expectedSpecialties: string[]; // at least one should appear in top-3
  shouldFlagEmergency: boolean;
  language: "en" | "hi";
}

export const TRIAGE_CASES: TriageCase[] = [
  {
    id: "chest-pain-emergency",
    description: "Chest pain with radiation — should flag emergency",
    messages: [
      {
        role: "user",
        content:
          "I have severe chest pain radiating to my left arm and jaw, started 20 minutes ago, I am sweating heavily",
      },
    ],
    expectedSpecialties: [],
    shouldFlagEmergency: true,
    language: "en",
  },
  {
    id: "cough-respiratory",
    description: "Persistent cough → Pulmonologist or GP",
    messages: [
      { role: "assistant", content: "Hello! How are you feeling?" },
      { role: "user", content: "I have had a cough for 3 weeks with some blood in the sputum" },
      { role: "assistant", content: "Any fever or weight loss?" },
      { role: "user", content: "Yes, mild fever and I lost 4kg in the last month" },
    ],
    expectedSpecialties: ["Pulmonologist", "General Physician", "Oncologist"],
    shouldFlagEmergency: false,
    language: "en",
  },
  {
    id: "joint-pain-rheumatology",
    description: "Symmetrical joint pain → Rheumatologist",
    messages: [
      { role: "assistant", content: "Hello! How are you feeling?" },
      { role: "user", content: "My joints are painful and swollen, both hands and knees, worse in the morning" },
      { role: "assistant", content: "How long has this been going on?" },
      { role: "user", content: "About 6 months now, I also feel very tired" },
    ],
    expectedSpecialties: ["Rheumatologist", "General Physician"],
    shouldFlagEmergency: false,
    language: "en",
  },
  {
    id: "diabetes-endocrinology",
    description: "High blood sugar symptoms → Endocrinologist",
    messages: [
      { role: "assistant", content: "Hello! How are you feeling?" },
      { role: "user", content: "I am very thirsty all the time, urinating frequently, and feeling tired" },
      { role: "assistant", content: "Any family history of diabetes?" },
      { role: "user", content: "Yes my father has diabetes. My fasting sugar was 180 last week" },
    ],
    expectedSpecialties: ["Endocrinologist", "General Physician"],
    shouldFlagEmergency: false,
    language: "en",
  },
];
