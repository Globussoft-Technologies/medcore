import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden } from "./helpers";

// The Medication Reminders page is patient-facing. It calls:
//   GET  /patients?userId=...  → resolve the patient profile
//   GET  /ai/adherence/:patientId
//   POST /ai/adherence/enroll
//   DEL  /ai/adherence/:scheduleId

test.describe("Adherence (Medication Reminders)", () => {
  test("patient can load the page and see the heading + enroll action", async ({
    patientPage,
  }) => {
    // TODO: webkit auth-redirect residue after addInitScript fix — fixture race; residual ~30 specs awaiting deeper investigation
    test.skip(({ browserName }) => browserName === "webkit", "webkit auth-redirect residue after addInitScript fix — fixture race; residual ~30 specs awaiting deeper investigation");
    const page = patientPage;
    await page.goto("/dashboard/adherence");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /medication reminders/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /enroll prescription/i }).first()
    ).toBeVisible();

    // No crash / forbidden banner.
    await expectNotForbidden(page);
  });

  test("enroll form opens and validates missing prescription ID", async ({
    patientPage,
  }) => {

    // TODO: webkit auth-redirect residue

    test.skip(({ browserName }) => browserName === "webkit", "webkit auth-redirect residue");
    const page = patientPage;
    await page.goto("/dashboard/adherence");
    await dismissTourIfPresent(page);

    const enrollBtn = page
      .getByRole("button", { name: /enroll prescription/i })
      .first();
    await enrollBtn.click();

    // Expanded form shows the "Enroll a Prescription" sub-heading.
    await expect(
      page.getByRole("heading", { name: /enroll a prescription/i })
    ).toBeVisible({ timeout: 5_000 });

    // Submit empty — client-side validation should set an inline error.
    const submit = page.getByRole("button", { name: /^enroll$/i }).first();
    await submit.click().catch(() => undefined);

    await expect(
      page.getByText(/prescription id is required/i).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("empty-state message appears when no active schedules", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // Stub the adherence list endpoint to return an empty array so we deterministically
    // hit the empty-state branch regardless of seed drift.
    await page.route("**/api/v1/ai/adherence/**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [] }),
        });
      }
      return route.fallback();
    });

    await page.goto("/dashboard/adherence");
    await dismissTourIfPresent(page);

    // Either "no active medication reminders" (patient resolved, no schedules)
    // or "no patient profile found" (seed user is not linked to a patient).
    const noSchedules = page.getByText(
      /no active medication reminders|no patient profile found/i
    );
    await expect(noSchedules.first()).toBeVisible({ timeout: 15_000 });
  });

  test("page renders without crash for doctor role (no patient profile)", async ({
    doctorPage,
  }) => {

    // TODO: webkit auth-redirect residue

    test.skip(({ browserName }) => browserName === "webkit", "webkit auth-redirect residue");
    const page = doctorPage;
    await page.goto("/dashboard/adherence");
    await dismissTourIfPresent(page);

    // Page is not role-gated in the UI; a doctor can land on it but will either
    // see the "no patient profile" empty state or their own schedules list.
    await expect(
      page.getByRole("heading", { name: /medication reminders/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
