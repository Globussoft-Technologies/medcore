import { z } from "zod";

export const LabTestStatus = z.enum([
  "ORDERED",
  "SAMPLE_COLLECTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const LabResultFlag = z.enum(["NORMAL", "LOW", "HIGH", "CRITICAL"]);

export const createLabTestSchema = z.object({
  code: z.string().min(1, "Code is required"),
  name: z.string().min(1, "Name is required"),
  category: z.string().optional(),
  price: z.number().nonnegative(),
  sampleType: z.string().optional(),
  normalRange: z.string().optional(),
  description: z.string().optional(),
});

export const updateLabTestSchema = createLabTestSchema.partial();

export const createLabOrderSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  testIds: z.array(z.string().uuid()).min(1, "At least one test is required"),
  notes: z.string().max(2000).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
});

export const updateLabOrderStatusSchema = z.object({
  status: LabTestStatus,
});

// Issue #642 / #618: per-field caps on lab result inputs. Without
// these caps Notes/Parameter/Value accepted multi-megabyte payloads
// and the result table broke layout (a 2000-char Parameter renders
// off-screen). Caps mirror the realistic clinical envelopes:
//   - parameter: <= 200 chars (e.g. "Total Cholesterol / HDL ratio")
//   - value: <= 400 chars (long qualitative descriptions)
//   - unit / normalRange: <= 80 chars
//   - notes: <= 2000 chars (clinician narrative)
//
// Issue #616 (partial XSS sanitisation on Unit): the global
// `sanitize` middleware strips angle brackets BEFORE the schema runs,
// so `<script>alert(1)</script>` reached the DB as the textually-
// valid string `alert(1)`. We tighten `unit` (and `normalRange`) to
// the canonical lab-unit alphabet — letters, digits, % / mol / molar
// math (`/ * - + . , ( )`), whitespace, the micro sign µ, the
// superscript/subscript digits (`²³`), and the degree sign `°`. Anything
// else (parens with embedded `alert`, `=`, `<`, `>`, semicolons,
// quotes, backticks) is rejected outright instead of silently
// stripped. The set is intentionally liberal so legitimate units like
// `mg/dL`, `mmol/L`, `µg/mL`, `IU/mL`, `cells/mm³`, `°C`, `% (v/v)`
// all pass.
const LAB_UNIT_REGEX = /^[A-Za-z0-9µ°²³%/\\\-+*.,()\s\^]+$/;

