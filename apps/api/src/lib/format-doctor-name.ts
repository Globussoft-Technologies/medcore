// Issue #201 / #841: doctor names in `User.name` are stored with an
// inconsistent leading "Dr." in some rows (seed data + manual entries) and
// not in others. The API was concatenating `Dr. ${user.name}` raw across
// the patient timeline, search, agent-console, prescriptions, lab, and
// appointments handlers — producing "Dr. Dr. Rajesh Sharma" wherever the
// stored name already carried the prefix.
//
// Mirrors apps/web/src/lib/format-doctor-name.ts. Defensive:
//  - tolerates null / undefined / empty strings (returns "")
//  - strips any leading "Dr" / "Dr." / "DR." / "dr." (case-insensitive)
//    and any number of consecutive repetitions
//  - always returns the canonical "Dr. {name}" form when a name is present
export function formatDoctorName(name: string | null | undefined): string {
  if (!name) return "";
  const stripped = name.replace(/^(Dr\.?\s+)+/i, "").trim();
  if (!stripped) return "";
  return `Dr. ${stripped}`;
}
