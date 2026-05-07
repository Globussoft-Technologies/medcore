/**
 * HR-Operations / Leave-Management — APPROVAL queue + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/leave-management (apps/web/src/app/dashboard/leave-management/page.tsx)
 *   GET   /api/v1/leaves[?status=…]      — manager list/filter (apps/api/src/routes/leaves.ts:102)
 *   PATCH /api/v1/leaves/:id/approve     — ADMIN approve (leaves.ts:196, authorize ADMIN)
 *   PATCH /api/v1/leaves/:id/reject      — ADMIN reject  (leaves.ts:277, authorize ADMIN)
 *
 * Companion specs (intentionally NOT duplicated here):
 *   - e2e/my-leaves.spec.ts        — staff self-service submission + cancel + universal-access route shape
 *   - e2e/users.spec.ts            — /dashboard/users edit/deactivate/role-change live PATCH /users/:id round-trip
 *   - e2e/certifications.spec.ts   — /dashboard/certifications cert-expiry tracking surface
 *   - e2e/leave-calendar.spec.ts   — /dashboard/leave-calendar month-view chrome
 *   - e2e/payroll.spec.ts          — /dashboard/payroll generate/edit/calculate/slip lifecycle
 *
 * Scope of THIS file (E2E_COVERAGE_BACKLOG.md §5 P7 — HR-manager side):
 *   The original P7 framing listed eight scenarios. Reality on the shipped
 *   surface (audited 2026-05-05):
 *     - Manager approves/rejects a leave request           — SHIPPED, COVERED HERE
 *     - HR-manager approval QUEUE (chrome + tabs + filter) — SHIPPED, COVERED HERE
 *     - Tab-switch refetch contract (PENDING → APPROVED)   — SHIPPED, COVERED HERE
 *     - Reject-with-reason inline modal                    — SHIPPED, COVERED HERE
 *     - Non-ADMIN access-restricted in-page render branch  — SHIPPED, COVERED HERE
 *                                                            (DIFFERENT archetype from
 *                                                            /dashboard/users which
 *                                                            redirects via router.push)
 *     - Bulk staff CSV import via /dashboard/users         — DEFERRED: feature not shipped
 *                                                            (page.tsx has no upload
 *                                                            input, users.ts has no
 *                                                            POST /users/bulk endpoint;
 *                                                            single-create is the only
 *                                                            staff-creation surface today)
 *     - Permission-matrix fine-grained RBAC                — DEFERRED: not modelled
 *                                                            (only the 7-role enum at
 *                                                            packages/shared/Role exists
 *                                                            — there is no per-action
 *                                                            permission matrix UI)
 *     - Role change with effective DATE                    — DEFERRED: shipped role-change
 *                                                            (PATCH /users/:id { role })
 *                                                            has NO effective-date field
 *                                                            (immediate). Already covered
 *                                                            by users.spec.ts test 3 with
 *                                                            a live PATCH round-trip.
 *     - Deactivation + reactivation                        — DEFERRED: covered by
 *                                                            users.spec.ts test 2 (live
 *                                                            disable round-trip); the
 *                                                            re-enable path is just the
 *                                                            same toggle in reverse.
 *     - Payroll run / payslip generation                   — DEFERRED: already covered by
 *                                                            payroll.spec.ts (7 cases,
 *                                                            commit closure 2026-05-03).
 *     - Shift-conflict detection during scheduling         — DEFERRED: schedule-shift
 *                                                            collision UI not shipped
 *                                                            on /dashboard/schedule
 *                                                            (the markOverlappingShifts
 *                                                            helper at leaves.ts:53 fires
 *                                                            BACKEND-side after approve;
 *                                                            no client-facing collision
 *                                                            warning yet).
 *
 * Page-shape decision for /dashboard/leave-management (CLAUDE.md gotcha #7
 * archetype mapping; cron-learning bullet 6 redirect-target audit):
 *   The page has NO `router.push`/`router.replace` redirect — it's a third
 *   archetype: in-place "Access restricted to administrators." render
 *   branch (page.tsx:67-73). Non-ADMIN authed users land on the URL,
 *   layout chrome renders, but the leave-management body is replaced with
 *   the access-restricted card. URL stays at /dashboard/leave-management.
 *   We pin THIS archetype rather than asserting a redirect (a redirect
 *   assertion would falsely fail because the page never redirects).
 *
 * Why these tests exist:
 *   /dashboard/leave-management is the ADMIN side of the staff leave
 *   workflow. The companion staff-submit surface is covered by
 *   my-leaves.spec, but until now the ADMIN-side approve/reject flow had
 *   ZERO e2e coverage. A regression in the queue's status-tab refetch,
 *   the approve POST body shape, or the reject-with-reason modal would
 *   silently break HR ops — exactly the kind of gap §5 P7 was opened to
 *   close. We use page.route stubs for the approve/reject lifecycle so
 *   the assertions don't pollute the shared admin seed across runs (the
 *   real lifecycle is owned by leaves-approve.test.ts route-handler
 *   tests; this file's job is to pin the BROWSER → API request shape +
 *   the post-success UI re-render contract).
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 15_000;

/**
 * Synthetic PENDING leave row used by the page.route stubs below. The
 * shape mirrors the real Leave interface in page.tsx:11-25 — leaving any
 * field undefined would crash the React render at the table rows, so we
 * keep the surface complete and stable.
 */
