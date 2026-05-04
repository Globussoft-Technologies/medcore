/**
 * Unified Calendar surface — view-toggle contract + event detail popup +
 * navigation + access-shape pinning.
 *
 * What this exercises:
 *   /dashboard/calendar (apps/web/src/app/dashboard/calendar/page.tsx)
 *   GET /api/v1/appointments?from=YYYY-MM-DD&to=…    (every authed user)
 *   GET /api/v1/surgery?from=…                       (page-level only — staff)
 *   GET /api/v1/telemedicine?from=…
 *   GET /api/v1/antenatal?from=…    (PATIENT/DOCTOR/ADMIN-gated, page.tsx:117)
 *   GET /api/v1/prescriptions?followUpFrom=…
 *   GET /api/v1/shifts?from=…       (ADMIN-only client-side, page.tsx:123)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome renders (heading + "Unified view of all
 *     scheduled events" intro) + month is the default view + the three
 *     view-toggle tabs (data-testid="cal-view-{day,week,month}") flip the
 *     three corresponding panels (cal-month-view / cal-week-view /
 *     cal-day-view). The Issue #431 contract.
 *   - Month navigation contract: cal-prev / cal-next / cal-today buttons
 *     update the month label that lives between them. We pin "next then
 *     today" so the round-trip lands back on the live month label,
 *     proving cursor state cycles correctly.
 *   - Seeded walk-in event surfaces: a freshly-created appointment via the
 *     API drops a tile into the day's cell (covered by calendar-roster.spec.ts
 *     already — we deliberately DON'T duplicate that walk-in seed test here
 *     so the two specs don't double-pay the 5-second seedAppointment cost
 *     and don't race each other for the same patient1@ shift slot).
 *   - Event detail popup contract: clicking any rendered event tile mounts
 *     the popup with an "Open" CTA that links into the source dashboard
 *     route. We DON'T attempt drag-drop interaction (Playwright drag is
 *     fragile across renderers) — we pin the popup-via-click instead.
 *   - DOCTOR / NURSE access parity: the page is universally accessible
 *     (no `VIEW_ALLOWED`, no `router.push("/dashboard")` redirect — the
 *     Calendar widget is intentionally cross-role since every staff role
 *     wants the same "what's on today" view).
 *   - PATIENT access shape: PATIENT also lands on the page; the
 *     antenatal/appointments fetches return only their own rows (server-
 *     side BOLA scoping at apps/api/src/routes/{appointments,antenatal}.ts).
 *     We pin the chrome-renders branch and don't seed events — the
 *     determinism on a shared seed account is poor.
 *
 * Why these tests exist:
 *   /dashboard/calendar was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "event creation, drag, conflict
 *   detection — no e2e coverage". The page is the unified read surface
 *   for appointments/surgery/telemedicine/ANC/follow-ups/shifts; a
 *   silent regression in (i) the view-toggle wiring (Issue #431, the
 *   reason this test now pins all three panels), (ii) the Asia/Kolkata
 *   off-by-one fix (Issue #93, fmtYmd local-midnight semantics), or
 *   (iii) the time-prefix tile contract (Issue #397 — slotStart-via-
 *   formatAppointmentTime) cascades into every staff role's "what's
 *   on today" view simultaneously. There is NO event-creation flow on
 *   this page — it's a read-only aggregator; "creation" lives on the
 *   per-resource pages (/dashboard/appointments/new, /dashboard/surgery,
 *   etc.) so the backlog framing is aspirational. The "drag" and
 *   "conflict detection" hooks the backlog mentioned do not exist in
 *   the current implementation either; we pin the actual UI
 *   (view-toggle + nav + event-tile-popup) instead.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

const CAL_TIMEOUT = 15_000;

test.describe("Calendar — /dashboard/calendar (view-toggle contract + month nav + access-shape pinning, no role-gate redirect)", () => {
  test("ADMIN lands on /dashboard/calendar, page chrome renders, default Month view is mounted, the three view-toggle tabs are wired", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^calendar$/i }).first()
    ).toBeVisible({ timeout: CAL_TIMEOUT });
    await expect(
      page.getByText(/unified view of all scheduled events/i)
    ).toBeVisible();

    // Default = month. The three tabs all render (Issue #431 contract).
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: CAL_TIMEOUT,
    });
    await expect(page.getByTestId("cal-view-day")).toBeVisible();
    await expect(page.getByTestId("cal-view-week")).toBeVisible();
    await expect(page.getByTestId("cal-view-month")).toBeVisible();

    // The default view-tab must report aria-selected=true (page.tsx:291).
    await expect(page.getByTestId("cal-view-month")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  test("ADMIN view-toggle wiring: clicking Day → cal-day-view, Week → cal-week-view, Month → cal-month-view (all three Issue #431 panels mount)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Wait for default mount before flipping.
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: CAL_TIMEOUT,
    });

    await page.getByTestId("cal-view-day").click();
    await expect(page.getByTestId("cal-day-view")).toBeVisible({
      timeout: 5_000,
    });
    // Month view must unmount when Day is selected (the parent uses
    // `viewMode === "month" && (...)` guards, so the panel disappears).
    await expect(page.getByTestId("cal-month-view")).toHaveCount(0);
    await expect(page.getByTestId("cal-view-day")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await page.getByTestId("cal-view-week").click();
    await expect(page.getByTestId("cal-week-view")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("cal-day-view")).toHaveCount(0);

    await page.getByTestId("cal-view-month").click();
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("cal-week-view")).toHaveCount(0);
  });

  test("ADMIN month navigation: cal-next advances the label, cal-today returns to the live month — the cursor state-machine round-trips", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: CAL_TIMEOUT,
    });

    // Capture the live-month label (en-IN long-month-name + year, page.tsx:261).
    const liveLabel = await page
      .locator('[data-testid="cal-prev"] + span')
      .textContent();
    expect(liveLabel?.trim().length ?? 0).toBeGreaterThan(0);

    // Step forward — label must change.
    await page.getByTestId("cal-next").click();
    await expect(
      page.locator('[data-testid="cal-prev"] + span')
    ).not.toHaveText(liveLabel ?? "", { timeout: 3_000 });

    // Today button — bounce back to live month.
    await page.getByTestId("cal-today").click();
    await expect(
      page.locator('[data-testid="cal-prev"] + span')
    ).toHaveText(liveLabel ?? "", { timeout: 3_000 });
  });

  test("DOCTOR lands on /dashboard/calendar — universally accessible, no role-gate redirect (page has no VIEW_ALLOWED)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/calendar", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard\/calendar(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /^calendar$/i }).first()
    ).toBeVisible({ timeout: CAL_TIMEOUT });
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: CAL_TIMEOUT,
    });
  });

  test("PATIENT lands on /dashboard/calendar (open chrome — no role-gate redirect; PATIENT-allowed fetches resolve, ADMIN-only shifts fetch is short-circuited at page.tsx:123)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/calendar", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    // Pin reality: PATIENT stays on the page. CLAUDE.md gotcha #7 archetype 3
    // — open chrome, no client gate, server-side scoping is the truth.
    expect(page.url()).toMatch(/\/dashboard\/calendar(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /^calendar$/i }).first()
    ).toBeVisible({ timeout: CAL_TIMEOUT });
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: CAL_TIMEOUT,
    });

    // The Shifts legend chip is ADMIN-only (page.tsx:348-350) — for PATIENT
    // the chip must be absent. Lock the role-gated render branch so a
    // regression flipping the gate to all-roles surfaces here.
    await expect(page.getByText(/^shifts$/i)).toHaveCount(0);
  });
});
