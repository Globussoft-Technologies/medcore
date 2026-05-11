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
 *  - single-letter section shortcuts: "reject P" / "accept S" etc.
 *  - Levenshtein fuzzy correction for command verbs & section names so
 *    speech-recognition mishearings ("acsept", "rejact", "subjectiv")
 *    still resolve correctly
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

// Short aliases: single letters and common abbreviations.
// Deliberately excludes "a" as an alias for Assessment to avoid
// conflicting with the article "a" after stripFillers.
const SECTION_ALIASES: Array<[RegExp, SectionKey]> = [
  [/\bsub(?:j|jective)?\b/i, "S"],
  [/\bobj(?:ective)?\b/i,     "O"],
  [/\bassess(?:ment)?\b/i,    "A"],
  // single uppercase-ish letter after a command word or at word boundary
  [/\b[sS]\b/, "S"],
  [/\b[oO]\b/, "O"],
  [/\b[pP]\b/, "P"],
];

// ─── Levenshtein fuzzy correction ────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// [canonical, maxEditDistance]
const FUZZY_VOCAB: Array<[string, number]> = [
  ["accept",     2],
  ["reject",     2],
  ["approve",    2],
  ["subjective", 3],
  ["objective",  3],
  ["assessment", 3],
  ["plan",       1],
  ["discard",    2],
  ["cancel",     2],
  ["finalize",   2],
  ["submit",     2],
  ["dosage",     2],
  ["dose",       1],
  ["note",       1],
  ["sign",       1],
  ["all",        1],
];

/**
 * Correct individual words that are close to known command vocabulary.
 * Very short words (≤ 2 chars) are not fuzzy-corrected to avoid false
 * positives on articles and prepositions.
 *
 * Picks the CLOSEST in-threshold canonical (not the first), so e.g.
 * "objective" (dist 0 to "objective", dist 3 to "subjective") resolves
 * to "objective" instead of being snapped to "subjective" by list order.
 * An exact match (distance 0) short-circuits the search.
 */
function fuzzyCorrect(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 2) return word;
      let bestCanon = word;
      let bestDist = Infinity;
      for (const [canon, maxDist] of FUZZY_VOCAB) {
        const d = levenshtein(word, canon);
        if (d <= maxDist && d < bestDist) {
          bestDist = d;
          bestCanon = canon;
          if (d === 0) break;
        }
      }
      return bestCanon;
    })
    .join(" ");
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

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
 * Checks full words first, then short aliases (sub/obj/assess) and
 * single-letter shortcuts (S/O/A/P).
 */
function findSection(s: string): SectionKey | null {
  // Full word match
  for (const [tok, key] of Object.entries(SECTION_TOKENS)) {
    if (new RegExp(`\\b${tok}\\b`).test(s)) return key;
  }
  // Short aliases + single letters
  for (const [re, key] of SECTION_ALIASES) {
    if (re.test(s)) return key;
  }
  return null;
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseVoiceCommand(raw: string): VoiceAction {
  if (!raw || !raw.trim()) return { kind: "unknown", raw: "" };

  const original = raw.trim();
  // Apply normalise → strip fillers → fuzzy-correct typos
  const norm = fuzzyCorrect(stripFillers(normalise(original)));

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
  // medicine query as the doctor said it. Accept both "dosage" and "dose".
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

  // ── 7. bare section letter / name after command word ───
  // Handles edge cases like "P reject" where word order is reversed
  // and hasReject may not have matched with the fuzzy-corrected norm.
  if (section) {
    if (/\b(accept|approve|ok|okay)\b/.test(norm)) {
      return { kind: "accept-section", section };
    }
    if (/\b(reject|deny)\b/.test(norm)) {
      return { kind: "reject-section", section };
    }
  }

  return { kind: "unknown", raw: original };
}
