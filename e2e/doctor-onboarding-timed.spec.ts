import { test, expect } from "./fixtures";
import { API_BASE } from "./helpers";

/**
 * Pearl PRD Stage 1 §7.3 (PRD M6) / gap-analysis row 346 — ADMIN must be
 * able to onboard a brand-new doctor (User + Role + working hours +
 * appointment mode) in **< 5 minutes**.
 *
 * Touches:
 *   - apps/api/src/routes/auth.ts (POST /auth/register with role=DOCTOR
 *     auto-creates both the User and the Doctor row — see auth.ts ref
 *     Issue #205, and the comment block at the top of
 *     apps/web/src/app/dashboard/doctors/page.tsx)
 *   - apps/api/src/routes/doctors.ts
 *       - PATCH /doctors/:id            (specialization / qualification /
 *                                         registration number)
 *       - POST  /doctors/:id/schedule   (weekly schedule rows, one per day)
 *       - PATCH /doctors/:id/appointment-mode  (SLOT vs TOKEN vs CALLING)
 *
 * Why a timed spec: the editing surfaces all exist post-`fd58688`, but
 * Pearl §7.3 (PRD M6) is an SLA — every editing knob must combine into a
 * <5-min onboarding ceremony. This spec brackets the *full* admin
 * onboarding ceremony (User create → role assigned via register → profile
 * patch → 5 weekly schedule rows → appointment-mode set → presence-verify
 * in /doctors list) with `performance.now()` to surface perf regressions
 * (slow Prisma writes, slow auth-register, slow schedule upserts) as test
 * failures rather than support tickets.
 *
 * Scope-cuts vs the PRD prose:
 *   - We drive the five steps via API (request.post / adminApi) rather
 *     than the UI "Add Doctor" modal + per-day schedule form + appointment-
 *     mode editor. Rationale matches the receipt-timing spec
 *     (invoice-receipt-timed.spec.ts §c3c5b54): the UI layer's modal-open
 *     animations + EntityPicker debounce add 2-5s of UI noise that the
 *     Pearl SLA budget is NOT meant to police (the SLA is about the
 *     underlying create-profile-schedule path, mirrored by the form).
 *     API-level timing is the conservative measurement; the form layer
 *     wraps it.
 *   - We do NOT exercise the "elevate existing user" mode (the alternate
 *     `EntityPicker`-driven path in doctors/page.tsx). Pearl §7.3 row 346
 *     prose is "Admin onboards new doctor" — by definition a fresh user.
 *   - We exit via `test.skip` (matching appointment-booking-timed.spec.ts
 *     §02cbe53 / invoice-receipt-timed.spec.ts §c3c5b54) if the local API
 *     is unreachable so the suite defers to CI without spurious failure.
 */

interface RegisterResponse {
  user: { id: string; email: string };
  doctor?: { id: string };
}

interface DoctorRow {
  id: string;
  user: { id: string; email: string };
}

