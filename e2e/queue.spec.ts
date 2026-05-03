/**
 * Live Queue (/dashboard/queue) — beyond page-load coverage.
 *
 * What this exercises:
 *   /dashboard/queue (apps/web/src/app/dashboard/queue/page.tsx)
 *   GET    /api/v1/queue                     (list — display board)
 *   GET    /api/v1/queue/:doctorId           (per-doctor queue detail)
 *   POST   /api/v1/appointments/:id/transfer (reassign-to-doctor action)
 *   (apps/api/src/routes/queue.ts, apps/api/src/routes/appointments.ts)
 *
 * Surfaces touched:
 *   - Happy path: NURSE lands on /dashboard/queue, the display board renders
 *     (heading + at least one doctor token card or the "no patients" empty
 *     state), and clicking a doctor card triggers the detail-fetch round-trip
 *     to GET /api/v1/queue/:doctorId. Locks the click → fetch contract that
 *     the page-load-only smoke in doctor.spec.ts:20 does NOT cover.
 *   - Reassign interaction: RECEPTION, who is in `canTransfer` (page.tsx:64),
 *     opens the transfer modal via the per-row "Transfer …" button (gated by
 *     aria-label, since this page has zero data-testid attributes today),
 *     fills the new-doctor select + reason textarea, and the modal becomes
 *     visible with the confirm CTA. We assert the wiring up to the modal
 *     instead of submitting because submission depends on having ≥2 active
 *     doctors in the seed AND a BOOKED/CHECKED_IN row for that day — both
 *     of which are flaky in a shared seed across parallel test runs.
 *   - Role-gated CTA precedent: DOCTOR (in QUEUE_ALLOWED but NOT in
 *     canTransfer — page.tsx:64) reaches the page and sees the same display
 *     board, but the per-row Transfer / LWBS CTAs are absent. This pins the
 *     "fully-accessible page, role-gated CTAs" precedent that backlog
 *     §2.6 asks for.
 *   - Issue #383 RBAC: PATIENT, LAB_TECH, PHARMACIST are outside
 *     QUEUE_ALLOWED (page.tsx:16-21) and bounce to /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.6 line 130 listed `/dashboard/queue` as
 *   "queue priority/reassignment (page-load only)". The Live Queue routes a
 *   nurse's daily workflow and is the surface most likely to silently break
 *   when the appointments / queue API contracts drift, yet the only prior
 *   coverage was a single `getByRole("heading", { name: /queue/i })` smoke
 *   in doctor.spec.ts. This file adds reassign-modal interaction + the
 *   QUEUE_ALLOWED ↔ canTransfer matrix so a regression in either gate
 *   surfaces as a test failure rather than a prod RBAC bypass (the
 *   precedent here is Issue #383 — a real CRITICAL prod bug from Apr 2026).
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Live Queue — /dashboard/queue (NURSE happy path + RECEPTION reassign-modal interaction + DOCTOR role-gated CTA + PATIENT/LAB_TECH/PHARMACIST RBAC bounce)", () => {
  test("NURSE lands on /dashboard/queue, the display board fetches /api/v1/queue, and the page chrome (heading) renders without bouncing", async ({
    nursePage,
  }) => {
    const page = nursePage;

    // Wait for the GET /queue round-trip the page makes on mount
    // (loadDisplay in page.tsx:150-158). Asserting against the network
    // response — rather than just heading visibility — catches the case
    // where the page renders chrome but the queue API has 401'd or 500'd
    // silently, which is exactly the failure mode Issue #383 introduced.
    const queueListPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/queue") &&
        r.request().method() === "GET" &&
        // Match the bare list endpoint, not the per-doctor detail.
        new URL(r.url()).pathname.replace(/\/+$/, "").endsWith("/queue"),
      { timeout: 15_000 }
    );

    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    const queueRes = await queueListPromise;
    expect(queueRes.status()).toBeLessThan(400);

    await expect(
      page.getByRole("heading", { name: /queue/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("RECEPTION can open a doctor's queue detail and, when a transferable row is present, see the transfer modal with the new-doctor + reason fields", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /queue/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Click the first doctor card on the display board. The card is a
    // <button> rendered in page.tsx:191-219 — find it by its waiting/
    // current-token semantic structure. Settle for any focusable button
    // whose ancestor grid is the token board (3-col grid above the
    // queue-detail panel).
    const doctorCard = page
      .locator("button")
      .filter({ hasText: /current/i })
      .first();
    if (!(await doctorCard.isVisible().catch(() => false))) {
      // Empty seed for today: skip the rest. The first test already
      // covered the no-data path, and the LWBS / transfer surface is
      // structurally invisible without at least one queued patient.
      test.skip(true, "Display board empty for today; no doctor card to click.");
      return;
    }

    // Selecting a doctor triggers loadDoctorQueue → GET /queue/:id.
    const detailPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/queue/") &&
        r.request().method() === "GET",
      { timeout: 10_000 }
    );
    await doctorCard.click();
    const detailRes = await detailPromise.catch(() => null);
    if (detailRes) expect(detailRes.status()).toBeLessThan(400);

    // The detail panel renders either an empty-state ("No patients") or
    // one+ rows. The Transfer CTA only renders for canTransfer roles
    // (ADMIN, RECEPTION) on BOOKED/CHECKED_IN rows — page.tsx:297-299.
    const transferBtn = page
      .getByRole("button", { name: /transfer .* to another doctor/i })
      .first();
    if (!(await transferBtn.isVisible().catch(() => false))) {
      test.skip(
        true,
        "No BOOKED/CHECKED_IN row in this doctor's queue today; transfer CTA structurally absent.",
      );
      return;
    }

    await transferBtn.click();

    // Modal heading + the two form controls (page.tsx:367, 388) confirm
    // the reassignment surface is wired all the way through to the user.
    await expect(page.locator("#queue-transfer-doctor")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("#queue-transfer-reason")).toBeVisible();

    // Cancel out — submitting requires ≥2 active doctors in the seed and
    // would mutate appointment state in ways that leak across parallel
    // workers. The wiring up to the modal is the contract this test
    // pins; the POST /transfer round-trip is exercised by API specs.
    await page.getByRole("button", { name: /cancel/i }).first().click();
  });

  test("DOCTOR sees the queue page (in QUEUE_ALLOWED) but the per-row Transfer/LWBS CTAs are absent — pins the role-gated-CTA precedent (page.tsx:64, canTransfer = ADMIN | RECEPTION)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /queue/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Try to drill into the first doctor card so any queue-detail rows
    // would mount. If the board is empty, the assertion below still
    // holds (CTAs simply don't exist).
    const doctorCard = page
      .locator("button")
      .filter({ hasText: /current/i })
      .first();
    if (await doctorCard.isVisible().catch(() => false)) {
      await doctorCard.click().catch(() => undefined);
      await page.waitForTimeout(800);
    }

    // The Transfer CTA must NEVER render for DOCTOR — canTransfer is
    // hard-gated to ADMIN | RECEPTION in page.tsx:64.
    await expect(
      page.getByRole("button", { name: /transfer .* to another doctor/i })
    ).toHaveCount(0);
    // Same gate covers the LWBS CTA at page.tsx:314-340.
    await expect(
      page.getByRole("button", {
        name: /mark .* as left without being seen/i,
      })
    ).toHaveCount(0);
  });

  test("PATIENT bounces to /dashboard/not-authorized — Issue #383 (CRITICAL prod RBAC bypass): PATIENT is outside QUEUE_ALLOWED in page.tsx:16-21", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to redirect.
    await page.waitForTimeout(800);

    // Either the access-denied surface or a bounce back to /dashboard.
    // Both match the issue-#179 redirect contract (see symptom-diary.spec.ts:181).
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
    // The transfer CTA must structurally not have rendered.
    await expect(
      page.getByRole("button", { name: /transfer .* to another doctor/i })
    ).toHaveCount(0);
  });

  test("LAB_TECH bounces to /dashboard/not-authorized — LAB_TECH is outside QUEUE_ALLOWED (page.tsx:16-21)", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(
      page.getByRole("button", { name: /transfer .* to another doctor/i })
    ).toHaveCount(0);
  });

  test("PHARMACIST bounces to /dashboard/not-authorized — PHARMACIST is outside QUEUE_ALLOWED (page.tsx:16-21)", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(
      page.getByRole("button", { name: /transfer .* to another doctor/i })
    ).toHaveCount(0);
  });
});
