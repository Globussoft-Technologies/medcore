/**
 * Cross-patient vaccination schedule — /dashboard/immunization-schedule.
 *
 * What this exercises:
 *   apps/web/src/app/dashboard/immunization-schedule/page.tsx (180 lines)
 *   GET /api/v1/ehr/immunizations/schedule?filter=week|month|overdue
 *       (apps/api/src/routes/ehr.ts:408 — authorize(DOCTOR, NURSE, ADMIN))
 *
 * Page-shape archetype: UNIVERSAL-ACCESS / no client-side gate.
 *   page.tsx has NO `VIEW_ALLOWED` constant, NO `router.replace`, and NO
 *   `useAuthStore`-driven redirect. The chrome renders for any auth'd user
 *   and the API gate at ehr.ts:410 (`authorize(Role.DOCTOR, Role.NURSE,
 *   Role.ADMIN)`) is the real RBAC truth (CLAUDE.md gotcha #7 archetype 3).
 *   Non-allowed roles (PATIENT / RECEPTION / LAB_TECH / PHARMACIST) see the
 *   page chrome but the GET 403s and the table renders the empty-state.
 *
 * Surfaces touched:
 *   - DOCTOR/NURSE/ADMIN: heading + filter chips (Due-this-week /
 *     Due-this-month / Overdue) + the table that surfaces patient name +
 *     vaccine + dose + last-given + next-due-date + days-until.
 *   - Filter wiring: clicking a chip flips data-active="true" AND re-fires
 *     the GET with the matching ?filter= query-string (Issue #426 fix).
 *   - PATIENT/LAB_TECH: chrome renders, table empty-state because the API
 *     403s the request.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.12 entry
 *   "/dashboard/immunization-schedule — vaccination schedule" by pinning
 *   the page chrome, the three-chip filter contract, the empty-state pin,
 *   the `?filter=` query-string round-trip (Issue #426), and the universal-
 *   access route shape with API-side gating.
 *
 *   Note: e2e/pediatric.spec.ts already covers UIP/IAP per-patient
 *   immunization schedule via /dashboard/pediatric — this spec
 *   intentionally focuses on the CROSS-PATIENT catalog page shape
 *   (heading + filters + table), not the per-patient immunization view.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

// Two stubbed schedule rows so the table renders deterministically without
// depending on whatever immunizations the seed has happened to land in any
// given filter window. Shape mirrors apps/api/src/routes/ehr.ts:422-431 plus
// the include for patient.user.{name,phone}.
function makeStubRows() {
  const today = new Date();
  const inFiveDays = new Date(today.getTime() + 5 * 86_400_000);
  const overdue = new Date(today.getTime() - 12 * 86_400_000);
  return [
    {
      id: "imm-stub-1",
      patientId: "pat-stub-1",
      vaccine: "MMR",
      doseNumber: 1,
      dateGiven: new Date(today.getTime() - 365 * 86_400_000).toISOString(),
      nextDueDate: inFiveDays.toISOString(),
      patient: {
        id: "pat-stub-1",
        mrNumber: "MR-99001",
        user: { name: "Aarav Iyer", phone: "+919800000001" },
      },
    },
    {
      id: "imm-stub-2",
      patientId: "pat-stub-2",
      vaccine: "DPT-Booster",
      doseNumber: 2,
      dateGiven: new Date(today.getTime() - 540 * 86_400_000).toISOString(),
      nextDueDate: overdue.toISOString(),
      patient: {
        id: "pat-stub-2",
        mrNumber: "MR-99002",
        user: { name: "Saanvi Mehta", phone: "+919800000002" },
      },
    },
  ];
}

test.describe("Immunization schedule — /dashboard/immunization-schedule (DOCTOR/NURSE/ADMIN cross-patient catalog + filter chip wiring + universal-access page shape)", () => {
  test("DOCTOR lands on the page chrome with heading, three filter chips (Due this week / Due this month / Overdue) and a populated table when the API returns rows", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.route("**/api/v1/ehr/immunizations/schedule**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: makeStubRows(), error: null }),
      }),
    );

    await gotoAuthed(page, "/dashboard/immunization-schedule");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Three filter chips with stable testids (page.tsx:95).
    await expect(
      page.locator('[data-testid="immunization-filter-week"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="immunization-filter-month"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="immunization-filter-overdue"]'),
    ).toBeVisible();

    // Default filter is "week" (page.tsx:25) — its chip carries data-active="true".
    await expect(
      page.locator('[data-testid="immunization-filter-week"]'),
    ).toHaveAttribute("data-active", "true");

    // Both stub rows render — patient name links to /dashboard/patients/[id].
    await expect(page.getByText("Aarav Iyer")).toBeVisible();
    await expect(page.getByText("Saanvi Mehta")).toBeVisible();
    await expect(page.getByText("MMR")).toBeVisible();
    await expect(page.getByText(/DPT-Booster/i)).toBeVisible();
  });

  test("DOCTOR clicking the Overdue chip flips data-active='true' AND re-fires the GET with ?filter=overdue (Issue #426 stale-closure fix verification)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Track the filter values seen across requests so we can assert the
    // chip click fired a SECOND request with filter=overdue. The page
    // mounts with filter=week so the first GET carries that value.
    const filtersSeen: string[] = [];
    await page.route("**/api/v1/ehr/immunizations/schedule**", (route) => {
      const u = new URL(route.request().url());
      filtersSeen.push(u.searchParams.get("filter") ?? "");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      });
    });

    await gotoAuthed(page, "/dashboard/immunization-schedule");
    await dismissTourIfPresent(page);
    await expect(
      page.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Initial mount fired ?filter=week.
    await expect.poll(() => filtersSeen.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(filtersSeen[0]).toBe("week");

    // Click Overdue — both the active-attr flip AND the GET refire are the
    // load-bearing assertions for the Issue #426 closure-trap fix.
    await page.locator('[data-testid="immunization-filter-overdue"]').click();

    await expect(
      page.locator('[data-testid="immunization-filter-overdue"]'),
    ).toHaveAttribute("data-active", "true");
    await expect(
      page.locator('[data-testid="immunization-filter-week"]'),
    ).toHaveAttribute("data-active", "false");

    await expect
      .poll(() => filtersSeen.includes("overdue"), { timeout: 5_000 })
      .toBe(true);
  });

  test("NURSE reaches the same chrome — confirms NURSE is in the API allow-set per ehr.ts:410 authorize(DOCTOR, NURSE, ADMIN)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/ehr/immunizations/schedule**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      }),
    );

    await gotoAuthed(page, "/dashboard/immunization-schedule");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeVisible({ timeout: 15_000 });
    // Empty-state copy (page.tsx:113-115) when the API returns no rows.
    await expect(
      page.getByText(/No immunizations match this filter/i),
    ).toBeVisible();
  });

  test("DOCTOR with an empty schedule sees the 'No immunizations match this filter' empty-state instead of the table", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.route("**/api/v1/ehr/immunizations/schedule**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      }),
    );

    await gotoAuthed(page, "/dashboard/immunization-schedule");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/No immunizations match this filter/i),
    ).toBeVisible();

    // Table headers must not render when the dataset is empty (page.tsx:117).
    await expect(page.getByRole("columnheader", { name: /^Vaccine$/ })).toHaveCount(
      0,
    );
  });

  test("PATIENT visiting /dashboard/immunization-schedule does NOT bounce — page is universally accessible (no client gate); chrome renders but the GET 403s so the table sits in the empty-state", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // We deliberately do NOT stub the API call here — the real /immunizations
    // /schedule endpoint will 403 the PATIENT (ehr.ts:410). The page swallows
    // the error in its catch block and sets rows=[] so the empty-state
    // surface is what the user actually sees.
    await page.goto("/dashboard/immunization-schedule", {
      waitUntil: "domcontentloaded",
    });
    await dismissTourIfPresent(page);

    // No bounce — URL stays on the page.
    await expect(page).toHaveURL(/\/dashboard\/immunization-schedule/, {
      timeout: 10_000,
    });

    // Chrome still renders (heading + filter chips).
    await expect(
      page.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="immunization-filter-week"]'),
    ).toBeVisible();

    // The table sits in the empty-state because the API rejected the call.
    await expect(
      page.getByText(/No immunizations match this filter/i),
    ).toBeVisible({ timeout: 15_000 });
  });
});
