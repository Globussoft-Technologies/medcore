import { test, expect } from "./fixtures";
import { API_BASE, dismissTourIfPresent, expectNotForbidden } from "./helpers";

/**
 * Daily ADMIN operational levers — leave / duty-roster / audit / tenants /
 * scheduled-reports. Each test exercises the in-page surface most likely to
 * regress (an actionable button, a filter, a form) and uses adminApi for
 * deterministic seeding where in-page seeding would be brittle.
 *
 * Runs under --project=full (testMatch **\/*.spec.ts). The five cases below
 * intentionally avoid destructive ops on shared tenant config so re-running
 * the spec against the same DB stays idempotent.
 */
test.describe("Admin operations — daily levers", () => {
  test("ADMIN approves a leave request on /dashboard/leave-management", async ({
    browserName,
    adminPage,
    adminApi,
  }) => {
    // webkit auth-redirect residue (TODO.md #4).
    test.skip(browserName === "webkit", "webkit auth-redirect residue");
    const page = adminPage;

    // Seed a PENDING leave directly via the API. The /leaves POST handler
    // pulls userId from req.user, so this creates a leave belonging to the
    // current ADMIN — which is fine: the approve endpoint doesn't disallow
    // self-approval, and the row will show up in the PENDING tab.
    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const fromDate = fmt(today);
    const toDate = fmt(new Date(today.getTime() + 24 * 60 * 60 * 1000));
    const seedRes = await adminApi.post(`${API_BASE}/leaves`, {
      data: {
        type: "CASUAL",
        fromDate,
        toDate,
        reason: `e2e-admin-ops ${Date.now()}`,
      },
    });
    expect(seedRes.ok()).toBeTruthy();
    const seedJson = await seedRes.json();
    const leaveId: string = seedJson.data.id;

    await page.goto("/dashboard/leave-management");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /leave management/i })
    ).toBeVisible({ timeout: 15_000 });

    // The default tab is PENDING — find the row's Approve button and click.
    const approveBtn = page
      .getByRole("button", { name: /^approve$/i })
      .first();
    await expect(approveBtn).toBeVisible({ timeout: 10_000 });
    await approveBtn.click();

    // useConfirm() opens a dialog with a stable test id.
    await page.locator('[data-testid="confirm-dialog-confirm"]').click();

    // Verify via API the leave actually flipped (deterministic; avoids
    // relying on the table re-render which depends on tab + filter state).
    await expect
      .poll(
        async () => {
          const r = await adminApi.get(`${API_BASE}/leaves?status=APPROVED`);
          if (!r.ok()) return false;
          const j = await r.json();
          return (j.data as Array<{ id: string; status: string }>).some(
            (l) => l.id === leaveId && l.status === "APPROVED"
          );
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);
  });

  test("ADMIN publishes a duty-roster slot on /dashboard/duty-roster", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/duty-roster");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /duty roster/i })
    ).toBeVisible({ timeout: 15_000 });

    // The "Add Shift" modal needs us to pick a staff member from the in-page
    // dropdown which is populated by /shifts/staff. Resolving a userId via
    // adminApi is more deterministic than fishing the first <option> text out
    // of the DOM (the list may be empty until React finishes loading).
    const staffRes = await adminApi.get(`${API_BASE}/shifts/staff`);
    expect(staffRes.ok()).toBeTruthy();
    const staffJson = await staffRes.json();
    const staff: Array<{ id: string; role: string }> = staffJson.data ?? [];
    // Prefer DOCTOR/NURSE — ADMIN-typed staff sometimes appear too.
    const target =
      staff.find((s) => s.role === "DOCTOR" || s.role === "NURSE") ?? staff[0];
    expect(target, "no staff available to schedule").toBeTruthy();

    // The page's "Add Shift" form is straightforward, but the Bulk modal is
    // complex. Go through the simple form. Use a date well in the future so
    // we don't collide with anything realistic-seeded.
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Set the page's date filter so the new shift becomes visible after creation.
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill(date);

    await page.getByRole("button", { name: /add shift/i }).first().click();

    // The "Add Shift" form is the only <form> rendered with that heading.
    // Scope all interactions to it so we don't accidentally target the
    // page-level filters above the table.
    const modal = page
      .locator("form")
      .filter({ has: page.getByRole("heading", { name: /^add shift$/i }) })
      .first();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator("select").first().selectOption(target!.id);
    await modal.locator('input[type="date"]').first().fill(date);

    // Submit ("Create" button) inside the modal form.
    await modal.getByRole("button", { name: /^create$/i }).click();

    // The modal should close and the new shift appear in the MORNING column
    // (default 07:00–15:00). Assert via the API to avoid timezone slicing of
    // the table rows.
    await expect
      .poll(
        async () => {
          const r = await adminApi.get(
            `${API_BASE}/shifts/roster?date=${date}`
          );
          if (!r.ok()) return false;
          const j = await r.json();
          const shifts: Array<{ userId: string; date: string }> =
            j.data?.shifts ?? [];
          return shifts.some((s) => s.userId === target!.id);
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);
  });

  test("ADMIN reviews audit log filter on /dashboard/audit", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /audit log/i })
    ).toBeVisible({ timeout: 15_000 });

    // Apply an Entity filter (the dropdown is populated from a static list,
    // so it always has User/Patient/etc. regardless of seed state).
    const entitySelect = page.locator("select").nth(2); // From → To → Entity
    await entitySelect.selectOption("User");

    // Capture the network call so we can assert the filter actually went
    // through to the server, not just changed local state.
    const filterReq = page.waitForRequest(
      (req) =>
        /\/api\/v1\/audit(\?|\/search\?)/.test(req.url()) &&
        /entity=User/i.test(req.url()),
      { timeout: 10_000 }
    );
    await page.getByRole("button", { name: /apply filters/i }).click();
    await filterReq;

    // Re-rendered table either shows rows whose Entity column reads "User"
    // or the empty-state. Either is valid; what matters is the request fired
    // and the page didn't 403/crash.
    await expectNotForbidden(page);
    await expect(
      page.getByText(/application error|something went wrong/i)
    ).toHaveCount(0);
  });

  test("ADMIN configures tenant on /dashboard/tenants", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/tenants", { waitUntil: "domcontentloaded" });
    // The tenants page enforces super-admin-on-default-tenant in the API.
    // For non-default-tenant ADMINs the GET /tenants returns 403 and the page
    // shows a toast + empty list. We still expect /dashboard/tenants to load
    // (no redirect to not-authorized) for any ADMIN.
    await expectNotForbidden(page);

    // The page mounts even when the API returns 403, because the role gate
    // on the client only checks user.role === "ADMIN". If we're redirected
    // back to /dashboard (the page itself routes non-ADMINs there) we
    // can't proceed — but adminPage fixture is ADMIN, so this is just a
    // safety check.
    if (!/\/dashboard\/tenants/.test(page.url())) {
      test.skip(true, "ADMIN was bounced off /dashboard/tenants");
      return;
    }

    // The page-level data-testid hooks are stable; the search input is a
    // multi-tenant config "field that is editable" without persisting any
    // destructive state. (We don't open the Create modal — that would
    // attempt to provision a real tenant.)
    const search = page.locator('[data-testid="tenants-search"]');
    await expect(search).toBeVisible({ timeout: 10_000 });
    await search.fill("e2e-probe");
    await expect(search).toHaveValue("e2e-probe");

    // The Create button is rendered for every ADMIN (the API gate fires only
    // on submit). Asserting it's actionable proves the editable surface
    // exists without us actually saving anything.
    const createBtn = page.locator('[data-testid="tenants-create-open"]');
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toBeEnabled();
  });

  test("ADMIN schedules a report on /dashboard/scheduled-reports", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/scheduled-reports");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /scheduled reports/i })
    ).toBeVisible({ timeout: 15_000 });

    const uniqueName = `E2E daily census ${Date.now()}`;

    // Open the create form.
    await page.getByRole("button", { name: /new report/i }).click();

    // The form is the only visible <form>; fields are simple labelled inputs.
    // DAILY @ 09:00 IST ≡ cron `0 9 * * *` per the route's computeNextRun.
    await page.locator('input[placeholder*="Weekly Revenue Email" i]').fill(uniqueName);
    // Report type defaults to DAILY_CENSUS — leave it.
    // Frequency defaults to DAILY — leave it.
    await page.locator('input[type="time"]').first().fill("09:00");
    await page
      .locator('textarea[placeholder*="admin@example.com" i]')
      .fill("ops@e2e.medcore.local");

    await page.getByRole("button", { name: /^create schedule$/i }).click();

    // Confirm via API (deterministic). The list endpoint returns most-recent
    // first so the newly-created row should be near the top.
    await expect
      .poll(
        async () => {
          const r = await adminApi.get(`${API_BASE}/scheduled-reports`);
          if (!r.ok()) return false;
          const j = await r.json();
          return (j.data as Array<{ name: string }>).some(
            (s) => s.name === uniqueName
          );
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    // And the in-page list shows the new schedule.
    await expect(page.getByText(uniqueName).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
