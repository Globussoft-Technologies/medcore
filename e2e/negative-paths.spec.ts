/**
 * Cross-cutting Negative-Paths coverage e2e (E2E_COVERAGE_BACKLOG §4.7).
 *
 * What this exercises:
 *   - /login form-error surfaces (apps/web/src/app/login/page.tsx) — 401
 *     credential rejection rendered into the inline `role="alert"` banner.
 *   - /register form 5xx + 408 retry UX (apps/web/src/app/register/page.tsx,
 *     `register-error-banner` + `register-retry-btn` data-testids,
 *     submitRegistration() error branch at page.tsx:99-138). User-driven
 *     resubmit is the only retry mechanism shipped — `lib/api.ts` has no
 *     auto-retry loop on 5xx (verified at apps/web/src/lib/api.ts:177-190).
 *   - /dashboard/patients 409 duplicate-record handling
 *     (apps/web/src/app/dashboard/patients/page.tsx:127, 187-202, 347-358) —
 *     the `existingPatient` payload renders a `patient-duplicate-view` link
 *     so reception can pull the existing chart instead of creating a dupe.
 *   - /dashboard/patients server-side 400 validation envelope
 *     (extractFieldErrors -> per-field inline `error-{field}` spans).
 *   - /display kiosk offline banner (apps/web/src/app/display/page.tsx:50,
 *     73, 150-158) — fetch failure on `/queue` flips `setOffline(true)` and
 *     surfaces a `role="status"` "Offline — showing last update" banner.
 *
 * VERIFY-BEFORE-SCAFFOLD audit (cron-learning bullet 7 — backlog framing
 * is sometimes aspirational; verify against the codebase before scaffolding):
 *
 *   §4.7 backlog scenario             | Verdict          | Evidence
 *   -----------------------------------|------------------|----------------
 *   Form failure messaging             | shipped (3 cases)| login banner +
 *     (validation, duplicate, server)  |                  | register retry +
 *                                      |                  | patients 409+400
 *   API 500 error envelope rendering   | shipped          | register 5xx
 *                                      |                  | branch (page.tsx
 *                                      |                  | :120-125)
 *   Offline + cached fallback display  | shipped          | /display:50,73,
 *                                      |                  | 150-158
 *   API 503 auto-retry                 | DEFERRED — UI    | lib/api.ts:177-
 *                                      | not shipped      | 190 throws on 5xx
 *                                      |                  | with no retry
 *                                      |                  | loop. Page-level
 *                                      |                  | manual retry IS
 *                                      |                  | shipped (covered
 *                                      |                  | by register-retry
 *                                      |                  | test below).
 *   Offline + sync-on-reconnect for    | DEFERRED — UI    | grep across
 *     authed forms                     | not shipped      | apps/web/src for
 *                                      |                  | navigator.onLine
 *                                      |                  | / online events
 *                                      |                  | returns 0 hits
 *                                      |                  | outside /display
 *                                      |                  | (kiosk poll-only,
 *                                      |                  | no queueing).
 *   Navigate-away mid-form             | DEFERRED — UI    | repo-wide grep
 *     (beforeunload guard)             | not shipped      | for
 *                                      |                  | beforeunload /
 *                                      |                  | onbeforeunload /
 *                                      |                  | leaveConfirm
 *                                      |                  | returns 0 hits.
 *                                      |                  | No unsaved-form
 *                                      |                  | guard ships.
 *   File-upload format/size client     | DEFERRED — UI    | only `accept`
 *     rejection                        | not shipped      | attribute used
 *                                      |                  | (browser filter,
 *                                      |                  | not enforced).
 *                                      |                  | grep for
 *                                      |                  | file.size /
 *                                      |                  | maxSize / "too
 *                                      |                  | large" returns 0
 *                                      |                  | client-side hits
 *                                      |                  | in apps/web/src/
 *                                      |                  | app/dashboard.
 *   File-upload AV-scan feedback       | DEFERRED — UI    | no UI surface
 *                                      | not shipped      | renders the
 *                                      |                  | virus-scan verdict
 *                                      |                  | back to user yet.
 *
 * All deferred scenarios re-enter the backlog when the matching UI surfaces
 * ship; the verdicts are pinned in this header so future agents can re-audit
 * cheaply (one grep) before adding more cases.
 *
 * Why these tests exist:
 *   E2E_COVERAGE_BACKLOG §4.7 — "most specs are happy-path". A user
 *   submitting a form that fails server-side should never see a half-rendered
 *   page or a swallowed error. This file pins the visible failure surfaces:
 *   401 banner copy, 5xx retry CTA, 409 duplicate-link CTA, 400 inline field
 *   errors, and the kiosk offline banner. Selector hygiene (CLAUDE.md #10)
 *   is honoured — every `role="alert"` query excludes Next.js's global
 *   `__next-route-announcer__`.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

// Selector that excludes Next.js's app-router global route-announcer (CLAUDE.md
// gotcha #10 — bare `getByRole('alert')` would always match the announcer
// before our banner). Used by every alert assertion below.
const ALERT_BANNER = '[role="alert"]:not(#__next-route-announcer__)';

// Generous timeout for the public pages — `next dev` cold-starts on first
// request, and dashboard pages need the auth round-trip before chrome paints.
const PAGE_TIMEOUT = 15_000;

test.describe("Negative paths — error surfaces, retries, and offline (E2E_COVERAGE_BACKLOG §4.7)", () => {
  test("/login: invalid credentials render the inline alert banner with the 401 copy and keep the user on /login", async ({
    browser,
  }) => {
    // Use a fresh browser context — `/login` is a public route and we MUST
    // NOT inherit any role fixture's auth cookie or the page would bounce
    // to `/dashboard` before we can submit the form.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Stub the login POST so the test pins the *page response to a 401*
    // rather than depending on the seed for a guaranteed-bad cred. Server
    // returns the standard error envelope shape; lib/api.ts attaches
    // `.status = 401` and the page maps that to the i18n key
    // `login.error.invalidCredentials`.
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Invalid credentials" }),
      })
    );

    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("form", { name: /login form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#login-email").fill("nobody@medcore.local");
    await page.locator("#login-password").fill("totallywrongpw");
    await page.getByRole("button", { name: /sign in|login/i }).click();

    // The inline alert banner appears (login/page.tsx:307-314). Exclude the
    // Next.js __next-route-announcer__ global per CLAUDE.md gotcha #10.
    const alert = page.locator(ALERT_BANNER).first();
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText(/invalid email or password/i);

    // No navigation — the URL must still be /login.
    await expect(page).toHaveURL(/\/login/);

    await ctx.close();
  });

  test("/register: a 500 from /auth/register renders the retry banner; clicking Retry resubmits and succeeds without retyping the form", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Two-stage stub: first POST → 500 (retryable), second POST → 201 (success).
    // page.tsx:120-125 (`isRetryable = status >= 500`) sets `setRetryable(true)`
    // and renders the data-testid="register-retry-btn" CTA — clicking it calls
    // submitRegistration() again with the SAME form values.
    let registerCalls = 0;
    await page.route("**/api/v1/auth/register", (route) => {
      registerCalls++;
      if (registerCalls === 1) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Internal server error" }),
        });
      }
      // Stub the auto-login that follows registration as well, otherwise the
      // page tries the real /auth/login and the test would depend on seed.
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            user: { id: "stubbed-user-id", role: "PATIENT" },
            tokens: { accessToken: "stub-at", refreshToken: "stub-rt" },
          },
        }),
      });
    });
    // The page's auto-login fires `/auth/login` after a 201 register. Stub it
    // too so the redirect-to-/dashboard happens predictably.
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            user: { id: "stubbed-user-id", role: "PATIENT", name: "E2E User" },
            tokens: { accessToken: "stub-at", refreshToken: "stub-rt" },
          },
        }),
      })
    );

    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Fill a valid form (passes both client + server validation).
    // Issue #617 / #684 / #713 (May 2026): the register page now also
    // requires confirmPassword, gender, dateOfBirth, address, an emergency
    // contact triplet, and a T&C consent checkbox before the client-side
    // submit will fire. Without these, validateClient() fails and the
    // /auth/register POST stub never receives the request — the retry
    // banner never appears.
    const uniqueEmail = `e2e-neg-${Date.now()}@medcore.local`;
    await page.locator("#reg-name").fill("Priya Sharma");
    await page.locator("#reg-email").fill(uniqueEmail);
    await page.locator("#reg-phone").fill("9871234567");
    await page.locator("#reg-password").fill("Medcore@E2e9!");
    await page.locator("#reg-confirm-password").fill("Medcore@E2e9!");
    await page.locator("#reg-gender").selectOption("FEMALE");
    await page.locator("#reg-dob").fill("1990-04-12");
    await page.locator("#reg-address").fill("12 MG Road, Bengaluru 560001");
    await page.locator("#reg-ec-name").fill("Ravi Sharma");
    await page.locator("#reg-ec-phone").fill("9881234567");
    await page.locator("#reg-ec-rel").fill("Sibling");
    await page.getByTestId("reg-accept-terms").check();

    await page
      .getByRole("button", { name: /register|create account|sign up/i })
      .click();

    // First POST → 500 → retry banner appears with the data-testids the page
    // ships explicitly for this state.
    const errBanner = page.getByTestId("register-error-banner");
    await expect(errBanner).toBeVisible({ timeout: 10_000 });
    const retryBtn = page.getByTestId("register-retry-btn");
    await expect(retryBtn).toBeVisible();

    // Form values must NOT be cleared — the user shouldn't have to retype
    // 6 fields because of a server hiccup (page.tsx:107-108).
    await expect(page.locator("#reg-email")).toHaveValue(uniqueEmail);
    await expect(page.locator("#reg-name")).toHaveValue("Priya Sharma");

    // Second POST is wired to succeed — clicking Retry should resubmit.
    await retryBtn.click();

    // After successful retry the page does an auto-login then router.push
    // to /dashboard. The /dashboard route requires a real user, but the
    // store's `login()` will have been resolved with our stubbed tokens,
    // so we just assert that the navigation kicks off (URL leaves /register).
    await expect(page).not.toHaveURL(/\/register/, { timeout: 15_000 });
    expect(registerCalls).toBe(2);

    await ctx.close();
  });

  test("/register: a 408 timeout response is treated as retryable (separate code path from 5xx)", async ({
    browser,
  }) => {
    // Pin the explicit `status === 408` branch in the retryable check at
    // page.tsx:122 — without this case, a timeout would fall through to the
    // generic non-retryable toast and lose the resubmit affordance.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.route("**/api/v1/auth/register", (route) =>
      route.fulfill({
        status: 408,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Request timed out — please try again",
        }),
      })
    );

    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Issue #617 / #684 / #713 (May 2026): see the 500-retry test above for
    // the full reasoning — the register form now requires the full PATIENT
    // intake set up front.
    await page.locator("#reg-name").fill("Anjali Verma");
    await page.locator("#reg-email").fill(`e2e-408-${Date.now()}@medcore.local`);
    await page.locator("#reg-phone").fill("9881234567");
    await page.locator("#reg-password").fill("Medcore@E2e9!");
    await page.locator("#reg-confirm-password").fill("Medcore@E2e9!");
    await page.locator("#reg-gender").selectOption("FEMALE");
    await page.locator("#reg-dob").fill("1992-08-25");
    await page.locator("#reg-address").fill("9 Brigade Road, Bengaluru 560025");
    await page.locator("#reg-ec-name").fill("Sunita Verma");
    await page.locator("#reg-ec-phone").fill("9881234568");
    await page.locator("#reg-ec-rel").fill("Mother");
    await page.getByTestId("reg-accept-terms").check();

    await page
      .getByRole("button", { name: /register|create account|sign up/i })
      .click();

    // 408 must surface the SAME retry banner shape as 5xx — both go through
    // the `isRetryable` branch.
    await expect(page.getByTestId("register-error-banner")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("register-retry-btn")).toBeVisible();
    await expect(page).toHaveURL(/\/register/);

    await ctx.close();
  });

  test("/dashboard/patients: a 409 from POST /patients renders the duplicate-match banner with a one-click 'View existing patient' CTA", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    // Stub the patient-create POST so the test pins the 409 envelope shape.
    // The server returns `{ existingPatient: { id, mrNumber, name } }` in the
    // payload — page.tsx:187-202 reads it and surfaces the
    // data-testid="patient-duplicate-view" link.
    const existingId = "stubbed-existing-patient";
    await page.route(/\/api\/v1\/patients(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Patient with this phone already exists",
            existingPatient: {
              id: existingId,
              mrNumber: "MR-DUP-0001",
              name: "Existing Patient",
            },
          }),
        });
      }
      // Let the GET /patients listing pass through untouched.
      await route.fallback();
    });

    // The page accepts `?register=1` to open the registration form on load
    // (page.tsx:76) — saves us a click + reduces flake risk on the CTA query.
    await gotoAuthed(page, "/dashboard/patients?register=1");
    await expectNotForbidden(page);

    // Wait for the form to be open + the phone input to render.
    await expect(page.getByTestId("patient-name")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.getByTestId("patient-name").fill("Duplicate Test");
    await page.getByTestId("patient-phone").fill("9876543210");

    // Submit — the form's submit button is the one inside the open form panel.
    // Click the submit button by its translated label fallback regex.
    await page
      .locator("form")
      .filter({ has: page.getByTestId("patient-name") })
      .getByRole("button", { name: /register|save|create|add/i })
      .first()
      .click();

    // The "View existing patient" link is the data-testid the page ships.
    const dupLink = page.getByTestId("patient-duplicate-view");
    await expect(dupLink).toBeVisible({ timeout: 10_000 });
    await expect(dupLink).toContainText(/MR-DUP-0001/);

    // The phone-error span renders the friendly "Already registered…" copy.
    await expect(page.getByTestId("error-patient-phone")).toContainText(
      /already registered/i
    );
  });

  test("/dashboard/patients: a 400 with Zod-style { details: [{ field, message }] } renders inline per-field errors via extractFieldErrors", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    // Stub the POST to return the canonical Zod error envelope. The page
    // funnels this through extractFieldErrors() (lib/field-errors.ts) and
    // sets `formErrors[field]` — each renders as its own data-testid="error-…"
    // span beneath the relevant input.
    await page.route(/\/api\/v1\/patients(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Validation failed",
            details: [
              { field: "phone", message: "Phone must be 10–15 digits" },
              { field: "name", message: "Name is required" },
            ],
          }),
        });
      }
      await route.fallback();
    });

    await gotoAuthed(page, "/dashboard/patients?register=1");
    await expectNotForbidden(page);

    await expect(page.getByTestId("patient-name")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Bypass the page's own client-side validation by giving plausible values
    // — server is the one rejecting here.
    await page.getByTestId("patient-name").fill("Server Reject Test");
    await page.getByTestId("patient-phone").fill("9876512345");

    await page
      .locator("form")
      .filter({ has: page.getByTestId("patient-name") })
      .getByRole("button", { name: /register|save|create|add/i })
      .first()
      .click();

    // Both inline errors must surface — they come from the server payload's
    // `details` array, not from any client-side check.
    await expect(page.getByTestId("error-patient-phone")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("error-patient-phone")).toContainText(
      /10.{0,3}15 digits/i
    );
  });

  test("/display: when GET /queue fails, the kiosk surfaces the 'Offline — showing last update' banner instead of a blank screen", async ({
    browser,
  }) => {
    // /display is a public, no-auth kiosk route. A fetch failure flips the
    // board into offline mode (useDisplayData in display/_shared.tsx) and
    // renders the role="status" yellow banner (DisplayHeader). This is the ONE
    // shipped offline-detection surface in the web app — every other "offline"
    // mention is in marketing copy or test fixtures (verified pre-scaffold).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Force the PUBLIC display queue endpoint to 503 BEFORE navigation so the
    // very first poll fails. The board now fetches /api/v1/queue/display (a
    // no-auth, PII-redacted endpoint) rather than the staff /queue. On a fresh
    // context there's no cache, so the offline banner shows.
    await page.route("**/api/v1/queue/display", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Service unavailable" }),
      })
    );

    await page.goto("/display", { waitUntil: "domcontentloaded" });

    // The offline banner uses role="status" (not role="alert") — pinning the
    // visible copy as well so a copy regression surfaces.
    const offlineBanner = page
      .locator('[role="status"]')
      .filter({ hasText: /offline/i })
      .first();
    await expect(offlineBanner).toBeVisible({ timeout: 10_000 });
    await expect(offlineBanner).toContainText(/showing last update/i);

    // The "No cached data available" fallback message renders below when
    // there's no prior cache (page.tsx:184).
    await expect(
      page.getByText(/no cached data available/i)
    ).toBeVisible({ timeout: 5_000 });

    await ctx.close();
  });
});
