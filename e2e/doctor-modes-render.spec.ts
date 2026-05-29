import { test, expect } from "./fixtures";
import { API_BASE, dismissTourIfPresent, seedPatient } from "./helpers";

/**
 * Pearl PRD Stage 1 §6 / gap-analysis row 324 — All three doctor modes
 * (CALLING / TOKEN / SLOT) must render their mode-specific booking UI on
 * the same hospital, on the same booking form, when three different
 * doctors with three different `appointmentMode` enums are picked in
 * succession. queue.test.ts (commit 97542ec) already covers the
 * server-side plumbing for the 3 modes; this is the end-to-end DOM
 * rendering assertion that was missing.
 *
 * Touches (read-only — the spec drives the form, no source edits):
 *   - apps/web/src/app/dashboard/appointments/page.tsx
 *       - Branch-by-mode UI (CALLING panel at line 1984; slot picker
 *         shell at 2005-2028; channel picker at 1896-1930 — auto-hides
 *         when availableChannelsFor(doctor).length === 1).
 *   - apps/api/src/routes/doctors.ts
 *       - PATCH /doctors/:id/appointment-mode persists appointmentMode +
 *         enabledChannels (doctors.ts:446).
 *
 * Why this spec exists separately from bf2c289 (booking-calling-mode-hides-
 * ui.spec.ts): that spec proved CALLING-only hides the slot/token UI with
 * a single positive control (SLOT doctor). It did NOT prove that the
 * third mode — TOKEN — also renders on the same form against the same
 * receptionist session, nor that switching across all three in order
 * produces the right testid surface for each. Row 324 is the broader
 * "3 doctors x 3 modes coexist correctly on one hospital" assertion.
 *
 * Mode <-> testid map (verified against page.tsx 2026-05-23):
 *   CALLING -> appt-book-calling-mode (panel) + appt-book-calling-add
 *   TOKEN   -> appt-book-slots / appt-book-no-slots (same shell as SLOT)
 *   SLOT    -> appt-book-slots / appt-book-no-slots
 * To differentiate TOKEN vs SLOT at the DOM level we add WALKIN to each
 * doctor's enabledChannels so the channel picker stays visible
 * (avail.length === 2) and its mode-specific button testids surface:
 *   appt-book-channel-calling / -token / -slot.
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
 * Inlined per the file-allowlist scope-cut (no helpers.ts edits in this
 * gap row). Mirrors the shape used in booking-calling-mode-hides-ui.spec.ts.
 */
