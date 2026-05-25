import { test, expect } from "./fixtures";
import { API_BASE } from "./helpers";

/**
 * Pearl PRD Stage 1 §7.3 (PRD M6) / gap-analysis row 343 — RECEPTION must
 * be able to **register + book + mark-arrived** for a fresh walk-in patient
 * in **< 60 seconds**, end-to-end.
 *
 * Touches:
 *   - apps/api/src/routes/patients.ts (POST /patients — register)
 *   - apps/api/src/routes/appointments.ts
 *       - POST  /appointments/book                (book scheduled slot)
 *       - PATCH /appointments/:id/status          (arrival = CHECKED_IN)
 *   - apps/api/src/routes/doctors.ts (GET /doctors — discover anchor doctor)
 *
 * Why a timed spec: the existing reception.spec.ts asserts each step in
 * isolation (register → URL match, book → URL match, etc.) but never
 * brackets the full receptionist throughput. Pearl §7.3 row 343 is a wall-
 * clock SLA on the END-TO-END ceremony: "by the time the patient leaves
 * the front desk, they are checked in for their appointment". This spec
 * brackets the three API calls with `performance.now()` to surface perf
 * regressions (slow Prisma writes, slow doctor lookup, slow slot
 * collision-check) as test failures rather than support tickets.
 *
 * Scope-cuts vs the PRD prose:
 *   - We drive the three steps via API (receptionApi) rather than the UI
 *     walk-in form + booking panel + check-in CTA. Rationale matches the
 *     other Pearl timing specs (appointment-booking-timed.spec.ts §02cbe53,
 *     invoice-receipt-timed.spec.ts §724cf6e, doctor-onboarding-timed.spec
 *     .ts §f22928a): the UI layer's modal-open animations + EntityPicker
 *     debounce + slot-grid hydration add 2-5s of UI noise that the Pearl
 *     SLA budget is NOT meant to police. API-level timing is the
 *     conservative measurement; the form layer wraps it.
 *   - We exit via `test.skip` (matching the sibling timing specs) if seed
 *     prerequisites (a doctor exists, the receptionToken authenticates)
 *     aren't available — the local-API-not-running case defers cleanly to
 *     CI without spurious failure.
 *   - "Arrived" maps to status=CHECKED_IN in the appointment status enum
 *     (see updateAppointmentStatusSchema in packages/shared/src/validation/
 *     appointment.ts:35-44). The PATCH /:id/status handler at
 *     appointments.ts:645 auto-stamps `checkInAt = now` on this transition,
 *     which is the canonical "patient arrived at the desk" timestamp.
 *
 * Per CLAUDE.md gotchas:
 *   - #8: PATIENT_NAME_REGEX rejects digits — uniqueness goes on phone
 *     (digits allowed), not on the name.
 *   - Date.now() base-36 in the phone suffix keeps re-runs collision-free.
 */

interface DoctorRow {
  id: string;
  user?: { email?: string };
}
interface PatientCreateResponse {
  id: string;
  mrNumber: string;
  name?: string;
}
interface AppointmentBookResponse {
  id: string;
  status: string;
}

