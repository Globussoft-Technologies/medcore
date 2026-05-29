// Pearl PRD Stage 1 §6 / gap-doc row 326 — "WhatsApp share of printed Rx
// sends signed-PDF link". Closes the row that previously read
// "Functional but not timed: share button + signed-PDF URL exist; no e2e
// that asserts the WhatsApp deep-link triggers".
//
// What this exercises:
//   - apps/web/src/app/patient/prescriptions/page.tsx — the patient PWA's
//     My-Prescriptions list. Each shareable row (signatureUrl set AND
//     status not in CANCELLED/REJECTED/DRAFT) renders an `<a>` with
//     `data-testid="patient-prescriptions-share-btn"` whose `href` is
//     `https://wa.me/?text=<encoded message containing the verify URL>`.
//   - The verify URL points at `/verify/rx/<rxId>` on the same origin —
//     the public verify page where any third-party can confirm the
//     signed-PDF authenticity (qrcode + hash, prescriptions.ts:1396+).
//
// Why this is the right surface:
//   The staff `/dashboard/prescriptions` "Share via WhatsApp" button hits
//   `POST /prescriptions/:id/share` which delivers via Meta Cloud API
//   server-side — no `wa.me/?text=` deep-link generated client-side.
//   The actual `wa.me/?text=` deep-link with the signed-Rx URL embedded
//   lives ONLY on the patient PWA (see also `/patient/dashboard` for the
//   most-recent-Rx tile). The Pearl §6.1 patient-facing PWA is the
//   surface row 326's "WhatsApp share of printed Rx sends signed-PDF
//   link" actually describes — staff share is a different protocol.
//
// Why route-intercept rather than a real seeded patient JWT:
//   The patient PWA gates content on the patient-OTP cookie set by
//   `POST /api/v1/patient-auth/otp-verify`, NOT the staff bearer-token
//   flow `apiLogin` in fixtures.ts uses. The existing `patientPage`
//   fixture authenticates via /auth/login (staff bearer-token flow with
//   role=PATIENT) which does not mint the patient-auth cookies the page
//   probes. Adding an OTP fixture is deferred to a separate piece (see
//   touch-target-audit.spec.ts:35-43 scope-cut). We instead route-
//   intercept `**/api/v1/prescriptions*` with a known-shaped list so the
//   page renders the deterministic row we want to inspect — a REAL DOM
//   assertion against the real page bundle, not a vitest unit test.
//
// Scope-cuts vs the PRD prose:
//   - "Sends" — we assert the deep-link's existence + shape (verify URL
//     embedded, https://wa.me/ host), not that the patient's WhatsApp
//     client actually opens. Asserting OS-level handler launch is out of
//     scope for a browser e2e — the deep-link contract IS the wa.me URL
//     shape, and Meta + iOS/Android handle the rest.
//   - "Printed Rx" — Pearl groups print + share as sister flows. The
//     printed PDF surface is covered by row 323 (new-patient-OPD-timed)
//     which asserts the `application/pdf` Content-Type + `%PDF-` magic
//     bytes. This spec is the share-link sibling.
//
// Per CLAUDE.md gotchas:
//   - #10: only one role=alert (the error state) — no global route
//     announcer hops because we never use getByRole('alert').
//   - #8: no patient names with digits — the mocked row uses "Sharma".
//   - The page doesn't render a <select>, so gotcha #9 doesn't apply.

import { test, expect } from "@playwright/test";

const KNOWN_RX_ID = "rx-pearl-row-326-share-link-test";
const KNOWN_DOCTOR_NAME = "Sharma";

interface MockedRx {
  id: string;
  createdAt: string;
  diagnosis: string | null;
  status: string;
  signatureUrl: string;
  doctor: {
    user: { name: string };
    specialty: string;
  };
  items: Array<{
    id: string;
    medicineName: string;
    dosage: string;
    frequency: string;
  }>;
}

function buildMockedRx(): MockedRx {
  return {
    id: KNOWN_RX_ID,
    createdAt: "2026-05-15T10:00:00Z",
    diagnosis: "Pearl §6 row 326 — share-link e2e fixture",
    // ISSUED ∉ NON_SHAREABLE_STATUSES → share CTA visible.
    status: "ISSUED",
    // signatureUrl populated → isShareable === true (page.tsx:288-290).
    signatureUrl: "https://example.com/sig.png",
    doctor: {
      user: { name: KNOWN_DOCTOR_NAME },
      specialty: "General",
    },
    items: [
      {
        id: `${KNOWN_RX_ID}-item-1`,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "TID",
      },
    ],
  };
}

