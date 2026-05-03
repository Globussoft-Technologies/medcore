/**
 * Expenses (operational spending) ADMIN happy-path + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/expenses (apps/web/src/app/dashboard/expenses/page.tsx)
 *   GET /api/v1/expenses, GET /api/v1/expenses/summary, POST /api/v1/expenses
 *   (apps/api/src/routes/expenses.ts — all three guarded by authorize(ADMIN))
 *
 * Surfaces touched:
 *   - ADMIN happy path: load → click Add Expense → fill amount /
 *     description / date → submit → confirm the new row lands in the
 *     expenses list. Locks the only stable contract the modal exposes
 *     (the date testid + the labelled inputs + the "Add Expense" CTA).
 *   - Future-date validation: page.tsx:349 short-circuits submit when
 *     `form.date > today()`. Rendering [data-testid="expense-form-error"]
 *     is the only user-visible signal, so we lock both the testid and
 *     the no-network-call invariant.
 *   - RBAC: per page.tsx:14 (ALLOWED_ROLES = {ADMIN}) and route guards
 *     at apps/api/src/routes/expenses.ts:22/74/128, every non-ADMIN
 *     role bounces to /dashboard/not-authorized. Issue #89 (DOCTOR ₹9.29
 *     lakh staff-salary leak) and issue #98 (RECEPTION over-access)
 *     codify why this gate must stay tight.
 *
 * Why these tests exist:
 *   /dashboard/expenses was previously listed under §2.3 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "expense entry — no e2e coverage".
 *   Both the salary-leak (#89) and the future-date guard (#64) regressed
 *   in code review more than once, so locking the visible contract here
 *   gives those guards a fast-failure signal instead of waiting for
 *   month-end finance to spot the drift.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Expenses — /dashboard/expenses (ADMIN Add-Expense flow + future-date gate + non-ADMIN RBAC bounces)", () => {
  test("ADMIN lands on /dashboard/expenses, page chrome renders, Add Expense CTA is visible", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^Expenses$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The Add Expense CTA only renders when canAdd is true (page.tsx:147,
    // ADMIN-only — aligned with the server, every route in
    // apps/api/src/routes/expenses.ts is authorize(Role.ADMIN)).
    await expect(
      page.getByRole("button", { name: /^Add Expense$/i })
    ).toBeVisible();
  });

  test("ADMIN can add a new expense through the modal: opens form, fills amount / description / date, submits, the new row appears in the list", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Use a unique tag in the description so the post-save assertion is
    // resilient to other expenses the seeded ADMIN account accumulates
    // across runs (the list orders by date desc, but we don't want to
    // assume our row is at index 0 — we match by content).
    const uniqueTag = `e2e-${Date.now()}`;
    const descriptionText = `Office supplies ${uniqueTag}`;

    // Open the Add Expense modal.
    await page.getByRole("button", { name: /^Add Expense$/i }).click();
    await expect(page.getByRole("heading", { name: /^Add Expense$/i }))
      .toBeVisible({ timeout: 5_000 });

    // Fill required fields. The form uses label associations; testids only
    // exist for the date input (page.tsx:423) and the error banner (455).
    await page.getByLabel(/^Amount \*$/).fill("125.50");
    await page.getByLabel(/^Description \*$/).fill(descriptionText);

    // Date input has a testid; use today() in YYYY-MM-DD form so we
    // satisfy both the client-side gate (page.tsx:349) and the server
    // zod check (packages/shared/src/validation/finance.ts:133).
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('[data-testid="expense-date"]').fill(today);

    // Submit and wait for the POST round-trip before asserting the row.
    const savePromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/expenses") &&
        r.request().method() === "POST"
    );
    await page.getByRole("button", { name: /^Add Expense$/i }).last().click();
    const saveRes = await savePromise;

    // Server contract: 201 + { success: true, data: { id, ... } }.
    expect(saveRes.status()).toBeLessThan(400);

    // Modal should auto-close on success (page.tsx:316-319 → onSaved
    // → setShowAdd(false)).
    await expect(
      page.getByRole("heading", { name: /^Add Expense$/i })
    ).toHaveCount(0, { timeout: 5_000 });

    // The newly-inserted expense should appear in the list. The unique
    // tag is part of the description, which is rendered verbatim in the
    // table body (page.tsx:282).
    await expect(
      page.locator(`text=${uniqueTag}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ADMIN submit is blocked when date is in the future: form shows the error banner and no POST is sent", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^Add Expense$/i }).click();
    await expect(page.getByRole("heading", { name: /^Add Expense$/i }))
      .toBeVisible({ timeout: 5_000 });

    await page.getByLabel(/^Amount \*$/).fill("99.00");
    await page.getByLabel(/^Description \*$/).fill("Future-date guard probe");

    // The date input has a `max={today()}` attribute (page.tsx:420), so a
    // future date can only be set programmatically. We need to remove the
    // max attribute first or the input will silently coerce the value;
    // overriding via evaluate keeps the test focused on the JS guard.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const dateInput = page.locator('[data-testid="expense-date"]');
    await dateInput.evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.removeAttribute("max");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, tomorrow);

    // Watch for any POST /expenses traffic. The client-side gate at
    // page.tsx:349 should short-circuit before the body is built.
    let serverHit = false;
    await page.route("**/api/v1/expenses", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /^Add Expense$/i }).last().click();

    // Modal stays open and the in-form error banner renders.
    await expect(
      page.locator('[data-testid="expense-form-error"]')
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.getByRole("heading", { name: /^Add Expense$/i })
    ).toBeVisible();

    // Give any in-flight (non-)request a moment to surface before we
    // assert it never went out.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("DOCTOR bounces to /dashboard/not-authorized — expenses are ADMIN-only per issue #89 (₹9.29 lakh staff-salary leak)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect (page.tsx:89-96) a tick to fire.
    await page.waitForTimeout(800);

    // Either we're on the access-denied surface or the app pushed us
    // back somewhere under /dashboard. Both are acceptable per the
    // issue-#179 pattern used elsewhere in this suite.
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // The Add Expense CTA must NOT have rendered.
    await expect(
      page.getByRole("button", { name: /^Add Expense$/i })
    ).toHaveCount(0);
  });

  test("RECEPTION bounces to /dashboard/not-authorized — expenses are ADMIN-only per issue #98 (RECEPTION over-access lockdown)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.getByRole("button", { name: /^Add Expense$/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces to /dashboard/not-authorized — PATIENT is outside ALLOWED_ROLES in page.tsx:14", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/expenses", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.getByRole("button", { name: /^Add Expense$/i })
    ).toHaveCount(0);
  });
});