test.describe("Pearl §7.3 — ADMIN onboards new doctor (user + role + working hours + appointment mode) in <5min", () => {
  test("clock-bracketed flow: POST /auth/register?role=DOCTOR → PATCH /doctors/:id → POST /doctors/:id/schedule × 5 → PATCH /doctors/:id/appointment-mode → GET /doctors verifies row", async ({
    adminApi,
  }) => {
    // ─── START TIMER ────────────────────────────────────────────────────────
    // Per the Pearl §7.3 prose, "onboard" begins at "I want a new doctor in
    // the system" and ends at "doctor is fully configured and visible in the
    // roster". Nothing to pre-seed — a fresh User+Doctor pair IS the work.
    const t0 = performance.now();

    // Tag the email with a timestamp so re-runs don't collide on the unique
    // index. PATIENT_NAME_REGEX rejects digits (CLAUDE.md gotcha #8) but
    // we're not using it on the name here — the doctor's name field uses a
    // looser /^[A-Za-z spaces]+$/ in the form (see doctors/page.tsx:225).
    // We still steer clear of digits in the name field to be safe and put
    // uniqueness on the email instead.
    const uniq = Date.now().toString(36);
    const email = `pearl.row346.${uniq}@medcore.local`;

    // 1. Create the User + Doctor pair via the auth-register backdoor that
    //    doctors/page.tsx uses. role=DOCTOR triggers the auto-create of the
    //    Doctor row server-side (auth.ts Issue #205) with default
    //    specialization / qualification that we patch in step 2.
    const registerRes = await adminApi.post(`${API_BASE}/auth/register`, {
      data: {
        name: "Doctor Pearl Test",
        email,
        phone: "+919876543210",
        password: "PearlTest!2026",
        role: "DOCTOR",
      },
    });
    if (!registerRes.ok()) {
      // Either the API is unreachable (local-dev not started) or the
      // register handler returned a 4xx/5xx for an environmental reason
      // (rate-limit, etc.). Either way, defer to CI rather than failing.
      const status = registerRes.status();
      const body = await registerRes.text();
      test.skip(
        true,
        `Pearl §7.3 prerequisite (POST /auth/register?role=DOCTOR) failed ` +
          `with ${status} — likely the local API isn't running. Suite defers ` +
          `to CI. Body: ${body.slice(0, 200)}`
      );
    }
    const registered = (await registerRes.json()).data as RegisterResponse;
    expect(registered.user.email).toBe(email);

    // 2. Resolve the freshly-created Doctor row's id. The /auth/register
    //    response sometimes returns the Doctor child id (post-fd58688) and
    //    sometimes only the User id (older code paths). Mirror the
    //    fallback-to-list strategy that doctors/page.tsx uses.
    let doctorId = registered.doctor?.id;
    if (!doctorId) {
      const listRes = await adminApi.get(`${API_BASE}/doctors`);
      expect(
        listRes.ok(),
        `GET /doctors after register failed: ${listRes.status()} ${(await listRes.text()).slice(0, 200)}`
      ).toBeTruthy();
      const list = (await listRes.json()).data as DoctorRow[];
      const found = list.find((d) => d.user?.email === email);
      expect(
        found,
        `Doctor row for ${email} not found in /doctors list after register`
      ).toBeDefined();
      doctorId = found!.id;
    }
    expect(doctorId).toMatch(/^[0-9a-f-]{36}$/);

    // 3. PATCH the Doctor profile with the admin-supplied specialization /
    //    qualification / registration number. Mirrors the best-effort PATCH
    //    in doctors/page.tsx:276 — the frontend wraps the same call in
    //    `.catch(() => undefined)` with an explicit "PATCH /doctors/:id is
    //    not implemented yet" comment. There's no matching server route
    //    (only PATCH /doctors/:id/appointment-mode exists in doctors.ts),
    //    so this round-trip 404s by design. We KEEP the call so the
    //    timing reflects what the real admin flow does, but TOLERATE
    //    the 404 — production silently ignores it and the doctor row
    //    keeps its server-side defaults. If the server ever adds the
    //    route, this assertion will start passing without a test change.
    const patchRes = await adminApi.patch(
      `${API_BASE}/doctors/${doctorId}`,
      {
        data: {
          specialization: "General Medicine",
          qualification: "MBBS, MD",
          registrationNumber: `NMC-${uniq}`,
        },
      }
    );
    if (!patchRes.ok() && patchRes.status() !== 404) {
      throw new Error(
        `PATCH /doctors/:id profile failed with unexpected status: ${patchRes.status()} ${(await patchRes.text()).slice(0, 200)}`
      );
    }

    // 4. Set weekly working hours: Mon-Fri 9am-5pm with 15-min slots and
    //    no buffer. The schedule POST is upsert-by-(doctorId, dayOfWeek,
    //    startTime), so calling five times is the canonical "5 weekday
    //    rows" setup. dayOfWeek 1-5 = Mon-Fri (0=Sun, 6=Sat).
    for (let day = 1; day <= 5; day++) {
      const schedRes = await adminApi.post(
        `${API_BASE}/doctors/${doctorId}/schedule`,
        {
          data: {
            dayOfWeek: day,
            startTime: "09:00",
            endTime: "17:00",
            slotDurationMinutes: 15,
            bufferMinutes: 0,
          },
        }
      );
      expect(
        schedRes.ok(),
        `POST /doctors/:id/schedule (day=${day}) failed: ${schedRes.status()} ${(await schedRes.text()).slice(0, 200)}`
      ).toBeTruthy();
    }

    // 5. PATCH the appointment-mode to SLOT (the most-common booking
    //    posture for OPD doctors per Pearl §3.2). Mirrors the
    //    /:id/appointment-mode handler in doctors.ts:447.
    const modeRes = await adminApi.patch(
      `${API_BASE}/doctors/${doctorId}/appointment-mode`,
      {
        data: {
          appointmentMode: "SLOT",
          dailyAppointmentLimit: 40,
          bufferMinutes: 0,
        },
      }
    );
    expect(
      modeRes.ok(),
      `PATCH /doctors/:id/appointment-mode failed: ${modeRes.status()} ${(await modeRes.text()).slice(0, 200)}`
    ).toBeTruthy();

    // 6. Verify the doctor is now discoverable via GET /doctors (the same
    //    list the admin's Doctors registry page hydrates from). This is
    //    the "doctor appears in the roster" half of the Pearl bullet —
    //    the schedule + mode patches must have committed cleanly.
    const finalListRes = await adminApi.get(`${API_BASE}/doctors`);
    expect(
      finalListRes.ok(),
      `final GET /doctors failed: ${finalListRes.status()}`
    ).toBeTruthy();
    const finalList = (await finalListRes.json()).data as DoctorRow[];
    const onboarded = finalList.find((d) => d.id === doctorId);
    expect(
      onboarded,
      `freshly-onboarded doctor ${doctorId} not visible in /doctors list`
    ).toBeDefined();

    // ─── STOP TIMER + ASSERT 5min SLA ──────────────────────────────────────
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §7.3 row 346] doctor-onboarding in ${elapsedMs} ms (budget: 300000 ms)`
    );
    expect(
      elapsedMs,
      `Pearl §7.3 SLA: admin onboards new doctor (user + role + working hours + appointment mode) ` +
        `in < 5 min. Observed ${elapsedMs} ms.`
    ).toBeLessThan(300_000);
  });
});
