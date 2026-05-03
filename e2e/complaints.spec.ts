/**
 * Complaint workflow e2e coverage.
 *
 * What this exercises:
 *   /dashboard/complaints (apps/web/src/app/dashboard/complaints/page.tsx)
 *   POST /api/v1/complaints, GET /api/v1/complaints, GET /api/v1/complaints/stats
 *   (apps/api/src/routes/feedback.ts:253-373 — complaintsRouter)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page heading + stats tiles
 *     (`complaints-total-open`, `complaints-critical-open`) render and
 *     the New-Complaint CTA is reachable. Locks the testid contract used
 *     by the SLA banner + KPI tiles.
 *   - New-complaint modal: clicking the CTA opens the form (caller
 *     name / phone / category / priority / description fields), and
 *     submitting with an empty description triggers the client-side
 *     validation toast — page.tsx:163-166 short-circuits before any
 *     POST goes out.
 *   - Tab switch: clicking "Resolved" re-fires the GET with
 *     ?status=RESOLVED and the table re-renders without crashing.
 *   - RECEPTION happy path: the same page is reachable with the
 *     RECEPTION role (page is in the RECEPTION nav at
 *     dashboard/layout.tsx:277).
 *   - Server-side RBAC: the LIST endpoint
 *     (`authorize(ADMIN, RECEPTION, DOCTOR, NURSE)` at feedback.ts:330)
 *     returns 403 for PATIENT and LAB_TECH. The page itself has no
 *     client-side gate, so the server check is the only one that
 *     prevents non-staff from reading other people's complaints.
 *
 * Why these tests exist:
 *   /dashboard/complaints was listed under §2.5 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "complaint workflow" with no e2e
 *   coverage. The page is reception's primary triage surface for
 *   walk-in / phone complaints and a regression in the modal-validation
 *   gate (description required) would let blank tickets land in the
 *   queue. The RBAC checks pin the server-side authorize() so a future
 *   refactor of feedback.ts can't silently expose the list to PATIENT.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, API_BASE } from "./helpers";

test.describe("Complaints workflow — /dashboard/complaints (ADMIN/RECEPTION triage UI + validation + server RBAC on list)", () => {
  test("ADMIN lands on /dashboard/complaints, the page heading + stats tiles + New-Complaint CTA all render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/complaints", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Page heading is the literal "Complaints" in page.tsx:276.
    await expect(
      page.getByRole("heading", { name: /^complaints$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Stats tiles — locked via testid because the source-of-truth for
    // these counts is the issue-#92 stats payload (totalOpen ⊆ criticalOpen
    // invariant). A regression in the rendering would silently hide the
    // KPIs from the receptionist desk.
    await expect(
      page.locator('[data-testid="complaints-total-open"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="complaints-critical-open"]')
    ).toBeVisible();

    // The CTA has no testid; use the accessible button name (page.tsx:281).
    await expect(
      page.getByRole("button", { name: /new complaint/i })
    ).toBeVisible();
  });

  test("ADMIN opens the New-Complaint modal — caller / category / priority / description fields all render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/complaints", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /new complaint/i }).click();

    // Modal heading (page.tsx:637).
    await expect(
      page.getByRole("heading", { name: /new complaint/i })
    ).toBeVisible({ timeout: 5_000 });

    // The form has no testids on inputs; assert via accessible labels —
    // these are the four fields the receptionist desk fills in.
    await expect(page.getByText(/caller name/i)).toBeVisible();
    await expect(page.getByText(/^phone$/i)).toBeVisible();
    await expect(page.getByText(/^category$/i).first()).toBeVisible();
    await expect(page.getByText(/^priority$/i).first()).toBeVisible();
    await expect(page.getByText(/^description$/i).first()).toBeVisible();

    // Submit + Cancel buttons in the modal footer (page.tsx:728-738).
    await expect(
      page.getByRole("button", { name: /^submit$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^cancel$/i })
    ).toBeVisible();
  });

  test("ADMIN submitting an empty description short-circuits client-side — toast fires, modal stays open, no POST sent", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/complaints", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /new complaint/i }).click();
    await expect(
      page.getByRole("heading", { name: /new complaint/i })
    ).toBeVisible({ timeout: 5_000 });

    // Spy on the network: the validation gate at page.tsx:163-166 must
    // fire BEFORE the api.post — if a future refactor accidentally
    // removes the gate the POST will land here and we want to know.
    let postHit = false;
    await page.route("**/api/v1/complaints", (route) => {
      if (route.request().method() === "POST") postHit = true;
      route.continue();
    });

    // Click Submit with everything blank.
    await page.getByRole("button", { name: /^submit$/i }).click();

    // Toast text from page.tsx:164 ("Description required"). The toast
    // store renders the literal string into the DOM (lib/toast.ts:23-26).
    await expect(
      page.locator("text=Description required").first()
    ).toBeVisible({ timeout: 3_000 });

    // Modal should still be open — submit() returned early.
    await expect(
      page.getByRole("heading", { name: /new complaint/i })
    ).toBeVisible();

    // Belt-and-braces: give any in-flight (non-)request a moment to
    // surface before we assert it never went out.
    await page.waitForTimeout(500);
    expect(postHit).toBe(false);
  });

  test("ADMIN can switch tabs — clicking Resolved re-fires GET /complaints?status=RESOLVED and the table renders without crashing", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/complaints", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Wait for the initial OPEN load to settle so the tab switch isn't
    // racing the first GET.
    await expect(
      page.locator('[data-testid="complaints-total-open"]')
    ).toBeVisible({ timeout: 15_000 });

    // Watch for the next list GET — TABS for Resolved sends ?status=RESOLVED
    // (page.tsx:131-133). A tab-switch regression typically shows up as
    // either a stale fetch (no second request) or a 4xx; both are caught
    // by waitForResponse + status assertion.
    const listResp = page.waitForResponse(
      (r) =>
        r.url().includes("/complaints") &&
        r.url().includes("status=RESOLVED") &&
        r.request().method() === "GET",
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: /^resolved$/i }).click();
    const res = await listResp;
    expect(res.status()).toBeLessThan(400);

    // Either the table renders rows or the empty-state copy fires;
    // both are valid post-switch states. The Application-error guard
    // catches the regression mode where tab switching crashes the page.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("RECEPTION lands on /dashboard/complaints — page chrome renders for the receptionist desk too", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/complaints", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Same heading + KPI tile contract as ADMIN. The receptionist nav
    // entry (layout.tsx:277) drops them here, so a regression that 403s
    // RECEPTION on GET /complaints would render an empty page.
    await expect(
      page.getByRole("heading", { name: /^complaints$/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="complaints-total-open"]')
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /new complaint/i })
    ).toBeVisible();
  });

  test("Server-side RBAC: PATIENT and LAB_TECH both get 403 from GET /complaints — the page has no client gate, so the server is the only line of defence", async ({
    request,
    patientToken,
    labTechToken,
  }) => {
    // GET /api/v1/complaints requires ADMIN/RECEPTION/DOCTOR/NURSE
    // (feedback.ts:330). PATIENT can FILE a complaint (POST has no
    // authorize) but must never be able to LIST other people's tickets.
    const patientRes = await request.get(`${API_BASE}/complaints`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    expect(patientRes.status()).toBe(403);

    const labTechRes = await request.get(`${API_BASE}/complaints`, {
      headers: { Authorization: `Bearer ${labTechToken}` },
    });
    expect(labTechRes.status()).toBe(403);
  });
});
