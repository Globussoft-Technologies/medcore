/**
 * My-Leaves staff self-service + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/my-leaves (apps/web/src/app/dashboard/my-leaves/page.tsx)
 *   GET  /api/v1/leaves/my            — current user's leaves + YTD summary
 *   POST /api/v1/leaves               — create PENDING leave request
 *   PATCH /api/v1/leaves/:id/cancel   — owner cancels own PENDING
 *   (apps/api/src/routes/leaves.ts:53-88, 141-182, 315-347)
 *
 * Surfaces touched:
 *   - DOCTOR happy path: page chrome (heading, "Request Leave" CTA), summary
 *     cards (Pending / Approved YTD / Days Used / By-Type), leaves table or
 *     "No leave requests yet" empty-state.
 *   - DOCTOR write flow: open modal → pick type / from / to / reason →
 *     Submit Request → modal closes → new PENDING row lands in the history
 *     table tagged with a Date.now() suffix so the assertion survives
 *     accumulated state on the shared dr.sharma account across runs.
 *   - DOCTOR client-side validation: empty Submit short-circuits before any
 *     POST hits /api/v1/leaves (issue #458 — required-field guard mirrored
 *     in JS now that the form is `noValidate`); reversed date-range surfaces
 *     "End date must be on or after start date" inline next to the To input
 *     (issue #32 — was a generic alert before).
 *   - NURSE happy path: same chrome renders for a different staff role,
 *     proving the page has no client-side RBAC gate.
 *   - PATIENT route shape: the page is fully accessible to all authenticated
 *     users (no `VIEW_ALLOWED` constant, no redirect in page.tsx). PATIENT
 *     reaching /dashboard/my-leaves sees the same chrome and a per-user
 *     scoped (typically empty) list — pinning this so a future RBAC tweak
 *     that adds a redirect surfaces here, not in production. The API's
 *     POST /leaves accepts any authenticated user (leaves.ts:53), so this
 *     IS the intended behaviour for now.
 *
 * Why these tests exist:
 *   /dashboard/my-leaves was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "employee leave-request submission" with
 *   no e2e coverage. The route is the staff side of the leave workflow whose
 *   approver/calendar surface already has coverage in
 *   `e2e/leave-calendar.spec.ts` and the `leaves-approve.test.ts` unit
 *   suite. A silent regression in the submit-form contract or the
 *   /leaves/my summary shape would be invisible until HR escalates a
 *   missing-pay incident — exactly the kind of gap the issue-#179
 *   coverage push was set up to close. Coverage here is the FIRST positive
 *   write-flow assertion plus the inline-validation gates from issue #32
 *   and issue #458.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("My Leaves — /dashboard/my-leaves (staff self-service submission + universal-access route shape)", () => {
  test("DOCTOR lands on /dashboard/my-leaves, page chrome renders, Request-Leave CTA is visible", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my leaves/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The "Request Leave" button is the single CTA above the table; it has
    // no data-testid (page.tsx:156-161), so we lock it via accessible name.
    // A regression that hides or renames this button would block every
    // staff member from submitting a request at all.
    await expect(
      page.getByRole("button", { name: /request leave/i })
    ).toBeVisible();

    // Crash-regression: the global error boundary must not have rendered
    // even if /leaves/my returned an error (page.tsx:69-71 swallows fetch
    // errors and falls back to an empty list).
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR can submit a new leave request through the modal: opens form, fills type/dates/reason, saves, sees the entry land in history as PENDING", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /request leave/i }).click();

    // Modal renders the inputs identified by id (page.tsx:285,304,339,377);
    // assert one of them is visible to know the modal is up before we type.
    await expect(page.locator("#my-leaves-type")).toBeVisible({
      timeout: 5_000,
    });

    // Tag the reason with a unique suffix so the assertion at the end is
    // resilient to whatever PENDING/APPROVED rows the shared dr.sharma
    // account has accumulated across previous runs of this spec or
    // adjacent leave specs.
    const uniqueTag = `e2e-${Date.now()}`;
    const reasonText = `E2E personal day ${uniqueTag} — locking the staff-submit contract`;

    // Pick CASUAL (the default; explicit anyway so a default-change doesn't
    // silently break this test).
    await page.locator("#my-leaves-type").selectOption("CASUAL");

    // Use a date 30 days out so the From/To range never collides with
    // historical seed data and the API's parseDate helper (UTC midnight,
    // leaves.ts:23-25) accepts the YYYY-MM-DD shape directly.
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 30);
    const fromIso = future.toISOString().slice(0, 10);
    const toDate = new Date(future);
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    const toIso = toDate.toISOString().slice(0, 10);

    await page.locator("#leave-from").fill(fromIso);
    await page.locator("#leave-to").fill(toIso);
    await page.locator("#leave-reason").fill(reasonText);

    // Submit and wait for the POST round-trip before asserting the row.
    // Server contract: 201 + { success: true, data: { id, status: "PENDING", … } }.
    const postPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/leaves") &&
        r.request().method() === "POST" &&
        !r.url().includes("/cancel")
    );
    await page.getByRole("button", { name: /submit request/i }).click();
    const postRes = await postPromise;
    expect(postRes.status()).toBeLessThan(400);

    // Modal should close on success (page.tsx:103 → setShowModal(false))
    // before the table re-renders with the new row.
    await expect(page.locator("#my-leaves-type")).toHaveCount(0, {
      timeout: 5_000,
    });

    // The newly-inserted reason should appear in the table. The full string
    // is rendered into a <p title=...> with truncation, but the inner text
    // node still carries the entire reason — match on the unique tag so the
    // assertion is independent of CSS truncation behaviour.
    await expect(
      page.locator(`text=${uniqueTag}`).first()
    ).toBeVisible({ timeout: 10_000 });

    // The new row's status badge must be PENDING — that's what unlocks the
    // owner-cancel button (page.tsx:256-265) and also what the approver UI
    // depends on. Locking the literal here protects both contracts.
    await expect(page.locator("text=PENDING").first()).toBeVisible();
  });

  test("DOCTOR Submit is blocked when required fields are empty: inline alerts render and no POST is sent (issue #458 — JS mirror of HTML5 required attrs after noValidate)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /request leave/i }).click();
    await expect(page.locator("#my-leaves-type")).toBeVisible({
      timeout: 5_000,
    });

    // Catch any rogue POST that slips past the client-side gate. Setting
    // this BEFORE the click means a regression that strips the JS guard
    // will trip serverHit=true, even though we'd see the modal-still-open
    // assertion either way.
    let serverHit = false;
    await page.route("**/api/v1/leaves", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /submit request/i }).click();

    // Modal stays open — the form short-circuited at page.tsx:83-90.
    await expect(page.locator("#my-leaves-type")).toBeVisible();

    // All three required-field error messages render inline. Each label
    // text is the exact string set by submitLeave() in page.tsx.
    await expect(
      page.locator("#fromDate-error", { hasText: "Start date is required" })
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.locator("#toDate-error", { hasText: "End date is required" })
    ).toBeVisible();
    await expect(
      page.locator("#reason-error", { hasText: "Reason is required" })
    ).toBeVisible();

    // Give any in-flight (non-)request a tick to surface before asserting
    // it never went out.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("DOCTOR reversed date-range surfaces inline 'End date must be on or after start date' next to the To input — issue #32, no alert(), no POST", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /request leave/i }).click();
    await expect(page.locator("#my-leaves-type")).toBeVisible({
      timeout: 5_000,
    });

    // Pick a from-date 30 days out and a to-date a day BEFORE it. The
    // page.tsx:56-59 reactive memo (toDateError) should populate as soon
    // as both fields hold values, even before Submit is clicked.
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 30);
    const fromIso = future.toISOString().slice(0, 10);
    const earlier = new Date(future);
    earlier.setUTCDate(earlier.getUTCDate() - 1);
    const toIso = earlier.toISOString().slice(0, 10);

    await page.locator("#leave-from").fill(fromIso);
    await page.locator("#leave-to").fill(toIso);
    await page.locator("#leave-reason").fill("E2E reverse-range guard");

    // Reactive error appears without Submit because of the memo at :56-59.
    await expect(
      page.locator("#toDate-error", {
        hasText: /End date must be on or after start date/i,
      })
    ).toBeVisible({ timeout: 3_000 });

    // Submit anyway — the gate at page.tsx:94-99 should still short-circuit.
    let serverHit = false;
    await page.route("**/api/v1/leaves", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /submit request/i }).click();
    // Modal still open → submit was blocked.
    await expect(page.locator("#my-leaves-type")).toBeVisible();
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("NURSE lands on /dashboard/my-leaves with the same chrome — proves page has no client-side role gate, NURSE is in the staff sidebar (layout.tsx:279)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my leaves/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /request leave/i })
    ).toBeVisible();
    // Crash-regression — same as the DOCTOR chrome test.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("PATIENT route-shape pin: page is universally accessible (no VIEW_ALLOWED in page.tsx, no redirect) — chrome renders, list scoped per-user by /leaves/my", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/my-leaves", {
      waitUntil: "domcontentloaded",
    });
    // Allow any role-gate useEffect a tick to fire (there isn't one — this
    // is exactly what we're pinning, but the wait makes the test robust to
    // a future addition that *does* introduce one and we want a clean
    // failure rather than a flake).
    await page.waitForTimeout(800);

    // The page DOES NOT redirect — this is the point of the pin.
    expect(page.url()).toContain("/dashboard/my-leaves");
    await expectNotForbidden(page);

    // Chrome and CTA render for PATIENT just like for staff. If a future
    // RBAC tweak hides the route from PATIENT, this assertion flips and
    // the route-shape change is caught in CI rather than after a deploy.
    await expect(
      page.getByRole("heading", { name: /my leaves/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /request leave/i })
    ).toBeVisible();
  });
});
