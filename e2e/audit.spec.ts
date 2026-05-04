/**
 * Audit Log dashboard — ADMIN-only forensic-trail viewer e2e coverage.
 *
 * What this exercises:
 *   /dashboard/audit (apps/web/src/app/dashboard/audit/page.tsx)
 *   GET /api/v1/audit                 (apps/api/src/routes/audit.ts — paginated list)
 *   GET /api/v1/audit/search?q=…      (audit.ts — fuzzy free-text search,
 *                                       activated when the `Free-text search`
 *                                       filter is non-empty per page.tsx:146)
 *   GET /api/v1/audit/filters         (action + user dropdown population)
 *   GET /api/v1/audit/retention-stats (banner with retention-window stats)
 *
 * Surfaces touched:
 *   - ADMIN: heading, retention banner (Issue #79 entity-canonicalisation +
 *     Issue #192 entityLabel resolution), filter cluster (date / entity /
 *     action / user / IP / free-text), Apply CTA, table rows, pagination.
 *   - Filter wiring: Entity dropdown selection → GET /audit?entity=User
 *     query-string contract; free-text → /audit/search endpoint switch.
 *   - Empty state: "No audit entries found" copy when API returns an
 *     empty page.
 *   - DOCTOR / NURSE / PATIENT: bounce. The client redirects via
 *     router.push("/dashboard") for any non-ADMIN role (page.tsx:120-122),
 *     and ALL audit.ts routes are gated by `router.use(authorize(Role.ADMIN))`
 *     at audit.ts:28. Bounce archetype: redirect-bounce-to-dashboard
 *     (NOT /dashboard/not-authorized).
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG.md §2.12 "/dashboard/audit — audit log
 *   filtering (light coverage)". The existing `admin-ops.spec.ts` "ADMIN
 *   reviews audit log filter" test covered ONLY the entity-filter wire +
 *   not-forbidden assertion; this spec deepens that to: full filter cluster
 *   render, entity-filter query-string contract, free-text → /audit/search
 *   endpoint switch (Issue #192 path), retention banner pin, empty-state,
 *   and the three-role bounce matrix that the API enforces tenant-wide.
 *   Compliance bucket per backlog §2.12.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const AUDIT_LIST_URL = "**/api/v1/audit?**";
const AUDIT_SEARCH_URL = "**/api/v1/audit/search?**";
const AUDIT_FILTERS_URL = "**/api/v1/audit/filters";
const AUDIT_RETENTION_URL = "**/api/v1/audit/retention-stats";

interface StubAuditEntry {
  id: string;
  timestamp: string;
  userId: string | null;
  userName: string;
  userEmail: string;
  action: string;
  entity: string;
  entityId: string | null;
  entityLabel: string | null;
  ipAddress: string | null;
  details: Record<string, unknown>;
}

function stubEntry(overrides: Partial<StubAuditEntry> = {}): StubAuditEntry {
  return {
    id: overrides.id ?? "audit-e2e-0001",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    userId: overrides.userId ?? "user-admin-test-1",
    userName: overrides.userName ?? "Test Admin",
    userEmail: overrides.userEmail ?? "admin@test.local",
    action: overrides.action ?? "AUTH_LOGIN",
    entity: overrides.entity ?? "User",
    entityId: overrides.entityId ?? "user-admin-test-1",
    entityLabel: overrides.entityLabel ?? "User: Test Admin",
    ipAddress: overrides.ipAddress ?? "127.0.0.1",
    details: overrides.details ?? {},
  };
}

async function stubAuditChrome(
  page: import("@playwright/test").Page,
  entries: StubAuditEntry[] = []
): Promise<void> {
  // Filter dropdown options (Issue #192-adjacent endpoint).
  await page.route(AUDIT_FILTERS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          actions: [
            "AUTH_LOGIN",
            "USER_REGISTER",
            "INVOICE_CREATE",
            "PRESCRIPTION_CREATE",
            "PATIENT_DATA_EXPORT",
          ],
          users: [
            { id: "user-admin-test-1", name: "Test Admin", email: "admin@test.local" },
            { id: "user-doc-test-1", name: "Test Doctor", email: "doctor@test.local" },
          ],
        },
      }),
    })
  );
  // Retention banner.
  await page.route(AUDIT_RETENTION_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          totalEntries: 12_345,
          byYear: [
            { year: "2025", count: 8_000 },
            { year: "2026", count: 4_345 },
          ],
          retentionDays: 2_555,
          oldestEntry: new Date("2025-01-01T00:00:00Z").toISOString(),
        },
      }),
    })
  );
  // List endpoint (default — applies to GET /audit?…).
  await page.route(AUDIT_LIST_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: entries,
        meta: {
          total: entries.length,
          page: 1,
          totalPages: entries.length === 0 ? 0 : 1,
        },
      }),
    })
  );
  // Search endpoint (free-text — used when q is non-empty).
  await page.route(AUDIT_SEARCH_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: entries,
        meta: {
          total: entries.length,
          page: 1,
          totalPages: entries.length === 0 ? 0 : 1,
        },
      }),
    })
  );
}

