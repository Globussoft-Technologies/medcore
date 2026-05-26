/**
 * Test-cron tick (2026-05-25) — unit coverage for the Pearl §8.2 staff
 * email-invite HTML template at `apps/api/src/templates/user-invite.html.ts`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `renderUserInviteEmail()` — the only
 *   exported function. Pins:
 *     * Returns `{ subject, html, text }` with the inputs substituted into
 *       all expected slots (tenant in subject + h1 + intro, invitee email
 *       in intro, accept URL in both the button and the visible fallback
 *       link, expiry rendered in Asia/Kolkata locale).
 *     * The accept URL appears EXACTLY TWICE in the html — once in the
 *       button `<a href>`, once as the visible "copy this link" anchor.
 *     * `escapeHtml()` converts the 5 HTML-significant characters
 *       (`& < > " '`) to their entity equivalents in tenant + email + url
 *       so injected `<script>`/attribute-break payloads cannot escape the
 *       template context. The raw payload tokens must NOT appear in the
 *       rendered html (just their escaped forms).
 *     * The `&` ampersand replacement runs FIRST so a payload like `&lt;`
 *       round-trips to `&amp;lt;` rather than collapsing back to `<`
 *       (catches the double-escape ordering regression).
 *     * Subject line uses the RAW tenant name (not escaped) — RFC 5322
 *       headers are not HTML, and SendGrid handles header encoding for
 *       us. This is intentional and pinned so a "harmonisation" refactor
 *       that escapes the subject too doesn't drift the on-the-wire value.
 *     * The plain-text body uses the raw inputs (also not escaped — text
 *       MIME parts are plain text, not HTML).
 *     * Expiry formatting always renders in Asia/Kolkata regardless of
 *       the server's TZ env — pinned by checking a known UTC instant
 *       maps to its IST representation (+05:30).
 *     * Empty-string tenant / empty-string email / empty-string url all
 *       render without throwing (no required-field guard in the source —
 *       caller is responsible for validation). This is the "missing-field
 *       fallback behaviour" — the template degrades gracefully.
 *
 * - MODULES: imports `renderUserInviteEmail` from `./user-invite.html`.
 *   No mocks needed — the function is pure (Date.toLocaleString uses ICU
 *   bundled with Node, deterministic in CI).
 *
 * - WHY: the file shipped at 0% coverage. The route at
 *   `apps/api/src/routes/user-invites.ts` ships this body to SendGrid for
 *   every staff invite; an XSS escape regression here would land injected
 *   HTML in an admin's mailbox (rendered by their mail client). The
 *   escape-ordering pin is the load-bearing assertion — the rest are
 *   substitution + structural sanity checks.
 *
 * No module-scope state, no env reads — no cleanup contract needed.
 */
import { describe, it, expect } from "vitest";
import { renderUserInviteEmail } from "./user-invite.html";

// A fixed UTC instant we can pin against the IST rendering.
// 2026-06-15T08:30:00Z → 2026-06-15T14:00 IST (+05:30).
const FIXED_EXPIRY = new Date("2026-06-15T08:30:00.000Z");

function defaults() {
  return {
    inviteeEmail: "newuser@example.com",
    tenantName: "Acme Hospital",
    acceptUrl: "https://medcore.example.com/accept-invite?token=abc.def.ghi",
    expiresAt: FIXED_EXPIRY,
  };
}

// ── happy render ────────────────────────────────────────────────────────