export const recordLabResultSchema = z.object({
  orderItemId: z.string().uuid(),
  parameter: z.string().min(1, "Parameter is required").max(200),
  value: z.string().min(1, "Value is required").max(400),
  unit: z
    .string()
    .max(80)
    .regex(
      LAB_UNIT_REGEX,
      "Unit may contain letters, digits, %, /, ^, parentheses and basic math symbols only",
    )
    .optional(),
  normalRange: z.string().max(80).optional(),
  flag: LabResultFlag.optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Issue #95 (clinical safety): for tests with a numeric result type
 * (i.e. the LabTest has a `unit` set, or `panicLow`/`panicHigh` thresholds
 * defined), the entered `value` MUST parse as a finite number. Saving free
 * text like "abc" as a numeric result silently bypasses delta-checks and
 * panic-value alerts. The router calls this AFTER `recordLabResultSchema`.
 *
 * Issue #611 (clinical sanity): also reject biologically-impossible
 * negative values for numeric tests. Negative values for things like
 * Hemoglobin / Creatinine / TSH are nonsense and previously stored
 * silently as `flag=NORMAL`. We allow negatives only when the test's
 * own `panicLow` is itself negative (e.g. base excess, anion gap),
 * which keeps the rule conservative.
 *
 * Returns null on success, or { field, message } on rejection so the API
 * can emit the same field-level error shape as the zod middleware.
 */
export function validateNumericLabResult(input: {
  value: string;
  test: {
    unit?: string | null;
    panicLow?: number | null;
    panicHigh?: number | null;
  };
}): { field: string; message: string } | null {
  const isNumericTest =
    (typeof input.test.unit === "string" && input.test.unit.trim().length > 0) ||
    typeof input.test.panicLow === "number" ||
    typeof input.test.panicHigh === "number";
  if (!isNumericTest) return null;
  const trimmed = input.value.trim();
  // Accept bare numbers, optional sign and decimal: "12", "12.5", "-1.4"
  const numeric = /^-?\d+(\.\d+)?$/;
  if (!numeric.test(trimmed)) {
    return {
      field: "value",
      message:
        "Value must be a number for this test (e.g. 12.5). Free text is not allowed.",
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { field: "value", message: "Value must be a finite number" };
  }
  // Issue #611: reject negatives unless the test's own panic floor is < 0
  // (allowing tests like base excess where negative is biologically valid).
  const allowsNegative =
    typeof input.test.panicLow === "number" && input.test.panicLow < 0;
  if (n < 0 && !allowsNegative) {
    return {
      field: "value",
      message:
        "Value must be ≥ 0 for this test (negative results are biologically impossible).",
    };
  }
  return null;
}

/**
 * Issue #611 (clinical safety): auto-elevate the result flag based on the
 * test's panic thresholds. A LabTech who submits `NORMAL` (or omits flag)
 * for a value that is outside the panic range should NOT be able to bury
 * a clinically dangerous result as Normal — the server overrides to
 * CRITICAL. The submitted flag is only honoured when the value sits
 * inside the panic range.
 *
 * Returns the effective flag the route should persist.
 */
export function deriveLabResultFlag(input: {
  value: string;
  flag?: "NORMAL" | "LOW" | "HIGH" | "CRITICAL" | null;
  test: {
    panicLow?: number | null;
    panicHigh?: number | null;
  };
}): "NORMAL" | "LOW" | "HIGH" | "CRITICAL" {
  const submitted = (input.flag ?? "NORMAL") as
    | "NORMAL"
    | "LOW"
    | "HIGH"
    | "CRITICAL";
  const trimmed = input.value.trim();
  const numeric = /^-?\d+(\.\d+)?$/;
  if (!numeric.test(trimmed)) return submitted;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return submitted;
  if (
    typeof input.test.panicLow === "number" &&
    n < input.test.panicLow
  ) {
    return "CRITICAL";
  }
  if (
    typeof input.test.panicHigh === "number" &&
    n > input.test.panicHigh
  ) {
    return "CRITICAL";
  }
  return submitted;
}

export const labQCSchema = z.object({
  testId: z.string().uuid(),
  qcLevel: z.enum(["LOW", "NORMAL", "HIGH", "INTERNAL"]),
  instrument: z.string().optional(),
  meanValue: z.number(),
  recordedValue: z.number(),
  cv: z.number().optional(),
  withinRange: z.boolean(),
  notes: z.string().optional(),
});

export const verifyResultSchema = z.object({
  notes: z.string().optional(),
});

export const shareLinkSchema = z.object({
  resource: z.enum(["lab_order", "prescription", "invoice"]).default("lab_order"),
  days: z.number().int().min(1).max(30).optional(), // default 7
});

export type CreateLabTestInput = z.infer<typeof createLabTestSchema>;
export type UpdateLabTestInput = z.infer<typeof updateLabTestSchema>;
export type CreateLabOrderInput = z.infer<typeof createLabOrderSchema>;
export type UpdateLabOrderStatusInput = z.infer<
  typeof updateLabOrderStatusSchema
>;
export type RecordLabResultInput = z.infer<typeof recordLabResultSchema>;
export type LabQCInput = z.infer<typeof labQCSchema>;
export type VerifyResultInput = z.infer<typeof verifyResultSchema>;
export type ShareLinkInput = z.infer<typeof shareLinkSchema>;
