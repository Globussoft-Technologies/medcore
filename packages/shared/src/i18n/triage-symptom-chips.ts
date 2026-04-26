/**
 * PRD §3.5.1 Phase 2 — localised symptom chips for the AI-booking / triage UIs.
 *
 * The chip row on the AI-booking (web) and triage (mobile) screens gives
 * patients a one-tap way to insert their chief complaint into the chat. Before
 * Phase 2 the chip labels were hardcoded English / Hindi only.
 *
 * Each chip has two fields:
 *   - `label`    — localised, user-visible text rendered in the button.
 *   - `complaint` — English canonical term sent to the LLM as the user turn.
 *
 * Keeping `complaint` in English means the triage prompt and downstream
 * specialty-ranking logic stay consistent regardless of UI language: the LLM
 * always reasons over the same vocabulary. The LLM then replies in the
 * language selected by the user (enforced by the LANGUAGE_SUFFIXES map in
 * `apps/api/src/services/ai/sarvam.ts`).
 *
 * Translations are medically verified (not machine-translated). The covered
 * set is the 10 most common chief complaints in the Indian outpatient mix:
 * fever, cough, chest pain, headache, abdominal pain, breathlessness,
 * vomiting, diarrhoea, back pain, fatigue.
 */

import type { TriageLanguageCode } from "../validation/ai";

export interface SymptomChip {
  /** Localised text shown in the chip button. */
  label: string;
  /** Canonical English complaint sent to the LLM. Must be consistent across locales. */
  complaint: string;
}

