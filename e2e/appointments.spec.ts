import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

/**
 * Regression tests for the April-2026 appointments bug batch:
 *   Issue #33 — direct URL navigation while logged in used to silently bounce
 *               the user to /login because the dashboard auth gate fired before
 *               the Zustand store rehydrated from localStorage.
 *   Issue #34 — past time slots on today's date were rendered as clickable.
 *   Issue #35 — clicking late-in-the-day slots (e.g. 18:00) froze the page.
 *
 * These tests exercise the browser, not the API, so they survive backend
 * schema drift. They use the pre-authenticated `adminPage` / `receptionPage`
 * fixtures which inject a real admin/reception token.
 */

test.describe("Appointments regressions (April 2026)", () => {
  test("Issue #33: direct URL nav to /dashboard/wards does NOT bounce an authed admin", async ({
    adminPage,
  }) => {
    const page = adminPage;
    // Land somewhere else first so the store is fully hydrated, then hop
    // directly to /dashboard/wards via a hard navigation — this is exactly
    // the path that used to drop the user at /login with no toast.
    await page.goto("/dashboard");
    await expect(page.getByAltText("MedCore").first()).toBeVisible({
      timeout: 15_000,
    });
    await dismissTourIfPresent(page);

    await page.goto("/dashboard/wards", { waitUntil: "domcontentloaded" });

    // Give the auth effect a moment to run; we should stay on /wards.
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/dashboard\/wards(?:[/?#].*)?$/);

    // The wards heading is the canonical "page rendered" signal.
    await expect(
      page.getByRole("heading", { name: /wards?/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Issue #34: today's past time slots are rendered with aria-disabled=true", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/appointments");
    await dismissTourIfPresent(page);
    await expect(
      page.getByRole("heading", { name: /appointment/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the booking panel if it isn't already visible.
    const openBookingBtn = page
      .getByRole("button", { name: /book appointment/i })
      .first();
    if (await openBookingBtn.isVisible().catch(() => false)) {
      await openBookingBtn.click();
    }

    // Pick any doctor to force slot load. The booking form auto-fills
    // today's date via toISODate(new Date()).
    const doctorSelect = page.locator("#appt-book-doctor");
    if (!(await doctorSelect.isVisible().catch(() => false))) {
      test.skip(
        true,
        "Booking form not available for this role in this environment"
      );
    }
    const options = await doctorSelect.locator("option").all();
    // Pick the first non-empty option.
    let chosenValue = "";
    for (const opt of options) {
      const v = await opt.getAttribute("value");
      if (v) {
        chosenValue = v;
        break;
      }
    }
    if (!chosenValue) {
      test.skip(true, "No seeded doctors available in this environment");
    }
    await doctorSelect.selectOption(chosenValue);

    // Any slot at all. If the schedule starts late enough that no past
    // slots exist yet today, this test is a no-op (it only needs to prove
    // that when a slot IS in the past it's marked as aria-disabled=true
    // AND that clicking it does nothing functionally).
    const slotButtons = page.locator(
      "button[data-past='true']"
    );
    const pastCount = await slotButtons.count();
    if (pastCount === 0) {
      test.skip(
        true,
        "No past slots on today's schedule — re-run later in the day."
      );
    }
    for (let i = 0; i < pastCount; i++) {
      const btn = slotButtons.nth(i);
      await expect(btn).toHaveAttribute("aria-disabled", "true");
      await expect(btn).toBeDisabled();
    }
  });

  test("Issue #35: clicking a late-in-the-day slot does NOT freeze the page", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/appointments");
    await dismissTourIfPresent(page);

    const openBookingBtn = page
      .getByRole("button", { name: /book appointment/i })
      .first();
    if (await openBookingBtn.isVisible().catch(() => false)) {
      await openBookingBtn.click();
    }

    const doctorSelect = page.locator("#appt-book-doctor");
    if (!(await doctorSelect.isVisible().catch(() => false))) {
      test.skip(
        true,
        "Booking form not available for this role in this environment"
      );
    }
    const options = await doctorSelect.locator("option").all();
    let chosenValue = "";
    for (const opt of options) {
      const v = await opt.getAttribute("value");
      if (v) {
        chosenValue = v;
        break;
      }
    }
    if (!chosenValue) {
      test.skip(true, "No seeded doctors available");
    }
    await doctorSelect.selectOption(chosenValue);

    // Pre-pick a patient via the in-form EntityPicker. The booking flow
    // requires a patient to be selected before a slot click opens the
    // Confirm Appointment dialog. Two characters minimum — EntityPicker's
    // default minQueryLength=2 won't trigger a fetch on a single letter.
    const patientInput = page.getByTestId("appt-book-patient-input");
    if (!(await patientInput.isVisible().catch(() => false))) {
      test.skip(
        true,
        "In-form Patient picker not available for this role in this environment"
      );
    }
    await patientInput.fill("an");
    const firstPatient = page.getByTestId("appt-book-patient-option").first();
    await firstPatient
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);
    if (!(await firstPatient.isVisible().catch(() => false))) {
      test.skip(true, "No seeded patients matched the picker query");
    }
    await firstPatient.click();

    // Try to find any "bookable" slot (not in the past, not taken). Prefer
    // a late-hour one like 18:00 since that is the exact slot that used to
    // freeze the tab; fall back to the first bookable slot.
    await page
      .locator("button", { hasText: /\d{2}:\d{2} - \d{2}:\d{2}/ })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => undefined);

    const bookable = page.locator(
      "button[aria-disabled='false']",
      { hasText: /\d{2}:\d{2} - \d{2}:\d{2}/ }
    );
    const bookableCount = await bookable.count();
    if (bookableCount === 0) {
      test.skip(
        true,
        "No bookable slots available for this doctor today — skipping"
      );
    }

    // Prefer 18:xx if present.
    let target = bookable.first();
    for (let i = 0; i < bookableCount; i++) {
      const text = (await bookable.nth(i).textContent()) || "";
      if (text.trim().startsWith("18:")) {
        target = bookable.nth(i);
        break;
      }
    }

    await target.click();

    // After the click the page must still be interactive. We assert two
    // signals: the Confirm Appointment dialog renders (proving the click
    // handler ran to completion), AND a subsequent DOM interaction
    // (clicking the dialog's Cancel button) succeeds within a sane timeout.
    const dialog = page.getByTestId("confirm-appointment-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const cancel = page.getByTestId("confirm-appointment-cancel");
    await expect(cancel).toBeVisible();
    await cancel.click({ timeout: 3_000 });
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test("Issue #33: unauthed direct URL gets redirected to /login with ?redirect=<path>", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // No auth injected — the dashboard gate should forward us to /login and
    // preserve the originally-requested path as a query param.
    await page.goto("/dashboard/wards");
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/dashboard/wards");
    await ctx.close();
  });
});
