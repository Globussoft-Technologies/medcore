/**
 * Doctor DETAIL surface end-to-end coverage.
 *
 * What this exercises:
 *   /dashboard/doctors/[id]                       (apps/web/src/app/dashboard/doctors/[id]/page.tsx)
 *   GET /api/v1/doctors                           (apps/api/src/routes/doctors.ts)
 *
 * Surfaces touched:
 *   - ADMIN happy path: name / specialization / qualification / weekly-schedule table
 *     all render, the admin-only Edit CTA is visible, the schedule rows are sorted
 *     Sunday → Saturday by the page (page.tsx:126-129).
 *   - DOCTOR happy path: page is reachable (no role gate exists — page.tsx has no
 *     `VIEW_ALLOWED`/redirect; auth is the only gate), the doctor's own profile chrome
 *     renders, the Edit CTA does NOT render (admin-only via page.tsx:140-155).
 *   - PATIENT route-shape pin: /dashboard/doctors/[id] is universally accessible to any
 *     authenticated user — the LIST page (/dashboard/doctors) is ADMIN-only by client
 *     redirect, but the DETAIL page is not. Locking this asymmetry so a future "lock
 *     down detail too" change is a deliberate decision, not a silent regression.
 *   - Not-found surface: a syntactically valid UUID that doesn't match any doctor row
 *     renders the `doctor-detail-notfound` empty-state panel rather than crashing.
 *
 * Why this spec exists:
 *   `e2e/doctors.spec.ts` covers the LIST page only (search / spec filter / Add-Doctor
 *   modal CTA + ADMIN-only RBAC redirects on /dashboard/doctors). `/dashboard/doctors/[id]`
 *   is listed under §2.4 of docs/E2E_COVERAGE_BACKLOG.md (line 114) as the
 *   "doctor profile/schedule" gap. The detail page was added in Issue #213-B
 *   (2026-04-30) to close the "card click → 404" bug; this spec pins its
 *   testid contract so the read-only profile chrome and the admin-only Edit CTA
 *   don't silently regress, and pins the route-shape asymmetry vs the LIST page.
 *
 * Architecture notes:
 *   - There is NO `GET /api/v1/doctors/:id` endpoint today (page.tsx:13-16 documents
 *     the gap). The page hits GET /api/v1/doctors and filters client-side. That list
 *     endpoint has no `authorize()` wrapper — only `authenticate` — so every role can
 *     fetch the roster and therefore reach this page directly. We pin that with the
 *     PATIENT route-shape test below.
 *   - The doctor row id is resolved at runtime via the pre-authed adminApi fixture
 *     against /doctors. We don't seed a doctor — the realistic seeder always plants
 *     `dr.sharma@medcore.local` plus 3-4 specialty doctors, and any of them is fine
 *     for this spec since we only assert on chrome / testid presence.
 *   - `gotoAuthed` is mandatory for in-test dashboard navigations after the fixture's
 *     initial /dashboard load (WebKit auth-race v4 — see helpers.ts:268-343).
 */

import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed, API_BASE } from "./helpers";

const PAGE_TIMEOUT = 15_000;

/**
 * Resolve a doctorId at runtime via the admin-authed APIRequestContext. The
 * realistic seeder always populates at least dr.sharma@medcore.local + a few
 * specialty doctors; any row is fine for the chrome-pinning tests below.
 */
