// Patient-portal link helper.
//
// Builds the "view your appointments / reports" URL appended to outbound
// WhatsApp/SMS booking + reschedule + bill confirmations so the patient can
// tap straight through.
//
// The base URL is DERIVED FROM THE INCOMING REQUEST — not from an env var —
// so it automatically uses whichever environment the user is actually on
// (the "software" host or the "demos" host) with zero per-env config. The
// same code path therefore produces a correct, working public link on BOTH
// deployments. Resolution order, most-trustworthy first:
//   1. `Origin` header   — the exact site the browser was on (the web app).
//   2. `x-forwarded-host` (+ `x-forwarded-proto`) — set by the reverse proxy
//      in front of the API, so it reflects the public host, not an internal
//      container address.
//   3. `Host` header / req.get("host") + req.protocol.
//   4. PUBLIC_APP_URL, then the demos domain — only if no request is given
//      or no host could be read (e.g. a cron/worker context with no request).
//
// Mirrors the request-host derivation already used in routes/ai-radiology.ts.
// WhatsApp/SMS clients auto-linkify the bare URL.

import type { Request } from "express";

const FALLBACK_BASE = "https://medcore.globusdemos.com";

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Resolve the public site base URL from the request. Falls back to
 * PUBLIC_APP_URL / the demos domain when no request is available (workers,
 * crons) or the host can't be read.
 */
export function siteBaseUrl(req?: Request): string {
  if (req) {
    // 1. Origin — the literal web-app URL the browser was on. Best signal.
    const origin = req.headers["origin"];
    if (typeof origin === "string" && /^https?:\/\//i.test(origin)) {
      return stripTrailingSlash(origin);
    }

    // 2/3. Reconstruct from forwarded-host / host + proto.
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ??
      req.protocol ??
      "https";
    const host =
      (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0] ??
      req.get?.("host") ??
      (req.headers["host"] as string | undefined);
    if (host) {
      return stripTrailingSlash(`${proto}://${host}`);
    }
  }

  // 4. No usable request context — fall back to env / demos domain.
  return stripTrailingSlash(process.env.PUBLIC_APP_URL || FALLBACK_BASE);
}

/** Deep link to the patient sign-in page (where they view appointments). */
export function patientPortalLink(req?: Request): string {
  return `${siteBaseUrl(req)}/patient/login`;
}

/** Deep link to a specific bill on the patient portal. */
export function patientBillLink(req: Request | undefined, invoiceId: string): string {
  return `${siteBaseUrl(req)}/patient/bills/${invoiceId}`;
}
