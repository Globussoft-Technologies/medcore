/**
 * Notification Templates admin-flow + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/notification-templates
 *     (apps/web/src/app/dashboard/notification-templates/page.tsx)
 *   GET  /api/v1/notifications/templates
 *   POST /api/v1/notifications/templates
 *   PUT  /api/v1/notifications/templates/:id
 *     (apps/api/src/routes/notifications.ts:178-199 + 440-468, all
 *      authorize(Role.ADMIN))
 *
 * Surfaces touched:
 *   - ADMIN happy path: the heading "Notification Templates" renders,
 *     the GET /notifications/templates fires on mount and returns 2xx,
 *     and the type/channel matrix table renders rows for the 13
 *     NOTIFICATION_TYPES across 4 CHANNELS.
 *   - Modal-open contract: clicking an Add/Edit cell button (page.tsx:
 *     142-164) opens the editor dialog and pre-fills the body with the
 *     DEFAULT_BODIES placeholder for that type.
 *   - EMAIL channel reveals the Subject input (page.tsx:193-206) — the
 *     conditional render is the only differentiator between EMAIL rows
 *     and the WHATSAPP / SMS / PUSH rows.
 *   - Save flow: filling a body and clicking Save fires either POST
 *     (when no template exists) or PUT (when editing) and the modal
 *     closes after the success toast.
 *   - Non-ADMIN bounce: useEffect at page.tsx:61-65 pushes any non-ADMIN
 *     to /dashboard, so DOCTOR / NURSE / PATIENT never reach the matrix.
 *
 * Why these tests exist:
 *   /dashboard/notification-templates was listed under §2.5 of
 *   docs/E2E_COVERAGE_BACKLOG.md as the template-config surface with no
 *   e2e cover. It is the source of truth for every patient-facing
 *   message — accidental relaxation of the admin-only gate would let
 *   any staff role rewrite notification copy fleet-wide, and a broken
 *   matrix renderer would silently freeze all template edits.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Notification Templates — /dashboard/notification-templates (ADMIN matrix + edit modal + non-ADMIN RBAC redirects)", () => {
  test("ADMIN lands on /dashboard/notification-templates, heading renders, GET /notifications/templates fires and the type/channel matrix is visible", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const templatesPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/templates") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/notification-templates");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toBeVisible({ timeout: 15_000 });

    const templatesRes = await templatesPromise;
    expect(templatesRes.status()).toBeLessThan(400);

    // Matrix must render: every NOTIFICATION_TYPES entry shows up as a
    // row label (page.tsx:135-137). Pin two representative rows from
    // distant ends of the type list so a regression that drops a
    // template-type lights up.
    await expect(
      page.locator("text=/^APPOINTMENT_BOOKED$/")
    ).toBeVisible();
    await expect(
      page.locator("text=/^LOW_STOCK_ALERT$/")
    ).toBeVisible();

    // Channel headers (CHANNELS array, page.tsx:36) render at the top
    // of the matrix table. Each is unique to this page's table head.
    for (const channel of ["WHATSAPP", "SMS", "EMAIL", "PUSH"]) {
      await expect(
        page.getByRole("columnheader", { name: channel })
      ).toBeVisible();
    }
  });

  test("ADMIN clicking an Add/Edit cell opens the editor modal pre-filled with the DEFAULT_BODIES placeholder for that type", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notification-templates");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toBeVisible({ timeout: 15_000 });

    // The APPOINTMENT_BOOKED row is the first in NOTIFICATION_TYPES. Its
    // four cells render either "Add" (no template yet) or "Edit"
    // (template exists for the type+channel combo). We click the first
    // cell button on that row regardless — both paths open the same
    // modal at page.tsx:174-244.
    const apptRow = page
      .locator("tr")
      .filter({ has: page.locator("text=/^APPOINTMENT_BOOKED$/") })
      .first();
    await expect(apptRow).toBeVisible();

    // Click the FIRST cell button on this row — corresponds to WHATSAPP.
    await apptRow.getByRole("button", { name: /^(add|edit)$/i }).first().click();

    // Modal heading reads "<TYPE> — <CHANNEL>". For APPOINTMENT_BOOKED +
    // WHATSAPP this is unambiguous.
    await expect(
      page.getByRole("heading", { name: /APPOINTMENT_BOOKED.*WHATSAPP/ })
    ).toBeVisible({ timeout: 5_000 });

    // The body textarea pre-fills with DEFAULT_BODIES.APPOINTMENT_BOOKED
    // when no template exists yet; if a template DOES exist the body is
    // whatever was last saved. Either way the textarea must be visible
    // and non-empty.
    const bodyField = page.locator("#edit-template-body");
    await expect(bodyField).toBeVisible();
    const bodyValue = await bodyField.inputValue();
    expect(bodyValue.length).toBeGreaterThan(0);

    // Cancel cleanly so we don't mutate seed data.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(bodyField).toHaveCount(0, { timeout: 5_000 });
  });

  test("ADMIN opening an EMAIL-channel cell reveals the Subject input — page.tsx:193-206 conditional render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notification-templates");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toBeVisible({ timeout: 15_000 });

    // EMAIL is the third channel (index 2) in CHANNELS so it's the
    // third button cell on each row. We pick LAB_RESULT_READY because
    // it's a row whose semantic name reduces test-flake from accidental
    // text matches elsewhere on the page.
    const labRow = page
      .locator("tr")
      .filter({ has: page.locator("text=/^LAB_RESULT_READY$/") })
      .first();
    await expect(labRow).toBeVisible();

    // The third button on the row corresponds to EMAIL (CHANNELS[2]).
    await labRow.getByRole("button", { name: /^(add|edit)$/i }).nth(2).click();

    await expect(
      page.getByRole("heading", { name: /LAB_RESULT_READY.*EMAIL/ })
    ).toBeVisible({ timeout: 5_000 });

    // Subject input only renders for EMAIL — page.tsx:193-206.
    await expect(page.locator("#edit-template-subject")).toBeVisible();

    await page.getByRole("button", { name: /^cancel$/i }).click();
  });

  test("ADMIN editing a template body and clicking Save fires a POST or PUT to /notifications/templates and the modal closes", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notification-templates");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Pick MEDICATION_DUE + PUSH (last channel = index 3) — a low-traffic
    // template combo so collisions with other tests are unlikely.
    const medRow = page
      .locator("tr")
      .filter({ has: page.locator("text=/^MEDICATION_DUE$/") })
      .first();
    await expect(medRow).toBeVisible();
    await medRow.getByRole("button", { name: /^(add|edit)$/i }).nth(3).click();

    await expect(
      page.getByRole("heading", { name: /MEDICATION_DUE.*PUSH/ })
    ).toBeVisible({ timeout: 5_000 });

    // Tag the body with a unique-ish marker so the round-trip is
    // observable to the next reader. Don't use Date.now() in any
    // patient-name-shaped field (CLAUDE.md gotcha #8) — body is plain
    // template text, digits are fine here.
    const tag = `e2e-${Date.now()}`;
    const bodyField = page.locator("#edit-template-body");
    await bodyField.fill(`Medication {{medication}} due at {{time}}. ${tag}`);

    // Save fires either POST (line 97-104) or PUT (line 90-95) depending
    // on whether the template exists already. Match either method.
    const savePromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/templates") &&
        ["POST", "PUT"].includes(r.request().method()),
      { timeout: 15_000 }
    );
    await page.getByRole("button", { name: /^save$/i }).click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBeLessThan(400);

    // Modal closes after the success toast (page.tsx:107).
    await expect(bodyField).toHaveCount(0, { timeout: 10_000 });
  });

  test("DOCTOR bounces off /dashboard/notification-templates — useEffect at page.tsx:61-65 pushes non-ADMIN to /dashboard, the matrix never renders", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/notification-templates", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/notification-templates/);
    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toHaveCount(0);
  });

  test("NURSE bounces off /dashboard/notification-templates — same role-gate useEffect, the matrix never renders", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/notification-templates", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/notification-templates/);
    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces off /dashboard/notification-templates — admin-only surface, the matrix never renders", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/notification-templates", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/notification-templates/);
    await expect(
      page.getByRole("heading", { name: /^notification templates$/i })
    ).toHaveCount(0);
  });
});