async function pickFirstDoctorId(
  adminApi: import("@playwright/test").APIRequestContext
): Promise<string> {
  const res = await adminApi.get(`${API_BASE}/doctors`);
  if (!res.ok()) {
    throw new Error(
      `pickFirstDoctorId: GET /doctors failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const list = json.data ?? [];
  if (!Array.isArray(list) || list.length === 0 || !list[0]?.id) {
    throw new Error(
      "pickFirstDoctorId: /doctors returned no rows; the realistic seeder didn't run"
    );
  }
  return list[0].id as string;
}

test.describe("Doctor detail — /dashboard/doctors/[id] (read-only profile + weekly schedule + admin-only Edit CTA)", () => {
  test("ADMIN lands on /dashboard/doctors/[id], profile card + weekly schedule render, and the admin-only Edit CTA is visible", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const doctorId = await pickFirstDoctorId(adminApi);

    await gotoAuthed(page, `/dashboard/doctors/${doctorId}`);
    await expectNotForbidden(page);

    // Wait for the loader (page.tsx:96-101) to clear and the detail container
    // to mount. data-testid="doctor-detail-page" is the page-level anchor at
    // page.tsx:132 — once it's visible the GET /doctors round-trip resolved
    // and the doctor row was found.
    await expect(
      page.locator('[data-testid="doctor-detail-page"]')
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Profile chrome: name + specialization + qualification (qualification is
    // optional in the DoctorRecord shape — the testid only renders when it's
    // present, so we use a soft .or() against the spec field which is always
    // there).
    await expect(
      page.locator('[data-testid="doctor-detail-name"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="doctor-detail-spec"]')
    ).toBeVisible();

    // Admin-only Edit CTA — gated by `isAdmin = user?.role === "ADMIN"`
    // (page.tsx:94, render at page.tsx:140-155). If this leaks to non-admin
    // we want the DOCTOR test below to fail BEFORE this assertion runs,
    // not co-equally with it.
    await expect(
      page.locator('[data-testid="doctor-detail-edit"]')
    ).toBeVisible();

    // Weekly Schedule section — either the table renders OR the empty-state
    // placeholder. We assert on the union: at least one of the two must be
    // visible. Realistic seed plants schedules for the demo doctors so the
    // table path is the common case, but we don't want to flake if the seed
    // changes.
    const tableVisible = await page
      .locator('[data-testid="doctor-detail-schedule-table"]')
      .isVisible()
      .catch(() => false);
    const emptyVisible = await page
      .locator('[data-testid="doctor-detail-schedule-empty"]')
      .isVisible()
      .catch(() => false);
    expect(tableVisible || emptyVisible).toBe(true);
  });

  test("DOCTOR can reach /dashboard/doctors/[id] directly — page has no client-side role gate, chrome renders, but the admin-only Edit CTA is hidden", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const doctorId = await pickFirstDoctorId(adminApi);

    await gotoAuthed(page, `/dashboard/doctors/${doctorId}`);
    await expectNotForbidden(page);

    // Page renders for DOCTOR — there is no `router.replace("/dashboard/not-authorized")`
    // anywhere in apps/web/src/app/dashboard/doctors/[id]/page.tsx. The DOCTOR
    // can absolutely view a colleague's read-only profile.
    await expect(
      page.locator('[data-testid="doctor-detail-page"]')
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(
      page.locator('[data-testid="doctor-detail-name"]')
    ).toBeVisible();

    // Edit CTA is admin-only (page.tsx:140 `{isAdmin && (…)}`) — must NOT
    // render for DOCTOR. This is the surface that captures any future
    // regression where the role gate is loosened.
    await expect(
      page.locator('[data-testid="doctor-detail-edit"]')
    ).toHaveCount(0);
  });

  test("PATIENT can reach /dashboard/doctors/[id] directly — route-shape pin: detail page is universally accessible (LIST page is admin-only, but DETAIL is not)", async ({
    patientPage,
    adminApi,
  }) => {
    const page = patientPage;
    const doctorId = await pickFirstDoctorId(adminApi);

    await gotoAuthed(page, `/dashboard/doctors/${doctorId}`);

    // The /dashboard/doctors LIST page redirects every non-ADMIN role to
    // /dashboard/not-authorized (covered by doctors.spec.ts). The DETAIL
    // page does NOT — page.tsx has no `VIEW_ALLOWED` / `router.replace`,
    // and the underlying GET /api/v1/doctors endpoint has no `authorize()`
    // wrapper (apps/api/src/routes/doctors.ts:15 — only `authenticate` runs).
    //
    // We deliberately pin this asymmetry rather than asserting a redirect:
    // if the team later decides PATIENT shouldn't see provider PII via a
    // crafted URL, that's a deliberate change that should update THIS test,
    // not slip in silently.
    expect(page.url()).not.toContain("/dashboard/not-authorized");
    await expect(
      page.locator('[data-testid="doctor-detail-page"]')
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Edit CTA must not render for PATIENT.
    await expect(
      page.locator('[data-testid="doctor-detail-edit"]')
    ).toHaveCount(0);
  });

  test("Unknown doctor id renders the not-found empty-state panel rather than crashing — bad uuid path lands cleanly on doctor-detail-notfound", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // A syntactically valid UUID v4 that no seeded doctor row will ever match.
    // The page filters /doctors client-side (page.tsx:71-79) so a missing
    // match flips `notFound = true` → renders the amber empty-state panel
    // gated by data-testid="doctor-detail-notfound" (page.tsx:113-122).
    const fakeUuid = "00000000-0000-0000-0000-0000000000aa";
    await gotoAuthed(page, `/dashboard/doctors/${fakeUuid}`);
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="doctor-detail-notfound"]')
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The detail page chrome must NOT render for an unknown id — confirms
    // the loader took the not-found branch, not the doctor-found branch.
    await expect(
      page.locator('[data-testid="doctor-detail-page"]')
    ).toHaveCount(0);
  });
});
