/**
 * AI Bill & Insurance Explainer review-queue e2e coverage.
 *
 * What this exercises:
 *   /dashboard/bill-explainer (apps/web/src/app/dashboard/bill-explainer/page.tsx)
 *   GET   /api/v1/ai/bill-explainer/pending   (apps/api/src/routes/ai-bill-explainer.ts)
 *   POST  /api/v1/ai/bill-explainer/:id/approve
 *
 * Surfaces touched:
 *   - ADMIN / RECEPTION: review-and-approve queue. The page has NO
 *     client-side role gate; access is enforced at the API by the
 *     authorize(Role.ADMIN, Role.RECEPTION) call on /pending. Other
 *     roles render the page chrome but the GET /pending fetch 403s and
 *     the toast-error path drops them on an empty list (route-shape
 *     pin per CLAUDE.md gotcha #7).
 *   - Approve & Send CTA: only renders for items in DRAFT status; flips
 *     them to APPROVED and the route filters them out of the local list.
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG.md §2.3 "/dashboard/bill-explainer —
 *   explanation workflow (only smoke-visited)". Mirrors the canonical
 *   AI-explainer coverage shape established by e2e/lab-explainer.spec.ts
 *   so the two AI review surfaces stay in lockstep on assertions
 *   (heading + Refresh + empty-state + approve round-trip).
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PENDING_URL = "**/api/v1/ai/bill-explainer/pending";

function stubExplanationRow(overrides: Partial<{
  id: string;
  invoiceId: string;
  patientId: string;
  language: "en" | "hi";
  status: "DRAFT" | "APPROVED" | "SENT";
  content: string;
  flaggedItems: Array<{ description: string; amount: number; reason: string }>;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "be-e2e-0001",
    invoiceId: overrides.invoiceId ?? "inv-deadbeef-0000",
    patientId: overrides.patientId ?? "pat-cafebabe-0000",
    language: overrides.language ?? "en",
    content:
      overrides.content ??
      "Your bill includes a consultation fee and a procedure-room charge. The total reflects 18% GST as required by law.",
    status: overrides.status ?? "DRAFT",
    flaggedItems: overrides.flaggedItems ?? [],
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

test.describe("AI Bill & Insurance Explainer — /dashboard/bill-explainer (ADMIN/RECEPTION review queue, page is no-gate but API authorize() enforces RBAC)", () => {
  test("ADMIN lands on the review queue: heading + Refresh button + queue chrome render without crashing", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub /pending to keep the page in a deterministic empty state so
    // we're asserting on the page chrome, not on whatever happens to
    // be in the seed DB.
    await page.route(PENDING_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/bill-explainer");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /ai bill.*insurance explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /refresh/i }).first()
    ).toBeVisible();
  });

  test("Empty-state surfaces when /pending returns []: 'All caught up!' card visible, no Approve CTAs anywhere", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(PENDING_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/bill-explainer");
    await dismissTourIfPresent(page);

    await expect(page.getByText(/all caught up/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/no bill explanations are pending review/i).first()
    ).toBeVisible();

    // Approve & Send is per-row; with zero rows, none should exist.
    await expect(page.getByRole("button", { name: /approve.*send/i })).toHaveCount(0);
  });

  test("DRAFT card renders content + flagged items + Approve CTA, and POST /approve removes the card from the queue", async ({
    adminPage,
  }) => {
    const page = adminPage;
    const explanationId = "be-e2e-approve-flow";

    await page.route(PENDING_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            stubExplanationRow({
              id: explanationId,
              status: "DRAFT",
              content:
                "Your bill of Rs. 1,770 includes a Rs. 1,000 specialist consultation, a Rs. 500 procedure-room fee, and 18% GST.",
              flaggedItems: [
                {
                  description: "Procedure room fee",
                  amount: 500,
                  reason: "Above typical consultation room rate",
                },
              ],
            }),
          ],
        }),
      })
    );

    let approveCalled = false;
    await page.route(
      `**/api/v1/ai/bill-explainer/${explanationId}/approve`,
      (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        approveCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: explanationId, status: "SENT" },
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/bill-explainer");
    await dismissTourIfPresent(page);

    // Card content from the stub.
    await expect(
      page.getByText(/specialist consultation/i).first()
    ).toBeVisible({ timeout: 15_000 });

    // Flagged-items mini-list ("1 Item to Check" header + the row text).
    await expect(page.getByText(/1 item to check/i).first()).toBeVisible();
    await expect(page.getByText(/procedure room fee/i).first()).toBeVisible();
    await expect(
      page.getByText(/above typical consultation room rate/i).first()
    ).toBeVisible();

    const approveBtn = page
      .getByRole("button", { name: /approve.*send/i })
      .first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // The page filters approved entries out of local state → empty card returns.
    await expect(page.getByText(/all caught up/i).first()).toBeVisible({
      timeout: 10_000,
    });
    expect(approveCalled).toBe(true);
  });

  test("Refresh button re-issues GET /pending: at least 2 fetches observed across mount + click", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    let calls = 0;
    await page.route(PENDING_URL, (route) => {
      calls++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      });
    });

    await gotoAuthed(page, "/dashboard/bill-explainer");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai bill.*insurance explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /refresh/i }).first().click();

    // Mount + explicit refresh = 2 GETs minimum.
    await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  });

  test("Non-DRAFT cards (APPROVED) render content but DO NOT expose the Approve & Send CTA", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route(PENDING_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            stubExplanationRow({
              id: "be-e2e-already-approved",
              status: "APPROVED",
              content:
                "Already-approved explanation copy that should still display in the queue but without the action button.",
            }),
          ],
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/bill-explainer");
    await dismissTourIfPresent(page);

    await expect(
      page.getByText(/already-approved explanation copy/i).first()
    ).toBeVisible({ timeout: 15_000 });

    // Status badge for non-DRAFT row should read "Approved", and the
    // CTA must be absent — the page only renders Approve&Send when
    // item.status === "DRAFT".
    await expect(page.getByText(/^approved$/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /approve.*send/i })).toHaveCount(0);
  });

  test("Page is universally accessible: PATIENT lands on /dashboard/bill-explainer without an auth-redirect or crash banner — the page has no client gate (CLAUDE.md gotcha #7)", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // Real /pending fetch from a PATIENT will 403 server-side; the page
    // toasts an error and renders empty state. We don't stub here — we
    // want to pin the actual route shape (chrome renders, no crash).
    await gotoAuthed(page, "/dashboard/bill-explainer");

    // Crucial pin: page does NOT redirect to /not-authorized today.
    expect(page.url()).not.toContain("/dashboard/not-authorized");

    // Heading still renders (page chrome is unconditional).
    await expect(
      page.getByRole("heading", { name: /ai bill.*insurance explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // No Next.js / React error overlay.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR sees the same no-redirect route shape as PATIENT — RBAC is API-side only on /pending", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await gotoAuthed(page, "/dashboard/bill-explainer");

    expect(page.url()).not.toContain("/dashboard/not-authorized");
    await expect(
      page.getByRole("heading", { name: /ai bill.*insurance explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Even if the API errors out, the queue must not show a stale
    // "Approve & Send" button for a doctor (there's no DRAFT row to act
    // on, regardless of fetch outcome).
    await expect(page.getByRole("button", { name: /approve.*send/i })).toHaveCount(0);
  });
});
