/**
 * FHIR R4 export workflow — ADMIN-only export surface, smoke + RBAC.
 *
 * What this exercises:
 *   /dashboard/fhir-export (apps/web/src/app/dashboard/fhir-export/page.tsx)
 *   GET /api/v1/fhir/Patient/:id              (single Patient resource)
 *   GET /api/v1/fhir/Patient/:id/$everything  (searchset bundle)
 *   GET /api/v1/fhir/Patient/:id/$export      (transaction bundle for ABDM push)
 *
 * Surfaces touched:
 *   - ADMIN: full happy path — search patient, pick from autocomplete, click
 *     "Patient resource" / "$everything bundle" / "ABDM push bundle", see the
 *     stubbed JSON preview + Copy/Download/Toggle controls.
 *   - DOCTOR / NURSE / RECEPTION / PATIENT / LAB_TECH / PHARMACIST: gated out
 *     via the `useEffect` redirect at page.tsx:58-62 — `router.push("/dashboard")`
 *     for any role !== "ADMIN". This is the REDIRECT-TO-/dashboard archetype
 *     (NOT /dashboard/not-authorized — confirmed page.tsx:60), matching the 6th
 *     cron-learning bullet pattern (e.g. tenants/page.tsx:124-128, insurance-
 *     claims page.tsx:138).
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.12 entry
 *   "/dashboard/fhir-export — full export workflow (smoke only)". The existing
 *   coverage in abdm-consent.spec.ts only pins the Patient-resource path; this
 *   spec covers all three export kinds + the preview/Copy/Download contract +
 *   the redirect-to-/dashboard RBAC archetype for non-ADMIN roles. Network
 *   fetches are stubbed via page.route so we never trigger a real export
 *   payload (would generate large output per the route handler's
 *   $everything/$export branches).
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

const PAGE_TIMEOUT = 15_000;

const FAKE_PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_LABEL = "Fhir Smoke Patient";

function jsonFulfill(body: unknown, status: number = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  } as const;
}

const FHIR_PATIENT_RESOURCE = {
  resourceType: "Patient",
  id: FAKE_PATIENT_ID,
  name: [{ use: "official", text: PATIENT_LABEL }],
  gender: "unknown",
  birthDate: "1990-01-01",
};

const FHIR_EVERYTHING_BUNDLE = {
  resourceType: "Bundle",
  id: "everything-bundle-stub",
  type: "searchset",
  total: 1,
  entry: [
    {
      resource: FHIR_PATIENT_RESOURCE,
    },
  ],
};

const FHIR_EXPORT_BUNDLE = {
  resourceType: "Bundle",
  id: "abdm-push-bundle-stub",
  type: "transaction",
  total: 1,
  entry: [
    {
      resource: FHIR_PATIENT_RESOURCE,
      request: { method: "PUT", url: `Patient/${FAKE_PATIENT_ID}` },
    },
  ],
};

async function stubPatientSearch(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/v1/patients?search=*", (route) =>
    route.fulfill(
      jsonFulfill({
        success: true,
        data: [
          {
            id: FAKE_PATIENT_ID,
            user: { name: PATIENT_LABEL, phone: "+919812345678" },
          },
        ],
      })
    )
  );
}

async function pickPatient(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#fhir-patient").fill(PATIENT_LABEL.slice(0, 6));
  await expect(page.getByText(PATIENT_LABEL).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.getByText(PATIENT_LABEL).first().click();
}

test.describe("FHIR export — /dashboard/fhir-export (ADMIN-only; non-ADMIN redirects to /dashboard, NOT /not-authorized)", () => {
  test("ADMIN lands on the page; header + three export buttons all render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubPatientSearch(page);

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The three ExportButton tiles render with the documented copy
    // (page.tsx:217-237). Buttons are disabled until a patient is picked.
    const patientBtn = page
      .getByRole("button", { name: /patient resource/i })
      .first();
    const everythingBtn = page
      .getByRole("button", { name: /\$everything bundle/i })
      .first();
    const exportBtn = page
      .getByRole("button", { name: /abdm push bundle/i })
      .first();
    await expect(patientBtn).toBeVisible();
    await expect(everythingBtn).toBeVisible();
    await expect(exportBtn).toBeVisible();
    await expect(patientBtn).toBeDisabled();
    await expect(everythingBtn).toBeDisabled();
    await expect(exportBtn).toBeDisabled();
  });

  test("ADMIN picks a patient and runs Patient-resource export — preview pane shows JSON + Copy + Download", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubPatientSearch(page);

    let patientFetchCount = 0;
    await page.route(
      `**/api/v1/fhir/Patient/${FAKE_PATIENT_ID}`,
      (route) => {
        patientFetchCount += 1;
        return route.fulfill(jsonFulfill(FHIR_PATIENT_RESOURCE));
      }
    );

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await pickPatient(page);

    // After patient pick the buttons enable; the Patient-resource button
    // fires GET /fhir/Patient/:id and the preview pane mounts.
    await page.getByRole("button", { name: /patient resource/i }).first().click();

    await expect(
      page.getByText(/patient resource preview/i).first()
    ).toBeVisible({ timeout: 10_000 });
    // The fhir+json badge proves the page rendered the kind-aware preview
    // header (page.tsx:253-255).
    await expect(
      page.getByText(/application\/fhir\+json/i).first()
    ).toBeVisible();
    // Copy + Download CTAs only render once a payload is loaded
    // (page.tsx:258-277).
    await expect(
      page.getByRole("button", { name: /copy/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /download/i }).first()
    ).toBeVisible();
    // Pre block contains the resourceType key from the stubbed JSON.
    await expect(page.getByText(/"resourceType"/).first()).toBeVisible();
    // Wiring pin: the FHIR endpoint was actually hit.
    expect(patientFetchCount).toBeGreaterThanOrEqual(1);
  });

  test("ADMIN runs $everything bundle export — bundle preview surfaces", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubPatientSearch(page);

    let everythingHit = false;
    await page.route(
      `**/api/v1/fhir/Patient/${FAKE_PATIENT_ID}/$everything`,
      (route) => {
        everythingHit = true;
        return route.fulfill(jsonFulfill(FHIR_EVERYTHING_BUNDLE));
      }
    );

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await pickPatient(page);
    await page
      .getByRole("button", { name: /\$everything bundle/i })
      .first()
      .click();

    await expect(
      page.getByText(/\$everything bundle preview/i).first()
    ).toBeVisible({ timeout: 10_000 });
    // The stubbed Bundle's type field surfaces in the JSON pre block.
    await expect(page.getByText(/"searchset"/).first()).toBeVisible();
    expect(everythingHit).toBe(true);
  });

  test("ADMIN runs ABDM push bundle export — transaction-bundle preview surfaces", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubPatientSearch(page);

    let exportHit = false;
    await page.route(
      `**/api/v1/fhir/Patient/${FAKE_PATIENT_ID}/$export`,
      (route) => {
        exportHit = true;
        return route.fulfill(jsonFulfill(FHIR_EXPORT_BUNDLE));
      }
    );

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await pickPatient(page);
    await page
      .getByRole("button", { name: /abdm push bundle/i })
      .first()
      .click();

    await expect(
      page.getByText(/abdm push bundle preview/i).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/"transaction"/).first()).toBeVisible();
    expect(exportHit).toBe(true);
  });

  test("ADMIN sees an inline error banner when the FHIR endpoint returns a 500", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubPatientSearch(page);

    await page.route(
      `**/api/v1/fhir/Patient/${FAKE_PATIENT_ID}`,
      (route) =>
        route.fulfill(
          jsonFulfill(
            { success: false, error: "FHIR mapper failed" },
            500
          )
        )
    );

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await pickPatient(page);
    await page.getByRole("button", { name: /patient resource/i }).first().click();

    // The page surfaces the error message into the red error pane
    // (page.tsx:240-244). We scope the alert lookup to NOT hit the Next.js
    // global route announcer (CLAUDE.md gotcha #10).
    await expect(
      page.locator('div').filter({ hasText: /fhir mapper failed/i }).first()
    ).toBeVisible({ timeout: 10_000 });
    // No preview pane should have rendered on a failed export.
    await expect(
      page.getByText(/patient resource preview/i)
    ).toHaveCount(0);
  });

  test("DOCTOR is redirected to /dashboard — useEffect at page.tsx:58-62 (REDIRECT-TO-/dashboard archetype, NOT /not-authorized)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // Assert the canonical archetype: router.push("/dashboard") (NOT
    // /dashboard/not-authorized). This is the same shape as tenants.spec.ts
    // and insurance-claims.spec.ts (6th cron-learning bullet).
    expect(page.url()).not.toContain("/dashboard/fhir-export");
    expect(page.url()).not.toContain("/dashboard/not-authorized");
    expect(page.url()).toMatch(/\/dashboard(\?|$|\/)/);
    // The FHIR Export heading must NOT have rendered.
    await expect(
      page.getByRole("heading", { name: /fhir export/i })
    ).toHaveCount(0);
  });

  test("PATIENT is redirected to /dashboard — same archetype, no role-leak past the gate", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/fhir-export", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).not.toContain("/dashboard/fhir-export");
    expect(page.url()).not.toContain("/dashboard/not-authorized");
    expect(page.url()).toMatch(/\/dashboard(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /fhir export/i })
    ).toHaveCount(0);
  });
});
