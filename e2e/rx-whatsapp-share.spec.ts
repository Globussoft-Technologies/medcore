// Pearl PRD Stage 1 §6 / gap-doc row 326 — "WhatsApp share of printed Rx
// sends signed-PDF link". Closes the row that previously read
// "Functional but not timed: share button + signed-PDF URL exist; no e2e
// that asserts the WhatsApp share triggers".
//
// What this exercises:
//   - apps/web/src/app/patient/prescriptions/page.tsx — the patient PWA's
//     My-Prescriptions list. Each row renders a `<button>` with
//     `data-testid="patient-prescriptions-share-btn"` that, on click,
//     POSTs `/api/v1/prescriptions/:id/share` with `{ channel: "WHATSAPP" }`
//     (page.tsx:134-155 `shareViaWhatsApp`). The server delivers the
//     signed-Rx verify link to the patient's registered phone number via
//     Meta Cloud API (prescriptions.ts:1396+ — the public verify page
//     where any third-party can confirm the signed-PDF authenticity).
//   - This is the same protocol the staff `/dashboard/prescriptions`
//     "Share via WhatsApp" CTA uses — server-side delivery, audit-logged,
//     and bound to the patient's registered phone (no client-side
//     `wa.me/?text=` deep-link).
//
// Why server-side delivery, not a client-side wa.me deep-link:
//   The previous patient-PWA implementation rendered an `<a href="wa.me/
//   ?text=<encoded verify URL>">` that opened whichever WhatsApp client
//   the device picked. That worked but had three failure modes:
//     1. The send was UNAUDITED — no record on the server that the
//        patient was offered the share, only that they tapped a deep-link.
//     2. The verify URL leaked into browser history + referrer headers
//        of whatever app opened next.
//     3. The recipient phone was whoever the patient picked in WhatsApp,
//        not necessarily the one registered with the clinic — which
//        defeats the point of an Rx delivery audit-trail.
//   The current server-delivered flow (POST /:id/share with channel
//   "WHATSAPP", routed through Meta Cloud API) fixes all three: the
//   share is logged, the verify URL never touches the client URL bar,
//   and the recipient is the registered phone (NOT a wa.me-picked one).
//
// Why route-intercept rather than a real seeded patient JWT:
//   The patient PWA gates content on the patient-OTP cookie set by
//   `POST /api/v1/patient-auth/otp-verify`, NOT the staff bearer-token
//   flow `apiLogin` in fixtures.ts uses. The existing `patientPage`
//   fixture authenticates via /auth/login (staff bearer-token flow with
//   role=PATIENT) which does not mint the patient-auth cookies the page
//   probes. Adding an OTP fixture is deferred to a separate piece (see
//   touch-target-audit.spec.ts:35-43 scope-cut). We instead route-
//   intercept the prescriptions list + share endpoint with a known-
//   shaped pair so the page renders the deterministic row we want to
//   click — a REAL DOM assertion against the real page bundle, not a
//   vitest unit test.
//
// Scope-cuts vs the PRD prose:
//   - "Sends" — we assert that clicking the share button fires a POST
//     with `{ channel: "WHATSAPP" }` to the share endpoint. Asserting
//     that Meta Cloud API actually delivers the WhatsApp template is
//     out of scope for a browser e2e (no Meta sandbox in CI). The
//     server-side delivery is covered by route-handler tests against
//     a mocked Meta client (apps/api/src/routes/__tests__/
//     prescriptions.share.test.ts).
//   - "Printed Rx" — Pearl groups print + share as sister flows. The
//     printed PDF surface is covered by row 323 (new-patient-OPD-timed)
//     which asserts the `application/pdf` Content-Type + `%PDF-` magic
//     bytes. This spec is the share sibling.
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
    // ISSUED → share CTA visible (page renders unconditionally now and
    // surfaces server-side 409s as toasts).
    status: "ISSUED",
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

