// Shared helper that renders a doctor's display name with exactly ONE
// "Dr. " prefix, regardless of whether the raw `User.name` in the database
// already contains one.
//
// Background (Issue #12 / #25): the seed data and some manual registrations
// save doctors with `name = "Dr. Rajesh Sharma"`. Various UI surfaces were
// independently prepending "Dr. " again, producing "Dr. Dr. Rajesh Sharma"
// in headers, appointment confirmations, and patient-facing notifications.
//
// The helper is defensive:
//  - tolerates null / undefined / empty strings (returns "")
//  - strips any leading "Dr" / "Dr." / "DR." / "dr." (case-insensitive)
//    and any number of consecutive repetitions (pre-buggy data like
//    "Dr. Dr. Rajesh")
//  - always returns the canonical "Dr. {name}" form when a name is present
export function formatDoctorName(name: string | null | undefined): string {
  if (!name) return "";
  const stripped = name.replace(/^(Dr\.?\s+)+/i, "").trim();
  if (!stripped) return "";
  return `Dr. ${stripped}`;
}
