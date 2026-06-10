// Patient-portal link helper.
//
// Builds the "view your appointments / reports" URL that we append to
// outbound WhatsApp/SMS booking + reschedule confirmations so the patient
// can tap straight through to sign in. The base comes from PUBLIC_APP_URL
// (set per-env, e.g. http://localhost:3000 in dev, the real domain in prod);
// falls back to a sensible default if unset so messages never ship a broken
// "undefined" URL. WhatsApp/SMS clients auto-linkify the bare URL.

const DEFAULT_BASE = "http://localhost:3000";

/** The configured site base URL, trailing slash stripped. */
export function siteBaseUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim() || DEFAULT_BASE;
  return raw.replace(/\/+$/, "");
}

/** Deep link to the patient sign-in page (where they view appointments). */
export function patientPortalLink(): string {
  return `${siteBaseUrl()}/patient/login`;
}