test.describe("Pearl §6 row 326 — patient PWA's Share-via-WhatsApp button generates a wa.me deep-link carrying the signed-Rx verify URL", () => {
  test("the share <a> on /patient/prescriptions has href starting with https://wa.me/?text= AND the encoded message body contains the /verify/rx/<id> URL pointing at the prescription's public verify page", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      // /patient/prescriptions is wrapped by the staff DashboardLayout
      // (PatientLayoutShell.tsx:96-100 routes everything except /patient,
      // /patient/login, /patient/register through staff chrome). The
      // DashboardLayout probes /auth/me and bounces unauthed visitors
      // to /login — when the test only mocked /prescriptions, the
      // /auth/me probe got a real 401 and the page never mounted, so
      // the seeded share-row never appeared. Mock /auth/me to return a
      // PATIENT user so the layout's auth gate passes and the page
      // renders. The shape mirrors `apps/web/src/lib/store.ts:coerceUser`'s
      // expectations.
      await page.route("**/api/v1/auth/me", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: {
                id: "pearl-row-326-patient",
                email: "pearl.row.326@example.com",
                name: "Pearl Row 326 Patient",
                role: "PATIENT",
                tenantId: null,
                patient: { id: "pearl-row-326-patient-row", abhaId: null },
              },
              error: null,
            }),
          });
          return;
        }
        await route.continue();
      });

      // Route-intercept the prescriptions list endpoint with a known row.
      // Matches the page's fetch shape: GET /api/v1/prescriptions?page=1&limit=20
      // (page.tsx:138-140). We don't differentiate page numbers — the spec only
      // needs the first page to render the share row.
      const mockedRx = buildMockedRx();
      await page.route("**/api/v1/prescriptions*", async (route) => {
        const url = route.request().url();
        // Only handle the LIST endpoint; let any other prescription sub-path
        // (e.g. /:id/pdf — the share button never hits this, but the page's
        // download CTA is `<a href>` and doesn't fetch) fall through. The
        // share <a> is href-only, no fetch fires when we read its href.
        if (
          route.request().method() === "GET" &&
          /\/api\/v1\/prescriptions(\?|$)/.test(url)
        ) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: [mockedRx],
              error: null,
              meta: { page: 1, limit: 20, total: 1 },
            }),
          });
          return;
        }
        await route.continue();
      });

      // The PWA shell + page render unconditionally; the page's auth state
      // machine probes /api/v1/prescriptions and decodes the 200 above as
      // a happy-path "ready" state with one row. No OTP cookie needed —
      // the page never inspects cookies directly.
      const navResp = await page.goto("/patient/prescriptions", {
        waitUntil: "domcontentloaded",
      });
      // Tolerate a 200/304 on the page bundle itself; the SPA mounts and
      // fires the API call after first paint.
      test.skip(
        !navResp || navResp.status() >= 400,
        `/patient/prescriptions failed to load (status ${navResp?.status()}). ` +
          "Likely the local web app on :3000 isn't running; suite defers to CI."
      );

      // Page-driven assertion — wait for the seeded row to materialize.
      // The row testid mirrors the unit test (page.test.tsx:114).
      const row = page.locator(
        '[data-testid="patient-prescriptions-row"][data-prescription-id="' +
          KNOWN_RX_ID +
          '"]'
      );
      await row.waitFor({ state: "visible", timeout: 10_000 });

      // Lock onto the share <a> scoped to this row so future fixtures
      // (multiple rows) don't break the assertion.
      const shareAnchor = row.locator(
        '[data-testid="patient-prescriptions-share-btn"]'
      );
      await expect(shareAnchor).toBeVisible();

      const href = await shareAnchor.getAttribute("href");
      expect(
        href,
        "patient-prescriptions-share-btn must carry an href attribute (page.tsx renders an <a>, not a button)"
      ).toBeTruthy();

      // Assertion 1 — wa.me deep-link host shape.
      expect(
        href!.startsWith("https://wa.me/?text="),
        `Pearl §6 row 326: share href must be a wa.me deep-link of the shape ` +
          `https://wa.me/?text=<encoded>. Got: ${href}`
      ).toBe(true);

      // Assertion 2 — decoded message body contains the verify URL with the
      // prescription id baked in. encodeURIComponent doesn't escape ":" or
      // "/" so we can grep for the path directly. The host varies by origin
      // (localhost / staging / prod) — we only assert the path.
      const decoded = decodeURIComponent(
        href!.replace("https://wa.me/?text=", "")
      );
      expect(
        decoded,
        `Pearl §6 row 326: decoded wa.me message body must contain the verify ` +
          `URL path /verify/rx/${KNOWN_RX_ID} so the recipient can verify the ` +
          `signed Rx. Got: ${decoded}`
      ).toContain(`/verify/rx/${KNOWN_RX_ID}`);

      // Assertion 3 — message body names the doctor so the recipient knows
      // who issued the script (page.tsx:294-296). Defensive: catches the
      // class of regression where a refactor drops the doctor-name prefix
      // and the patient gets an anonymous "My prescription: <url>" blob.
      expect(
        decoded,
        `Pearl §6 row 326: decoded wa.me message body should reference the ` +
          `prescribing doctor name. Got: ${decoded}`
      ).toContain(`Dr. ${KNOWN_DOCTOR_NAME}`);

      // Assertion 4 — opens in a new tab + no opener leak. Defense against
      // a regression that turns the <a> into a same-tab navigation (which
      // would nuke the patient's PWA state on iOS/Android).
      await expect(shareAnchor).toHaveAttribute("target", "_blank");
      await expect(shareAnchor).toHaveAttribute("rel", "noopener noreferrer");
    } finally {
      await ctx.close();
    }
  });
});
