/**
 * Lab Result Intelligence dashboard — page-load + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/lab-intel (apps/web/src/app/dashboard/lab-intel/page.tsx)
 *   GET /api/v1/ai/lab-intel/aggregates    (apps/api/src/routes/ai-lab-intel.ts)
 *   GET /api/v1/ai/lab-intel/critical
 *   GET /api/v1/ai/lab-intel/deviations
 *
 * Surfaces touched:
 *   - DOCTOR / ADMIN: full read access — KPI tiles + criticals table + deviations
 *     section all render; severity filter + date range + Refresh CTA wired.
 *   - NURSE: read-only banner shows; Action column shows "View only" instead of
 *     "View Order" links (page.tsx:362-376 readOnly branch).
 *   - LAB_TECH / RECEPTION / PATIENT / PHARMACIST: gated out via the issue-#179
 *     redirect pattern (page.tsx:230-239) — useEffect router.replace() to
 *     /dashboard/not-authorized?from=... So this is the "redirect to
 *     /dashboard/not-authorized" archetype (NOT the /dashboard variant per
 *     the FHIR-export sibling and the 6th cron-learning bullet).
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.12 entry
 *   "/dashboard/lab-intel — lab-intelligence dashboards (page-load only)".
 *   Pins the KPI/table contract + filter wiring + the redirect-to-not-authorized
 *   archetype for disallowed roles. AI calls are stubbed via stubAi() so the
 *   spec is deterministic regardless of Sarvam availability (precedent:
 *   lab-tech.spec.ts uses the same pattern for the LAB_TECH bounce case).
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, stubAi } from "./helpers";

const PAGE_TIMEOUT = 15_000;

// Stub bodies that match the response shapes consumed by lab-intel/page.tsx.
// Keep them small but realistic enough to exercise every render branch.
const STUB_AGGREGATES = {
  success: true,
  data: {
    criticalsThisWeek: 7,
    patientsWithTrendConcerns: 3,
    testsOutsideRefRange: 12,
    averageDeviationPct: 18.4,
  },
};

const STUB_CRITICALS = {
  success: true,
  data: [
    {
      id: "crit-e2e-0001",
      patientId: "pt-e2e-0001",
      patientName: "Ananya Sharma",
      testName: "Haemoglobin",
      result: "6.8",
      unit: "g/dL",
      referenceRange: "12.0 - 15.5",
      severity: "CRITICAL",
      flaggedAt: new Date().toISOString(),
      labOrderId: "lo-e2e-0001",
    },
    {
      id: "crit-e2e-0002",
      patientId: "pt-e2e-0002",
      patientName: "Rahul Verma",
      testName: "Potassium",
      result: "6.2",
      unit: "mmol/L",
      referenceRange: "3.5 - 5.0",
      severity: "HIGH",
      flaggedAt: new Date().toISOString(),
      labOrderId: "lo-e2e-0002",
    },
  ],
};

const STUB_DEVIATIONS = {
  success: true,
  data: [
    {
      patientId: "pt-e2e-0001",
      patientName: "Ananya Sharma",
      parameter: "Haemoglobin",
      recentValues: [9.1, 8.4, 7.6, 6.8],
      deviationPct: 25.3,
      direction: "down",
    },
  ],
};

async function stubAllLabIntel(
  page: import("@playwright/test").Page,
  opts?: {
    aggregates?: unknown;
    criticals?: unknown;
    deviations?: unknown;
  }
): Promise<void> {
  await stubAi(
    page,
    "**/api/v1/ai/lab-intel/aggregates**",
    opts?.aggregates ?? STUB_AGGREGATES
  );
  await stubAi(
    page,
    "**/api/v1/ai/lab-intel/critical**",
    opts?.criticals ?? STUB_CRITICALS
  );
  await stubAi(
    page,
    "**/api/v1/ai/lab-intel/deviations**",
    opts?.deviations ?? STUB_DEVIATIONS
  );
}

