import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

// AI Lab Report Explainer — doctor/admin surface for reviewing and approving
// AI-generated plain-language explanations. Endpoints used:
//   GET  /ai/reports/pending
//   PATCH /ai/reports/:id/approve

test.describe("Lab Report Explainer", () => {
  test("doctor can load the page with heading + refresh + stats", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/lab-explainer");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai lab report explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /refresh/i }).first()
    ).toBeVisible();

    // Stat pills ("Pending Review", "With Abnormal Values", "With Critical Values")
    await expect(page.getByText(/pending review/i).first()).toBeVisible();
  });

  test("empty-state 'All caught up!' when /pending returns []", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.route("**/api/v1/ai/reports/pending", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await page.goto("/dashboard/lab-explainer");
    await dismissTourIfPresent(page);

    await expect(page.getByText(/all caught up/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("pending cards render + Approve button triggers PATCH", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    const explanationId = "expl-e2e-0001";

    await page.route("**/api/v1/ai/reports/pending", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: explanationId,
              labOrderId: "lo-abcdef1234",
              patientId: "p-1234567890",
              explanation: "Your haemoglobin is slightly low but your other values look normal.",
              flaggedValues: [
                {
                  parameter: "Haemoglobin",
                  value: "10.2 g/dL",
                  flag: "LOW",
                  plainLanguage: "Slightly below normal range.",
                },
              ],
              language: "en",
              status: "PENDING_REVIEW",
              approvedBy: null,
              approvedAt: null,
              sentAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      })
    );

    let approveCalled = false;
    await page.route(`**/api/v1/ai/reports/${explanationId}/approve`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      approveCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { id: explanationId, status: "SENT" },
        }),
      });
    });

    await page.goto("/dashboard/lab-explainer");
    await dismissTourIfPresent(page);

    // Card body content from the stub.
    await expect(page.getByText(/haemoglobin is slightly low/i).first()).toBeVisible({
      timeout: 15_000,
    });

    const approveBtn = page
      .getByRole("button", { name: /approve.*send to patient/i })
      .first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // After a successful approve, the card is filtered out → empty state shows.
    await expect(page.getByText(/all caught up/i).first()).toBeVisible({
      timeout: 10_000,
    });
    expect(approveCalled).toBe(true);
  });

  test("refresh re-fetches pending list without crashing", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    let calls = 0;
    await page.route("**/api/v1/ai/reports/pending", (route) => {
      calls++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      });
    });

    await page.goto("/dashboard/lab-explainer");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai lab report explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /refresh/i }).first().click();

    // Both the mount and the explicit refresh should have fired a GET.
    await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  });

  test("patient hitting /dashboard/lab-explainer does not crash the app", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/lab-explainer");

    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