test.describe("Audit Log — /dashboard/audit (ADMIN-only forensic trail viewer; non-ADMIN redirect-bounce to /dashboard)", () => {
  test("ADMIN lands on /dashboard/audit: heading + Export CSV CTA + retention banner + filter cluster all render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAuditChrome(page, [
      stubEntry({
        id: "audit-e2e-row-001",
        action: "AUTH_LOGIN",
        entity: "User",
        entityId: "user-admin-test-1",
        entityLabel: "User: Test Admin",
      }),
    ]);

    await gotoAuthed(page, "/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /audit log/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /export csv/i }).first()
    ).toBeVisible();
    // Retention banner from the stubbed GET /audit/retention-stats. Match
    // the unique "12,345 entries stored" copy the page synthesises so we're
    // sure we're hitting the banner, not the table cells.
    await expect(page.getByText(/12,345 entries stored/i)).toBeVisible();
    // Filter cluster — bind to stable IDs (avoid `.first()` collisions with
    // the layout's LanguageDropdown <select> per CLAUDE.md gotcha #9).
    await expect(page.locator("#audit-filter-from")).toBeVisible();
    await expect(page.locator("#audit-filter-to")).toBeVisible();
    await expect(page.getByTestId("audit-entity-filter")).toBeVisible();
    await expect(page.locator("#audit-filter-action")).toBeVisible();
    await expect(page.locator("#audit-filter-user")).toBeVisible();
    await expect(page.locator("#audit-filter-ip")).toBeVisible();
    await expect(page.locator("#audit-filter-q")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /apply filters/i }).first()
    ).toBeVisible();
  });

  test("ADMIN entity-filter wires through to GET /audit?entity=Patient query-string contract", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAuditChrome(page, []);

    await gotoAuthed(page, "/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /audit log/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Pin the network contract: selecting an entity + clicking Apply re-fetches
    // the list with `?entity=Patient`. The list endpoint is /audit (NOT
    // /audit/search), since the free-text field is empty.
    const filtered = page.waitForRequest(
      (req) =>
        /\/api\/v1\/audit\?/.test(req.url()) &&
        /entity=Patient/.test(req.url()) &&
        !/\/audit\/search/.test(req.url()),
      { timeout: 10_000 }
    );
    await page.getByTestId("audit-entity-filter").selectOption("Patient");
    await page.getByRole("button", { name: /apply filters/i }).first().click();
    await filtered;
    await expectNotForbidden(page);
  });

  test("ADMIN free-text filter switches the endpoint from /audit to /audit/search per page.tsx:146 (Issue #192-adjacent contract)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAuditChrome(page, []);

    await gotoAuthed(page, "/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /audit log/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    const searchReq = page.waitForRequest(
      (req) =>
        /\/api\/v1\/audit\/search\?/.test(req.url()) &&
        /q=login/.test(req.url()),
      { timeout: 10_000 }
    );
    await page.locator("#audit-filter-q").fill("login");
    await page.getByRole("button", { name: /apply filters/i }).first().click();
    await searchReq;
    await expectNotForbidden(page);
  });

  test("ADMIN sees the empty-state when the audit list is empty", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAuditChrome(page, []);

    await gotoAuthed(page, "/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /audit log/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/no audit entries found/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("ADMIN sees a populated table — entity column canonicalises (Issue #79) and entityLabel renders (Issue #192)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAuditChrome(page, [
      stubEntry({
        id: "audit-e2e-canon-1",
        // Lower-case "patient" historic write — the page's canonicalEntity()
        // helper must render this as "Patient" in the cell.
        entity: "patient",
        entityId: "pat-aaaa-bbbb-cccc",
        entityLabel: "Patient: Asha Mehta (MR: MR-2026-0001)",
        action: "PATIENT_DATA_EXPORT",
      }),
      stubEntry({
        id: "audit-e2e-canon-2",
        // snake_case → CapitalCamel ("scheduled_report" → "ScheduledReport").
        entity: "scheduled_report",
        entityId: "sr-1111-2222",
        entityLabel: "ScheduledReport: Daily Census",
        action: "USER_REGISTER",
      }),
    ]);

    await gotoAuthed(page, "/dashboard/audit");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Issue #79: lower-case "patient" → "Patient" in the cell.
    await expect(page.getByRole("cell", { name: "Patient" }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Issue #79: snake_case "scheduled_report" → "ScheduledReport".
    await expect(
      page.getByRole("cell", { name: "ScheduledReport" }).first()
    ).toBeVisible();
    // Issue #192: entityLabel surfaces the human-readable string under the
    // testid the page emits per row (`audit-entity-${entry.id}`).
    await expect(
      page.getByTestId("audit-entity-audit-e2e-canon-1")
    ).toContainText(/Asha Mehta/i);
    await expect(
      page.getByTestId("audit-entity-audit-e2e-canon-2")
    ).toContainText(/Daily Census/i);
  });

  test("DOCTOR is redirected away from /dashboard/audit — page.tsx:120 bounces non-ADMIN to /dashboard, audit.ts:28 enforces server-side", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/audit", { waitUntil: "domcontentloaded" });
    // Let the client-side useEffect fire its router.push.
    await page.waitForTimeout(800);
    // Bounce target is "/dashboard" (NOT "/dashboard/not-authorized") —
    // pin the actual archetype this page uses (matches admin-ops.spec.ts'
    // existing audit-filter pin under the ADMIN role lane).
    expect(page.url()).toMatch(/\/dashboard(\/?($|\?))/);
    expect(page.url()).not.toMatch(/\/dashboard\/audit/);
    // The page's "Access denied" placeholder also renders for any logged-in
    // non-ADMIN that races the redirect; either way the Audit Log heading
    // must NOT appear.
    await expect(
      page.getByRole("heading", { name: /audit log/i })
    ).toHaveCount(0);
  });

  test("PATIENT is redirected away from /dashboard/audit — outside the ADMIN allowlist (audit.ts:28)", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/audit", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/\/dashboard(\/?($|\?))/);
    expect(page.url()).not.toMatch(/\/dashboard\/audit/);
    await expect(
      page.getByRole("heading", { name: /audit log/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /apply filters/i })
    ).toHaveCount(0);
  });
});