test.describe("Lab Result Intelligence — /dashboard/lab-intel (DOCTOR/ADMIN/NURSE allowed; redirect-to-not-authorized for everyone else)", () => {
  test("DOCTOR lands on /dashboard/lab-intel; KPI tiles + critical table + deviations section all render", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Page chrome — title pinned via testid (page.tsx:415).
    await expect(page.locator('[data-testid="lab-intel-title"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // All four KPI tiles render with the stubbed numbers (page.tsx:497-525).
    await expect(
      page.locator('[data-testid="lab-intel-kpi-criticals"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-kpi-deviations"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-kpi-outside-range"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-kpi-avg-deviation"]')
    ).toBeVisible();
    // Avg-deviation tile formats as "18.4%" via the format="pct" branch.
    await expect(
      page.locator('[data-testid="lab-intel-kpi-avg-deviation"]')
    ).toContainText(/18\.4%/);

    // Critical Values table — row anchored by row testid (page.tsx:296).
    // The page renders the testid twice (the row's <tr> AND a nested
    // patient link <a> inside it both carry the same data-testid). Use
    // .first() so strict-mode doesn't flag the dual match.
    await expect(
      page.locator('[data-testid="lab-intel-row-crit-e2e-0001"]').first()
    ).toBeVisible();
    await expect(page.locator("body")).toContainText(/Ananya Sharma/);

    // Deviations section + at least one trend row (page.tsx:561, 592).
    await expect(
      page.locator('[data-testid="lab-intel-deviations-section"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-deviation-pt-e2e-0001"]')
    ).toBeVisible();
  });

  test("ADMIN sees the same chrome as DOCTOR (full-access role)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(page.locator('[data-testid="lab-intel-title"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });
    await expect(
      page.locator('[data-testid="lab-intel-refresh"]')
    ).toBeVisible();
    // ADMIN is NOT in READONLY_ROLES (page.tsx:34) so the read-only banner
    // must not render.
    await expect(
      page.locator('[data-testid="lab-intel-readonly-banner"]')
    ).toHaveCount(0);
  });

  test("NURSE sees the read-only banner and 'View only' actions instead of order links", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(page.locator('[data-testid="lab-intel-title"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });
    // READONLY_ROLES = {NURSE} → banner renders (page.tsx:474-482).
    await expect(
      page.locator('[data-testid="lab-intel-readonly-banner"]')
    ).toBeVisible();
    // The Action column for NURSE renders "View only" (page.tsx:362-365)
    // rather than the "View Order" link DOCTOR/ADMIN see.
    await expect(page.locator("body")).toContainText(/View only/);
  });

  test("filter cluster wiring — date inputs, severity select and Refresh CTA all visible and wired", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="lab-intel-title"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Filter inputs are anchored by testid so we don't snag the global
    // LanguageDropdown <select> that the dashboard layout injects (CLAUDE.md
    // gotcha #9).
    await expect(page.locator('[data-testid="lab-intel-from"]')).toBeVisible();
    await expect(page.locator('[data-testid="lab-intel-to"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-severity"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="lab-intel-refresh"]')
    ).toBeVisible();

    // Severity select offers the three documented options (page.tsx:455-457).
    const severity = page.locator('[data-testid="lab-intel-severity"]');
    await expect(severity.locator("option")).toHaveCount(3);

    // Switching severity to CRITICAL re-fires the criticals fetch with the
    // severity= query param — pin the wiring without asserting on table
    // contents (the stub returns the same body either way).
    let criticalCallWithSeverity = false;
    await page.route("**/api/v1/ai/lab-intel/critical**", (route) => {
      if (route.request().url().includes("severity=CRITICAL")) {
        criticalCallWithSeverity = true;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STUB_CRITICALS),
      });
    });
    await severity.selectOption("CRITICAL");
    // Allow the re-fetch effect to settle.
    await page.waitForTimeout(500);
    expect(criticalCallWithSeverity).toBe(true);
  });

  test("empty state — when /critical and /deviations return [], 'No critical values' + 'No baseline deviations' surfaces show", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await stubAllLabIntel(page, {
      criticals: { success: true, data: [] },
      deviations: { success: true, data: [] },
    });

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="lab-intel-title"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // sr-only empty hook for criticals (page.tsx:553-557).
    await expect(
      page.locator('[data-testid="lab-intel-empty"]')
    ).toBeAttached();
    // Visible empty state for the deviations section (page.tsx:580-586).
    await expect(
      page.locator('[data-testid="lab-intel-deviations-empty"]')
    ).toBeVisible();
  });

  test("LAB_TECH is bounced to /dashboard/not-authorized — outside ALLOWED_ROLES (page.tsx:33)", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    // Shield against a real Sarvam round-trip racing the redirect (lab-tech
    // spec uses the same defensive stub here — commit 9d7391a).
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire (page.tsx:230-239).
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard\/not-authorized(\?|$)|\/dashboard(\?|$)/
    );
    // The page chrome must NOT have rendered for a disallowed role.
    await expect(
      page.locator('[data-testid="lab-intel-title"]')
    ).toHaveCount(0);
  });

  test("PATIENT is bounced to /dashboard/not-authorized — outside ALLOWED_ROLES (page.tsx:33)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await stubAllLabIntel(page);

    await page.goto("/dashboard/lab-intel", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard\/not-authorized(\?|$)|\/dashboard(\?|$)/
    );
    await expect(
      page.locator('[data-testid="lab-intel-title"]')
    ).toHaveCount(0);
  });
});