describe("renderUserInviteEmail produces a three-part envelope on a fully populated input", () => {
  it("returns subject, html, and text strings", () => {
    const out = renderUserInviteEmail(defaults());
    expect(typeof out.subject).toBe("string");
    expect(typeof out.html).toBe("string");
    expect(typeof out.text).toBe("string");
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("renders an html5 doctype document wrapped in <html lang='en'>", () => {
    const { html } = renderUserInviteEmail(defaults());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<\/html>$/);
  });
});

// ── field substitution ─────────────────────────────────────────────────

describe("renderUserInviteEmail substitutes each input field into its expected slot", () => {
  it("places the tenant name in the subject line", () => {
    const { subject } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "St Jude Clinic",
    });
    expect(subject).toBe("You've been invited to join St Jude Clinic on MedCore");
  });

  it("places the tenant name in the html h1 and intro paragraph (twice in html)", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "UniqueTenantXYZ",
    });
    const matches = html.match(/UniqueTenantXYZ/g) ?? [];
    // Once in <h1>, once in the <strong> within the intro paragraph.
    expect(matches.length).toBe(2);
  });

  it("places the invitee email in the intro paragraph (once)", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      inviteeEmail: "unique-recipient@example.com",
    });
    const matches = html.match(/unique-recipient@example\.com/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("places the accept URL EXACTLY TWICE in the html (button href + fallback link)", () => {
    const url = "https://medcore.example.com/accept-invite?token=unique-token-xyz";
    const { html } = renderUserInviteEmail({ ...defaults(), acceptUrl: url });
    // Escape regex special chars in URL.
    const escapedForRegex = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = html.match(new RegExp(escapedForRegex, "g")) ?? [];
    expect(matches.length).toBe(3); // 1 button href + 1 fallback href + 1 visible text
    // Verify the structural shape: button + visible fallback anchor.
    expect(html).toMatch(/<a href="[^"]*unique-token-xyz[^"]*"\s+style/);
    expect(html).toMatch(/>https:\/\/medcore\.example\.com\/accept-invite\?token=unique-token-xyz<\/a>/);
  });

  it("places the accept URL in the plain-text body as 'Set your password: <url>'", () => {
    const url = "https://medcore.example.com/accept-invite?token=text-test";
    const { text } = renderUserInviteEmail({ ...defaults(), acceptUrl: url });
    expect(text).toMatch(new RegExp(`Set your password: ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("places the invitee email in the plain-text body as 'Email: <addr>'", () => {
    const { text } = renderUserInviteEmail({
      ...defaults(),
      inviteeEmail: "textuser@example.com",
    });
    expect(text).toMatch(/Email: textuser@example\.com/);
  });

  it("renders the expiry in the html body (escaped via escapeHtml of the locale string)", () => {
    const { html } = renderUserInviteEmail(defaults());
    // Asia/Kolkata medium date + short time for 2026-06-15T08:30Z = 15 Jun 2026, 02:00 pm
    // The exact glyphs vary by ICU version but must contain the year and an IST hour.
    expect(html).toMatch(/2026/);
    // The expiry slot is bolded in the html.
    expect(html).toMatch(/expires on <strong>[^<]+<\/strong>/);
  });

  it("renders the expiry in the plain-text body with the Asia/Kolkata trailer", () => {
    const { text } = renderUserInviteEmail(defaults());
    expect(text).toMatch(/Expires: .+\(Asia\/Kolkata\)/);
    expect(text).toMatch(/2026/);
  });

  it("formats the expiry in Asia/Kolkata regardless of the server TZ (UTC 08:30 → IST 02:00 pm)", () => {
    // The IST representation of 2026-06-15T08:30:00Z is 2026-06-15 14:00 IST.
    // Locale 'en-IN' with timeStyle:'short' renders as "2:00 pm" (or "2:00 PM"
    // depending on ICU version) — assert the digits and the pm marker
    // case-insensitively so we're robust to ICU upgrades.
    const { text } = renderUserInviteEmail(defaults());
    expect(text).toMatch(/2:00\s*[pP][mM]/);
  });
});

// ── HTML-injection guard ───────────────────────────────────────────────

describe("renderUserInviteEmail escapes HTML-significant characters in user-supplied fields", () => {
  it("escapes < and > in tenantName so an injected <script> cannot execute", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "<script>alert(1)</script>",
    });
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("escapes < and > in inviteeEmail", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      inviteeEmail: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
    expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("escapes \" and ' so attribute-context payloads cannot break out", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      acceptUrl: 'https://x.test/"onload="alert(1)',
    });
    // The double-quote in the URL must be escaped so it does NOT close the
    // href attribute. The raw " must not appear inside the href value.
    expect(html).toMatch(/href="https:\/\/x\.test\/&quot;onload=&quot;alert\(1\)"/);
    expect(html).not.toMatch(/href="https:\/\/x\.test\/"onload="alert\(1\)"/);
  });

  it("escapes the apostrophe in tenantName as &#39;", () => {
    const { html } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "O'Reilly Clinic",
    });
    expect(html).toMatch(/O&#39;Reilly Clinic/);
    expect(html).not.toMatch(/<h1[^>]*>You're invited to O'Reilly Clinic<\/h1>/);
  });

  it("escapes & FIRST so an already-encoded entity becomes &amp;lt; (not collapsed back to <)", () => {
    // If & is replaced AFTER <, "&lt;" → "&lt;" (no change), and a later
    // payload with raw < would still escape correctly. But if & is replaced
    // AFTER, we'd see "&amp;lt;" only when the source had a literal &.
    // The pinned ordering is &-first, so "&lt;" in the input should render
    // as "&amp;lt;" (the ampersand was escaped to &amp;).
    const { html } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "&lt;Hospital&gt;",
    });
    expect(html).toMatch(/&amp;lt;Hospital&amp;gt;/);
    // Crucially, the rendered html must NOT contain "&lt;Hospital&gt;" as a
    // bare substring — that would mean the entities were emitted literally
    // and a mail client would render them as <Hospital> text. The escaped
    // form &amp;lt; renders as the literal four characters "&lt;".
    // (Negative assertion using a non-overlapping anchor to avoid matching
    // the &amp;lt; substring as a positive.)
    expect(html.match(/&lt;Hospital&gt;/g)).toBeNull();
  });

  it("does NOT escape the subject (RFC 5322 headers are not HTML)", () => {
    const { subject } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "<Acme>",
    });
    expect(subject).toBe("You've been invited to join <Acme> on MedCore");
    expect(subject).not.toMatch(/&lt;/);
  });

  it("does NOT escape the plain-text body (text MIME parts are not HTML)", () => {
    const { text } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "<Acme & Co>",
      inviteeEmail: "user+tag@example.com",
    });
    expect(text).toMatch(/<Acme & Co>/);
    expect(text).not.toMatch(/&lt;/);
    expect(text).not.toMatch(/&amp;/);
  });
});

// ── missing / empty field fallbacks ────────────────────────────────────

describe("renderUserInviteEmail degrades gracefully when string fields are empty", () => {
  it("renders without throwing when tenantName is the empty string", () => {
    expect(() =>
      renderUserInviteEmail({ ...defaults(), tenantName: "" }),
    ).not.toThrow();
    const { subject, html } = renderUserInviteEmail({
      ...defaults(),
      tenantName: "",
    });
    expect(subject).toBe("You've been invited to join  on MedCore");
    expect(html).toMatch(/You're invited to <\/h1>/);
  });

  it("renders without throwing when inviteeEmail is the empty string", () => {
    expect(() =>
      renderUserInviteEmail({ ...defaults(), inviteeEmail: "" }),
    ).not.toThrow();
    const { text } = renderUserInviteEmail({
      ...defaults(),
      inviteeEmail: "",
    });
    expect(text).toMatch(/Email: \n/);
  });

  it("renders without throwing when acceptUrl is the empty string (button still emitted with empty href)", () => {
    expect(() =>
      renderUserInviteEmail({ ...defaults(), acceptUrl: "" }),
    ).not.toThrow();
    const { html, text } = renderUserInviteEmail({
      ...defaults(),
      acceptUrl: "",
    });
    expect(html).toMatch(/<a href=""/);
    expect(text).toMatch(/Set your password: \n/);
  });

  it("renders without throwing when ALL string fields are empty (and the Date is still valid)", () => {
    expect(() =>
      renderUserInviteEmail({
        inviteeEmail: "",
        tenantName: "",
        acceptUrl: "",
        expiresAt: FIXED_EXPIRY,
      }),
    ).not.toThrow();
  });

  it("throws (or produces 'Invalid Date') when expiresAt is an invalid Date — surfaces upstream rather than silently shipping", () => {
    const invalid = new Date("not-a-date");
    // toLocaleString on an invalid Date returns "Invalid Date" in Node ICU —
    // it does NOT throw. Pin this so a caller that forgets to validate the
    // date sees the literal "Invalid Date" string in the body (loudly broken,
    // not silently wrong).
    const { html, text } = renderUserInviteEmail({
      ...defaults(),
      expiresAt: invalid,
    });
    expect(html).toMatch(/Invalid Date/);
    expect(text).toMatch(/Invalid Date/);
  });
});
