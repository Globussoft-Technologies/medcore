/**
 * /dashboard/users — EDIT / DEACTIVATE / ROLE-CHANGE coverage.
 *
 * What this exercises:
 *   /dashboard/users (apps/web/src/app/dashboard/users/page.tsx)
 *   PATCH /api/v1/users/:id (apps/api/src/routes/patient-extras.ts:396)
 *
 * Why this file is separate from admin.spec.ts:
 *   admin.spec.ts already covers the CREATE flow (POST /auth/register from
 *   the "Add Staff User" form). This file covers the row-level Edit /
 *   Disable / Role-change actions added under Issue #286 plus the
 *   ADMIN-only RBAC bounce — explicitly NOT touching create.
 *
 * Roles on the matrix (page.tsx:111-114, :265):
 *   ADMIN  → full access; non-ADMIN → router.push("/dashboard").
 *
 * Self-action guards on the API (patient-extras.ts:464,475):
 *   - Self-disable: PATCH { isActive:false } on own id → 400.
 *   - Self-demote:  PATCH { role: <non-ADMIN> } on own id → 400.
 *   The Edit modal also disables the role-select for the current user
 *   (page.tsx:652) and the Disable button is `disabled` on own row
 *   (page.tsx:548).
 */
import { test, expect } from "./fixtures";
import { API_BASE, dismissTourIfPresent, expectNotForbidden } from "./helpers";

/**
 * Seed a throwaway staff user so the EDIT / DEACTIVATE flows have a
 * deterministic row to act on without mutating the seeded admin /
 * doctor / nurse accounts other specs rely on.
 *
 * Uses POST /auth/register — same path the page's Create form hits.
 * Returns the user's id so we can target row-level testids
 * (`user-edit-${id}`, `user-toggle-${id}`).
 */
