import { test, expect } from "./fixtures";
import { dismissTourIfPresent, seedPatient } from "./helpers";

/**
 * Pearl PRD Stage 1 §3.4 / gap-analysis row 327 — RECEPTION must be able to
 * book an appointment for a **returning** patient in **< 30 seconds**.
 *
 * Touches:
 *   - apps/web/src/app/dashboard/appointments/page.tsx (booking panel +
 *     in-form EntityPicker + slot grid + Confirm Appointment dialog)
 *   - apps/api/src/routes/appointments.ts (POST /appointments/book)
 *
 * Why a timed spec: the existing appointment specs (appointments.spec.ts,
 * reception.spec.ts) only assert functional correctness — that a booking
 * CTA exists / a slot click works. Pearl's acceptance bullet is a wall-clock
 * SLA. This spec brackets the receptionist's actual booking flow with
 * `performance.now()` to surface perf regressions (slow slot fetches, slow
 * picker debounce, slow POST) as test failures, not bug reports.
 *
 * "Returning" patient = already in the database before the timer starts.
 * We seed via the receptionApi fixture (NOT in-band via the UI) so the
 * timer measures only the booking flow, not the create-patient flow.
 */
test.describe("Pearl §3.4 — RECEPTION books appointment in <30s for returning patient", () => {
  test("clock-bracketed flow: search returning patient → pick doctor → pick slot → confirm → success", async ({
    receptionPage,
    receptionApi,
  }) => {
    // ─── Pre-flight: seed a returning patient (NOT counted toward the 30s). ──
    // The patient must exist BEFORE the receptionist opens the booking form;
    // that's what "returning" means in the Pearl spec.
    const patient = await seedPatient(receptionApi, {
      name: "Aanya Sharma",
    });
    expect(patient.id).toMatch(/^[0-9a-f-]{36}$/);

    const page = receptionPage;

    // ─── Pre-flight: land the page + dismiss any first-run tour BEFORE the
    // timer starts. The Pearl bullet is about the booking *task* time, not
    // about first-paint hydration or onboarding overlays.
    await page.goto("/dashboard/appointments");
    await dismissTourIfPresent(page);
    await expect(
      page.getByRole("heading", { name: /appointment/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // ─── START TIMER ────────────────────────────────────────────────────────
    const t0 = performance.now();

    // 1. Open the booking panel. If empty-state is on screen the CTA is in
    //    EmptyState (action button); otherwise the toolbar exposes
    //    `data-testid="appt-book-toggle"`.
    const toggle = page.getByTestId("appt-book-toggle");
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
    } else {
      await page
        .getByRole("button", { name: /book appointment/i })
        .first()
        .click();
    }
    await expect(page.getByTestId("appt-book-panel")).toBeVisible({
      timeout: 10_000,
    });

    // 2. Search for the returning patient via the in-form EntityPicker.
    //    Use `data-entity-id` to lock onto the exact seeded row (CLAUDE.md
    //    gotcha 11 — name-substring matches are flaky when seeded fixtures
    //    accumulate across worker reuse).
    const patientInput = page.getByTestId("appt-book-patient-input");
    await expect(patientInput).toBeVisible({ timeout: 5_000 });
    await patientInput.fill(patient.name.slice(0, 4));
    const patientOption = page
      .locator(
        `[data-testid="appt-book-patient-option"][data-entity-id="${patient.id}"]`
      )
      .first();
    // Fallback: if the picker hasn't indexed our seeded row by name (rare
    // when search returns by debounced phone/MR), pick the first option that
    // matches by name substring. Either way must succeed inside 30s budget.
    const lockedOnExact = await patientOption
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (lockedOnExact) {
      await patientOption.click();
    } else {
      const firstOpt = page.getByTestId("appt-book-patient-option").first();
      await firstOpt.waitFor({ state: "visible", timeout: 5_000 });
      await firstOpt.click();
    }

    // 3. Pick the first available seeded doctor. The DoctorSelect was
    //    rewritten from a native <select> to a custom dropdown: a
    //    <button id="appt-book-doctor" aria-haspopup="listbox"> that
    //    opens a <ul role="listbox"> of <button role="option"> entries.
    //    Step 1 click the trigger; step 2 pick the first real option
    //    (the listbox's first entry is the placeholder/"unset" — we
    //    skip it and click options.nth(1)). The id selector still
    //    scopes against the global LanguageDropdown (CLAUDE.md gotcha 9).
    const doctorTrigger = page.locator("#appt-book-doctor");
    await expect(doctorTrigger).toBeVisible({ timeout: 5_000 });
    await doctorTrigger.click();

    const listbox = page.getByRole("listbox");
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
    const options = listbox.getByRole("option");
    const optionCount = await options.count();
    // The placeholder entry counts as one option; <= 1 means no seeded
    // doctors. Skip gracefully — the Pearl <30s SLA is moot without one.
    if (optionCount <= 1) {
      test.skip(
        true,
        "No seeded doctors available in this environment — Pearl <30s SLA is moot without a doctor to book against."
      );
    }
    await options.nth(1).click();

    // 4. Pick a bookable slot. The slot grid only renders once the doctor's
    //    schedule fetch resolves; wait for the slots container OR the
    //    "no slots" empty state, then pick the first non-disabled,
    //    non-past slot.
    const slotsContainer = page.getByTestId("appt-book-slots");
    const noSlots = page.getByTestId("appt-book-no-slots");
    const callingMode = page.getByTestId("appt-book-calling-mode");

    // Wait for ONE of: slots / no-slots / calling-mode to appear.
    await Promise.race([
      slotsContainer.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
      noSlots.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
      callingMode.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
    ]);

    if (await callingMode.isVisible().catch(() => false)) {
      // CALLING-mode doctor — no slot click, single "Add to queue" button.
      await page.getByTestId("appt-book-calling-add").click();
    } else if (await noSlots.isVisible().catch(() => false)) {
      test.skip(
        true,
        "No bookable slots on today's schedule for the picked doctor — re-run mid-shift."
      );
    } else {
      const bookableSlot = slotsContainer.locator(
        "button[aria-disabled='false']:not([data-past='true'])"
      );
      const slotCount = await bookableSlot.count();
      if (slotCount === 0) {
        test.skip(
          true,
          "All slots are past/taken for the picked doctor today — re-run earlier in the day."
        );
      }
      await bookableSlot.first().click();

      // 5. Confirm the Confirm Appointment dialog.
      const dialog = page.getByTestId("confirm-appointment-dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      // Sanity: the dialog displays OUR patient (proves the picker lock-on
      // succeeded and the booking is about to fire against the right row).
      await expect(
        page.getByTestId("confirm-appointment-patient")
      ).toContainText(patient.name.split(" ")[0]);
      await page.getByTestId("confirm-appointment-confirm").click();
      // The route closes the dialog + collapses the booking panel + fires
      // a toast on success. Dialog-hidden is the canonical "POST resolved"
      // signal — toasts dismiss themselves and races other assertions.
      await expect(dialog).toBeHidden({ timeout: 10_000 });
    }

    // Final success signal: the booking panel collapses back to the list.
    await expect(page.getByTestId("appt-book-panel")).toBeHidden({
      timeout: 5_000,
    });

    // ─── STOP TIMER + ASSERT 30s SLA ────────────────────────────────────────
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);
    // Log the wall-clock so CI surfaces the exact figure — useful for
    // tracking the SLA budget over time even when the test passes.
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §3.4 row 327] RECEPTION booked appointment in ${elapsedMs} ms (budget: 30000 ms)`
    );
    expect(
      elapsedMs,
      `Pearl §3.4 SLA: receptionist must book a returning patient in < 30 s. Observed ${elapsedMs} ms.`
    ).toBeLessThan(30_000);
  });
});
