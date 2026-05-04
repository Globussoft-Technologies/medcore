/**
 * Nurse Workstation — NURSE-only daily hub with quick actions, meds-due
 * card, assigned admissions, vitals queue, ER triage cases and recent
 * rounds.
 *
 * What this exercises:
 *   /dashboard/workstation (apps/web/src/app/dashboard/workstation/page.tsx, 489 lines)
 *   GET /api/v1/medication/administrations/due?window=30
 *   GET /api/v1/emergency/cases/active
 *   GET /api/v1/appointments?status=CHECKED_IN&date=&limit=50
 *   GET /api/v1/admissions?status=ADMITTED&limit=50
 *   GET /api/v1/nurse-rounds?admissionId=...
 *
 * Surfaces touched:
 *   - NURSE: lands on the page, sees title + NURSE pill + four
 *     ActionBtn quick-actions keyed by data-testid (`quick-record-vitals`,
 *     `quick-administer-med`, `quick-start-round`, `quick-triage`), the
 *     "Medications Due in Next 30 Minutes" card, and the four lower
 *     panels (My Assigned Patients, Vitals to Record, ER Cases, Recent
 *     Rounds).
 *   - NURSE with stubbed meds-due + appointments + admissions sees populated
 *     rows; clicking `quick-record-vitals` issues a router.push to
 *     `/dashboard/vitals?appointmentId=<first>` (Issue #432 fix at
 *     page.tsx:147-156) — the URL after click is the deterministic signal.
 *   - PATIENT/DOCTOR/RECEPTION: page.tsx:38-42 fires `router.replace("/dashboard")`
 *     via useEffect AND page.tsx:108-114 renders an inline "Workstation is
 *     for nurses only." placeholder before the redirect lands. This is the
 *     REDIRECT-BOUNCE archetype with a brief inline-placeholder flash —
 *     same shape as agent-console, NOT the pure admin-gate-placeholder
 *     archetype that ai-kpis + ai-fraud use.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.4 entry
 *   "/dashboard/workstation — task assignment (RBAC-only tested)" by
 *   deepening past the existing RBAC-only coverage to pin: chrome + four
 *   quick-action buttons + meds-due card + the context-aware
 *   `quick-record-vitals` deep-link from Issue #432, plus the
 *   redirect-bounce contract for non-NURSE roles.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

function medsDueFixture() {
  return [
    {
      id: "med-admin-1",
      scheduledAt: "2026-05-05T10:00:00.000Z",
      patientName: "Aarav Iyer",
      medicationOrder: {
        medicineName: "Amoxicillin 500mg",
        dosage: "1 tab",
        admission: {
          patient: { user: { name: "Aarav Iyer" } },
        },
      },
    },
  ];
}

function appointmentsFixture() {
  return [
    {
      id: "appt-1",
      tokenNumber: 7,
      patient: { user: { name: "Bina Pillai" } },
      doctor: { user: { name: "Sharma" } },
    },
  ];
}

function admissionsFixture() {
  return [
    {
      id: "adm-1",
      admissionNumber: "ADM-001",
      patient: { user: { name: "Chetan Rao" } },
      bed: { bedNumber: "12", ward: { name: "Ward A" } },
    },
  ];
}

function emergencyCasesFixture() {
  return [
    {
      id: "er-1",
      caseNumber: "ER-2026-001",
      chiefComplaint: "Severe abdominal pain",
      status: "WAITING",
      triageLevel: "P2",
    },
  ];
}

test.describe("Nurse Workstation — /dashboard/workstation (NURSE-only daily hub + REDIRECT-BOUNCE for non-NURSE roles)", () => {
  test("NURSE lands on the page chrome with title, NURSE pill, four quick-action buttons and the four lower-panel headings", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/medication/administrations/due**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/emergency/cases/active**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/appointments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/admissions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/nurse-rounds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/workstation");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /^Workstation$/i })
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Your nursing hub for today/i)).toBeVisible();

    // The four quick-action buttons use stable data-testids (page.tsx:144-222).
    await expect(page.locator('[data-testid="quick-record-vitals"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-administer-med"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-start-round"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-triage"]')).toBeVisible();

    // The four lower panels render their headings even when empty.
    await expect(
      page.getByRole("heading", { name: /Medications Due in Next 30 Minutes/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /My Assigned Patients/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Vitals to Record/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /ER Cases Awaiting Triage/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /My Recent Rounds/i })
    ).toBeVisible();
  });

  test("NURSE with a stubbed meds-due row sees the medication card body populated and the patient + medicine names rendered", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/medication/administrations/due**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: medsDueFixture(),
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/emergency/cases/active**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/appointments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/admissions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/nurse-rounds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/workstation");
    await dismissTourIfPresent(page);

    await expect(page.getByText(/Amoxicillin 500mg/)).toBeVisible({
      timeout: 15_000,
    });
    // Patient name appears alongside the dosage (page.tsx:255-260).
    await expect(page.getByText(/Aarav Iyer/).first()).toBeVisible();
    // Empty-state copy must NOT render when a row exists.
    await expect(
      page.getByText(/No medications due in the next 30 minutes/)
    ).toHaveCount(0);
  });

  test("NURSE clicking 'Record Vitals' with a CHECKED_IN appointment in the queue deep-links to /dashboard/vitals?appointmentId=<id> (Issue #432 fix at page.tsx:147-156)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/medication/administrations/due**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/emergency/cases/active**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/appointments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: appointmentsFixture(),
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/admissions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/nurse-rounds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    // Stub the destination page so we don't navigate into /vitals chrome —
    // we only care that the URL changes to the right query string.
    await page.route("**/api/v1/vitals**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/workstation");
    await dismissTourIfPresent(page);

    // Wait for the CHECKED_IN appointment row to flush into state — the
    // ActionBtn onClick reads `vitalsToRecord[0]` synchronously, so the
    // queue must have populated before the click for the deep-link to fire.
    await expect(page.getByText(/Bina Pillai/)).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="quick-record-vitals"]').click();

    await expect(page).toHaveURL(/\/dashboard\/vitals\?appointmentId=appt-1/, {
      timeout: 10_000,
    });
  });

  test("NURSE clicking 'Record Vitals' with NO CHECKED_IN appointments in the queue lands on /dashboard/vitals (no query) — page.tsx:152-155 fallback branch", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/medication/administrations/due**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/emergency/cases/active**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/appointments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/admissions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/nurse-rounds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/vitals**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/workstation");
    await dismissTourIfPresent(page);

    // Wait for the empty-state to render so we know the fetches settled
    // before clicking — otherwise the click may race the state update.
    await expect(page.getByText(/All vitals up to date/)).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('[data-testid="quick-record-vitals"]').click();

    // No appointmentId query param when the queue is empty.
    await expect(page).toHaveURL(/\/dashboard\/vitals(\?|$)/, {
      timeout: 10_000,
    });
    await expect(page).not.toHaveURL(/appointmentId=/);
  });

  test("PATIENT visiting /dashboard/workstation gets bounced via router.replace('/dashboard') — REDIRECT-BOUNCE archetype, page.tsx:38-42 useEffect", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/workstation", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!workstation))/, {
      timeout: 10_000,
    });
    // The four NURSE quick-action buttons never mount on this branch.
    await expect(
      page.locator('[data-testid="quick-record-vitals"]')
    ).toHaveCount(0);
  });

  test("DOCTOR is also outside the NURSE allow-set and hits the same redirect-bounce — confirms the page is strictly NURSE-only client-side", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/workstation", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!workstation))/, {
      timeout: 10_000,
    });
    await expect(
      page.locator('[data-testid="quick-administer-med"]')
    ).toHaveCount(0);
  });

  test("NURSE with stubbed admissions + ER cases sees the populated lower panels (My Assigned Patients + ER Cases Awaiting Triage)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/medication/administrations/due**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/emergency/cases/active**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: emergencyCasesFixture(),
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/appointments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/admissions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: admissionsFixture(),
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/nurse-rounds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/workstation");
    await dismissTourIfPresent(page);

    // Admission row renders with admissionNumber + ward + bed (page.tsx:309-313).
    await expect(page.getByText(/Chetan Rao/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/ADM-001/)).toBeVisible();

    // ER triage row — caseNumber + chiefComplaint + triage pill.
    await expect(page.getByText(/ER-2026-001/)).toBeVisible();
    await expect(page.getByText(/Severe abdominal pain/)).toBeVisible();
  });
});