test.describe("Pearl §6 row 326 — patient PWA's Share-via-WhatsApp button POSTs the server-side share endpoint with channel=WHATSAPP", () => {
  test("clicking the share <button> on /patient/prescriptions fires POST /api/v1/prescriptions/:id/share with body { channel: 'WHATSAPP' } — the server delivers the verify link to the patient's registered phone via Meta Cloud API", async ({
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
      //
      // Catch-all guard against the global 401 redirect. Any unmocked
      // /api/v1/* call (e.g. DashboardLayout's /branches sidebar probe,
      // /chat/unread polls, /branding lookup) returns an empty 200 —
      // this prevents the global 401 redirect in lib/api.ts:90-94
      // (`window.location.replace(/login?next=...)`) from firing on a
      // single un-routed background poll and trashing the page
      // mid-render. Without this guard, webkit shards flake with a
      // navigation to /login?next=/patient/prescriptions before the
      // seeded row ever paints.
      //
      // Order-independent via route.fallback(): the catch-all defers to
      // any later-registered specific handler whose URL matches, so the
      // specific /auth/me + /prescriptions* routes below always take
      // precedence regardless of Playwright's handler order semantics.
      const SPECIFIC_PATTERNS = [
        /\/api\/v1\/auth\/me(\?|$)/,
        /\/api\/v1\/prescriptions(\?|\/|$)/,
      ];
      await page.route("**/api/v1/**", async (route) => {
        const url = route.request().url();
        if (SPECIFIC_PATTERNS.some((rx) => rx.test(url))) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: null, error: null }),
        });
      });

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

      // Capture the share POST so the assertions can inspect body shape.
      // Declared before the route registration so the closure can mutate it.
      let sharePostBody: unknown = null;
      let sharePostUrl: string | null = null;

      // Route-intercept the prescriptions list endpoint with a known row
      // AND the share POST. Matches the page's fetch shapes:
      //   GET  /api/v1/prescriptions?page=1&limit=20 (list — page.tsx:165-168)
      //   POST /api/v1/prescriptions/:id/share       (share — page.tsx:141)
      //
      // Regex (not glob) because Playwright's `*` does not cross `/` — a
      // glob like `**/api/v1/prescriptions*` matches the LIST endpoint
      // (`/prescriptions?...`) but NOT the deeper share path
      // (`/prescriptions/<id>/share`). Without this fix the share POST
      // fell through to the dev server and returned a real 403, which is
      // what surfaced in the chromium full shard.
      const mockedRx = buildMockedRx();
      await page.route(/\/api\/v1\/prescriptions/, async (route) => {
        const req = route.request();
        const url = req.url();
        const method = req.method();

        // Share POST — match any URL that contains `/share` regardless of
        // trailing chars (query string, trailing slash). The previous
        // `/share$` anchor was strict enough that a webkit URL
        // normalization (e.g. a tacked-on `?` or `/`) made the share POST
        // fall through to `route.continue()` → real backend → 403 from
        // the CSRF middleware. The id is captured for the URL assertion;
        // matching on `/share` keeps the matcher narrow enough to not
        // collide with the list GET while tolerant of normalization.
        if (method === "POST" && /\/prescriptions\/[^/]+\/share(\?|$|\/)/.test(url)) {
          sharePostUrl = url;
          try {
            sharePostBody = req.postDataJSON();
          } catch {
            sharePostBody = req.postData();
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: { ok: true, channel: "WHATSAPP" },
              error: null,
            }),
          });
          return;
        }

        // List GET — only handle the LIST endpoint; the list shape mirrors
        // the route's `{ success, data, meta }` envelope.
        if (method === "GET" && /\/api\/v1\/prescriptions(\?|$|\/)/.test(url)) {
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
        // Catch-all — every prescription-shaped URL gets a benign 200 so a
        // stray sub-path (anything not matched above) can NEVER escape to
        // the real backend and 403 the test. The page only fires the list
        // GET and the share POST against this prefix; a /:id/pdf <a> click
        // isn't driven by this spec, so the empty body is harmless.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: null, error: null }),
        });
      });

      // Suppress the OnboardingTour modal that DashboardLayout auto-opens
      // for every never-seen-this-role user (layout.tsx:679 calls
      // `hasCompletedTour(user.role, user.id)`). Without this, the
      // tour's z-100 overlay intercepts pointer events on top of the
      // share button and the click times out under webkit (Chromium
      // happened to mount + fire the API faster than the tour rendered,
      // masking the same race). The v1 global key suppresses the tour
      // for ALL roles (OnboardingTour.tsx:75 + hasCompletedTour's
      // `if (hasCompletedTourV1()) return true` early-out).
      await page.addInitScript(() => {
        try {
          // OnboardingTour.tsx:100 — hasCompletedTourV1() checks for the
          // LITERAL string "true" (not "1"); seeding any other value
          // silently fails to suppress.
          localStorage.setItem("medcore_tour_completed_v1", "true");
        } catch {
          // localStorage may not be writable in webkit private contexts —
          // best-effort; the tour just won't be suppressed and the click
          // will fail the same way it did before this guard.
        }
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

      // Lock onto the share <button> scoped to this row so future fixtures
      // (multiple rows) don't break the assertion.
      const shareButton = row.locator(
        '[data-testid="patient-prescriptions-share-btn"]'
      );
      await expect(shareButton).toBeVisible();

      // The CTA is now a <button> (not an <a>) — defends against a
      // regression that flips back to the old client-side wa.me deep-link
      // shape (which leaked the verify URL into browser history and went
      // out un-audited; see header comment for the full rationale).
      await expect(shareButton).toHaveJSProperty("tagName", "BUTTON");

      // Trigger the share. Wait for the POST response in parallel so the
      // assertion that follows has a deterministic anchor — the page's
      // success toast fires AFTER the await resolves (page.tsx:141-142),
      // so awaiting the response here also rules out a fire-and-forget
      // regression that drops the POST entirely.
      const sharePromise = page.waitForResponse(
        (r) =>
          // Mirror the route-handler match — tolerant of trailing `/`
          // so a URL-normalization quirk in webkit doesn't drop us into a
          // 10s timeout while the response is sitting right there.
          /\/api\/v1\/prescriptions\/[^/]+\/share(\/|$)/.test(new URL(r.url()).pathname) &&
          r.request().method() === "POST",
        { timeout: 10_000 }
      );
      await shareButton.click();
      const shareRes = await sharePromise;

      // Assertion 1 — server-side share endpoint was hit, not a wa.me
      // deep-link. Defends against a regression that flips the button
      // back to an <a href="wa.me/...">.
      expect(
        shareRes.ok(),
        `Pearl §6 row 326: share POST must succeed (the page surfaces ` +
          `non-2xx responses as toast.error and the verify URL never gets ` +
          `delivered). Got status ${shareRes.status()}.`
      ).toBe(true);

      // Assertion 2 — request URL targets the seeded prescription's id.
      // Catches a regression that POSTs a stale id (e.g. cached from a
      // prior list, the wrong row in a multi-row list, etc.). Trailing
      // `?`/`/` are tolerated to mirror the route handler's broadened
      // match (some browsers normalize the URL with a tacked-on terminator).
      expect(
        sharePostUrl,
        `Pearl §6 row 326: share POST URL must include /prescriptions/<id>/share ` +
          `with the seeded id. Got: ${sharePostUrl}`
      ).toMatch(new RegExp(`/prescriptions/${KNOWN_RX_ID}/share(\\?|$|/)`));

      // Assertion 3 — request body carries channel: "WHATSAPP". The server
      // multiplexes the same endpoint for SMS / EMAIL / WHATSAPP based on
      // this field; missing or wrong channel means the patient gets the
      // verify link in the wrong protocol (or not at all).
      expect(
        sharePostBody,
        `Pearl §6 row 326: share POST body must carry { channel: "WHATSAPP" } ` +
          `so the API routes through Meta Cloud delivery. Got: ` +
          `${JSON.stringify(sharePostBody)}`
      ).toMatchObject({ channel: "WHATSAPP" });
    } finally {
      await ctx.close();
    }
  });
});
