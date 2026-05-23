import { test, expect } from "./fixtures";
import { API_BASE, dismissTourIfPresent, seedPatient } from "./helpers";

/**
 * Pearl PRD Stage 1 §6 / gap-analysis row 328 — when a doctor is configured
 * with appointmentMode="CALLING" (and only the CALLING booking channel
 * enabled), the booking form at /dashboard/appointments MUST NOT render any
 * slot-picker or token-estimate UI. The CALLING-mode hint panel renders
 * instead, with a single "Add to today's queue" button (no slotId in the
 * POST body — the API mints arrivalSeq).
 *
 * Touches:
 *   - apps/web/src/app/dashboard/appointments/page.tsx
 *       — branch-by-mode UI added in 47131fa; channel auto-select when
 *         availableChannelsFor(doctor).length === 1 (page.tsx:1805); slot
 *         picker only renders when selectedChannel ∈ {SLOT, TOKEN}
 *         (page.tsx:2005, 2025).
 *   - apps/api/src/routes/doctors.ts
 *       — PATCH /doctors/:id/appointment-mode persists appointmentMode +
 *         enabledChannels (doctors.ts:446).
 *
 * Why this spec exists: 47131fa shipped the UI branching but didn't add a
 * DOM-level "absence" assertion. appointment-booking-timed.spec.ts uses an
 * either-or wait that tolerates CALLING-mode doctors but does NOT assert
 * that the slot/token UI is hidden in that branch — a regression that
 * re-introduced the slot picker for CALLING doctors would pass that spec
 * silently. This spec closes that gap with explicit `toBeHidden()` /
 * `toHaveCount(0)` checks on the slot + token UI, and a positive control
 * (a SLOT-mode doctor on the same page) that asserts the slot UI DOES
 * render — proving the absence assertions aren't trivially true (e.g. the
 * form failed to load at all).
 */

interface RegisterResponse {
  user: { id: string; email: string };
  doctor?: { id: string };
}

interface DoctorRow {
  id: string;
  user: { id: string; email: string };
}

/**
 * Register a fresh DOCTOR user via the /auth/register backdoor (auth.ts
 * Issue #205 auto-creates the Doctor row when role=DOCTOR). Returns the
 * Doctor.id so we can PATCH its appointment-mode + schedule.
 *
 * Mirrors the helper-shape used in doctor-onboarding-timed.spec.ts — kept
 * inline here to honour the file-allowlist scope-cut (we're not allowed to
 * touch helpers.ts in this gap row).
 */
async function registerFreshDoctor(
  adminApi: import("@playwright/test").APIRequestContext,
  emailTag: string
): Promise<string> {
  const email = `pearl.row328.${emailTag}@medcore.local`;
  const registerRes = await adminApi.post(`${API_BASE}/auth/register`, {
    data: {
      name: "Doctor Pearl Row328",
      email,
      phone: "+919876543211",
      password: "PearlTest!2026",
      role: "DOCTOR",
    },
  });
  if (!registerRes.ok()) {
    const status = registerRes.status();
    const body = (await registerRes.text()).slice(0, 200);
    throw new Error(
      `POST /auth/register?role=DOCTOR failed: ${status} ${body}`
    );
  }
  const registered = (await registerRes.json()).data as RegisterResponse;
  if (registered.doctor?.id) return registered.doctor.id;

  // Fallback when auth/register returned only the User id — find the Doctor
  // row by joined email (same pattern as doctor-onboarding-timed.spec.ts).
  const listRes = await adminApi.get(`${API_BASE}/doctors`);
  const list = (await listRes.json()).data as DoctorRow[];
  const found = list.find((d) => d.user?.email === email);
  if (!found) {
    throw new Error(
      `Doctor row for ${email} not found in /doctors after register`
    );
  }
  return found.id;
}

