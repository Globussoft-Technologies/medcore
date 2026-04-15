import { test, expect } from "./fixtures";

test.describe("Patient journeys", () => {
  test("patient can view their upcoming appointments", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/appointments");
    await expect(
      page.getByRole("heading", { name: /appointment/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.locator("body")).not.toContainText(/forbidden|403/i);
  });

  test("patient can view their prescriptions", async ({ patientPage }) => {
    const page = patientPage;
    await page.goto("/dashboard/prescriptions");
    await expect(
      page.getByRole("heading", { name: /prescription/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("body")).not.toContainText(/forbidden|403/i);
  });

  test("patient can view their pending bills", async ({ patientPage }) => {
    const page = patientPage;
    await page.goto("/dashboard/billing");
    await expect(
      page.getByRole("heading", { name: /billing|invoice|bill/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("body")).not.toContainText(/forbidden|403/i);
  });
});