export const SYMPTOM_CHIPS: Record<TriageLanguageCode, SymptomChip[]> = {
  en: [
    { label: "Fever", complaint: "Fever" },
    { label: "Cough", complaint: "Cough" },
    { label: "Chest pain", complaint: "Chest pain" },
    { label: "Headache", complaint: "Headache" },
    { label: "Abdominal pain", complaint: "Abdominal pain" },
    { label: "Breathlessness", complaint: "Breathlessness" },
    { label: "Vomiting", complaint: "Vomiting" },
    { label: "Diarrhoea", complaint: "Diarrhoea" },
    { label: "Back pain", complaint: "Back pain" },
    { label: "Fatigue", complaint: "Fatigue" },
  ],
  hi: [
    { label: "बुखार", complaint: "Fever" },
    { label: "खाँसी", complaint: "Cough" },
    { label: "सीने में दर्द", complaint: "Chest pain" },
    { label: "सिरदर्द", complaint: "Headache" },
    { label: "पेट दर्द", complaint: "Abdominal pain" },
    { label: "साँस लेने में तकलीफ", complaint: "Breathlessness" },
    { label: "उल्टी", complaint: "Vomiting" },
    { label: "दस्त", complaint: "Diarrhoea" },
    { label: "कमर दर्द", complaint: "Back pain" },
    { label: "थकान", complaint: "Fatigue" },
  ],
  ta: [
    { label: "காய்ச்சல்", complaint: "Fever" },
    { label: "இருமல்", complaint: "Cough" },
    { label: "மார்பு வலி", complaint: "Chest pain" },
    { label: "தலைவலி", complaint: "Headache" },
    { label: "வயிற்று வலி", complaint: "Abdominal pain" },
    { label: "மூச்சுத் திணறல்", complaint: "Breathlessness" },
    { label: "வாந்தி", complaint: "Vomiting" },
    { label: "வயிற்றுப்போக்கு", complaint: "Diarrhoea" },
    { label: "முதுகு வலி", complaint: "Back pain" },
    { label: "சோர்வு", complaint: "Fatigue" },
  ],
  te: [
    { label: "జ్వరం", complaint: "Fever" },
    { label: "దగ్గు", complaint: "Cough" },
    { label: "ఛాతీ నొప్పి", complaint: "Chest pain" },
    { label: "తలనొప్పి", complaint: "Headache" },
    { label: "పొట్ట నొప్పి", complaint: "Abdominal pain" },
    { label: "శ్వాస తీసుకోవడంలో ఇబ్బంది", complaint: "Breathlessness" },
    { label: "వాంతులు", complaint: "Vomiting" },
    { label: "విరేచనాలు", complaint: "Diarrhoea" },
    { label: "వెన్ను నొప్పి", complaint: "Back pain" },
    { label: "అలసట", complaint: "Fatigue" },
  ],
  bn: [
    { label: "জ্বর", complaint: "Fever" },
    { label: "কাশি", complaint: "Cough" },
    { label: "বুকে ব্যথা", complaint: "Chest pain" },
    { label: "মাথাব্যথা", complaint: "Headache" },
    { label: "পেটে ব্যথা", complaint: "Abdominal pain" },
    { label: "শ্বাসকষ্ট", complaint: "Breathlessness" },
    { label: "বমি", complaint: "Vomiting" },
    { label: "ডায়রিয়া", complaint: "Diarrhoea" },
    { label: "কোমর ব্যথা", complaint: "Back pain" },
    { label: "ক্লান্তি", complaint: "Fatigue" },
  ],
  mr: [
    { label: "ताप", complaint: "Fever" },
    { label: "खोकला", complaint: "Cough" },
    { label: "छातीत दुखणे", complaint: "Chest pain" },
    { label: "डोकेदुखी", complaint: "Headache" },
    { label: "पोटदुखी", complaint: "Abdominal pain" },
    { label: "श्वास घेण्यास त्रास", complaint: "Breathlessness" },
    { label: "उलटी", complaint: "Vomiting" },
    { label: "जुलाब", complaint: "Diarrhoea" },
    { label: "पाठदुखी", complaint: "Back pain" },
    { label: "थकवा", complaint: "Fatigue" },
  ],
  kn: [
    { label: "ಜ್ವರ", complaint: "Fever" },
    { label: "ಕೆಮ್ಮು", complaint: "Cough" },
    { label: "ಎದೆ ನೋವು", complaint: "Chest pain" },
    { label: "ತಲೆನೋವು", complaint: "Headache" },
    { label: "ಹೊಟ್ಟೆ ನೋವು", complaint: "Abdominal pain" },
    { label: "ಉಸಿರಾಟದ ತೊಂದರೆ", complaint: "Breathlessness" },
    { label: "ವಾಂತಿ", complaint: "Vomiting" },
    { label: "ಭೇದಿ", complaint: "Diarrhoea" },
    { label: "ಬೆನ್ನು ನೋವು", complaint: "Back pain" },
    { label: "ಆಯಾಸ", complaint: "Fatigue" },
  ],
  ml: [
    { label: "പനി", complaint: "Fever" },
    { label: "ചുമ", complaint: "Cough" },
    { label: "നെഞ്ചുവേദന", complaint: "Chest pain" },
    { label: "തലവേദന", complaint: "Headache" },
    { label: "വയറുവേദന", complaint: "Abdominal pain" },
    { label: "ശ്വാസതടസ്സം", complaint: "Breathlessness" },
    { label: "ഛർദ്ദി", complaint: "Vomiting" },
    { label: "വയറിളക്കം", complaint: "Diarrhoea" },
    { label: "പുറംവേദന", complaint: "Back pain" },
    { label: "ക്ഷീണം", complaint: "Fatigue" },
  ],
};

/**
 * UI-chrome strings used by the AI-booking and triage screens. Only the
 * bare minimum needed for the 6 Phase-2 languages to render without mojibake
 * or missing-string fallbacks. Full UI translation is out of scope for
 * Phase 2 — see PRD §3.5.1.
 */
export interface TriageUIStrings {
  /** Placeholder text for the chat input. */
  inputPlaceholder: string;
  /** Short label shown above the language picker. */
  languageLabel: string;
  /** Aria-label for the language picker itself. */
  languagePickerAria: string;
  /** Heading above the symptom chips row. */
  symptomChipsLabel: string;
}

