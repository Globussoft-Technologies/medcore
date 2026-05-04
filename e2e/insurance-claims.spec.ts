/**
 * Insurance TPA Claims dashboard — review queue + submit-flow e2e coverage.
 *
 * What this exercises:
 *   /dashboard/insurance-claims (apps/web/src/app/dashboard/insurance-claims/page.tsx)
 *   GET   /api/v1/claims                  (apps/api/src/routes/insurance-claims.ts)
 *   POST  /api/v1/claims                  — submit-new-claim flow (gated client-side
 *                                           on missing pickers via Issue #302/#458)
 *   PATCH /api/v1/claims/:id/cancel       — drawer cancel CTA (not exercised here;
 *                                           covered structurally via the drawer
 *                                           render contract on a stubbed row)
 *
 * Surfaces touched:
 *   - ADMIN: lands on the review queue, sees the table chrome, exercises filter
 *     wiring (status query-string contract) and opens the side-drawer on row click.
 *   - RECEPTION: lands on the same queue (RBAC parity with ADMIN per page.tsx:138
 *     and POST /claims authorize() at insurance-claims.ts:164).
 *   - Submit-new modal: opens via the "Submit new claim" CTA; client-side
 *     validation (Issue #302 + #458) blocks empty Bill / Insurer / Policy /
 *     Diagnosis / Amount fields without touching the network.
 *   - DOCTOR / PATIENT: bounce. The page redirects via router.push("/dashboard")
 *     when user.role is not ADMIN | RECEPTION (page.tsx:138). Note: redirect
 *     target is "/dashboard", NOT "/dashboard/not-authorized" — the bounce
 *     archetype here is "redirect-bounce-to-dashboard", distinct from the
 *     classic /not-authorized landing.
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG.md §2.12 "/dashboard/insurance-claims — claim
 *   submission/appeal/reconciliation (smoke only)". The full lifecycle
 *   (submit → SUBMITTED → APPROVED → SETTLED + appeal + reconcile billed-vs-
 *   approved) requires deep TPA-adapter stubs; we pin the structural surface
 *   (filters, table, drawer, submit-modal validation) and skip the multi-step
 *   lifecycle until a TPA-stub helper lands. See P8 in the backlog top-10 for
 *   the full lifecycle scope.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const CLAIMS_LIST_URL = "**/api/v1/claims**";

interface StubClaim {
  id: string;
  billId: string;
  patientId: string;
  tpaProvider: string;
  providerClaimRef: string | null;
  insurerName: string;
  policyNumber: string;
  diagnosis: string;
  amountClaimed: number;
  amountApproved: number | null;
  status: string;
  submittedAt: string | null;
  createdAt: string;
}

function stubClaim(overrides: Partial<StubClaim> = {}): StubClaim {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "claim-e2e-0001",
    billId: overrides.billId ?? "inv-e2e-deadbeef",
    patientId: overrides.patientId ?? "pat-e2e-cafebabe",
    tpaProvider: overrides.tpaProvider ?? "MEDI_ASSIST",
    providerClaimRef: overrides.providerClaimRef ?? "TPA-E2E-12345",
    insurerName: overrides.insurerName ?? "Star Health Insurance",
    policyNumber: overrides.policyNumber ?? "POL-E2E-9999",
    diagnosis: overrides.diagnosis ?? "Hypertension stage 2",
    amountClaimed: overrides.amountClaimed ?? 50_000,
    amountApproved: overrides.amountApproved ?? null,
    status: overrides.status ?? "SUBMITTED",
    submittedAt: overrides.submittedAt ?? now,
    createdAt: overrides.createdAt ?? now,
  };
}