async function registerFreshDoctor(
  adminApi: import("@playwright/test").APIRequestContext,
  emailTag: string
): Promise<{ id: string; email: string }> {
  const email = `pearl.row324.${emailTag}@medcore.local`;
  const registerRes = await adminApi.post(`${API_BASE}/auth/register`, {
    data: {
      // CLAUDE.md gotcha #8 — PATIENT_NAME_REGEX rejects digits; tag
      // uniqueness on the email, not the name. The gap-row reference
      // (Row 324) lives in the file header + this comment, not in
      // the request body.
      name: "Doctor Pearl",
      email,
      phone: "+919876543210",
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
  if (registered.doctor?.id) return { id: registered.doctor.id, email };

  // Fallback when /auth/register returned only the User id.
  const listRes = await adminApi.get(`${API_BASE}/doctors`);
  const list = (await listRes.json()).data as DoctorRow[];
  const found = list.find((d) => d.user?.email === email);
  if (!found) {
    throw new Error(
      `Doctor row for ${email} not found in /doctors after register`
    );
  }
  return { id: found.id, email };
}

/**
 * Pick a specific doctor in the booking-form's DoctorSelect, then wait
 * for the form state to settle (the select's onChange triggers a
 * `/schedule/slots` fetch + channel-auto-pick for single-channel doctors).
 *
 * Scoped to `select#appt-book-doctor` to dodge the global
 * LanguageDropdown that injects a `<select>` into every dashboard layout
 * (CLAUDE.md gotcha #9).
 */
async function pickDoctor(
  page: import("@playwright/test").Page,
  doctorId: string
): Promise<void> {
  // DoctorSelect was rewritten from a native <select> to a custom
  // dropdown: <button id="appt-book-doctor" aria-haspopup="listbox"> that
  // opens a <ul role="listbox"> of <button role="option" data-doctor-id>
  // entries. The id is exposed via `data-doctor-id` on each option (see
  // apps/web/src/app/dashboard/appointments/page.tsx DoctorSelect) so the
  // test can lock onto a specific seeded doctor — all three test doctors
  // share the same `name` per CLAUDE.md gotcha #8 (digits rejected), so
  // picking by visible text would be ambiguous.
  const doctorTrigger = page.locator("#appt-book-doctor");
  await expect(doctorTrigger).toBeVisible({ timeout: 5_000 });
  await doctorTrigger.click();
  const option = page.locator(
    `[role="option"][data-doctor-id="${doctorId}"]`,
  );
  await expect(option).toBeVisible({ timeout: 5_000 });
  await option.click();
}

test.describe("Pearl §6 row 324 — all 3 doctor modes (CALLING / TOKEN / SLOT) render their mode-specific UI on the same hospital", () => {
  test("three doctors with CALLING / TOKEN / SLOT modes each render the right testids and hide the other modes' testids when picked in succession", async ({
    receptionPage,
    adminApi,
    receptionApi,
  }) => {
    // ─── Pre-flight: prove the local API is reachable, else defer to CI. ─
    // Mirrors the test.skip pattern from bf2c289 + 02cbe53 — local-dev
    // runs without the API up should not produce red CI noise.
    const probe = await adminApi.get(`${API_BASE}/doctors`).catch(() => null);
    if (!probe || !probe.ok()) {
      test.skip(
        true,
        `Pearl §6 row 324 prerequisite (GET /doctors) failed — API likely not running. Suite defers to CI.`
      );
    }

    const uniq = Date.now().toString(36);
    const doctorIdsToDeactivate: string[] = [];

    // ─── Seed three doctors, one per appointmentMode. ────────────────────
    // We pair each primary channel with WALKIN in enabledChannels so the
    // channel picker stays visible (avail.length === 2), giving us a
    // mode-distinct testid (appt-book-channel-calling/-token/-slot) to
    // assert against. The primary channel still auto-selects via the
    // selectedChannel state, so the affirmative mode panels still render.
    const callingDoctor = await registerFreshDoctor(adminApi, `c-${uniq}`);
    const tokenDoctor = await registerFreshDoctor(adminApi, `t-${uniq}`);
    const slotDoctor = await registerFreshDoctor(adminApi, `s-${uniq}`);
    doctorIdsToDeactivate.push(callingDoctor.id, tokenDoctor.id, slotDoctor.id);

    const modePatches: Array<{
      id: string;
      mode: "CALLING" | "TOKEN" | "SLOT";
      channels: string[];
    }> = [
      { id: callingDoctor.id, mode: "CALLING", channels: ["CALLING", "WALKIN"] },
      { id: tokenDoctor.id, mode: "TOKEN", channels: ["TOKEN", "WALKIN"] },
      { id: slotDoctor.id, mode: "SLOT", channels: ["SLOT", "WALKIN"] },
    ];

    for (const m of modePatches) {
      const res = await adminApi.patch(
        `${API_BASE}/doctors/${m.id}/appointment-mode`,
        {
          data: {
            appointmentMode: m.mode,
            enabledChannels: m.channels,
            dailyAppointmentLimit: 40,
          },
        }
      );
      expect(
        res.ok(),
        `PATCH ${m.mode}-doctor appointment-mode failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
      ).toBeTruthy();
    }

    // SLOT-mode doctor needs a weekly schedule so /schedule/slots can
    // produce a non-empty grid (or at least the no-slots empty-state
    // — either is an acceptable rendering of the SLOT branch).
    for (let day = 0; day <= 6; day++) {
      await adminApi.post(`${API_BASE}/doctors/${slotDoctor.id}/schedule`, {
        data: {
          dayOfWeek: day,
          startTime: "00:00",
          endTime: "23:45",
          slotDurationMinutes: 15,
          bufferMinutes: 0,
        },
      });
    }
    // TOKEN-mode doctor likewise needs a schedule — the slot-shell only
    // renders if slotsWithPast.length > 0 OR the no-slots empty-state
    // surfaces (which also needs a date target). The shell's outer guard
    // is (channel === SLOT || channel === TOKEN), so a TOKEN doctor with
    // zero schedule rows surfaces the empty-state branch, which is still
    // a TOKEN-mode rendering (the assertion accepts either).
    for (let day = 0; day <= 6; day++) {
      await adminApi.post(`${API_BASE}/doctors/${tokenDoctor.id}/schedule`, {
        data: {
          dayOfWeek: day,
          startTime: "00:00",
          endTime: "23:45",
          slotDurationMinutes: 15,
          bufferMinutes: 0,
        },
      });
    }

    // ─── Seed a returning patient so the booking form has a row to pick. ─
    const patient = await seedPatient(receptionApi, { name: "Aanya Sharma" });
    expect(patient.id).toMatch(/^[0-9a-f-]{36}$/);

    // ─── Drive the booking form. ─────────────────────────────────────────
    const page = receptionPage;
    await page.goto("/dashboard/appointments");
    await dismissTourIfPresent(page);
    await expect(
      page.getByRole("heading", { name: /appointment/i }).first()
    ).toBeVisible({ timeout: 15_000 });

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

    // ─── Mode 1 — CALLING doctor. ────────────────────────────────────────
    // Affirmative: appt-book-calling-mode + appt-book-calling-add visible,
    // appt-book-channel-calling button visible.
    // Negative: slot-shell (appt-book-slots / -no-slots) absent and
    // walkin-mode panel absent (walkin-mode only renders when the user
    // explicitly switches to the WALKIN channel — auto-select picks the
    // primary channel CALLING).
    await pickDoctor(page, callingDoctor.id);
    await expect(page.getByTestId("appt-book-calling-mode")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("appt-book-calling-add")).toBeVisible();
    await expect(page.getByTestId("appt-book-channel-calling")).toBeVisible();
    await expect(page.getByTestId("appt-book-slots")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-no-slots")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-walkin-mode")).toHaveCount(0);

    // ─── Mode 2 — TOKEN doctor. ──────────────────────────────────────────
    // Affirmative: appt-book-channel-token button visible (mode-distinct
    // testid) AND one of appt-book-slots / appt-book-no-slots visible
    // (TOKEN reuses the slot-shell — page.tsx:2005-2006 gates on
    // `channel === SLOT || channel === TOKEN`).
    // Negative: CALLING panel + WALKIN panel both absent (auto-select
    // picks the primary channel TOKEN, not WALKIN).
    await pickDoctor(page, tokenDoctor.id);
    await expect(page.getByTestId("appt-book-channel-token")).toBeVisible({
      timeout: 10_000,
    });
    const tokenSlots = page.getByTestId("appt-book-slots");
    const tokenNoSlots = page.getByTestId("appt-book-no-slots");
    await Promise.race([
      tokenSlots.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
      tokenNoSlots
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => null),
    ]);
    const tokenSlotsVisible = await tokenSlots.isVisible().catch(() => false);
    const tokenNoSlotsVisible = await tokenNoSlots
      .isVisible()
      .catch(() => false);
    expect(
      tokenSlotsVisible || tokenNoSlotsVisible,
      "TOKEN-mode doctor must surface either appt-book-slots or appt-book-no-slots (the shared SLOT/TOKEN shell)."
    ).toBeTruthy();
    await expect(page.getByTestId("appt-book-calling-mode")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-calling-add")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-walkin-mode")).toHaveCount(0);

    // ─── Mode 3 — SLOT doctor. ───────────────────────────────────────────
    // Affirmative: appt-book-channel-slot button visible AND one of
    // appt-book-slots / appt-book-no-slots visible.
    // Negative: CALLING panel absent (proves switching from TOKEN to SLOT
    // didn't leave any CALLING-mode DOM behind), WALKIN panel absent.
    await pickDoctor(page, slotDoctor.id);
    await expect(page.getByTestId("appt-book-channel-slot")).toBeVisible({
      timeout: 10_000,
    });
    const slotSlots = page.getByTestId("appt-book-slots");
    const slotNoSlots = page.getByTestId("appt-book-no-slots");
    await Promise.race([
      slotSlots.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null),
      slotNoSlots
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => null),
    ]);
    const slotSlotsVisible = await slotSlots.isVisible().catch(() => false);
    const slotNoSlotsVisible = await slotNoSlots
      .isVisible()
      .catch(() => false);
    expect(
      slotSlotsVisible || slotNoSlotsVisible,
      "SLOT-mode doctor must surface either appt-book-slots or appt-book-no-slots."
    ).toBeTruthy();
    await expect(page.getByTestId("appt-book-calling-mode")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-calling-add")).toHaveCount(0);
    await expect(page.getByTestId("appt-book-walkin-mode")).toHaveCount(0);

    // ─── Cleanup: deactivate the 3 seeded doctors so subsequent suites
    // don't pick them up in unscoped /doctors lists. Best-effort — a
    // failed deactivate must not fail the test.
    for (const id of doctorIdsToDeactivate) {
      await adminApi
        .delete(`${API_BASE}/doctors/${id}`)
        .catch(() => null);
    }
  });
});
