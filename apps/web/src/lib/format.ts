/**
 * Small collection of defensive formatters for user-facing display.
 *
 * These are deliberately forgiving: they never throw and they never render
 * "Invalid Date" / "NaN" / "null" — UI shows an em-dash placeholder for any
 * bad input. That prevents a single malformed row (e.g. a legacy LeaveRequest
 * with a null fromDate) from making an entire page look broken.
 */

const PLACEHOLDER = "—";

/**
 * Safely render a date-ish value as a locale date string.
 *
 * Accepts the full universe of values that might arrive from the API / DB:
 *  - `null` / `undefined`              → placeholder
 *  - `""`                              → placeholder
 *  - `"invalid string"`                → placeholder
 *  - numeric `NaN`                     → placeholder
 *  - ISO strings / `Date` instances    → `Date.toLocaleDateString(locale)`
 *  - millisecond numbers               → `Date.toLocaleDateString(locale)`
 *
 * @param value  Any value that could conceivably represent a date.
 * @param locale Optional locale; defaults to the runtime default.
 * @returns Formatted date string, or "—" for any unparsable input.
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  locale?: string
): string {
  if (value === null || value === undefined) return PLACEHOLDER;
  if (typeof value === "string" && value.trim() === "") return PLACEHOLDER;
  if (typeof value === "number" && Number.isNaN(value)) return PLACEHOLDER;

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;

  return d.toLocaleDateString(locale);
}

/**
 * Safely render a date-ish value as a locale date-time string. Same defensive
 * semantics as {@link formatDate}.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale?: string
): string {
  if (value === null || value === undefined) return PLACEHOLDER;
  if (typeof value === "string" && value.trim() === "") return PLACEHOLDER;
  if (typeof value === "number" && Number.isNaN(value)) return PLACEHOLDER;

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;

  return d.toLocaleString(locale);
}

/**
 * Render a date range as "from → to", with either side independently falling
 * back to the placeholder when unparsable.
 */
export function formatDateRange(
  from: string | number | Date | null | undefined,
  to: string | number | Date | null | undefined,
  locale?: string
): string {
  return `${formatDate(from, locale)} – ${formatDate(to, locale)}`;
}

/**
 * Compute completed years of age from a date of birth.
 *
 * Returns `null` (never `0`) for any input we cannot confidently compute from —
 * UI call sites should render the placeholder "—" / "Unknown" for null, NOT
 * "0". Zero is ONLY returned when the DOB is genuinely less than 1 full year
 * in the past (infants).
 *
 * - `null` / `undefined` / empty / invalid string → `null`
 * - DOB in the future (clock-skew / bad data)     → `null`
 * - Valid DOB, <1 year old infant                 → `0` (real answer)
 * - Valid DOB, older                              → completed years
 *
 * Leap-year safe: uses anniversary comparison on month/day rather than
 * dividing by 365.25 which drifts by ~0.25 days per year.
 */
export function ageFromDOB(
  dob: string | number | Date | null | undefined,
  now: Date = new Date()
): number | null {
  if (dob === null || dob === undefined) return null;
  if (typeof dob === "string" && dob.trim() === "") return null;
  if (typeof dob === "number" && Number.isNaN(dob)) return null;

  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;

  // Future DOB is always garbage — do NOT return 0 (would falsely flag as
  // newborn). Return null so the caller renders the placeholder.
  if (birth.getTime() > now.getTime()) return null;

  let years = now.getFullYear() - birth.getFullYear();
  const monthDelta = now.getMonth() - birth.getMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getDate() < birth.getDate())
  ) {
    years--;
  }
  // Sanity ceiling — anything over 150 is data corruption, not a supercentenarian.
  if (years < 0 || years > 150) return null;
  return years;
}

/**
 * Display an age for a patient row, given whatever mix of stored `age` and
 * `dateOfBirth` the API returned. Prefers DOB (always accurate) and falls
 * back to the stored integer. Returns "—" instead of "0" for unknown cases.
 *
 * Rules:
 *   - DOB present and parseable → render DOB-derived age (may be 0 for infants,
 *     which is a real answer)
 *   - DOB missing, `age` is a positive integer → render it
 *   - DOB missing, `age` is 0 / null / undefined → render "—"
 *     (legacy data where age was never set)
 */
export function formatPatientAge(
  patient: {
    age?: number | null;
    dateOfBirth?: string | number | Date | null;
  },
  placeholder: string = PLACEHOLDER
): string {
  const fromDob = ageFromDOB(patient.dateOfBirth ?? null);
  if (fromDob !== null) return String(fromDob);
  const stored = patient.age;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return String(stored);
  }
  return placeholder;
}
