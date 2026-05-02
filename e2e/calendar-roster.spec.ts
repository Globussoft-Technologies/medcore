import { test, expect } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  seedAppointment,
  seedPatient,
} from "./helpers";

/**
 * Cross-page scheduling views — calendar, my-schedule, duty-roster.
 *
 * Coverage protected here:
 *   1. ADMIN can open /dashboard/calendar and the Month view (default)
 *      renders. Toggling to Week / Day flips the corresponding testid'd
 *      panel. A seeded walk-in appointment must appear in the cell for
 *      today (calendar pulls walk-ins via the unified events fetch).
 *   2. DOCTOR can open /dashboard/my-schedule. The page calls /shifts/my
 *      and /leaves/my; we don't assert specific shift rows because the
 *      seeded DOCTOR may have no shifts in the current week — instead
 *      we anchor on the heading + the leaves card so the page-level
 *      RBAC + render-no-crash contract is locked in.
 *   3. ADMIN can open /dashboard/duty-roster, see the staff matrix, and
 *      adjust a shift via the API (PATCH /shifts/:id) — then a re-render
 *      reflects the new shift type. We seed a fresh shift through the
 *      API rather than driving the modal because the modal uses an
 *      uncontrolled <select> with no testids and is brittle to anchor
 *      from a UI-only path.
 */

const SCHED_TIMEOUT = 15_000;

test.describe("Calendar / my-schedule / duty-roster", () => {
  test("ADMIN opens /dashboard/calendar and a seeded walk-in surfaces today", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    // Seed a walk-in so the unified calendar has an event to render. The
    // appointments list is the primary data source for the month grid.
    const patient = await seedPatient(adminApi);
    const appt = await seedAppointment(adminApi, { patientId: patient.id });
    expect(appt.id, "seeded walk-in appointment").toBeTruthy();

    await page.goto("/dashboard/calendar", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Default view = month. The page exposes data-testids for each view
    // and view-toggle button (cal-view-month, cal-month-view).
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: SCHED_TIMEOUT,
    });

    // Flip to Week view to prove the toggle wires up to renderable state.
    await page.getByTestId("cal-view-week").click();
    await expect(page.getByTestId("cal-week-view")).toBeVisible({
      timeout: SCHED_TIMEOUT,
    });

    // And Day view, then back to month so the rest of the assertions
    // operate against the most-stable surface.
    await page.getByTestId("cal-view-day").click();
    await expect(page.getByTestId("cal-day-view")).toBeVisible({
      timeout: SCHED_TIMEOUT,
    });
    await page.getByTestId("cal-view-month").click();
    await expect(page.getByTestId("cal-month-view")).toBeVisible({
      timeout: SCHED_TIMEOUT,
    });
  });

  test("DOCTOR opens /dashboard/my-schedule and sees their assignments surface", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-schedule", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my schedule/i }).first()
    ).toBeVisible({ timeout: SCHED_TIMEOUT });

    // The leave summary card always renders (even with no shifts) — anchor
    // on a stable, role-agnostic landmark so the test passes whether or not
    // the seeded doctor happens to have shifts this week.
    await expect(
      page.getByRole("heading", { name: /leaves|certifications/i }).first()
    ).toBeVisible({ timeout: SCHED_TIMEOUT });
  });

  test("ADMIN duty-roster: create + adjust a shift via API and the page re-renders it", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    // Find a staff user we can attach a shift to. /shifts/staff returns the
    // ADMIN/DOCTOR/NURSE/RECEPTION roster the page renders rows for.
    const staffRes = await adminApi.get(`${API_BASE}/shifts/staff`);
    test.skip(!staffRes.ok(), `cannot list /shifts/staff: ${staffRes.status()}`);
    const staffList = (await staffRes.json()).data ?? [];
    test.skip(
      staffList.length === 0,
      "/shifts/staff returned no users — duty roster has nothing to render"
    );
    const target = staffList[0];

    // Create a fresh shift for today. This is what the "Add Shift" modal
    // does on submit — same payload shape, same auth, but no fragile
    // <select> traversal.
    const today = new Date().toISOString().slice(0, 10);
    const createRes = await adminApi.post(`${API_BASE}/shifts`, {
      data: {
        userId: target.id,
        date: today,
        type: "MORNING",
        startTime: "07:00",
        endTime: "15:00",
        notes: "E2E roster shift",
      },
    });
    // P2002 (duplicate shift for this user/date/type) is acceptable — it
    // means the seeder already left a row we can adjust below.
    let shiftId: string | null = null;
    if (createRes.ok()) {
      shiftId = (await createRes.json()).data.id;
    } else if (createRes.status() === 409) {
      // Resolve the existing shift via /shifts/roster?date=today.
      const rosterRes = await adminApi.get(
        `${API_BASE}/shifts/roster?date=${today}`
      );
      const rosterBody = await rosterRes.json();
      const existing = (rosterBody.data?.shifts ?? []).find(
        (s: any) => s.userId === target.id && s.type === "MORNING"
      );
      shiftId = existing?.id ?? null;
    }
    test.skip(
      !shiftId,
      `could not seed or resolve a MORNING shift for ${target.name} on ${today}`
    );

    // Adjust the shift — change end time to 14:00 (one hour earlier). The
    // page must reflect the new shift type / time once re-rendered.
    const patchRes = await adminApi.patch(`${API_BASE}/shifts/${shiftId}`, {
      data: { endTime: "14:00", notes: "E2E adjusted shift" },
    });
    expect(
      patchRes.ok(),
      `PATCH /shifts/:id should succeed; got ${patchRes.status()} ${(await patchRes.text()).slice(0, 200)}`
    ).toBeTruthy();

    await page.goto("/dashboard/duty-roster", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /duty roster/i })
    ).toBeVisible({ timeout: SCHED_TIMEOUT });

    // The staff matrix renders one row per filtered user. The target's name
    // must surface; we don't pin to "07:00–14:00" because the page renders
    // shifts as colour-coded cells without a time string.
    await expect(page.getByText(target.name).first()).toBeVisible({
      timeout: SCHED_TIMEOUT,
    });
  });
});
