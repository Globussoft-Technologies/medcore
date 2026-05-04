/**
 * Seed-data integrity regression suite (closes the gap that let bugs #497
 * and #499 ship to production):
 *
 *   #497 — Patient "Aarav Sharma" had `ageDays: 3` (newborn) which the
 *          patient table's derived `age` column rendered as "0 yrs",
 *          looking like a data-entry bug on the pediatric dashboard.
 *
 *   #499 — Pediatric MR numbers used `mrSeqBase = 9000`, leaving an
 *          ~8965-row gap between seed-realistic.ts (MR000001..MR000035)
 *          and seed-pediatric-patients.ts (MR009000..MR009007). The
 *          carve-out was undocumented and confused users browsing
 *          /dashboard/patients (they saw a chunk of low MR numbers, then
 *          a sudden jump to MR009xxx with nothing in between).
 *
 * Why parse source files instead of importing the seed modules:
 *   Each seed-*.ts file calls `main()` at module load (it's a runnable
 *   script, not a library). Importing it would actually try to connect to
 *   Prisma during the test run. To keep this suite as a fast, DB-free
 *   static integrity check we read the source files with fs and pull the
 *   relevant literal arrays out with targeted regexes. This deliberately
 *   does NOT exercise the mrNumber padStart logic at runtime — the goal
 *   is to catch the *static* pre-conditions (ageDays, mrSeqBase, sequence
 *   start) that produced the bug-in-production values, since that's what
 *   would have caught both #497 and #499 at PR time.
 *
 * Self-skip convention:
 *   The wider rls.test.ts integration suite gates on DATABASE_URL_TEST
 *   via `describe.skipIf(!TEST_DB_AVAILABLE)`. This suite has no DB
 *   dependency (it operates entirely on text + regex) so it runs
 *   unconditionally — `npm test` on a developer laptop without a test DB
 *   will still execute these assertions. That's intentional: a seed-data
 *   integrity check is most useful precisely when a DB is NOT available
 *   (on CI smoke runs, on contributors' laptops without `db push`, etc.).
 *   We retain the gating import below (commented) for parity with the
 *   convention; flip the `describe` to `describe.skipIf(...)` if a future
 *   change adds DB-backed assertions.
 *
 * What this file enforces (assertion count surfaced in the report):
 *   1. seed-pediatric-patients.ts:
 *       a. PEDIATRIC_PATIENTS is non-empty.
 *       b. Every entry has a non-empty `name`.
 *       c. Every entry has `ageDays` >= 1 (no DOB-in-future / age-0 yrs).
 *       d. Aarav Sharma specifically has ageDays > 365 (regression: #497).
 *       e. No duplicate names within the array.
 *       f. mrSeqBase is contiguous with seed-realistic's PATIENT_DATA
 *          length + 1 (regression: #499).
 *   2. seed-realistic.ts:
 *       a. PATIENT_DATA is non-empty.
 *       b. Every entry has a positive integer `age`.
 *       c. Every entry has a non-empty `name`.
 *       d. mrSeq starts at 1 (the canonical first MR number).
 *   3. seed.ts:
 *       a. The `next_mr_number` SystemConfig value covers every MR
 *          allocated by the seed bundle (must be > realistic count +
 *          pediatric count).
 *       b. Rahul Kumar's hard-coded MR000001 matches the seed-realistic
 *          mrSeq=1 entry's MR (otherwise the upsert-by-email
 *          idempotency contract is broken and a re-seed produces
 *          colliding MRs).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_SRC = resolve(__dirname, "..");

function readSeedSource(name: string): string {
  return readFileSync(resolve(DB_SRC, name), "utf8");
}

/**
 * Strip `// ...` line comments out of seed source before regex extraction.
 * The fix for #497 added a multi-line `// Bug #497: was ageDays: 3 ...`
 * comment ABOVE the real `ageDays: 365 * 5 + 45` literal — without this
 * scrub, an `ageDays:` regex would happily match the literal "3" inside
 * the comment text and falsely report Aarav as still age-0. We strip
 * line comments (preserving line breaks for column-stable error
 * messages) before any property extraction.
 */
function stripLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

/**
 * Extract a numeric `ageDays` literal for a given patient name out of the
 * PEDIATRIC_PATIENTS array source. Captures expressions like:
 *   ageDays: 3,
 *   ageDays: 365 * 5 + 45,
 * and evaluates the simple arithmetic so the test asserts the
 * post-evaluation day count rather than the literal token.
 */
function extractAgeDaysForName(source: string, name: string): number | null {
  const cleaned = stripLineComments(source);
  const blockRe = new RegExp(
    `name:\\s*"${name}",[\\s\\S]*?ageDays:\\s*([0-9 +*\\-/]+)[,\\s]`,
    "m",
  );
  const m = cleaned.match(blockRe);
  if (!m) return null;
  const expr = m[1].trim();
  // Whitelist guard: only digits, +, *, -, /, spaces. Then eval safely via Function.
  if (!/^[0-9 +*\-/]+$/.test(expr)) return null;
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${expr});`)() as number;
}

/**
 * Pull every `name: "<...>"` value out of an array literal in a seed file.
 * Used to count rows + check for duplicates without importing (which would
 * trigger the seed module's main() at load time).
 */
function extractAllNames(source: string, arrayName: string): string[] {
  const arrStart = source.indexOf(`const ${arrayName} = [`);
  if (arrStart === -1) return [];
  // Find the matching closing bracket of the top-level array.
  let depth = 0;
  let end = -1;
  for (let i = arrStart; i < source.length; i++) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = source.slice(arrStart, end);
  const re = /name:\s*"([^"]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Extract every `age: <int>` literal from PATIENT_DATA in seed-realistic.ts.
 */
function extractAllAges(source: string): number[] {
  const arrStart = source.indexOf("const PATIENT_DATA = [");
  if (arrStart === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = arrStart; i < source.length; i++) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = source.slice(arrStart, end);
  const re = /age:\s*(\d+)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(parseInt(m[1], 10));
  return out;
}

describe("seed-data integrity (regression #497, #499)", () => {
  const pediatricSrc = readSeedSource("seed-pediatric-patients.ts");
  const realisticSrc = readSeedSource("seed-realistic.ts");
  const seedSrc = readSeedSource("seed.ts");

  // ── PEDIATRIC_PATIENTS ────────────────────────────────────────────────
  describe("seed-pediatric-patients.ts :: PEDIATRIC_PATIENTS", () => {
    const names = extractAllNames(pediatricSrc, "PEDIATRIC_PATIENTS");

    it("contains at least one patient", () => {
      expect(names.length).toBeGreaterThan(0);
    });

    it("has no duplicate patient names (regression: avoid silent upsert collisions)", () => {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes).toEqual([]);
    });

    it("has a non-empty name on every patient", () => {
      for (const n of names) expect(n.trim().length).toBeGreaterThan(0);
    });

    it("every patient's ageDays >= 1 (no DOB-in-future, no age-0 rendering)", () => {
      // Bug #497 — Aarav had ageDays: 3 which displayed as age 0 yrs.
      // We tighten "ageDays > 0" further down for Aarav specifically; the
      // global floor of 1 catches the obvious "DOB == today" case which
      // would render "0d old" on the pediatric module.
      for (const n of names) {
        const days = extractAgeDaysForName(pediatricSrc, n);
        expect(days, `ageDays missing or unparseable for ${n}`).not.toBeNull();
        expect(days!, `${n} ageDays must be >= 1`).toBeGreaterThanOrEqual(1);
      }
    });

    it('Aarav Sharma renders age >= 1 yr (regression #497: was ageDays: 3 → age 0 yrs)', () => {
      const days = extractAgeDaysForName(pediatricSrc, "Aarav Sharma");
      expect(days, "Aarav Sharma not found in PEDIATRIC_PATIENTS").not.toBeNull();
      // Math.floor(ageDays / 365) is the formula the seed uses for the
      // Patient.age column. Assert the post-floor value is >= 1.
      expect(Math.floor(days! / 365)).toBeGreaterThanOrEqual(1);
    });

    it("mrSeqBase is contiguous with seed-realistic.ts PATIENT_DATA (regression #499)", () => {
      // Bug #499 — was mrSeqBase = 9000 (8965-row gap). Must now equal
      // PATIENT_DATA.length + 1 so the MR sequence is unbroken.
      const mrBaseMatch = pediatricSrc.match(/let mrSeqBase\s*=\s*(\d+)/);
      expect(mrBaseMatch, "mrSeqBase declaration not found").not.toBeNull();
      const mrSeqBase = parseInt(mrBaseMatch![1], 10);

      const realisticPatientNames = extractAllNames(realisticSrc, "PATIENT_DATA");
      const expected = realisticPatientNames.length + 1;
      expect(
        mrSeqBase,
        `pediatric mrSeqBase=${mrSeqBase} must equal seed-realistic PATIENT_DATA.length+1 (=${expected}) for contiguous numbering`,
      ).toBe(expected);
    });
  });

  // ── PATIENT_DATA (seed-realistic.ts) ──────────────────────────────────
  describe("seed-realistic.ts :: PATIENT_DATA", () => {
    const names = extractAllNames(realisticSrc, "PATIENT_DATA");
    const ages = extractAllAges(realisticSrc);

    it("contains at least one patient", () => {
      expect(names.length).toBeGreaterThan(0);
    });

    it("name and age count match (each row carries an age literal)", () => {
      expect(ages.length).toBe(names.length);
    });

    it("every patient has a non-empty name", () => {
      for (const n of names) expect(n.trim().length).toBeGreaterThan(0);
    });

    it("every patient has age >= 1 (no age=0, no negative ages)", () => {
      for (let i = 0; i < ages.length; i++) {
        expect(ages[i], `${names[i]} age must be >= 1`).toBeGreaterThanOrEqual(1);
      }
    });

    it("MR sequence starts at 1 (`let mrSeq = 1`)", () => {
      // The padStart-6 format produces MR000001 from mrSeq=1. Any other
      // start would re-introduce a gap relative to the SystemConfig
      // next_mr_number bookkeeping in seed.ts.
      expect(realisticSrc).toMatch(/let mrSeq\s*=\s*1\b/);
    });
  });

  // ── seed.ts SystemConfig + canonical patient row ──────────────────────
  describe("seed.ts :: SystemConfig + canonical patient row", () => {
    it("Rahul Kumar's hard-coded mrNumber is MR000001 (must match seed-realistic mrSeq=1)", () => {
      // Both seed.ts and seed-realistic.ts upsert by email
      // patient1@medcore.local. The MR string must match in both places
      // or a re-seed creates an inconsistent row.
      expect(seedSrc).toMatch(/mrNumber:\s*"MR000001"/);
    });

    it("next_mr_number SystemConfig value exceeds total seeded MR count (regression #499)", () => {
      const m = seedSrc.match(/key:\s*"next_mr_number",\s*value:\s*"(\d+)"/);
      expect(m, "next_mr_number SystemConfig key not found in seed.ts").not.toBeNull();
      const nextMr = parseInt(m![1], 10);

      const realisticCount = extractAllNames(realisticSrc, "PATIENT_DATA").length;
      const pediatricCount = extractAllNames(pediatricSrc, "PEDIATRIC_PATIENTS").length;

      // The next free MR must be strictly greater than the highest MR
      // any seed file allocates. With contiguous numbering that's
      // realistic + pediatric.
      const highestAllocated = realisticCount + pediatricCount;
      expect(
        nextMr,
        `next_mr_number=${nextMr} must be > highest seeded MR sequence (${highestAllocated})`,
      ).toBeGreaterThan(highestAllocated);
    });
  });
});