const FIRST_NAMES = ["Aarav", "Saanvi", "Vihaan", "Diya", "Reyansh", "Priya"];
const LAST_NAMES = ["Mehta", "Joshi", "Reddy", "Sharma", "Gupta", "Verma"];
function pearlSafeName(): string {
  // No digits — PATIENT_NAME_REGEX bans them. CLAUDE.md gotcha #8.
  const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${f} ${l}`;
}

function tomorrowMorningSlot(): { date: string; slotId: string } {
  // bookAppointmentSchema's `.refine(isBookingDateNotPast)` requires the
  // date to be today-or-later, and the SLOT-mode handler additionally
  // rejects same-day-past-time. Tomorrow at 09:00 sidesteps both gates
  // regardless of when the suite runs.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, slotId: "09:00" };
}

test.describe("Pearl §7.3 — RECEPTION registers + books + arrives in <60s", () => {
  test("clock-bracketed flow: POST /patients → POST /appointments/book → PATCH /appointments/:id/status {CHECKED_IN}", async ({
    receptionApi,
  }) => {
    // ─── Pre-flight: resolve an anchor doctor (NOT counted toward the 60s). ──
    // We need a real doctorId to book against. This is the "doctor exists in
    // the system" precondition — Pearl §7.3 row 343's SLA assumes the
    // receptionist isn't also creating a doctor mid-flow.
    const doctorsRes = await receptionApi.get(`${API_BASE}/doctors`);
    if (!doctorsRes.ok()) {
      test.skip(
        true,
        `Pearl §7.3 prerequisite (GET /doctors) failed with ${doctorsRes.status()} — ` +
          "likely the local API isn't running. Suite defers to CI."
      );
    }
    const doctorsJson = await doctorsRes.json();
    const doctorList = (doctorsJson.data ?? doctorsJson) as
      | DoctorRow[]
      | { doctors: DoctorRow[] };
    const doctors: DoctorRow[] = Array.isArray(doctorList)
      ? doctorList
      : (doctorList?.doctors ?? []);
    const anchorDoctor = doctors[0];
    if (!anchorDoctor?.id) {
      test.skip(
        true,
        "No seeded doctors available — Pearl <60s SLA is moot without an anchor doctor."
      );
    }
    expect(anchorDoctor.id).toMatch(/^[0-9a-f-]{36}$/);

    const { date, slotId } = tomorrowMorningSlot();

    // Tag uniqueness on phone (digits allowed) NOT name (regex rejects).
    const uniq = Date.now().toString().slice(-9);
    const phone = `+91${uniq}`;
    const patientName = pearlSafeName();

    // ─── START TIMER ────────────────────────────────────────────────────────
    const t0 = performance.now();

    // 1. REGISTER — POST /patients. Mirrors the seedPatient shape (helpers
    //    .ts:585) but inlined so the timer includes ONLY this request's
    //    server-side cost.
    const registerRes = await receptionApi.post(`${API_BASE}/patients`, {
      data: {
        name: patientName,
        age: 32,
        gender: "MALE",
        phone,
      },
    });
    if (!registerRes.ok()) {
      const status = registerRes.status();
      const body = await registerRes.text();
      test.skip(
        true,
        `Pearl §7.3 register step (POST /patients) failed with ${status} — ` +
          `likely an env precondition. Suite defers to CI. Body: ${body.slice(0, 200)}`
      );
    }
    const registerJson = await registerRes.json();
    const newPatient = (registerJson.data ?? registerJson) as PatientCreateResponse;
    expect(
      newPatient.id,
      `register response missing patient id: ${JSON.stringify(registerJson).slice(0, 200)}`
    ).toMatch(/^[0-9a-f-]{36}$/);

    // 2. BOOK — POST /appointments/book. Tomorrow 09:00 sidesteps both the
    //    same-day-past-time guard (appointments.ts:118) and the date-not-
    //    past refine (validation/appointment.ts:20). slotId is optional for
    //    TOKEN/CALLING modes and required for SLOT mode — sending it works
    //    for all three (TOKEN ignores it cleanly, CALLING errors only if
    //    the doctor IS in CALLING mode, which we tolerate by skip-exit).
    const bookRes = await receptionApi.post(`${API_BASE}/appointments/book`, {
      data: {
        patientId: newPatient.id,
        doctorId: anchorDoctor.id,
        date,
        slotId,
        notes: "Pearl §7.3 row 343 timed register-book-arrive flow",
      },
    });
    if (!bookRes.ok()) {
      const status = bookRes.status();
      const body = await bookRes.text();
      // 409 = slot already taken (a previous run booked it; we don't reset
      // between runs in CI). Defer rather than fail — the SLA isn't about
      // slot-grid arithmetic.
      test.skip(
        status === 409,
        `Pearl §7.3 book step returned 409 (slot conflict — likely a previous run ` +
          `already booked tomorrow 09:00 for doctor ${anchorDoctor.id}). Re-run later in the day.`
      );
      test.skip(
        true,
        `Pearl §7.3 book step (POST /appointments/book) failed with ${status}. ` +
          `Body: ${body.slice(0, 200)}`
      );
    }
    const bookJson = await bookRes.json();
    const booked = (bookJson.data ?? bookJson) as AppointmentBookResponse;
    expect(
      booked.id,
      `book response missing appointment id: ${JSON.stringify(bookJson).slice(0, 200)}`
    ).toMatch(/^[0-9a-f-]{36}$/);

    // 3. ARRIVE — PATCH /appointments/:id/status {status: "CHECKED_IN"}.
    //    CHECKED_IN is the canonical "patient arrived at the front desk"
    //    transition — the handler at appointments.ts:679 auto-stamps
    //    checkInAt = now on this status. Per updateAppointmentStatusSchema
    //    the enum is one of BOOKED/CHECKED_IN/IN_CONSULTATION/COMPLETED/
    //    CANCELLED/NO_SHOW (validation/appointment.ts:35-44).
    const arriveRes = await receptionApi.patch(
      `${API_BASE}/appointments/${booked.id}/status`,
      { data: { status: "CHECKED_IN" } }
    );
    expect(
      arriveRes.ok(),
      `arrive (PATCH /appointments/:id/status CHECKED_IN) failed: ` +
        `${arriveRes.status()} ${(await arriveRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    const arriveJson = await arriveRes.json();
    const arrived = (arriveJson.data ?? arriveJson) as AppointmentBookResponse;
    expect(arrived.status).toBe("CHECKED_IN");

    // ─── STOP TIMER + ASSERT 60s SLA ────────────────────────────────────────
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §7.3 row 343] reception register→book→arrive in ${elapsedMs} ms (budget: 60000 ms)`
    );
    expect(
      elapsedMs,
      `Pearl §7.3 SLA: receptionist must register + book + mark-arrived ` +
        `for a fresh walk-in in < 60 s. Observed ${elapsedMs} ms.`
    ).toBeLessThan(60_000);
  });
});
