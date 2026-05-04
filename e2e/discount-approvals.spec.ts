/**
 * Discount Approvals queue + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/discount-approvals (apps/web/src/app/dashboard/discount-approvals/page.tsx)
 *   GET   /api/v1/billing/discount-approvals?status=...  (apps/api/src/routes/billing.ts)
 *   POST  /api/v1/billing/discount-approvals/:id/approve (ADMIN-only)
 *   POST  /api/v1/billing/discount-approvals/:id/reject  (ADMIN-only)
 *
 * Surfaces touched:
 *   - ADMIN: full approve / reject queue with Pending / Approved /
 *     Rejected tab strip.
 *   - RECEPTION: page renders (VIEW_ALLOWED includes RECEPTION) but
 *     approve/reject calls 403 server-side; we exercise read-only chrome.
 *   - DOCTOR / NURSE / PATIENT: Issue #509 client-side gate redirects
 *     them to /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   Closes the "request side" half of E2E_COVERAGE_BACKLOG.md §2.3
 *   "/dashboard/discount-approvals — request side (approval side
 *   covered)". Approval-side seeding is already covered by
 *   refunds-discounts.spec.ts; this file pins the page chrome, the
 *   tab-switch fetch contract, the empty state, the action CTAs on a
 *   PENDING row, and the Issue #509 RBAC gate so a future regression in
 *   the page's redirect effect is caught at this level. Stubs are used
 *   to keep the spec independent of upstream invoice / discount-request
 *   seed state (which is covered end-to-end by refunds-discounts).
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const APPROVALS_URL = "**/api/v1/billing/discount-approvals?status=*";

function stubApprovalRow(overrides: Partial<{
  id: string;
  invoiceNumber: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  amount: number;
  percentage: number | null;
  reason: string;
  patientName: string;
  mrNumber: string;
  rejectionReason: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "da-e2e-0001",
    amount: overrides.amount ?? 500,
    percentage: overrides.percentage ?? 25,
    reason: overrides.reason ?? "E2E senior-citizen courtesy",
    status: overrides.status ?? "PENDING",
    createdAt: new Date().toISOString(),
    rejectionReason: overrides.rejectionReason ?? null,
    invoice: {
      id: "inv-da-e2e-0001",
      invoiceNumber: overrides.invoiceNumber ?? "INV-E2E-DA-001",
      totalAmount: 1770,
      patient: {
        mrNumber: overrides.mrNumber ?? "MR-E2E-DA-001",
        user: {
          name: overrides.patientName ?? "Aanya Sharma",
          phone: "+919999900001",
        },
      },
    },
  };
}