test.describe("Insurance Claims — /dashboard/insurance-claims (ADMIN + RECEPTION review queue, redirect-bounce for DOCTOR / PATIENT)", () => {
  test("ADMIN lands on the queue: heading + Submit-new CTA + AI-Draft CTA + filters render without crashing", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the list to a deterministic single-row response so we're asserting
    // page chrome, not whatever happens to be in the seed DB.
    await page.route(CLAIMS_LIST_URL, (route) => {
      const u = new URL(route.request().url());
      // Only intercept the LIST endpoint, not /claims/:id.
      if (/\/claims\/?$/.test(u.pathname) || /\/claims$/.test(u.pathname)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [stubClaim()] }),
        });
      }
      return route.fallback();
    });

    await gotoAuthed(page, "/dashboard/insurance-claims");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /insurance claims/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /submit new claim/i }).first()
    ).toBeVisible();
    await expect(page.getByTestId("insurance-claims-ai-draft")).toBeVisible();
    // Filter cluster: status / TPA / from / to. Bind to the stable `id`s the
    // page declares (avoid `select.first()` per CLAUDE.md gotcha #9 —
    // LanguageDropdown is the first <select> in the layout chrome).
    await expect(page.locator("#claims-filter-status")).toBeVisible();
    await expect(page.locator("#claims-filter-tpa")).toBeVisible();
    await expect(page.locator("#claims-filter-from")).toBeVisible();
    await expect(page.locator("#claims-filter-to")).toBeVisible();
    // The stubbed row must surface.
    await expect(page.getByTestId("claim-row").first()).toBeVisible();
  });

  test("ADMIN status filter wires through to GET /claims?status=SUBMITTED query-string contract", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Bare initial fulfilment so the page renders. The waitForRequest below
    // captures the post-filter GET that carries `status=SUBMITTED`.
    await page.route(CLAIMS_LIST_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/insurance-claims");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /insurance claims/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Pin the network contract: changing the Status filter re-fetches with
    // `?status=SUBMITTED`. The list endpoint is /claims (NOT /claims/:id) so
    // the regex anchors on the ?status= query rather than the path tail.
    const filtered = page.waitForRequest(
      (req) =>
        /\/api\/v1\/claims\?/.test(req.url()) &&
        /status=SUBMITTED/.test(req.url()),
      { timeout: 10_000 }
    );
    await page.locator("#claims-filter-status").selectOption("SUBMITTED");
    await filtered;
  });

  test("ADMIN clicks a row → side-drawer opens with timeline + Documents headers from GET /claims/:id", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const seeded = stubClaim({
      id: "claim-e2e-drawer-001",
      providerClaimRef: "TPA-DRAWER-001",
      diagnosis: "Pneumonia, unspecified",
      amountClaimed: 75_000,
      status: "UNDER_REVIEW",
    });

    await page.route(CLAIMS_LIST_URL, (route) => {
      const u = new URL(route.request().url());
      // Detail by id wins first — order matters because /:id matches the
      // bare list pathname check below.
      if (u.pathname.endsWith(`/claims/${seeded.id}`)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              ...seeded,
              documents: [],
              timeline: [
                {
                  id: "tl-1",
                  status: "SUBMITTED",
                  note: "Submitted to TPA",
                  source: "system",
                  timestamp: new Date().toISOString(),
                },
              ],
              memberId: "MEM-001",
              icd10Codes: ["J18.9"],
            },
          }),
        });
      }
      if (/\/claims\/?$/.test(u.pathname) || /\/claims$/.test(u.pathname)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [seeded] }),
        });
      }
      return route.fallback();
    });

    await gotoAuthed(page, "/dashboard/insurance-claims");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(page.getByTestId("claim-row").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("claim-row").first().click();

    const drawer = page.getByRole("complementary", { name: /claim detail/i });
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(
      drawer.getByRole("heading", { name: /claim detail/i }).first()
    ).toBeVisible();
    await expect(drawer.getByText(/^timeline$/i).first()).toBeVisible();
    await expect(drawer.getByText(/^documents$/i).first()).toBeVisible();
    await expect(drawer.getByText(/TPA-DRAWER-001/).first()).toBeVisible();
  });

  test("RECEPTION reaches /dashboard/insurance-claims (RBAC parity with ADMIN; no redirect, queue chrome renders)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    await page.route(CLAIMS_LIST_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/insurance-claims");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /insurance claims/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /submit new claim/i }).first()
    ).toBeVisible();
    // Empty-state copy on the deterministic empty stub.
    await expect(page.getByText(/no claims match your filters/i)).toBeVisible();
  });

  test("ADMIN opens the Submit-new modal and empty-form submit triggers Issue #302/#458 client-side guard (no POST fired)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(CLAIMS_LIST_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    // Track POST attempts to /claims — the client-side guard MUST short-circuit
    // before hitting the network.
    let postAttempts = 0;
    await page.route("**/api/v1/claims", (route) => {
      if (route.request().method() === "POST") {
        postAttempts += 1;
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "should-not-reach" }),
        });
      }
      return route.fallback();
    });

    await gotoAuthed(page, "/dashboard/insurance-claims");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /submit new claim/i }).first().click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(
      modal.getByRole("heading", { name: /submit new claim/i }).first()
    ).toBeVisible();
    // Submit empty form → React-side validator (`noValidate` form) should
    // surface a single "Please select a Bill (invoice)..." message and never
    // POST. The cluster of fallbacks (#302, #458) all live inside the same
    // submit() handler and short-circuit before the api.post call.
    await modal.getByRole("button", { name: /^submit$/i }).click();
    await expect(
      modal.getByText(/please select a bill/i).first()
    ).toBeVisible({ timeout: 5_000 });
    expect(postAttempts).toBe(0);
  });

  test("DOCTOR is redirected away from /dashboard/insurance-claims — page.tsx:138 bounces non-{ADMIN,RECEPTION} to /dashboard", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.goto("/dashboard/insurance-claims", {
      waitUntil: "domcontentloaded",
    });
    // Allow the client-side useEffect to fire its router.push.
    await page.waitForTimeout(800);
    // The bounce target is "/dashboard" (NOT "/dashboard/not-authorized") —
    // pin the actual archetype, don't fabricate.
    expect(page.url()).toMatch(/\/dashboard(\/?($|\?))/);
    expect(page.url()).not.toMatch(/\/dashboard\/insurance-claims/);
    // Submit-new CTA must NOT be visible (would mean the page rendered).
    await expect(
      page.getByRole("button", { name: /submit new claim/i })
    ).toHaveCount(0);
  });

  test("PATIENT is redirected away from /dashboard/insurance-claims — outside ADMIN/RECEPTION allowlist", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/insurance-claims", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/\/dashboard(\/?($|\?))/);
    expect(page.url()).not.toMatch(/\/dashboard\/insurance-claims/);
    await expect(
      page.getByRole("button", { name: /submit new claim/i })
    ).toHaveCount(0);
    await expect(page.getByTestId("claim-row")).toHaveCount(0);
  });
});