export const TRIAGE_UI_STRINGS: Record<TriageLanguageCode, TriageUIStrings> = {
  en: {
    inputPlaceholder: "Describe your symptoms...",
    languageLabel: "Language",
    languagePickerAria: "Choose language",
    symptomChipsLabel: "Common symptoms",
  },
  hi: {
    inputPlaceholder: "अपनी तकलीफ बताएँ...",
    languageLabel: "भाषा",
    languagePickerAria: "भाषा चुनें",
    symptomChipsLabel: "सामान्य लक्षण",
  },
  ta: {
    inputPlaceholder: "உங்கள் அறிகுறிகளை விவரிக்கவும்...",
    languageLabel: "மொழி",
    languagePickerAria: "மொழியைத் தேர்ந்தெடுக்கவும்",
    symptomChipsLabel: "பொதுவான அறிகுறிகள்",
  },
  te: {
    inputPlaceholder: "మీ లక్షణాలను వివరించండి...",
    languageLabel: "భాష",
    languagePickerAria: "భాషను ఎంచుకోండి",
    symptomChipsLabel: "సాధారణ లక్షణాలు",
  },
  bn: {
    inputPlaceholder: "আপনার লক্ষণগুলি বর্ণনা করুন...",
    languageLabel: "ভাষা",
    languagePickerAria: "ভাষা নির্বাচন করুন",
    symptomChipsLabel: "সাধারণ লক্ষণ",
  },
  mr: {
    inputPlaceholder: "तुमची लक्षणे सांगा...",
    languageLabel: "भाषा",
    languagePickerAria: "भाषा निवडा",
    symptomChipsLabel: "सामान्य लक्षणे",
  },
  kn: {
    inputPlaceholder: "ನಿಮ್ಮ ಲಕ್ಷಣಗಳನ್ನು ವಿವರಿಸಿ...",
    languageLabel: "ಭಾಷೆ",
    languagePickerAria: "ಭಾಷೆಯನ್ನು ಆರಿಸಿ",
    symptomChipsLabel: "ಸಾಮಾನ್ಯ ಲಕ್ಷಣಗಳು",
  },
  ml: {
    inputPlaceholder: "നിങ്ങളുടെ ലക്ഷണങ്ങൾ വിവരിക്കുക...",
    languageLabel: "ഭാഷ",
    languagePickerAria: "ഭാഷ തിരഞ്ഞെടുക്കുക",
    symptomChipsLabel: "സാധാരണ ലക്ഷണങ്ങൾ",
  },
};

/**
 * Display name + native-script rendering of each supported language, for use
 * in the language-picker dropdown. Kept next to the chip translations so all
 * i18n for the triage surface lives in one file.
 */
export const LANGUAGE_DISPLAY: Record<TriageLanguageCode, { englishName: string; nativeName: string }> = {
  en: { englishName: "English", nativeName: "English" },
  hi: { englishName: "Hindi", nativeName: "हिन्दी" },
  ta: { englishName: "Tamil", nativeName: "தமிழ்" },
  te: { englishName: "Telugu", nativeName: "తెలుగు" },
  bn: { englishName: "Bengali", nativeName: "বাংলা" },
  mr: { englishName: "Marathi", nativeName: "मराठी" },
  kn: { englishName: "Kannada", nativeName: "ಕನ್ನಡ" },
  ml: { englishName: "Malayalam", nativeName: "മലയാളം" },
};

/**
 * Convert an app-level triage language code (`en`, `hi`, `ta`, …) into the
 * BCP-47 tag Sarvam ASR expects (`en-IN`, `hi-IN`, `ta-IN`, …). Sarvam's
 * `language_code` form-field accepts these 8 codes natively.
 *
 * Used by both the web scribe page and the triage voice-input path so the
 * ASR backend transcribes in the same language the user picked.
 */
export function toSarvamLanguageCode(code: TriageLanguageCode | string): string {
  switch (code) {
    case "en":
      return "en-IN";
    case "hi":
      return "hi-IN";
    case "ta":
      return "ta-IN";
    case "te":
      return "te-IN";
    case "bn":
      return "bn-IN";
    case "mr":
      return "mr-IN";
    case "kn":
      return "kn-IN";
    case "ml":
      return "ml-IN";
    default:
      // Unknown / unexpected code — default to Indian English so the ASR call
      // doesn't 400. Matches sarvam.ts `resolveLanguageSuffix` fallback.
      return "en-IN";
  }
}

