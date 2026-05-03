/**
 * Patient Registration form e2e coverage.
 *
 * What this exercises:
 *   /dashboard/patients/register (apps/web/src/app/dashboard/patients/register/page.tsx)
 *     — issue #143 redirect-shim that forwards to
 *     /dashboard/patients?register=1, where the canonical create form lives
 *     (apps/web/src/app/dashboard/patients/page.tsx, gated by PATIENTS_ALLOWED
 *     and the RECEPTION/ADMIN-only "Register Patient" CTA).
 *   POST /api/v1/patients (apps/api/src/routes/patients.ts) authorised for
 *     ADMIN + RECEPTION, validated by createPatientSchema in
 *     packages/shared/src/validation/patient.ts (PHONE_REGEX,
 *     PATIENT_NAME_REGEX, age 1–130 adult-flow refine).
 *
 * Why these tests exist:
 *   §2.1 of docs/E2E_COVERAGE_BACKLOG.md flagged the registration form as
 *   "no e2e coverage". This file locks the redirect-shim, the client-side
 *   field validation contract (issues #103/#104/#138/#167), the server-side
 *   Zod-rejection path, and the issue-#382 RBAC gate that bounces non-staff
 *   away from the patient registry. A regression in any of those four
 *   surfaces was previously invisible to CI.
 */
import { test, expect } from "./fixtures";
import { API_BASE, expectNotForbidden } from "./helpers";

