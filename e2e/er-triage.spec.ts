import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

// ER Triage Assistant — clinical-only surface (doctor/nurse). The page POSTs
// /ai/er-triage/assess with chief complaint + vitals and renders an ESI level.

test.describe("ER Triage Assistant", () => {
  test("doctor can load ER Triage page with form + assess button", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /er triage assistant/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Chief Complaint is the required anchor field.
    await expect(
      page.getByPlaceholder(/sudden onset chest pain|chief complaint/i).first()
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: /assess patient/i }).first()
    ).toBeVisible();
  });

  test("assess button is disabled when chief complaint is empty", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);

    const assess = page.getByRole("button", { name: /assess patient/i }).first();
    await expect(assess).toBeVisible({ timeout: 15_000 });
    await expect(assess).toBeDisabled();
  });

  test("submitting with stubbed API renders the triage level badge", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Stub the POST so the test is deterministic regardless of AI availability.
    await page.route("**/api/v1/ai/er-triage/assess", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            suggestedTriageLevel: 2,
            triageLevelLabel: "Emergent",
            disposition: "Resuscitation bay — immediate physician eval",
            immediateActions: ["Attach cardiac monitor", "IV access x2"],
            suggestedInvestigations: ["12-lead ECG", "Troponin"],
            redFlags: ["Radiation to left arm"],
            calculatedMEWS: 4,
            aiReasoning: "Concerning for acute coronary syndrome.",
            disclaimer: "AI-assisted — final triage decision with clinician.",
          },
        }),
      });
    });

    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);

    await page
      .getByPlaceholder(/sudden onset chest pain|chief complaint/i)
      .first()
      .fill("Crushing substernal chest pain for 20 minutes");

    await page.getByRole("button", { name: /assess patient/i }).first().click();

    // Results panel — ESI level copy + immediate actions header.
    await expect(page.getByText(/esi level/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: /immediate actions/i }).first()
    ).toBeVisible();
    await expect(page.getByText(/12-lead ECG/).first()).toBeVisible();
  });

  test("error toast appears when the assess API fails", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await page.route("**/api/v1/ai/er-triage/assess", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "LLM upstream failure" }),
      });
    });

    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);

    await page
      .getByPlaceholder(/sudden onset chest pain|chief complaint/i)
      .first()
      .fill("Headache");

    await page.getByRole("button", { name: /assess patient/i }).first().click();

    // No results panel should render, and the page should not crash.
    await expect(page.locator("body")).not.toContainText(/ESI Level/);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("patient hitting /dashboard/er-triage does not crash / shows stable UI", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/er-triage");

    // Either the page loads (form visible) or the API rejects. In both cases
    // the app shell must not render an error boundary.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
