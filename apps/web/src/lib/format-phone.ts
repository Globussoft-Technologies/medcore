// Issue #278 (Apr 2026): the app surfaced a mix of phone formats — the
// patients table showed `9876543212` (10-digit local), the ambulance
// trip card showed `+917321588452` (12-digit, no separator), and some
// fixture rows had 15-digit junk like `DEF-10`. We picked the canonical
// "10-digit local with optional `+91` prefix and one space" form, after
// quickly checking the other Indian-context EMRs the team uses; the
// patients table is already close enough to the canonical form, so this
// helper just normalises everything else to match.
//
// Behaviour:
//  - returns "" for null/undefined/empty input (callers should fall back
//    to a "—" placeholder themselves rather than rendering a literal
//    "+91 " with nothing after it)
//  - strips every non-digit; if the result is unrealistically short or
//    long we hand back the trimmed original so we never silently delete
//    a real-but-weird number
//  - 10 digits → `XXXXX XXXXX` (legible local form)
//  - 11 digits starting with 0 → strip the leading 0, format as 10
//  - 12 digits starting with 91 → `+91 XXXXX XXXXX`
//  - 13 digits starting with `+91` (already-formatted-ish) → same as 12
//  - anything else → return digits unchanged so the operator can see
//    something is off and edit it manually

export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 7 || digits.length > 15) {
    // Probably junk (e.g. the `DEF-10` 15-char fixture or a partially
    // typed value) — surface the original so reception can correct it
    // rather than us silently mutating it into something else.
    return trimmed;
  }

  let local: string;
  if (digits.length === 10) {
    local = digits;
    return `${local.slice(0, 5)} ${local.slice(5)}`;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    local = digits.slice(1);
    return `${local.slice(0, 5)} ${local.slice(5)}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    local = digits.slice(2);
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  if (digits.length === 13 && digits.startsWith("091")) {
    local = digits.slice(3);
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  // International or non-Indian: keep an optional leading + and group
  // the rest in 5-char chunks for legibility.
  const grouped = digits.match(/.{1,5}/g)?.join(" ") ?? digits;
  return trimmed.startsWith("+") ? `+${grouped}` : grouped;
}