test.describe("Pearl §6 row 328 — CALLING-mode doctor: booking form hides slot/token UI", () => {
  test("calling-mode doctor renders the queue hint and ZERO slot-picker / token UI; SLOT-mode doctor (positive control) renders the slot picker", async ({
    receptionPage,
    adminApi,
    receptionApi,
  }) => {
    // ─── Pre-flight: prove the local API is reachable, else defer to CI. ───
    // Mirror the test.skip pattern from appointment-booking-timed +
    // doctor-onboarding-timed — local-dev runs without the API up should
    // not produce red CI noise.
    const probe = await adminApi.get(`${API_BASE}/doctors`).catch(() => null);
    if (!probe || !probe.ok()) {
      test.skip(
        true,
        `Pearl §6 row 328 prerequisite (GET /doctors) failed — API likely not running. Suite defers to CI.`
      );
    }

    const uniq = Date.now().toString(36);

    // ─── Seed two doctors: one CALLING-only, one SLOT-only (positive control)
    const callingDoctorId = await registerFreshDoctor(adminApi, `c-${uniq}`);
    const slotDoctorId = await registerFreshDoctor(adminApi, `s-${uniq}`);

    // PATCH the CALLING doctor: mode=CALLING + enabledChannels=["CALLING"]
    // so availableChannelsFor() returns length 1 and the channel picker
    // auto-selects CALLING + hides itself (page.tsx:1801-1809, 1896-1930).
    const cModeRes = await adminApi.patch(
      `${API_BASE}/doctors/${callingDoctorId}/appointment-mode`,
      {
        data: {
          appointmentMode: "CALLING",
          enabledChannels: ["CALLING"],
          dailyAppointmentLimit: 40,
        },
      }
    );
    expect(
      cModeRes.ok(),
      `PATCH CALLING-doctor appointment-mode failed: ${cModeRes.status()} ${(await cModeRes.text()).slice(0, 200)}`
    ).toBeTruthy();

    // PATCH the SLOT doctor + give it a Mon-Sun weekly schedule so the
    // /schedule/slots endpoint returns a non-empty slot grid for the
    // positive-control assertion. dayOfWeek 0=Sun..6=Sat.
    const sModeRes = await adminApi.patch(
      `${API_BASE}/doctors/${slotDoctorId}/appointment-mode`,
      {
        data: {
          appointmentMode: "SLOT",
          enabledChannels: ["SLOT"],
          dailyAppointmentLimit: 40,
        },
      }
    );
    expect(
      sModeRes.ok(),
      `PATCH SLOT-doctor appointment-mode failed: ${sModeRes.status()} ${(await sModeRes.text()).slice(0, 200)}`
    ).toBeTruthy();

    for (let day = 0; day <= 6; day++) {
      await adminApi.post(`${API_BASE}/doctors/${slotDoctorId}/schedule`, {
        data: {
          dayOfWeek: day,
          startTime: "00:00",
          endTime: "23:45",
          slotDurationMinutes: 15,
          bufferMinutes: 0,
        },
      });
    }

    // ─── Seed a returning patient so the booking form has a row to pick. ──
    // CLAUDE.md gotcha #8 — PATIENT_NAME_REGEX rejects digits, so we tag
    // uniqueness on the helper-generated phone/MR, not the name.
    const patient = await seedPatient(receptionApi, { name: "Aanya Sharma" });
    expect(patient.id).toMatch(/^[0-9a-f-]{36}$/);

    // ─── Drive the booking form. ─────────────────────────────────────────
    const page = receptionPage;
    await page.goto("/dashboard/appointments");
    await dismissTourIfPresent(page);
    await expect(
      page.getByRole("heading", { name: /appointment/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open booking panel (toolbar toggle OR EmptyState CTA — mirrors the
    // appointment-booking-timed pattern).
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

    // Pick the returning patient via the in-form EntityPicker. Lock onto
    // the exact seeded row via data-entity-id (CLAUDE.md gotcha #11).
    const patientInput = page.getByTestId("appt-book-patient-input");
    await expect(patientInput).toBeVisible({ timeout: 5_000 });
    await patientInput.fill(patient.name.slice(0, 4));
    const patientOption = page
      .locator(
        `[data-testid="appt-book-patient-option"][data-entity-id="${patient.id}"]`
      )
      .first();
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

    // ─── Step 1 — pick the CALLING-only doctor. ──────────────────────────
    // DoctorSelect is scoped by id (#appt-book-doctor) to avoid the global
    // LanguageDropdown (CLAUDE.md gotcha #9).
    const doctorSelect = page.locator("select#appt-book-doctor");
    await expect(doctorSelect).toBeVisible({ timeout: 5_000 });
    await doctorSelect.selectOption(callingDoctorId);

    // The CALLING-mode hint panel MUST render with the "Add to today's
    // queue" button. This is the affirmative half of the assertion.
    await expect(page.getByTestId("appt-book-calling-mode")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("appt-book-calling-add")).toBeVisible();

    // ABSENCE assertions — the meat of row 328. Slot-picker UI, no-slots
    // empty-state, walkin panel must ALL be absent. Use toHaveCount(0) so
    // the assertion fails loudly if the locator ever resolves to a node
    // (even an invisible one) — Hidden tolerates display:none on an
    // existing node, Count(0) does not.
    await expect(page.getByTestId("appt-book-slots")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-no-slots")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-walkin-mode")).toHaveCount(0);

    // Defensive text-marker absence — even if a future regression adds an
    // un-testid'd slot heading or token-number label inside the CALLING
    // branch, these would flag it.
    await expect(page.locator("text=/available slots/i")).toHaveCount(0);
    await expect(page.locator("text=/pick a start slot/i")).toHaveCount(0);
    await expect(page.locator("text=/token number/i")).toHaveCount(0);

    // ─── Step 2 — positive control: switch to the SLOT doctor. ───────────
    // Picking a different doctor in the same form must (a) hide the
    // CALLING-mode panel and (b) reveal the slot-picker (or the no-slots
    // empty-state in the unlikely case the schedule produced zero
    // bookable slots — either way, the CALLING panel must be gone).
    await doctorSelect.selectOption(slotDoctorId);

    await expect(page.getByTestId("appt-book-calling-mode")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-calling-add")).toHaveCount(0);

    // Exactly one of {appt-book-slots, appt-book-no-slots} must surface
    // for the SLOT doctor — that's what proves the slot-branch is alive
    // and the absence assertions above weren't trivially satisfied by a
    // dead form. Wait up to 10s for the schedule fetch to resolve.
    const slotsContainer = page.getByTestId("appt-book-slots");
    const noSlots = page.getByTestId("appt-book-no-slots");
    await Promise.race([
      slotsContainer.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
      noSlots.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
    ]);
    const slotsVisible = await slotsContainer.isVisible().catch(() => false);
    const noSlotsVisible = await noSlots.isVisible().catch(() => false);
    expect(
      slotsVisible || noSlotsVisible,
      "Positive control: SLOT-mode doctor must surface either the slot picker or the no-slots empty-state, proving the absence assertions for CALLING-mode are non-trivial."
    ).toBeTruthy();
  });
});
