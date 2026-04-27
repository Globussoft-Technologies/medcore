/**
 * PRD §4.5.6 — Voice commands for the AI Scribe review screen.
 *
 * Pure parser that maps a recognised utterance to a `VoiceAction` discriminated
 * union. Kept side-effect-free so it can be unit-tested without React, the
 * Web Speech API, or the page component.
 *
 * Matching philosophy:
 *  - case-insensitive
 *  - tolerant of leading filler ("the", "to", "please", articles)
 *  - allows loose word order for accept/reject section commands so
 *    "accept the plan" / "plan accept" both resolve to the same action
 *  - returns `{ kind: "unknown" }` (NOT throws) when nothing matches —
 *    the caller decides whether to toast or stay silent
 */

export type SectionKey = "S" | "O" | "A" | "P";

export type VoiceAction =
  | { kind: "accept-section"; section: SectionKey }
  | { kind: "reject-section"; section: SectionKey }
  | { kind: "accept-all" }
  | { kind: "change-dosage"; medicineQuery: string; newDosage: string }
  | { kind: "add-note"; section: SectionKey | null; text: string }
  | { kind: "discard" }
  | { kind: "show-help" }
  | { kind: "unknown"; raw: string };

const SECTION_TOKENS: Record<string, SectionKey> = {
  subjective: "S",
  objective: "O",
  assessment: "A",
  plan: "P",
};

/**
 * Strip filler words and punctuation, collapse whitespace, lowercase.
 * Keeps medicine / dosage payloads intact because they're carved out
 * via regex BEFORE this normaliser runs.
 */
function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip common filler tokens that don't affect intent.
 * "accept the plan" -> "accept plan"
 * "please accept plan" -> "accept plan"
 */
function stripFillers(s: string): string {
  return s
    .replace(/\b(the|please|kindly|now|just|go ahead and|can you|could you)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect a section keyword anywhere in the (already normalised) string.
 * Returns the canonical SectionKey or null.
 */
function findSection(s: string): SectionKey | null {
  for (const [tok, key] of Object.entries(SECTION_TOKENS)) {
    // word boundary match so "subjectively" wouldn't match "subjective"
    if (new RegExp(`\\b${tok}\\b`).test(s)) return key;
  }
  return null;
}

export function parseVoiceCommand(raw: string): VoiceAction {
  if (!raw || !raw.trim()) return { kind: "unknown", raw: "" };

  const original = raw.trim();
  const norm = stripFillers(normalise(original));

  // ── 1. "what can I say" / cheat-sheet ──────────────────
  if (
    /\bwhat can i say\b/.test(norm) ||
    /\bshow (commands|help)\b/.test(norm) ||
    /\bvoice help\b/.test(norm)
  ) {
    return { kind: "show-help" };
  }

  // ── 2. discard / cancel / go back ──────────────────────
  if (
    /\b(discard|cancel|go back|exit review|close review|cancel review)\b/.test(norm)
  ) {
    return { kind: "discard" };
  }

  // ── 3. accept all / approve all / sign off ─────────────
  if (/\b(accept|approve)\s+all\b/.test(norm) || /\ball\s+(accept|approve)\b/.test(norm)) {
    return { kind: "accept-all" };
  }
  if (/\b(sign off|signoff|finalize|submit)\b/.test(norm)) {
    return { kind: "accept-all" };
  }

  // ── 4. change dosage of <medicine> to <new> ────────────
  // Run the regex against the ORIGINAL casing so we preserve the
  // medicine query as the doctor said it (helps the substring match
  // against `medicineName` later). Whitespace already collapsed in
  // `original` is fine — we don't strictly need to here.
  // Accept both "dosage" and "dose".
  const dosageMatch = original.match(
    /change\s+(?:the\s+)?(?:dosage|dose)\s+(?:of\s+)?(.+?)\s+to\s+(.+?)$/i,
  );
  if (dosageMatch) {
    const medicineQuery = dosageMatch[1].trim().replace(/[.,!?;:]+$/, "");
    const newDosage = dosageMatch[2].trim().replace(/[.,!?;:]+$/, "");
    if (medicineQuery && newDosage) {
      return { kind: "change-dosage", medicineQuery, newDosage };
    }
  }

  // ── 5. add note <text> ─────────────────────────────────
  // "add note <text>" or "add note to plan <text>" / "add plan note <text>"
  const addNoteMatch = original.match(
    /^(?:add|append)\s+(?:a\s+)?note\s*(?:to\s+(subjective|objective|assessment|plan)\s+)?(.+)$/i,
  );
  if (addNoteMatch) {
    const sectionWord = (addNoteMatch[1] || "").toLowerCase();
    const text = addNoteMatch[2].trim();
    if (text) {
      const section = sectionWord ? SECTION_TOKENS[sectionWord] : null;
      return { kind: "add-note", section, text };
    }
  }
  // also "add <section> note <text>"
  const addSectionNoteMatch = original.match(
    /^(?:add|append)\s+(subjective|objective|assessment|plan)\s+note\s+(.+)$/i,
  );
  if (addSectionNoteMatch) {
    return {
      kind: "add-note",
      section: SECTION_TOKENS[addSectionNoteMatch[1].toLowerCase()],
      text: addSectionNoteMatch[2].trim(),
    };
  }

  // ── 6. accept / reject <section> (loose word order) ────
  const hasAccept = /\b(accept|approve|ok|okay)\b/.test(norm);
  const hasReject = /\b(reject|deny|throw out|redo)\b/.test(norm);
  const section = findSection(norm);

  if (section && hasAccept && !hasReject) {
    return { kind: "accept-section", section };
  }
  if (section && hasReject && !hasAccept) {
    return { kind: "reject-section", section };
  }

  return { kind: "unknown", raw: original };
}