test.describe(
  "Patient Registration — /dashboard/patients/register (RECEPTION happy path + client/server validation + non-staff RBAC bounces)",
  () => {
    test("the /dashboard/patients/register shim redirects to /dashboard/patients?register=1 and opens the registration form for RECEPTION", async ({
      receptionPage,
    }) => {
      const page = receptionPage;
      await page.goto("/dashboard/patients/register", {
        waitUntil: "domcontentloaded",
      });
      await expectNotForbidden(page);

      // Issue #143: the static /register segment exists only to win the
      // dynamic-route collision and forward to the canonical query-string
      // entry point. Lock that contract so a regression in the redirect
      // doesn't silently send reception to a "Patient not found" page.
      await page.waitForURL(/\/dashboard\/patients\?register=1/, {
        timeout: 10_000,
      });

      // Form chrome must be visible (showForm is auto-set when ?register=1).
      await expect(
        page.locator('[data-testid="patient-name"]')
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('[data-testid="patient-phone"]')
      ).toBeVisible();
    });

    test("RECEPTION submits a unique-named patient with a valid phone and the new row appears in the list", async ({
      receptionPage,
    }) => {
      const page = receptionPage;
      await page.goto("/dashboard/patients/register", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForURL(/\/dashboard\/patients\?register=1/, {
        timeout: 10_000,
      });

      // The PATIENT_NAME_REGEX (packages/shared/src/validation/patient.ts) is
      // /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/ — DIGITS ARE FORBIDDEN. The previous
      // attempt at this test used `E2eReg ${Date.now()}` for uniqueness,
      // which the client-side mirror regex in apps/web/.../patients/page.tsx
      // rejected silently (handleCreatePatient sets formErrors and
      // early-returns — no POST is fired), so the search row never appeared.
      // We build a digit-free unique tag instead: an all-letter base name
      // plus a unique alphabetic suffix derived from a random hex chunk
      // mapped onto A–Z. The phone we use to drive the search is a much
      // more reliable filter key anyway because there's no chance of a
      // partial match against an unrelated seeded row.
      const hexToAlpha = (hex: string) =>
        hex
          .split("")
          .map((c) => String.fromCharCode(97 + (parseInt(c, 16) % 26)))
          .join("");
      const uniqSuffix = hexToAlpha(
        Math.random().toString(16).slice(2, 10) +
          Date.now().toString(16).slice(-6)
      );
      const tag = `E2eReg ${uniqSuffix}`; // digit-free, regex-safe
      const phone = `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

      await page.locator('[data-testid="patient-name"]').fill(tag);
      await page.locator('[data-testid="patient-phone"]').fill(phone);
      await page.locator('[data-testid="patient-age"]').fill("34");

      // Pin the POST status BEFORE looking for the row in the list. The
      // prior search-row-find assertion was hiding silent 4xx (and the
      // pre-submit client-side regex bail) — by waiting on the actual
      // network call and asserting < 400 we get a clear failure message
      // listing the server's complaint instead of a generic
      // "element not found" 10s after a no-op submit.
      const createResp = page.waitForResponse(
        (r) =>
          r.url().includes("/patients") && r.request().method() === "POST",
        { timeout: 10_000 }
      );

      // The submit button is the form's only `type="submit"` and is the
      // first one rendered inside the registration form. Anchor on that
      // structural relationship so it survives copy changes to the i18n key.
      await page
        .getByRole("button", { name: /^Register Patient$/i })
        .last()
        .click();

      const resp = await createResp;
      const status = resp.status();
      if (status >= 400) {
        const body = await resp.text().catch(() => "<no body>");
        throw new Error(
          `POST /patients failed with ${status}: ${body.slice(0, 500)}`
        );
      }
      expect(status).toBeLessThan(400);

      // Success signal: the new row should be reachable via the patient-search
      // box. The list page doesn't show a success toast on create — handler
      // just does setShowForm(false) + loadPatients() — and the form-hidden
      // assertion was unreliable here because /dashboard/patients is the
      // same page that owns the form (no navigation away on success), so we
      // anchor on the load-bearing post-submit reality: the new row is
      // present in the search-driven re-fetch of /patients.
      //
      // We search by phone instead of by the name tag because phone is a
      // stricter filter (10–15 contiguous digits unique per row, no risk of
      // partial-match against a seeded patient) and the API's
      // /patients?search=… contains-match against user.phone is the same
      // code path the UI uses (see apps/api/src/routes/patients.ts: the
      // search OR-clause covers mrNumber / name / phone / email / address).
      await page.locator('[data-testid="patient-search"]').fill(phone);
      await expect(page.locator(`text=${tag}`).first()).toBeVisible({
        timeout: 10_000,
      });
    });

    test("RECEPTION cannot submit with empty required fields — client-side validation surfaces field errors and no POST /patients fires", async ({
      receptionPage,
    }) => {
      const page = receptionPage;
      await page.goto("/dashboard/patients/register", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForURL(/\/dashboard\/patients\?register=1/, {
        timeout: 10_000,
      });

      // Spy on the create endpoint. handleCreatePatient calls
      // setFormErrors() and then early-returns when errs is non-empty, so
      // a passing test must observe ZERO matching network calls.
      let postCount = 0;
      await page.route(`**/api/v1/patients`, (route) => {
        if (route.request().method() === "POST") postCount += 1;
        return route.continue();
      });

      // Fields left blank — name and phone are both required.
      await page
        .getByRole("button", { name: /^Register Patient$/i })
        .last()
        .click();

      await expect(
        page.locator('[data-testid="error-patient-name"]')
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        page.locator('[data-testid="error-patient-phone"]')
      ).toBeVisible();

      // Settle a tick so any in-flight POST would have been recorded.
      await page.waitForTimeout(500);
      expect(postCount).toBe(0);
    });

    test("a malformed phone reaching the API directly is rejected with HTTP 400 by createPatientSchema", async ({
      receptionApi,
    }) => {
      // Bypasses the client-side regex on purpose: we want to lock the
      // server-side guard so a future UI change that loosens the field
      // mask still fails closed at the Zod layer (PHONE_REGEX, issue #138).
      const res = await receptionApi.post(`${API_BASE}/patients`, {
        data: {
          name: `E2eReg ${Date.now()}`,
          phone: "not-a-phone",
          gender: "MALE",
          age: 30,
        },
      });

      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      // The validate() middleware emits a `details` array keyed by Zod path;
      // we don't pin the exact phrasing — only that "phone" surfaced.
      const blob = JSON.stringify(body).toLowerCase();
      expect(blob).toContain("phone");
    });

    test("PATIENT cannot reach /dashboard/patients/register — issue #382 staff-only gate redirects to /dashboard/not-authorized", async ({
      patientPage,
    }) => {
      const page = patientPage;
      await page.goto("/dashboard/patients/register", {
        waitUntil: "domcontentloaded",
      });

      // Two redirects in sequence: /register → ?register=1, then the
      // PATIENTS_ALLOWED guard kicks PATIENT to /not-authorized. Anchor
      // on the final URL only.
      await page.waitForURL(/\/dashboard\/not-authorized/, {
        timeout: 10_000,
      });
      expect(page.url()).toContain("/dashboard/not-authorized");
    });

    test("LAB_TECH cannot reach /dashboard/patients/register — RBAC bounce to /dashboard/not-authorized", async ({
      labTechPage,
    }) => {
      const page = labTechPage;
      await page.goto("/dashboard/patients/register", {
        waitUntil: "domcontentloaded",
      });

      await page.waitForURL(/\/dashboard\/not-authorized/, {
        timeout: 10_000,
      });
      expect(page.url()).toContain("/dashboard/not-authorized");
    });
  }
);