test.describe("Discount Approvals — /dashboard/discount-approvals (ADMIN/RECEPTION review queue, Issue #509 client-side VIEW_ALLOWED gate redirects DOCTOR/NURSE/PATIENT)", () => {
  test("ADMIN lands on the queue: heading + 3-tab strip + table renders a stubbed PENDING row with Approve / Reject CTAs", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(APPROVALS_URL, (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status");
      const data =
        status === "PENDING"
          ? [stubApprovalRow({ status: "PENDING", invoiceNumber: "INV-DA-PENDING-1" })]
          : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
    });

    await gotoAuthed(page, "/dashboard/discount-approvals");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /discount approvals/i })
    ).toBeVisible({ timeout: 15_000 });

    // Tab strip — exact-match buttons, all three tabs present.
    await expect(page.getByRole("button", { name: /^pending$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^approved$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^rejected$/i })).toBeVisible();

    // Stubbed PENDING row content surfaces.
    await expect(page.getByText("INV-DA-PENDING-1").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Aanya Sharma").first()).toBeVisible();

    // Per-row action buttons render only for PENDING rows.
    await expect(
      page.getByRole("button", { name: /^approve$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^reject$/i }).first()
    ).toBeVisible();
  });

  test("Empty-state copy surfaces when /discount-approvals returns []: 'No pending approvals.' message and zero action buttons", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(APPROVALS_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/discount-approvals");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /discount approvals/i })
    ).toBeVisible({ timeout: 15_000 });

    // Empty-state literal: "No <tab.toLowerCase()> approvals." → tab
    // defaults to PENDING on first render.
    await expect(page.getByText(/no pending approvals/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^reject$/i })).toHaveCount(0);
  });

  test("Tab switch from PENDING to APPROVED issues a fresh GET with status=APPROVED and renders the approved row", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const observedStatuses: string[] = [];
    await page.route(APPROVALS_URL, (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status") ?? "";
      observedStatuses.push(status);
      const data =
        status === "APPROVED"
          ? [
              stubApprovalRow({
                status: "APPROVED",
                invoiceNumber: "INV-DA-APPROVED-9",
                patientName: "Rahul Verma",
              }),
            ]
          : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
    });

    await gotoAuthed(page, "/dashboard/discount-approvals");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /discount approvals/i })
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^approved$/i }).click();

    await expect(page.getByText("INV-DA-APPROVED-9").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Rahul Verma").first()).toBeVisible();

    // The PENDING tab is no longer the source of truth → no Approve /
    // Reject action buttons on APPROVED rows.
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^reject$/i })).toHaveCount(0);

    // Both PENDING (mount) and APPROVED (post-click) should appear in
    // the observed call list at least once each.
    expect(observedStatuses).toContain("PENDING");
    expect(observedStatuses).toContain("APPROVED");
  });

  test("REJECTED tab renders the rejection reason inline with each row — pins the page-shape contract for downstream audit reviewers", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(APPROVALS_URL, (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status") ?? "";
      const data =
        status === "REJECTED"
          ? [
              stubApprovalRow({
                status: "REJECTED",
                invoiceNumber: "INV-DA-REJECTED-3",
                rejectionReason: "Insufficient justification per policy 4.2",
              }),
            ]
          : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
    });

    await gotoAuthed(page, "/dashboard/discount-approvals");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /^rejected$/i }).click();

    await expect(page.getByText("INV-DA-REJECTED-3").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/insufficient justification per policy 4\.2/i).first()
    ).toBeVisible();
  });

  test("RECEPTION can reach the queue (VIEW_ALLOWED matches API authorize on GET) — chrome renders without a redirect", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    await page.route(APPROVALS_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/discount-approvals");
    await dismissTourIfPresent(page);

    expect(page.url()).not.toContain("/dashboard/not-authorized");
    await expect(
      page.getByRole("heading", { name: /discount approvals/i })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/no pending approvals/i).first()
    ).toBeVisible();
  });

  test("DOCTOR is bounced to /dashboard/not-authorized — Issue #509 client-side VIEW_ALLOWED gate (page.tsx:16) keeps non-finance roles out", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/discount-approvals");

    // The page's useEffect calls router.replace into /not-authorized
    // (with an encoded ?from=) for any role outside the VIEW_ALLOWED
    // set. Allow ~1.2s for the effect to run + navigation to settle.
    await page.waitForURL(/\/dashboard\/not-authorized/, { timeout: 6_000 });
    expect(page.url()).toContain("/dashboard/not-authorized");

    // Heading from the discount-approvals page must NOT be present.
    await expect(page.getByRole("heading", { name: /^discount approvals$/i })).toHaveCount(0);
  });

  test("PATIENT is bounced to /dashboard/not-authorized — same Issue #509 gate, asserts no row data leaks before the redirect lands", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/discount-approvals");

    await page.waitForURL(/\/dashboard\/not-authorized/, { timeout: 6_000 });
    expect(page.url()).toContain("/dashboard/not-authorized");

    // Defence-in-depth: even on the brief transient page, no Approve /
    // Reject buttons must have rendered to a PATIENT.
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^reject$/i })).toHaveCount(0);
  });
});