const STUB_PENDING_LEAVE = {
  id: "stub-leave-pending-1",
  userId: "stub-user-doctor-1",
  type: "CASUAL",
  fromDate: "2026-06-15T00:00:00.000Z",
  toDate: "2026-06-17T00:00:00.000Z",
  totalDays: 3,
  reason: "E2E hr-operations approval-queue stub — PENDING row",
  status: "PENDING" as const,
  rejectionReason: null,
  approvedAt: null,
  createdAt: "2026-05-01T10:00:00.000Z",
  user: {
    id: "stub-user-doctor-1",
    name: "Stub Test Staff",
    role: "DOCTOR",
    email: "stub.staff@medcore.local",
  },
  approver: null,
};

const STUB_APPROVED_LEAVE = {
  ...STUB_PENDING_LEAVE,
  id: "stub-leave-approved-1",
  status: "APPROVED" as const,
  approvedAt: "2026-05-02T10:00:00.000Z",
  reason: "E2E hr-operations approval-queue stub — APPROVED row",
  approver: { id: "approver-admin-1", name: "Stub Admin" },
};

test.describe("HR Operations — /dashboard/leave-management (ADMIN approval queue + tab-switch refetch + access-restricted in-page archetype)", () => {
  test("ADMIN lands on /dashboard/leave-management, sees the queue chrome — heading, 4 status tabs (Pending/Approved/Rejected/All), filter cluster, table with stubbed PENDING row", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the PENDING-tab GET so the table reliably has at least one row to
    // render even if the seeded DB has zero pending leaves at the moment.
    await page.route(/\/api\/v1\/leaves(\?.*)?$/, (route) => {
      const url = route.request().url();
      // Route handler only matches `/leaves[?status=…]` (NOT /leaves/my,
      // /leaves/pending, /leaves/:id/approve, etc — they have additional
      // path segments).
      if (/\/leaves\?status=PENDING$|\/leaves$/.test(url)) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [STUB_PENDING_LEAVE],
            error: null,
          }),
        });
        return;
      }
      route.continue();
    });

    await gotoAuthed(page, "/dashboard/leave-management");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /leave management/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The 4 tab buttons (Pending / Approved / Rejected / All) — pinned via
    // accessible name because the page has no data-testid attributes.
    await expect(page.getByRole("button", { name: /^pending$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^approved$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^rejected$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible();

    // The filter cluster — type select, from-date, to-date inputs (page.tsx:148,165,176).
    // Scope by id to dodge gotcha #9 (LanguageDropdown's global <select>).
    await expect(page.locator("#leave-mgmt-type")).toBeVisible();
    await expect(page.locator("#leave-mgmt-from")).toBeVisible();
    await expect(page.locator("#leave-mgmt-to")).toBeVisible();

    // The stubbed PENDING row's reason text appears in the table.
    await expect(
      page.locator("text=E2E hr-operations approval-queue stub — PENDING row").first()
    ).toBeVisible({ timeout: 10_000 });

    // The PENDING row exposes Approve + Reject CTAs (page.tsx:247-263).
    await expect(page.getByRole("button", { name: /approve/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^reject$/i }).first()).toBeVisible();
  });

  test("ADMIN approves a PENDING request — Approve CTA fires PATCH /api/v1/leaves/:id/approve with body { status: 'APPROVED' }, useConfirm dialog Confirm pins the lifecycle", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the list GET → return one PENDING row.
    await page.route(/\/api\/v1\/leaves(\?.*)?$/, (route) => {
      const url = route.request().url();
      if (/\/leaves\?status=PENDING$|\/leaves$/.test(url)) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [STUB_PENDING_LEAVE],
            error: null,
          }),
        });
        return;
      }
      route.continue();
    });

    // Capture the approve PATCH body so the assertion locks the request shape.
    let approveBody: any = null;
    let approveUrl: string | null = null;
    await page.route(
      /\/api\/v1\/leaves\/[^/]+\/approve$/,
      (route) => {
        approveUrl = route.request().url();
        approveBody = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { ...STUB_PENDING_LEAVE, status: "APPROVED" },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/leave-management");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Wait for the stub row to render.
    await expect(
      page.locator("text=E2E hr-operations approval-queue stub — PENDING row").first()
    ).toBeVisible({ timeout: 10_000 });

    // Click Approve. handleApprove() at page.tsx:75 awaits useConfirm({title:'Approve…'})
    // which renders ConfirmDialog with stable testids
    // (data-testid="confirm-dialog-confirm" — see ConfirmDialog.tsx:104).
    // Use ^Approve$ (exact, not /approve/i) so the regex doesn't match
    // the "Approved" tab button at page.tsx:133, which renders BEFORE
    // the row's Approve and would be picked by .first().
    await page.getByRole("button", { name: /^approve$/i }).first().click();

    const confirmBtn = page.getByTestId("confirm-dialog-confirm");
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();

    // PATCH fired with the locked body shape.
    await expect.poll(() => approveBody, { timeout: 5_000 }).toEqual({ status: "APPROVED" });
    expect(approveUrl).toMatch(/\/api\/v1\/leaves\/stub-leave-pending-1\/approve$/);
  });

  test("ADMIN rejects a PENDING request via the Reject modal — empty-reason gate blocks submit, then with a reason fires PATCH /api/v1/leaves/:id/reject with body { rejectionReason: '...' }", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(/\/api\/v1\/leaves(\?.*)?$/, (route) => {
      const url = route.request().url();
      if (/\/leaves\?status=PENDING$|\/leaves$/.test(url)) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [STUB_PENDING_LEAVE],
            error: null,
          }),
        });
        return;
      }
      route.continue();
    });

    let rejectBody: any = null;
    let rejectUrl: string | null = null;
    let rejectHits = 0;
    await page.route(
      /\/api\/v1\/leaves\/[^/]+\/reject$/,
      (route) => {
        rejectHits += 1;
        rejectUrl = route.request().url();
        rejectBody = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              ...STUB_PENDING_LEAVE,
              status: "REJECTED",
              rejectionReason: rejectBody?.rejectionReason ?? "",
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/leave-management");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.locator("text=E2E hr-operations approval-queue stub — PENDING row").first()
    ).toBeVisible({ timeout: 10_000 });

    // Open the reject modal.
    await page.getByRole("button", { name: /^reject$/i }).first().click();

    // The reject modal is keyed by the rejection-reason textarea id (page.tsx:296).
    const reasonInput = page.locator("#leave-mgmt-reject-reason");
    await expect(reasonInput).toBeVisible({ timeout: 5_000 });

    // Empty-reason guard: clicking Reject in the modal with no text hits the
    // toast.error("Rejection reason is required") gate at page.tsx:88-90 and
    // does NOT fire a PATCH. The form's submit button is the second occurrence
    // of the "Reject" name (the row CTA was the first); scope to the modal.
    const modal = page.locator("form").filter({ has: reasonInput });
    await modal.getByRole("button", { name: /^reject$/i }).click();
    await page.waitForTimeout(400); // Let the empty-reason gate decide.
    expect(rejectHits).toBe(0);

    // With a reason filled, submit should round-trip.
    const rejectionReason = "E2E rejection — leave overlaps end-of-quarter blackout";
    await reasonInput.fill(rejectionReason);
    await modal.getByRole("button", { name: /^reject$/i }).click();

    await expect.poll(() => rejectBody, { timeout: 5_000 }).toEqual({ rejectionReason });
    expect(rejectUrl).toMatch(/\/api\/v1\/leaves\/stub-leave-pending-1\/reject$/);
  });

  test("ADMIN tab-switch contract pin: Pending → Approved fires GET /api/v1/leaves?status=APPROVED — list re-fetches with the new status filter, APPROVED row renders", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Track which status filter the GET was issued for, and serve a row
    // matching that tab so the table never collapses to "no rows" mid-test.
    const getCalls: string[] = [];
    await page.route(/\/api\/v1\/leaves(\?.*)?$/, (route) => {
      const url = route.request().url();
      if (!/\/leaves\?status=PENDING$|\/leaves\?status=APPROVED$|\/leaves\?status=REJECTED$|\/leaves$/.test(url)) {
        route.continue();
        return;
      }
      getCalls.push(url);
      const data = url.includes("status=APPROVED")
        ? [STUB_APPROVED_LEAVE]
        : url.includes("status=REJECTED")
          ? []
          : [STUB_PENDING_LEAVE];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data, error: null }),
      });
    });

    await gotoAuthed(page, "/dashboard/leave-management");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Wait for first-paint PENDING fetch.
    await expect(
      page.locator("text=E2E hr-operations approval-queue stub — PENDING row").first()
    ).toBeVisible({ timeout: 10_000 });

    // Switch to APPROVED tab.
    await page.getByRole("button", { name: /^approved$/i }).click();

    // The APPROVED row should now be rendered (proving the re-fetch fired
    // with `?status=APPROVED` AND the load() useCallback re-ran on tab change).
    await expect(
      page.locator("text=E2E hr-operations approval-queue stub — APPROVED row").first()
    ).toBeVisible({ timeout: 10_000 });

    // Assert at least one GET URL contained `status=APPROVED` — locks the
    // querystring contract at page.tsx:54 (`?status=${tab}`).
    expect(getCalls.some((u) => u.includes("status=APPROVED"))).toBe(true);
  });

  test("DOCTOR access-restricted archetype pin: /dashboard/leave-management does NOT redirect — page.tsx:67-73 renders an in-place 'Access restricted to administrators.' card, URL stays put, no Approve/Reject CTAs in the DOM", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/leave-management");
    // Allow any role-gate effect a tick (there isn't one — this test pins
    // the absence of a redirect, distinguishing this archetype from
    // /dashboard/users which DOES router.push("/dashboard")).
    await page.waitForTimeout(800);

    expect(page.url()).toContain("/dashboard/leave-management");

    // The access-restricted body card renders (page.tsx:67-73).
    await expect(
      page.locator("text=/access restricted to administrators/i").first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // No queue chrome — neither the Approve/Reject CTAs nor the status tabs
    // render in the access-restricted branch.
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    await expect(page.locator("#leave-mgmt-type")).toHaveCount(0);
  });

  test("PATIENT access-restricted archetype pin: same in-place card renders for PATIENT — confirms gate is `role !== ADMIN` (page.tsx:67), not staff-only", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/leave-management");
    await page.waitForTimeout(800);

    // PATIENT, like DOCTOR, sees the access-restricted card (NOT a redirect).
    expect(page.url()).toContain("/dashboard/leave-management");
    await expect(
      page.locator("text=/access restricted to administrators/i").first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Confirm no queue surface leaks to PATIENT either.
    await expect(page.locator("#leave-mgmt-type")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^pending$/i })
    ).toHaveCount(0);
  });
});