async function seedStaff(
  api: import("@playwright/test").APIRequestContext,
  role: "DOCTOR" | "NURSE" | "RECEPTION" = "DOCTOR"
): Promise<{ id: string; email: string; name: string; phone: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-staff-${stamp}@medcore.local`;
  // Mirrors freshPatientToken's strong-password recipe — accepted by
  // the same registerSchema validator.
  const password = `Pw!E2e-${stamp}-Aa9`;
  const name = `E2E Staff ${stamp}`;
  const phone = `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const res = await api.post(`${API_BASE}/auth/register`, {
    data: { name, email, phone, password, role },
  });
  if (!res.ok()) {
    throw new Error(
      `seedStaff failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return { id: data.user.id, email, name, phone };
}

test.describe("User Management — /dashboard/users edit / deactivate / role-change (CREATE flow lives in admin.spec.ts)", () => {
  test("ADMIN edits a seeded staff user's name + phone via the Edit modal — server stores the cleaned name and the row reflects the new name", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const staff = await seedStaff(adminApi, "DOCTOR");

    await page.goto("/dashboard/users");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /user management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The seeded row is keyed by user id — wait for it to be present.
    const editBtn = page.locator(`[data-testid="user-edit-${staff.id}"]`);
    await expect(editBtn).toBeVisible({ timeout: 15_000 });
    await editBtn.click();

    await expect(
      page.locator('[data-testid="user-edit-modal"]')
    ).toBeVisible();

    const updatedName = `${staff.name} Edited`;
    const updatedPhone = "+919876512345";
    await page.locator('[data-testid="user-edit-name"]').fill(updatedName);
    await page.locator('[data-testid="user-edit-phone"]').fill(updatedPhone);

    const savePromise = page.waitForResponse((r) =>
      /\/api\/v1\/users\/[^/]+$/.test(r.url()) &&
      r.request().method() === "PATCH"
    );
    await page.locator('[data-testid="user-edit-save"]').click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBeLessThan(400);

    // Modal closes on success (page.tsx:210).
    await expect(
      page.locator('[data-testid="user-edit-modal"]')
    ).toHaveCount(0, { timeout: 5_000 });

    // The list re-fetches and renders the updated name.
    await expect(page.locator(`text=${updatedName}`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("ADMIN deactivates a seeded staff user — confirm dialog accepts, row Status flips to Inactive", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const staff = await seedStaff(adminApi, "NURSE");

    // Auto-accept the confirm() dialog (page.tsx:227 → useConfirm).
    // useConfirm renders a custom modal, not window.confirm. We click the
    // confirm button inside the rendered dialog instead.
    await page.goto("/dashboard/users");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const toggle = page.locator(`[data-testid="user-toggle-${staff.id}"]`);
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toContainText(/disable/i);
    await toggle.click();

    // Click the danger-confirm button in the dialog. useConfirm dialogs
    // expose either a "Confirm" / "Disable" / "Yes" button — match
    // permissively so a copy tweak doesn't break the spec.
    const confirmBtn = page
      .getByRole("button", {
        name: /^(disable|confirm|yes|ok|continue)$/i,
      })
      .first();
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

    const patchPromise = page.waitForResponse((r) =>
      /\/api\/v1\/users\/[^/]+$/.test(r.url()) &&
      r.request().method() === "PATCH"
    );
    await confirmBtn.click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBeLessThan(400);

    // Row should now show Inactive and the toggle should read "Enable".
    await expect(toggle).toContainText(/enable/i, { timeout: 10_000 });
  });

  test("ADMIN promotes a seeded DOCTOR to NURSE via the Edit modal — role-select is enabled, save round-trips, and the role badge changes", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const staff = await seedStaff(adminApi, "DOCTOR");

    await page.goto("/dashboard/users");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const editBtn = page.locator(`[data-testid="user-edit-${staff.id}"]`);
    await expect(editBtn).toBeVisible({ timeout: 15_000 });
    await editBtn.click();

    const roleSelect = page.locator('[data-testid="user-edit-role"]');
    await expect(roleSelect).toBeVisible();
    // The select must be enabled for non-self rows (page.tsx:652
    // disables only when editing.id === user?.id).
    await expect(roleSelect).toBeEnabled();
    await roleSelect.selectOption("NURSE");

    const savePromise = page.waitForResponse((r) =>
      /\/api\/v1\/users\/[^/]+$/.test(r.url()) &&
      r.request().method() === "PATCH"
    );
    await page.locator('[data-testid="user-edit-save"]').click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBeLessThan(400);

    // Modal closes; reload list and assert the row's role badge changed.
    // The badge is rendered as a span containing the role text on the
    // same row as the user's name — assert NURSE appears within the
    // table after the re-fetch.
    await expect(
      page.locator('[data-testid="user-edit-modal"]')
    ).toHaveCount(0, { timeout: 5_000 });
    // The row now contains both the name and the NURSE badge.
    const row = page
      .locator("tr", { hasText: staff.name })
      .first();
    await expect(row).toContainText(/NURSE/, { timeout: 10_000 });
  });

  test("non-ADMIN (DOCTOR) is bounced from /dashboard/users — page.tsx:111-114 redirects to /dashboard, no row-level CTAs render", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/users", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // Either we're back on /dashboard or the page returned null
    // (page.tsx:265). Both surfaces share the same observable property:
    // the row-level Edit / Toggle controls do not render.
    expect(page.url()).toMatch(/\/dashboard(?:\/|$|\?)/);
    await expect(page.locator('[data-testid^="user-edit-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="user-toggle-"]')).toHaveCount(0);
  });

  test("non-ADMIN (NURSE) is bounced from /dashboard/users — same redirect path, no Edit modal CTA in the DOM", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/users", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(?:\/|$|\?)/);
    await expect(page.locator('[data-testid^="user-edit-"]')).toHaveCount(0);
    // The "Add Staff User" CTA is also gated behind the ADMIN render
    // branch — assert it's absent so a future regression that leaks
    // staff-creation UI to NURSE is caught here.
    await expect(
      page.getByRole("button", { name: /add staff user/i })
    ).toHaveCount(0);
  });

  test("self-deactivation guard — the toggle on the ADMIN's OWN row is disabled (page.tsx:548) so they cannot click Disable on themselves", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/users");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /user management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The seeded admin is admin@medcore.local — find its row and the
    // toggle button inside it.
    const adminRow = page.locator("tr", { hasText: "admin@medcore.local" }).first();
    await expect(adminRow).toBeVisible({ timeout: 10_000 });
    const ownToggle = adminRow.locator('[data-testid^="user-toggle-"]');
    await expect(ownToggle).toBeVisible();
    // page.tsx:548 → `disabled={u.id === user?.id}`.
    await expect(ownToggle).toBeDisabled();
  });
});
